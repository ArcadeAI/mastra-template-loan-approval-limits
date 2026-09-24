/**
 * The approval half of `/pre`: what the control plane has to look up before
 * the `PolicyEngine` can answer, and what it writes once the engine has.
 *
 * ## Why `Approvals.Decide` needs anything special at all
 *
 * The engine evaluates rules against a call's *inputs*, and `Decide`'s inputs
 * are `request_id`, `decision` and an optional `note`. None of those says who
 * asked, for how much, or whether the request is still open — the three facts
 * the decision turns on. They are in `governance.db`, one lookup away, and the
 * control plane is the only party that can make it: the link carries an opaque
 * id and nothing else, precisely so that possession of it is not permission.
 *
 * So `/pre` resolves `request_id` and hands the engine an extra input,
 * `approval`, carrying those three facts plus one derived comparison. The
 * rules that use it are ordinary rows in `policy_rules` — `pre.decide-*` in
 * `fixtures/governance.json` — so separation of duties, the clearance bar and
 * "a decision is final" are policy a presenter can edit on stage, not `if`s
 * compiled into this service.
 *
 * **`approval` is overwritten, never merged.** Whatever the caller put under
 * that key is discarded before the lookup, and if the lookup finds nothing the
 * key is absent rather than falsy. A model that learned the shape and passed
 * `approval={requester_id: "someone-else"}` would otherwise talk its way
 * through the separation-of-duties rule, which is the one control this whole
 * slice exists to hold.
 *
 * ## Where a grant comes from, and where it goes
 *
 * A grant is written **by the pre-hook**, when it allows a `Decide` that
 * approves, and by nothing else. That is what "no code path writes a grant
 * without passing through the pre-hook" means here: the approvals toolkit
 * cannot write one — it has no database — and the store endpoints do not,
 * because recording a decision is not the same act as issuing authority.
 *
 * But the pre-hook cannot write a *usable* one, and that distinction is the
 * whole of round 1's fix. `/pre` runs before the tool that records the
 * decision, so at the moment it writes, the outcome is not yet settled and
 * another `Decide` may still be in flight with the opposite answer. So the row
 * it writes is `pending`, which authorises nothing, and only the transaction
 * that records `approved` — winning the compare-and-swap on the request —
 * turns it on. A recorded `denied` voids it in that same transaction. See
 * `grants-store.ts`.
 *
 * A grant is *consumed* somewhere else again: on the retry, in `handlePre`,
 * when a grant is what turned a denial into an allow. Checking and consuming
 * are two steps in `GrantChecker` on purpose (#10), and they stay two steps
 * here — the grant is spent only when it was decisive, so a call that policy
 * allowed on its own does not quietly burn the one use an approval bought.
 */
import type { Database } from "bun:sqlite";

import type { ToolRef } from "@cg/governance-core";
import type { Grant, Inputs } from "@cg/policy-schema";

import { readApproval, type StoredApproval } from "./approvals-store.ts";
import {
  grantsFor as readGrantsFor,
  insertGrant,
  newGrantId,
  persistConsumption,
  type AuthorizedDecision,
  type InsertOutcome,
  type StoredGrant,
} from "./grants-store.ts";
import { subjectKey } from "./policy-cache.ts";

/** The tools of the approvals toolkit `/pre` treats specially, unqualified. */
export const DECIDE = "Decide";
export const REQUEST_APPROVAL = "RequestApproval";

/** The input key the resolved approval arrives under. Reserved; never merged. */
export const APPROVAL_INPUT = "approval";

/** The database reads and writes `/pre` needs. Everything else it does is pure. */
export interface PreStore {
  approval(requestId: string): StoredApproval | null;
  grantsFor(subjectId: string, tool: ToolRef): StoredGrant[];
  issueGrant(grant: Grant, authorizes: AuthorizedDecision): InsertOutcome;
  consume(grant: Grant): void;
}

/** What `handlePre` needs beyond the policy to govern the approval flow. */
export interface ApprovalControl {
  store: PreStore;
  /** `tool.toolkit` as Arcade files the deployed approvals toolkit. */
  toolkit: string;
  /** How long a grant this decision issues stays good. */
  grantTtlSeconds: number;
  newGrantId: () => string;
}

export function createPreStore(db: Database): PreStore {
  return {
    approval: (requestId) => readApproval(db, requestId),
    grantsFor: (subjectId, tool) => readGrantsFor(db, subjectId, tool),
    issueGrant: (grant, authorizes) => insertGrant(db, grant, authorizes),
    consume: (grant) => persistConsumption(db, grant),
  };
}

