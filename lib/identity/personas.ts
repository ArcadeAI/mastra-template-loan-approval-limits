/**
 * The four buttons on the sign-in panel, and the role and authority each of
 * them carries.
 *
 * **No emails and no passwords.** That is the point of #82's slice: the persona
 * a button names is a request to start a sign-in, and the identity that comes
 * back is whatever `apps/idp` asserts about whoever typed a password. If this
 * list carried emails, the temptation would be to trust one, and
 * `context.user_id` would become a value the browser chose. The addresses live
 * in the shared role email contract and are read in `roster.ts`, which resolves a label
 * *from* an email the IdP already asserted and never the other way round.
 *
 * The cast is `DESIGN.md`'s. It is a demo fixture in the same category as the
 * IdP itself: a forker deletes both and points at their own directory.
 *
 * ## Not the roster
 *
 * Since #32 nothing on screen reads a name, a role or a clearance from this
 * list. The card beside a signed-in person reads `governance.db`'s `subjects`
 * row through the control plane (`roster.ts`), because a user added with
 * `bun run users` is not in this list and a clearance raised live is not in it
 * either. What stays here is the sign-in hint's key and the words each demo
 * role reads as, `ROLE_LABELS`.
 *
 * The figures are still the fixture's, and `app-test/persona-roster.test.ts`
 * still reads `lib/control-plane/fixtures/governance.json` and fails if the
 * two ever disagree, so the cast written down here is the cast that seeds.
 */
export interface PersonaButton {
  /** The key the sign-in route echoes back as a label. Never an identity. */
  key: string;
  name: string;
  /** For a human to read. `roleKey` is what the policy matches on. */
  role: string;
  /** `subjects.role` in `governance.db` — what `access.analysts-cannot-see-approve` matches. */
  roleKey: string;
  /** `subjects.clearance`, US dollars, as the fixture seeds it. */
  clearance: number;
}

export const PERSONAS: readonly PersonaButton[] = [
  { key: "dana", name: "Alice", role: "Loan Officer", roleKey: "loan_officer", clearance: 50_000 },
  { key: "sam", name: "Bob", role: "Credit Analyst", roleKey: "credit_analyst", clearance: 0 },
  { key: "riley", name: "Charlie", role: "VP Credit", roleKey: "vp_credit", clearance: 250_000 },
  {
    key: "morgan",
    name: "Michael",
    role: "Chief Credit Officer",
    roleKey: "chief_credit_officer",
    clearance: 5_000_000,
  },
] as const;

/**
 * `subjects.role` → the words a person reads, for the demo cast's roles.
 * `roster.ts` title-cases any role not listed here.
 */
export const ROLE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  PERSONAS.map((persona) => [persona.roleKey, persona.role]),
);

/** A persona key the roster knows, or `undefined`. An unknown key is dropped, never echoed. */
export function knownPersona(key: string | null | undefined): string | undefined {
  return PERSONAS.find((persona) => persona.key === key?.trim().toLowerCase())?.key;
}
