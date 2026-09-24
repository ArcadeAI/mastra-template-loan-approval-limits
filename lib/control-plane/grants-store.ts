/**
 * `grants` — the narrow, expiring permissions an approval produces, and the
 * lifecycle that stops one existing before the decision that justifies it.
 *
 * ## Why a lifecycle
 *
 * Issuing a grant and recording the decision are two writes, and two writes
 * race. Round 1 of #52's review found the hole and drove it: two `Decide`
 * calls both pass `/pre` while the request is still `pending` — one approving,
 * one denying — the denial is recorded first, the approval's store write loses
 * with a `409`, and the grant the approval already minted sits there, usable,
 * against a request whose recorded outcome is `denied`.
 *
 * Ordering the two writes differently only moves the window. So the fix is not
 * ordering: a grant is minted **`pending`**, which is not usable, and the only
 * thing that can make it usable is the *same transaction* that records the
 * winning decision as `approved`. A decision that loses the compare-and-swap
 * changes nothing and therefore activates nothing; a recorded `denied` voids
 * every pending grant the request owns, in that same transaction. There is no
 * interleaving in which a grant is usable and the recorded outcome is not
 * `approved`, because the two facts are written together or not at all.
 *
 * Voiding sets `revoked_at` as well as `status`, so `GrantChecker` refuses the
 * row on its own terms even if somebody later reads the table without
 * consulting the status. Two independent reasons to refuse, neither relying on
 * the other.
 *
 * ## What this module does not do
 *
 * It holds no opinion about whether a grant *authorises* a call. That question
 * belongs to `GrantChecker` (#10), and asking it twice in two places is how
 * the two answers start to differ. What this module answers is narrower and
 * prior: is this row eligible to be asked about at all.
 */
import type { Database } from "bun:sqlite";

import { Grant, type ApprovalStatus } from "@cg/policy-schema";

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newGrantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "grn_";
  for (const byte of bytes) out += ID_ALPHABET[byte % 32];
  return out;
}

/** Where a grant is in its life. Only `active` is usable. */
export type GrantLifecycle = "pending" | "active" | "void";

/** The decisions a grant can be minted against. Today only approvals mint one. */
export type AuthorizedDecision = "approved" | "denied";

/**
 * A grant as stored, with the two facts that decide whether it may be
 * considered: its own lifecycle, and the *current* status of the approval
 * request it came from.
 *
 * Both travel together, read in one query, because a caller that fetched them
 * separately could act on a pair that was never true at the same instant.
 */
export interface StoredGrant {
  grant: Grant;
  lifecycle: GrantLifecycle;
  authorizes: AuthorizedDecision;
  /** `null` when the request row is gone, which is itself a reason to refuse. */
  requestStatus: ApprovalStatus | null;
  activated_at: string | null;
  voided_at: string | null;
}

interface Row {
  id: string;
  subject_id: string;
  granted_by: string;
  request_id: string;
  toolkit: string;
  tool: string;
  resource_id: string | null;
  pinned_inputs: string;
  ceiling: string | null;
  issued_at: string;
  expires_at: string;
  uses_remaining: number | null;
  revoked_at: string | null;
  status: string;
  authorizes: string;
  activated_at: string | null;
  voided_at: string | null;
  request_status: string | null;
}

const SELECT =
  `SELECT g.*, r.status AS request_status
     FROM grants g
     LEFT JOIN approval_requests r ON r.id = g.request_id`;

export type InsertOutcome = "inserted" | "duplicate_request";

/**
 * Mint a grant, `pending`.
 *
 * Never `active`: nothing that runs before a decision is recorded may produce
 * a usable grant, and `/pre` runs before the tool that records it. The unique
 * index over `request_id` is what makes `duplicate_request` the answer rather
 * than a second row — one approval, one grant, enforced by the database.
 */
