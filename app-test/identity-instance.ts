/**
 * Opens the app's one identity provider for a test file that imports a route
 * reaching it (`app/health/route.ts`), before that file changes the
 * environment.
 *
 * The provider is one per process (`lib/identity/provider/instance.ts`), and
 * `bun test` runs every file in one process, so whichever test reaches it
 * first decides its configuration for the rest of the run. Opening it here, in
 * memory, means no test writes an `idp.db` into the repo, and a test that sets
 * `NODE_ENV=production` to check the identity surface does not also boot a
 * provider that refuses to run without `BETTER_AUTH_SECRET` — which would then
 * read every browser as signed out for every file after it (#6). The sibling
 * of `loan-module-instance.ts` and `control-plane-instance.ts`.
 */
import { identityProviderFailure } from "../lib/identity/provider/instance.ts";

export async function openTestIdentity(): Promise<void> {
  const previous = process.env.IDP_DB_PATH;
  process.env.IDP_DB_PATH = ":memory:";
  try {
    const failure = await identityProviderFailure();
    if (failure !== null) throw new Error(`the test identity provider did not open: ${failure}`);
  } finally {
    if (previous === undefined) delete process.env.IDP_DB_PATH;
    else process.env.IDP_DB_PATH = previous;
  }
}