/**
 * The facts a `pre.decide-*` rule evaluates, as the engine will see them.
 *
 * `decided_by_requester` is derived here rather than by a rule because no
 * condition operator compares an input to `subject.user_id`; the comparison is
 * case-insensitive for the same reason `findSubject` is — Arcade, the OAuth
 * provider and the loan book do not all promise the same casing of an email,
 * and a case difference must not read as two different people.
 */
export interface ApprovalFacts extends Record<string, unknown> {
  requester_id: string;
  amount: number;
  status: string;
  decided_by_requester: boolean;
}

export function approvalFacts(stored: StoredApproval, clickerId: string): ApprovalFacts {
  const { record } = stored;
  return {
    requester_id: record.requester_id,
    amount: record.amount,
    status: record.status,
    decided_by_requester: subjectKey(record.requester_id) === subjectKey(clickerId),
  };
}

/**
 * The call's inputs with the reserved `approval` key replaced by what the
 * store actually holds, or removed when it holds nothing.
 *
 * Removal is what makes `pre.decide-needs-a-known-request` fire on an id that
 * names no request. A falsy placeholder would leave the other rules to trip
 * over a missing field and report the wrong reason.
 */
export function withResolvedApproval(
  inputs: Inputs,
  stored: StoredApproval | null,
  clickerId: string,
): Inputs {
  const { [APPROVAL_INPUT]: _discarded, ...rest } = inputs;
  return stored === null ? rest : { ...rest, [APPROVAL_INPUT]: approvalFacts(stored, clickerId) };
}

/**
 * The grant an approved decision issues: one action, one resource, one amount
 * ceiling, one use, and an expiry.
 *
 * Every field comes from the approval record and the binding resolved when the
 * request was created — never from the `Decide` call's arguments, which the
 * model chooses. The resource is *pinned*, so the retry cannot name a
 * different one; the amount is a *ceiling*, so the retry may come in at or
 * below what was approved but not above; `uses_remaining` is 1, so the second
 * attempt finds nothing.
 */
export function grantFrom(
  stored: StoredApproval,
  grantedBy: string,
  control: Pick<ApprovalControl, "grantTtlSeconds" | "newGrantId">,
  issuedAt: Date,
): Grant {
  const { record, binding } = stored;
  const expires = new Date(issuedAt.getTime() + control.grantTtlSeconds * 1000);

  return {
    id: control.newGrantId(),
    subject_id: record.requester_id,
    granted_by: grantedBy,
    request_id: record.id,
    match: { toolkit: binding.toolkit, tool: binding.tool },
    resource_id: record.resource_id,
    pinned_inputs: { [binding.resourceInput]: record.resource_id },
    ceiling:
      binding.amountInput === null ? null : { input: binding.amountInput, max: record.amount },
    issued_at: issuedAt.toISOString(),
    expires_at: expires.toISOString(),
    uses_remaining: 1,
    revoked_at: null,
  };
}

/** Default control, wired to a real database. */
export function createApprovalControl(
  db: Database,
  options: { toolkit: string; grantTtlSeconds: number; newGrantId?: () => string },
): ApprovalControl {
  return {
    store: createPreStore(db),
    toolkit: options.toolkit,
    grantTtlSeconds: options.grantTtlSeconds,
    newGrantId: options.newGrantId ?? newGrantId,
  };
}

/**
 * Why a stored grant may not even be considered, or `null` when it may.
 *
 * Two independent conditions, both required, and deliberately not collapsed
 * into one: the grant must have been **activated**, and the request it came
 * from must have **recorded** `approved`. Either alone leaves a hole. A grant
 * still `pending` belongs to a decision nobody has recorded, and a request
 * that reads `approved` may have activated a *different* grant — or none,
 * because the approval was written straight to the store with no pre-hook
 * behind it. Requiring both is what makes "usable" mean "the winning recorded
 * decision was approved, and this is the grant that decision turned on".
 *
 * Returning a sentence rather than a boolean is the point: the audit row says
 * a grant was present and why it was ignored, which is the difference between
 * a control that fired and a table that happened to be empty.
 */
export function whyUnusable(stored: StoredGrant): string | null {
  if (stored.lifecycle === "void") {
    return (
      `it was voided at ${stored.voided_at ?? "an unrecorded time"} because approval request ` +
      `${stored.grant.request_id} was decided ${stored.requestStatus ?? "otherwise"}`
    );
  }
  if (stored.lifecycle !== "active") {
    return (
      `it is still pending activation — approval request ${stored.grant.request_id} is ` +
      `${stored.requestStatus ?? "missing"}, and only the transaction that records an ` +
      `approval turns a grant on`
    );
  }
  if (stored.requestStatus !== "approved") {
    return (
      `approval request ${stored.grant.request_id} now reads ` +
      `${stored.requestStatus ?? "missing"}, not approved`
    );
  }
  return null;
}
