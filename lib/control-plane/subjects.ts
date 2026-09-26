/**
 * The cast, changed on purpose: the `subjects` writes `bun run users` makes
 * (#31), each with its row in `subject_changes`.
 *
 * Raising somebody's clearance is a governance action in its own right, so
 * every write here commits in one transaction with the record of it: a
 * clearance that changed without a row saying who changed it, and from what,
 * is the one thing a reviewer could not reconstruct later. The table is
 * append-only, enforced by triggers, like `audit_log`.
 *
 * The writes bump `policy_revision` through the triggers every `subjects`
 * write already fires, so a running control plane picks a change up within one
 * policy poll, with no restart.
 *
 * This module knows nothing about loans or people's passwords. Which tools a
 * role can or cannot see is asked of the policy engine, with the tool named by
 * the caller.
 */
import type { Database } from "bun:sqlite";

import { compilePolicy, resolveVisibility, type ToolRef } from "@cg/governance-core";
import { Subject } from "@cg/policy-schema";

import { readPolicy } from "./policy-store.ts";

export type SubjectChangeAction = "add" | "set-role" | "set-clearance" | "remove";

/** One row of `subject_changes`, as it comes back. */
export interface SubjectChange {
  seq: number;
  id: string;
  ts: string;
  actor: string;
  user_id: string;
  action: SubjectChangeAction;
  role_before: string | null;
  role_after: string | null;
  clearance_before: number | null;
  clearance_after: number | null;
}

/** What `addSubject` is given. Everything a `subjects` row holds but `attributes`. */
export interface NewSubject {
  user_id: string;
  display_name: string;
  role: string;
  clearance: number;
}

export class SubjectExistsError extends Error {
  constructor(readonly userId: string) {
    super(`governance.db already has a subject for ${userId}`);
    this.name = "SubjectExistsError";
  }
}

export class NoSuchSubjectError extends Error {
  constructor(readonly userId: string) {
    super(`governance.db has no subject for ${userId}`);
    this.name = "NoSuchSubjectError";
  }
}

/**
 * The key a subject is stored and found under: trimmed and lowercase, the
 * rule `policy-cache.ts::subjectKey` applies on the way out (#58).
 */
export function subjectId(email: string): string {
  return email.trim().toLowerCase();
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** `chg_` and 10 base32 characters, the shape of an audit event id with its own prefix. */
function newChangeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "chg_";
  for (const byte of bytes) out += ID_ALPHABET[byte % 32];
  return out;
}

interface SubjectRow {
  user_id: string;
  display_name: string;
  role: string;
  clearance: number;
  attributes: string;
}

function parseSubject(row: SubjectRow): Subject {
  return Subject.parse({ ...row, attributes: JSON.parse(row.attributes) });
}

export function readSubject(db: Database, email: string): Subject | null {
  const row = db
    .query<SubjectRow, [string]>("SELECT * FROM subjects WHERE user_id = ?")
    .get(subjectId(email));
  return row === null ? null : parseSubject(row);
}

export function listSubjects(db: Database): Subject[] {
  return db.query<SubjectRow, []>("SELECT * FROM subjects ORDER BY user_id").all().map(parseSubject);
}

/** Appends one row and returns it as stored. Callers are inside a transaction. */
function recordChange(
  db: Database,
  change: Omit<SubjectChange, "seq" | "id" | "ts">,
): SubjectChange {
  const row = db
    .query<SubjectChange, Record<string, string | number | null>>(
      `INSERT INTO subject_changes
         (id, ts, actor, user_id, action, role_before, role_after, clearance_before, clearance_after)
       VALUES
         ($id, $ts, $actor, $user_id, $action, $role_before, $role_after, $clearance_before, $clearance_after)
       RETURNING *`,
    )
    .get({
      $id: newChangeId(),
      $ts: new Date().toISOString(),
      $actor: change.actor,
      $user_id: change.user_id,
      $action: change.action,
      $role_before: change.role_before,
      $role_after: change.role_after,
      $clearance_before: change.clearance_before,
      $clearance_after: change.clearance_after,
    });
  if (row === null) throw new Error("subject_changes: the insert returned no row");
  return row;
}

