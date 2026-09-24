/**
 * Opens the app's one loan book for a test file that imports a route reaching
 * it (`app/health/route.ts`, `app/api/loans/route.ts`), before that file
 * changes the environment.
 *
 * The loan module is one per process (`lib/loans/instance.ts`), and `bun test`
 * runs every file in one process, so whichever test reaches it first decides
 * its configuration for the rest of the run. Opening it here, in memory, means
 * no test writes a `loans.db` into the repo — which is what happened before
 * this existed (#5): two `/health` tests opened the default `./loans.db`. The
 * sibling of `control-plane-instance.ts`.
 */
import { loanModuleFailure } from "../lib/loans/instance.ts";

export function openTestLoanBook(): void {
  const previous = process.env.LOANS_DB_PATH;
  process.env.LOANS_DB_PATH = ":memory:";
  try {
    const failure = loanModuleFailure();
    if (failure !== null) throw new Error(`the test loan book did not open: ${failure}`);
  } finally {
    if (previous === undefined) delete process.env.LOANS_DB_PATH;
    else process.env.LOANS_DB_PATH = previous;
  }
}