export function insertGrant(
  db: Database,
  grant: Grant,
  authorizes: AuthorizedDecision = "approved",
): InsertOutcome {
  const parsed = Grant.parse(grant);
  try {
    db.prepare(
      `INSERT INTO grants
         (id, subject_id, granted_by, request_id, toolkit, tool, resource_id,
          pinned_inputs, ceiling, issued_at, expires_at, uses_remaining, revoked_at,
          status, authorizes, activated_at, voided_at)
       VALUES
         ($id, $subject_id, $granted_by, $request_id, $toolkit, $tool, $resource_id,
          $pinned_inputs, $ceiling, $issued_at, $expires_at, $uses_remaining, $revoked_at,
          'pending', $authorizes, NULL, NULL)`,
    ).run({
      $id: parsed.id,
      $subject_id: parsed.subject_id,
      $granted_by: parsed.granted_by,
      $request_id: parsed.request_id,
      $toolkit: parsed.match.toolkit,
      $tool: parsed.match.tool,
      $resource_id: parsed.resource_id,
      $pinned_inputs: JSON.stringify(parsed.pinned_inputs),
      $ceiling: parsed.ceiling === null ? null : JSON.stringify(parsed.ceiling),
      $issued_at: parsed.issued_at,
      $expires_at: parsed.expires_at,
      $uses_remaining: parsed.uses_remaining,
      $revoked_at: parsed.revoked_at,
      $authorizes: authorizes,
    });
    return "inserted";
  } catch (cause) {
    if (isUniqueViolation(cause)) return "duplicate_request";
    throw cause;
  }
}

/**
 * Turn on the grants a recorded approval owns. Returns how many.
 *
 * Only rows that are still `pending` and were minted against `approved` are
 * touched, so a grant cannot be switched on by an outcome it was not issued
 * for, and one already voided stays voided. Called **only** from inside the
 * transaction that compare-and-swapped the request to `approved`; a decision
 * that lost that swap never reaches here.
 */
export function activatePendingGrants(db: Database, requestId: string, at: string): number {
  return db
    .prepare(
      `UPDATE grants SET status = 'active', activated_at = $at
        WHERE request_id = $request_id AND status = 'pending' AND authorizes = 'approved'`,
    )
    .run({ $request_id: requestId, $at: at }).changes;
}

/**
 * Void every grant still waiting on this request. Returns how many.
 *
 * `revoked_at` is set alongside the status on purpose: a voided grant is
 * refused by `GrantChecker` on the record's own terms, without anybody having
 * to remember to filter on `status`.
 */
export function voidPendingGrants(db: Database, requestId: string, at: string): number {
  return db
    .prepare(
      `UPDATE grants SET status = 'void', voided_at = $at, revoked_at = $at
        WHERE request_id = $request_id AND status = 'pending'`,
    )
    .run({ $request_id: requestId, $at: at }).changes;
}

/**
 * Every grant this subject holds for this tool, whatever state it is in, with
 * the request status attached.
 *
 * Deliberately unfiltered. The caller decides what is usable and says out loud
 * why each of the rest was not — that is what lets an audit row show that a
 * voided grant was present and ignored, rather than that nothing was there.
 * A `WHERE status = 'active'` here would be a cheaper filter and a silent one.
 */
export function grantsFor(
  db: Database,
  subjectId: string,
  tool: { toolkit: string; name: string },
): StoredGrant[] {
  return db
    .query<Row, { $subject_id: string; $toolkit: string; $tool: string }>(
      `${SELECT}
        WHERE g.subject_id = $subject_id AND g.toolkit = $toolkit AND g.tool = $tool
        ORDER BY g.issued_at ASC, g.id ASC`,
    )
    .all({ $subject_id: subjectId, $toolkit: tool.toolkit, $tool: tool.name })
    .map(fromRow);
}

/**
 * Write back a grant `consumeGrant` has spent. Single use is enforced by the
 * row, not by the returned value, so this is the step that makes it true.
 */
export function persistConsumption(db: Database, grant: Grant): void {
  db.prepare("UPDATE grants SET uses_remaining = $uses WHERE id = $id").run({
    $id: grant.id,
    $uses: grant.uses_remaining,
  });
}

export function allGrants(db: Database): StoredGrant[] {
  return db.query<Row, []>(`${SELECT} ORDER BY g.issued_at ASC, g.id ASC`).all().map(fromRow);
}

function fromRow(row: Row): StoredGrant {
  return {
    grant: Grant.parse({
      id: row.id,
      subject_id: row.subject_id,
      granted_by: row.granted_by,
      request_id: row.request_id,
      match: { toolkit: row.toolkit, tool: row.tool },
      resource_id: row.resource_id,
      pinned_inputs: JSON.parse(row.pinned_inputs),
      ceiling: row.ceiling === null ? null : JSON.parse(row.ceiling),
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      uses_remaining: row.uses_remaining,
      revoked_at: row.revoked_at,
    }),
    lifecycle: row.status as GrantLifecycle,
    authorizes: row.authorizes as AuthorizedDecision,
    requestStatus: row.request_status as ApprovalStatus | null,
    activated_at: row.activated_at,
    voided_at: row.voided_at,
  };
}

function isUniqueViolation(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("UNIQUE constraint failed");
}