/** Inserts a subject and its `add` row, or neither. Refuses a subject that already exists. */
export function addSubject(db: Database, subject: NewSubject, actor: string): SubjectChange {
  const parsed = Subject.parse({ ...subject, user_id: subjectId(subject.user_id) });
  return db.transaction(() => {
    if (readSubject(db, parsed.user_id) !== null) throw new SubjectExistsError(parsed.user_id);
    db.query(
      `INSERT INTO subjects (user_id, display_name, role, clearance, attributes)
       VALUES ($user_id, $display_name, $role, $clearance, $attributes)`,
    ).run({
      $user_id: parsed.user_id,
      $display_name: parsed.display_name,
      $role: parsed.role,
      $clearance: parsed.clearance,
      $attributes: JSON.stringify(parsed.attributes),
    });
    return recordChange(db, {
      actor,
      user_id: parsed.user_id,
      action: "add",
      role_before: null,
      role_after: parsed.role,
      clearance_before: null,
      clearance_after: parsed.clearance,
    });
  })();
}

/**
 * Changes one subject's role or clearance and records it. `null` when the
 * value is already what was asked for: nothing changed, so nothing is written.
 */
function update(
  db: Database,
  email: string,
  actor: string,
  change: { role: string } | { clearance: number },
): SubjectChange | null {
  return db.transaction(() => {
    const before = readSubject(db, email);
    if (before === null) throw new NoSuchSubjectError(subjectId(email));
    const after = Subject.parse({ ...before, ...change });
    if (after.role === before.role && after.clearance === before.clearance) return null;
    db.query("UPDATE subjects SET role = $role, clearance = $clearance WHERE user_id = $user_id").run({
      $role: after.role,
      $clearance: after.clearance,
      $user_id: before.user_id,
    });
    return recordChange(db, {
      actor,
      user_id: before.user_id,
      action: "role" in change ? "set-role" : "set-clearance",
      role_before: before.role,
      role_after: after.role,
      clearance_before: before.clearance,
      clearance_after: after.clearance,
    });
  })();
}

export function setSubjectRole(db: Database, email: string, role: string, actor: string): SubjectChange | null {
  return update(db, email, actor, { role });
}

export function setSubjectClearance(
  db: Database,
  email: string,
  clearance: number,
  actor: string,
): SubjectChange | null {
  return update(db, email, actor, { clearance });
}

/** Deletes a subject and records it. `null` when there was no subject to delete. */
export function removeSubject(db: Database, email: string, actor: string): SubjectChange | null {
  return db.transaction(() => {
    const before = readSubject(db, email);
    if (before === null) return null;
    db.query("DELETE FROM subjects WHERE user_id = ?").run(before.user_id);
    return recordChange(db, {
      actor,
      user_id: before.user_id,
      action: "remove",
      role_before: before.role,
      role_after: null,
      clearance_before: before.clearance,
      clearance_after: null,
    });
  })();
}

/** Every recorded change, oldest first; one person's when `email` is given. */
export function subjectChanges(db: Database, email?: string): SubjectChange[] {
  return email === undefined
    ? db.query<SubjectChange, []>("SELECT * FROM subject_changes ORDER BY seq").all()
    : db
        .query<SubjectChange, [string]>("SELECT * FROM subject_changes WHERE user_id = ? ORDER BY seq")
        .all(subjectId(email));
}

/**
 * Every role the policy knows: the roles on `subjects` rows, the roles any
 * rule narrows on, and `alsoKnown` (the caller passes the shipped fixture's).
 * Sorted, without repeats.
 *
 * The union, not `subjects` alone: a role is not forgotten because the last
 * person holding it was removed.
 */
export function knownRoles(db: Database, alsoKnown: readonly string[] = []): string[] {
  const { subjects, rules, output_rules } = readPolicy(db);
  const roles = new Set<string>(alsoKnown);
  for (const subject of subjects) roles.add(subject.role);
  for (const rule of [...rules, ...output_rules]) {
    for (const role of rule.subjects?.roles ?? []) roles.add(role);
  }
  return [...roles].sort();
}

/**
 * Whether `/access` would hide `tool` from this subject, asked of the policy
 * engine against the policy on disk, exactly as the hook would answer it.
 */
export function hiddenFrom(db: Database, subject: NewSubject, tool: ToolRef): boolean {
  const { catalogue, rules } = readPolicy(db);
  const policy = compilePolicy({ catalogue, rules });
  const candidate = Subject.parse({ ...subject, user_id: subjectId(subject.user_id) });
  const [visibility] = resolveVisibility(candidate, [tool], policy);
  return visibility!.decision.effect === "deny";
}
