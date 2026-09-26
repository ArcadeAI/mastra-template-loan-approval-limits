/**
 * Whether everybody who can sign in has a subject, and everybody with a
 * subject can sign in (#33).
 *
 * A user is two rows in two databases, joined on the lowercase email: a
 * Better Auth account in `idp.db`, which lets them sign in, and a `subjects`
 * row in `governance.db`, which the hooks decide on. `bun run users` writes
 * both or neither. Since #33 nothing seeds either side, so the only way the
 * two can disagree is somebody deleting one half by hand, or a disk deleted
 * and brought back on one side only (`idp.db` recreated after a
 * `BETTER_AUTH_SECRET` rotation, say). Both halves of the disagreement fail
 * quietly:
 *
 *   - **an identity with no subject** signs in, and every hook denies them
 *     with "an administrator must register the identity". The chat looks
 *     broken rather than governed.
 *   - **a subject with no identity** is on the roster that approval routing
 *     picks from, so a $95K request can be routed to somebody who cannot sign
 *     in to approve it. Nothing refuses, nothing is logged, and the request
 *     waits forever.
 *
 * So the difference is named on `/health`, with each address, the way
 * `fixture_drift` names a policy row. It is a different comparison from
 * `fixture_drift` (disk against the shipped fixture, inside the control plane)
 * and lives here, in the app, because it is the one place that holds both
 * modules: neither module opens the other's file.
 */

/** What differs, by address. `null` from {@link compareUsers} means nothing does. */
export interface UserDrift {
  /** Every address named below, qualified with which half is missing, sorted. */
  readonly ids: string[];
  /** In `idp.db`, not in `subjects`: can sign in, and is denied at every hook. */
  readonly identity_without_subject: string[];
  /** In `subjects`, not in `idp.db`: cannot sign in, and can still be routed an approval. */
  readonly subject_without_identity: string[];
}

export function compareUsers(identities: readonly string[], subjects: readonly string[]): UserDrift | null {
  const people = new Set(identities.map((email) => email.trim().toLowerCase()));
  const roster = new Set(subjects.map((email) => email.trim().toLowerCase()));
  const identity_without_subject = [...people].filter((email) => !roster.has(email)).sort();
  const subject_without_identity = [...roster].filter((email) => !people.has(email)).sort();
  if (identity_without_subject.length === 0 && subject_without_identity.length === 0) return null;
  return {
    ids: [
      ...identity_without_subject.map((email) => `identity-without-subject:${email}`),
      ...subject_without_identity.map((email) => `subject-without-identity:${email}`),
    ].sort(),
    identity_without_subject,
    subject_without_identity,
  };
}

/** The sentence `/health` says, which names each address and the fix. */
export function userDriftWarning(drift: UserDrift): string {
  const parts = [
    ...(drift.identity_without_subject.length === 0
      ? []
      : [
          `${drift.identity_without_subject.join(", ")} can sign in but ha${drift.identity_without_subject.length === 1 ? "s" : "ve"} ` +
            `no subject in governance.db, so every hook denies them`,
        ]),
    ...(drift.subject_without_identity.length === 0
      ? []
      : [
          `${drift.subject_without_identity.join(", ")} ha${drift.subject_without_identity.length === 1 ? "s" : "ve"} a subject ` +
            `but no identity in idp.db, so they cannot sign in, and approval routing can still pick them`,
        ]),
  ];
  return (
    `the users in idp.db and governance.db disagree: ${parts.join("; ")}. ` +
    "`bun run users list` shows both halves; `bun run users remove <email>` and `bun run users add` put a user back together."
  );
}
