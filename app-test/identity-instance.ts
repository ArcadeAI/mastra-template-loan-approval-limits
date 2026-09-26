/**
 * Opens the app's one identity provider for a test file that imports a route
 * reaching it (`app/health/route.ts`), before that file changes the
 * environment.
 *
 * The provider is one per process (`lib/identity/provider/instance.ts`), and
 * `bun test` runs every file in one process, so whichever test reaches it
 * first decides its configuration for the rest of the run. Opening it here, on
 * a scratch file outside the repo, means no test writes an `idp.db` into it, and a test that sets
 * `NODE_ENV=production` to check the identity surface does not also boot a
 * provider that refuses to run without `BETTER_AUTH_SECRET` — which would then
 * read every browser as signed out for every file after it (#6). The sibling
 * of `loan-module-instance.ts` and `control-plane-instance.ts`.
 *
 * A scratch file rather than `:memory:` since #33: nothing is seeded at first
 * boot any more, and a provider with nobody in it reports `no_users`. The demo
 * cast is written into the file first (`demo-cast.ts`), so the app these tests
 * read is one somebody has added people to, as `control-plane-instance.ts`
 * does for the other half.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { identityProviderFailure } from "../lib/identity/provider/instance.ts";
import { seedDemoIdentity } from "./demo-cast.ts";

export async function openTestIdentity(): Promise<void> {
  const previous = process.env.IDP_DB_PATH;
  const scratch = mkdtempSync(join(tmpdir(), "cg-test-identity-"));
  process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
  const path = join(scratch, "idp.db");
  await seedDemoIdentity(path);
  process.env.IDP_DB_PATH = path;
  try {
    const failure = await identityProviderFailure();
    if (failure !== null) throw new Error(`the test identity provider did not open: ${failure}`);
  } finally {
    if (previous === undefined) delete process.env.IDP_DB_PATH;
    else process.env.IDP_DB_PATH = previous;
  }
}
