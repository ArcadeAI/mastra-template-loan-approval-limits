/**
 * The app's one loan book, per process (#5).
 *
 * The routes under `app/bank/`, the bank's own screens and the app's `/health`
 * reach the loan module through here. It lives on `globalThis` rather than in
 * a module-level `let` because Next does not promise one module instance per
 * process: route bundles and `instrumentation.ts` can each evaluate this file,
 * and two instances would be two `loans.db` handles and two actor caches.
 *
 * `instrumentation.ts` opens it when the server starts, so a loan book that
 * cannot open — a fixture that does not parse, a seed that fails, a disk
 * written by a newer build, an identity address nothing can reach — says so on
 * the first lines the server prints rather than on the first request. The lazy
 * path below is the backstop, not the plan.
 *
 * Configured by the environment, exactly as the service was:
 * `LOANS_DB_PATH` (default `./loans.db`, in the directory the app runs from),
 * `IDENTITY_HOST` and `RESET_TOKEN`.
 *
 * `IDENTITY_HOST` is where bearers are validated, at `/oauth2/userinfo`. It
 * was the identity provider's public host until #6 folded the provider into
 * the app; now it is **local**, and unset it is the app's own listener,
 * `localhost:$PORT`, the same rule as `CONTROL_PLANE_HOST`. A validation is a
 * server-side read of the app's own module, and it must not leave the machine
 * through `APP_PUBLIC_HOST`'s tunnel (#4's finding, criterion 7 on #6). Over
 * HTTP rather than in-process on purpose: the loan module imports nothing
 * from the app, and its boundary test says so.
 */
import { openLoanBook } from "./db.ts";
import { publicHost } from "./public-host.ts";
import { createLoanModule, mountedFetch, SERVICE, type LoanModule } from "./server.ts";

const KEY = Symbol.for("cg.loan-module");

/** The open, or why it did not happen. Recorded once; a restart retries. */
type Opened = { ok: true; module: LoanModule; dbPath: string } | { ok: false; error: string };

type Holder = { [KEY]?: Opened };

/**
 * A loan book that did not open. Thrown by {@link loanModule}, so a caller
 * that forgets to handle it fails loudly rather than showing an empty bank.
 */
export class LoanBookUnavailable extends Error {
  override name = "LoanBookUnavailable";
}

/** What the environment says, read the way `scripts/loans.ts` reads it. */
export function loanModuleConfig(env: Record<string, string | undefined> = process.env) {
  return {
    dbPath: env.LOANS_DB_PATH?.trim() || "./loans.db",
    resetToken: env.RESET_TOKEN?.trim() ?? "",
    idpHost: publicHost("IDENTITY_HOST", env.IDENTITY_HOST, `localhost:${env.PORT?.trim() || "3000"}`),
  };
}

function open(): Opened {
  const holder = globalThis as Holder;
  if (holder[KEY] === undefined) {
    try {
      const { dbPath, resetToken, idpHost } = loanModuleConfig();
      const db = openLoanBook(dbPath);
      holder[KEY] = { ok: true, module: createLoanModule({ db, idpHost, resetToken }), dbPath };
      const loans = holder[KEY].module.health().loans;
      console.log(`[${SERVICE}] ${loans} loans in ${dbPath}, tokens validated against ${idpHost}`);
    } catch (cause) {
      // Kept, not retried per request: a fixture that does not parse or a seed
      // that fails does not fix itself, and the seed runs inside one
      // transaction with the schema, so the file is left with no tables and
      // the next boot tries again from nothing. `cg-loan-app` refused to start
      // in this case; the app cannot, because the same process serves sign-in
      // and the chat, so it stays up, answers 503 on every loan route, and
      // `/health` says why. What it never does is come up with zero rows.
      const error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      console.error(`[${SERVICE}] THE LOAN BOOK DID NOT OPEN: ${error}`);
      holder[KEY] = { ok: false, error };
    }
  }
  return holder[KEY];
}

/**
 * Close the loan book and forget it, so the next call opens it again from the
 * environment. For tests, which share one process across files and each point
 * `LOANS_DB_PATH` at a throwaway file of their own; nothing in the app calls it.
 */
export function closeLoanModule(): void {
  const holder = globalThis as Holder;
  const opened = holder[KEY];
  if (opened?.ok) opened.module.db.close();
  delete holder[KEY];
}

/** Why the loan book is not open, or `null` when it is. */
export function loanModuleFailure(): string | null {
  const opened = open();
  return opened.ok ? null : opened.error;
}

/** The open loan module, opening it on the first call in this process. */
export function loanModule(): LoanModule {
  const opened = open();
  if (!opened.ok) throw new LoanBookUnavailable(opened.error);
  return opened.module;
}

/**
 * What the app's `/health` says about the loan book: the count, or the reason
 * there is none. Never a bare number, because `0` would read the same whether
 * the book is empty or the database never opened.
 */
export function loanBookHealth():
  | { status: "ok"; count: number }
  | { status: "failed"; count: null; error: string } {
  const opened = open();
  if (!opened.ok) return { status: "failed", count: null, error: opened.error };
  return { status: "ok", count: opened.module.health().loans };
}

/**
 * What `app/bank/[...path]/route.ts` exports for every method: the module
 * decides, handed the path within the mount by `mountedFetch`.
 */
export function serve(request: Request): Promise<Response> {
  const opened = open();
  if (!opened.ok) {
    return Promise.resolve(
      Response.json(
        { error: `The loan book did not open, so no loan route can answer: ${opened.error}` },
        { status: 503 },
      ),
    );
  }
  return mountedFetch(opened.module.fetch)(request);
}
