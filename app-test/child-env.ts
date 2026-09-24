/**
 * The environment a process spawned by a test gets: an **allowlist**, never the
 * parent's minus the variables somebody thought of.
 *
 * `.orca/project.md` has the measurement behind it (#5): a stub that inherited
 * a host variable from an exported `.env.local` listened on the wrong port and
 * failed a review. With the identity provider in the app since #6 the list of
 * variables that change what a child does is longer again — `APP_PUBLIC_HOST`,
 * `IDENTITY_HOST`, every `*_DB_PATH`, `BETTER_AUTH_SECRET` — so a child gets
 * what it needs to run at all, and everything else from the test that spawns
 * it, by name.
 */
const KEEP = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "LC_ALL", "SHELL", "CG_CHROME_BIN"] as const;

export function childEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of KEEP) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...extra };
}
