/**
 * Email → the person, for display only.
 *
 * The sign-in panel's buttons carry no email on purpose (`personas.ts`): the
 * identity on the session is the one the identity module asserted, never the
 * one a browser picked. This module runs in the opposite direction — it takes
 * an address that is *already* on the sealed session and finds the name, role
 * and authority to put next to it.
 *
 * That direction is what makes it safe, and it is the only direction offered.
 * There is no `emailFor(persona)` here, because a caller holding one would be
 * one refactor away from signing somebody in as a persona the browser named.
 *
 * ## The cast comes from the database
 *
 * `governance.db`'s `subjects` table, read through the control plane's own
 * `GET /api/approvals/roster` — the same read the approval page makes, at
 * `CONTROL_PLANE_HOST` and never at the public host. Until #32 this was a
 * static list of four personas joined on the `PERSONA_*` variables, so a user
 * added with `bun run users` had a role and a clearance the hooks enforced and
 * a card that said nobody was there. Now the name, the role and the clearance
 * on screen are the row `/hooks/pre` decides on, including a clearance raised
 * live.
 *
 * ## An unknown address is said out loud
 *
 * `unknown`, and the card says the control plane has no subject at this
 * address. The alternative — falling back to the first persona, or showing a
 * blank authority — would put a role and a dollar figure next to a person the
 * control plane knows nothing about, on a screen whose whole job is to say who
 * the agent is acting as. A label that can be wrong is worse than a label that
 * is missing. And a roster that could not be read is `unavailable`, never
 * `unknown`: "we could not ask" and "they are not there" are different facts.
 */
import { readRoster, type RosterEntry } from "../approvals-store.ts";
import { readWebConfig, type WebConfig } from "../config.ts";
import { ROLE_LABELS } from "./personas.ts";

/** A subject as a person reads it. */
export interface RosterPerson {
  /** `subjects.user_id`, lowercase — the join key. */
  email: string;
  /** `subjects.display_name`. */
  name: string;
  /** For a human to read. `roleKey` is what the policy matches on. */
  role: string;
  /** `subjects.role`. */
  roleKey: string;
  /** `subjects.clearance`, US dollars, as the control plane holds it now. */
  clearance: number;
}

export type PersonLookup =
  | { status: "signed-out" }
  | { status: "found"; person: RosterPerson }
  | { status: "unknown" }
  | { status: "unavailable"; reason: string };

/**
 * `loan_officer` → `Loan Officer`. The demo cast's roles read the way
 * `DESIGN.md` → Cast writes them; any other role is its key, title-cased, so a
 * role a forker adds still reads as words rather than as a column value.
 */
export function roleLabel(roleKey: string): string {
  return (
    ROLE_LABELS[roleKey] ??
    roleKey
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join(" ")
  );
}

function asPerson(entry: RosterEntry): RosterPerson {
  return {
    email: entry.user_id.trim().toLowerCase(),
    name: entry.display_name,
    role: roleLabel(entry.role),
    roleKey: entry.role,
    clearance: entry.clearance,
  };
}

/**
 * The subject at this address, or `null`. Matched case-insensitively, by the
 * same rule the control plane's `findSubject` applies (#58).
 */
export function personIn(subjects: readonly RosterEntry[], email: string | null | undefined): RosterPerson | null {
  const address = email?.trim().toLowerCase();
  if (!address) return null;
  const entry = subjects.find((subject) => subject.user_id.trim().toLowerCase() === address);
  return entry ? asPerson(entry) : null;
}

type RosterConfig = Pick<WebConfig, "controlPlaneHost" | "approvalsStoreToken">;

/**
 * The roster, or why not. The configuration is read here rather than as a
 * default argument, so a deployment that cannot say where its control plane is
 * gets a card that says so instead of a page that throws.
 */
async function read(config: RosterConfig | undefined) {
  try {
    return await readRoster(config ?? readWebConfig());
  } catch (cause) {
    return { ok: false as const, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** The signed-in person, read from the control plane. */
export async function lookupPerson(
  email: string | null | undefined,
  config?: RosterConfig,
): Promise<PersonLookup> {
  if (!email?.trim()) return { status: "signed-out" };
  const roster = await read(config);
  if (!roster.ok) return { status: "unavailable", reason: roster.reason };
  const person = personIn(roster.subjects, email);
  return person ? { status: "found", person } : { status: "unknown" };
}

/**
 * Address → display name, for labelling decisions (`decided_by_name`). One
 * roster read, however many addresses are then looked up. A roster that could
 * not be read names nobody, and the caller falls back to the address, which is
 * always true.
 */
export async function rosterNames(
  config?: RosterConfig,
): Promise<(email: string | null | undefined) => string | null> {
  const roster = await read(config);
  const subjects = roster.ok ? roster.subjects : [];
  return (email) => personIn(subjects, email)?.name ?? null;
}

/** `50000` → `$50,000`; `0` → `$0`. What the card puts next to a role. */
export function formatAuthority(clearance: number): string {
  return `$${clearance.toLocaleString("en-US")}`;
}
