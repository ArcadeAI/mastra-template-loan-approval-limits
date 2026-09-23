/**
 * `approval_requests` — the escalations a human acts on.
 *
 * The row is the wire record written out under "The approvals store contract"
 * in `tools/approvals/README.md`, one column per field, plus the control
 * plane's own resolution of the bare `action` name (see `action-binding.ts`).
 * Every record that leaves this module is `parse()`d through
 * `@cg/policy-schema`'s `ApprovalRecord`, so a hand-edited row that no longer
 * conforms fails here rather than rendering as a blank on the approval page.
 *
 * Two things this module deliberately does not do.
 *
 * **It does not authorize.** Answering a read is not permission and recording
 * a decision is not deciding: whether the person clicking may decide is a
 * `/pre` decision on `Approvals.Decide`, made before the decision request is
 * ever sent. The requester can read the DM she sent, so she can reach the read
 * too — which is exactly why the link is safe to put in a conversation.
 *
 * **It does not overwrite a decision.** `recordDecision` is a compare-and-swap:
 * it writes only while the request is `pending`, and reports `already_decided`
 * otherwise. That `WHERE status = 'pending'` is not politeness — it is the
 * point at which one of several in-flight decisions is declared the winner,
 * and everything that follows from a decision hangs off whether it changed a
 * row.
 *
 * **It settles the request's grants in the same transaction.** Winning the swap
 * with `approved` activates the pending grant the pre-hook minted; winning it
 * with `denied` voids every pending grant the request owns. A decision that
 * loses the swap changes nothing and therefore settles nothing — it cannot
 * activate a grant, and it cannot void one it did not win the right to. This
 * is what closes the race round 1 of #52's review found: there is no
 * interleaving in which a grant is usable and the recorded outcome is not
 * `approved`, because the two facts are written together or not at all.
 */
import type { Database } from "bun:sqlite";

import { ApprovalRecord, type ApprovalStatus } from "@cg/policy-schema";

import type { ActionBinding } from "./action-binding.ts";
import { activatePendingGrants, voidPendingGrants } from "./grants-store.ts";

/**
 * Ids are minted here and nowhere else. The toolkit does not supply one on
 * purpose: an id the toolkit invented is an id the model could predict, and
 * therefore ask about before anyone had approved it. `apr_` plus 12 Crockford
 * base32 characters, ~60 bits, matching the shape `audit-log.ts` uses.
 */
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newApprovalId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "apr_";
  for (const byte of bytes) out += ID_ALPHABET[byte % 32];
  return out;
}

/** What `POST /approvals` supplies, after the API layer has resolved it. */
export interface NewApproval {
  requester_id: string;
  requester_display_name: string;
  approver_id: string;
  approver_display_name: string;
  candidate_approver_ids: string[];
  action: string;
  resource_id: string;
  amount: number;
  required_clearance: number;
  rule: { id: string; description: string } | null;
  justification: string;
}

/** A stored request: the wire record plus what the control plane resolved. */
export interface StoredApproval {
  record: ApprovalRecord;
  binding: ActionBinding;
}

export interface DecisionInput {
  decision: Extract<ApprovalStatus, "approved" | "denied">;
  note: string | null;
  decided_by: string;
}

export type DecisionOutcome =
  | {
      outcome: "recorded";
      approval: StoredApproval;
      /** Grants this decision turned on, and grants it voided. */
      grantsActivated: number;
      grantsVoided: number;
    }
  | { outcome: "not_found" }
  | { outcome: "already_decided"; approval: StoredApproval };

interface Row {
  id: string;
  requester_id: string;
  approver_id: string;
  candidate_approver_ids: string;
  action: string;
  resource_id: string;
  amount: number;
  required_clearance: number;
  rule_id: string | null;
  rule_description: string | null;
  justification: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
  match_toolkit: string;
  match_tool: string;
  resource_input: string;
  amount_input: string | null;
  requester_display_name: string;
  approver_display_name: string;
}

const SELECT = "SELECT * FROM approval_requests WHERE id = $id";

