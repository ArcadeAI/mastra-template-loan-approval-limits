/**
 * Boots the app's one control plane for a test file that imports a route
 * reaching it (`app/health/route.ts`), before that file changes the
 * environment.
 *
 * The control plane is one per process (`lib/control-plane/instance.ts`), and
 * `bun test` runs every file in one process, so whichever test reaches it
 * first decides its configuration for the rest of the run. Booting it here,
 * on a scratch file outside the repo, means a test that sets `NODE_ENV=production` to check the
 * identity surface does not also boot a control plane that refuses to run,
 * and no test writes a `governance.db` into the repo.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { controlPlaneFailure } from "../lib/control-plane/instance.ts";
import { seedDemoGovernance } from "./demo-cast.ts";

/**
 * A scratch file rather than `:memory:` since #33, with the demo cast's
 * subjects written in first: a first boot seeds nobody, and `/health` holds the
 * control plane's subjects against `identity-instance.ts`'s people, which
 * carries the same cast.
 */
export function bootTestControlPlane(): void {
  const previous = process.env.GOVERNANCE_DB_PATH;
  const scratch = mkdtempSync(join(tmpdir(), "cg-test-control-plane-"));
  process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
  const path = join(scratch, "governance.db");
  seedDemoGovernance(path, {
    loanToolkit: process.env.ARCADE_LOAN_TOOLKIT?.trim() || "Loan",
    approvalsToolkit: process.env.ARCADE_APPROVALS_TOOLKIT?.trim() || "Approvals",
  });
  process.env.GOVERNANCE_DB_PATH = path;
  try {
    const failure = controlPlaneFailure();
    if (failure !== null) throw new Error(`the test control plane did not boot: ${failure}`);
  } finally {
    if (previous === undefined) delete process.env.GOVERNANCE_DB_PATH;
    else process.env.GOVERNANCE_DB_PATH = previous;
  }
}
