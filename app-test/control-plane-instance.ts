/**
 * Boots the app's one control plane for a test file that imports a route
 * reaching it (`app/health/route.ts`), before that file changes the
 * environment.
 *
 * The control plane is one per process (`lib/control-plane/instance.ts`), and
 * `bun test` runs every file in one process, so whichever test reaches it
 * first decides its configuration for the rest of the run. Booting it here,
 * in memory, means a test that sets `NODE_ENV=production` to check the
 * identity surface does not also boot a control plane that refuses to run,
 * and no test writes a `governance.db` into the repo.
 */
import { controlPlaneFailure } from "../lib/control-plane/instance.ts";

export function bootTestControlPlane(): void {
  const previous = process.env.GOVERNANCE_DB_PATH;
  process.env.GOVERNANCE_DB_PATH = ":memory:";
  try {
    const failure = controlPlaneFailure();
    if (failure !== null) throw new Error(`the test control plane did not boot: ${failure}`);
  } finally {
    if (previous === undefined) delete process.env.GOVERNANCE_DB_PATH;
    else process.env.GOVERNANCE_DB_PATH = previous;
  }
}