export function createApproval(
  db: Database,
  input: NewApproval,
  binding: ActionBinding,
  clock: { now: () => string; newId?: () => string },
): StoredApproval {
  const id = (clock.newId ?? newApprovalId)();
  const created_at = clock.now();

  db.prepare(
    `INSERT INTO approval_requests
       (id, requester_id, requester_display_name, approver_id, approver_display_name,
        candidate_approver_ids, action, resource_id, amount, required_clearance,
        rule_id, rule_description, justification, status, created_at,
        match_toolkit, match_tool, resource_input, amount_input)
     VALUES
       ($id, $requester_id, $requester_display_name, $approver_id, $approver_display_name,
        $candidate_approver_ids, $action, $resource_id, $amount, $required_clearance,
        $rule_id, $rule_description, $justification, 'pending', $created_at,
        $match_toolkit, $match_tool, $resource_input, $amount_input)`,
  ).run({
    $id: id,
    $requester_id: input.requester_id,
    $requester_display_name: input.requester_display_name,
    $approver_id: input.approver_id,
    $approver_display_name: input.approver_display_name,
    $candidate_approver_ids: JSON.stringify(input.candidate_approver_ids),
    $action: input.action,
    $resource_id: input.resource_id,
    $amount: input.amount,
    $required_clearance: input.required_clearance,
    $rule_id: input.rule?.id ?? null,
    $rule_description: input.rule?.description ?? null,
    $justification: input.justification,
    $created_at: created_at,
    $match_toolkit: binding.toolkit,
    $match_tool: binding.tool,
    $resource_input: binding.resourceInput,
    $amount_input: binding.amountInput,
  });

  const stored = readApproval(db, id);
  if (stored === null) throw new Error(`approval ${id} vanished immediately after being written`);
  return stored;
}

export function readApproval(db: Database, id: string): StoredApproval | null {
  const row = db.query<Row, { $id: string }>(SELECT).get({ $id: id });
  return row === null ? null : fromRow(row);
}

export function recordDecision(
  db: Database,
  id: string,
  input: DecisionInput,
  now: () => string,
): DecisionOutcome {
  return db.transaction((): DecisionOutcome => {
    const existing = readApproval(db, id);
    if (existing === null) return { outcome: "not_found" };

    const at = now();
    // The compare-and-swap. `changes` is the whole answer: 1 means this
    // decision is the one that settled the request, 0 means another already
    // had. Reading the status first and then updating would be two answers
    // with a gap between them.
    const won =
      db
        .prepare(
          `UPDATE approval_requests
              SET status = $status, note = $note, decided_at = $decided_at, decided_by = $decided_by
            WHERE id = $id AND status = 'pending'`,
        )
        .run({
          $id: id,
          $status: input.decision,
          $note: input.note,
          $decided_at: at,
          $decided_by: input.decided_by,
        }).changes === 1;

    if (!won) {
      const current = readApproval(db, id);
      if (current === null) throw new Error(`approval ${id} vanished while being decided`);
      // Changed nothing, and so settles nothing: a losing decision must not
      // void a grant it did not win the right to void.
      return { outcome: "already_decided", approval: current };
    }

    // Same transaction, because "the request is approved" and "its grant is
    // usable" are one fact written twice, and a reader must never see one
    // without the other.
    const grantsActivated = input.decision === "approved" ? activatePendingGrants(db, id, at) : 0;
    const grantsVoided = input.decision === "denied" ? voidPendingGrants(db, id, at) : 0;

    const updated = readApproval(db, id);
    if (updated === null) throw new Error(`approval ${id} vanished while being decided`);
    return { outcome: "recorded", approval: updated, grantsActivated, grantsVoided };
  })();
}

/** How many requests are outstanding. For `/health` and the boot log line. */
export function pendingCount(db: Database): number {
  return (
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'pending'",
      )
      .get()?.n ?? 0
  );
}

function fromRow(row: Row): StoredApproval {
  const record = ApprovalRecord.parse({
    id: row.id,
    requester_id: row.requester_id,
    requester_display_name: row.requester_display_name,
    approver_id: row.approver_id,
    approver_display_name: row.approver_display_name,
    candidate_approver_ids: JSON.parse(row.candidate_approver_ids),
    action: row.action,
    resource_id: row.resource_id,
    amount: row.amount,
    required_clearance: row.required_clearance,
    rule:
      row.rule_id === null ? null : { id: row.rule_id, description: row.rule_description ?? "" },
    justification: row.justification,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    note: row.note,
  });

  return {
    record,
    binding: {
      toolkit: row.match_toolkit,
      tool: row.match_tool,
      resourceInput: row.resource_input,
      amountInput: row.amount_input,
    },
  };
}
