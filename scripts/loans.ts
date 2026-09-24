/**
 * The app's loan module on a port of its own.
 *
 * Not a service: the app serves `/bank/…` itself, in-process, since #5. This
 * runner exists for the test harnesses under `app-test/` and `test/`, for
 * `tools/loan`'s tests, and for anyone who wants the loan API on a socket
 * without booting Next. It opens the loan book the way the app does and puts
 * the same request handler behind `Bun.serve`. There is one implementation of
 * every route, and this is the second way to reach it.
 *
 * Laid out exactly as the app lays it out (`mountedFetch`): everything under
 * `/bank/…`, nothing at the root. So a consumer pointed at this runner and one
 * pointed at the app use the same paths.
 *
 * It binds `PORT` (`0` for whatever the OS gives) and prints
 * `listening on :<port>` on its boot line, which is how the harnesses learn the
 * port — never a literal and never a guess.
 *
 * Unlike the app, it refuses to start when the loan book will not open: there
 * is nothing else in this process to keep serving. An `IDENTITY_HOST`
 * nothing can reach exits 78 (sysexits' EX_CONFIG) before the database is
 * opened and before the port is bound, the way `cg-loan-app` always did.
 */
import { openLoanBook } from "../lib/loans/db.ts";
import { loanModuleConfig } from "../lib/loans/instance.ts";
import { orExitConfig } from "../lib/loans/public-host.ts";
import { createLoanModule, MOUNT, mountedFetch, SERVICE } from "../lib/loans/server.ts";
import { RESET_PATH } from "../lib/loans/reset.ts";

const { dbPath, resetToken, idpHost } = orExitConfig(SERVICE, () => loanModuleConfig());

const loans = createLoanModule({ db: openLoanBook(dbPath), idpHost, resetToken });

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8082),
  idleTimeout: 60,
  fetch: mountedFetch(loans.fetch),
});

console.log(
  `[${SERVICE}] listening on :${server.port} — ${loans.health().loans} loans in ${dbPath}, ` +
    `tokens validated against ${idpHost}, served under ${MOUNT}`,
);
console.log(
  resetToken.length > 0
    ? `[${SERVICE}] POST ${MOUNT}${RESET_PATH} is enabled (bearer RESET_TOKEN)`
    : `[${SERVICE}] POST ${MOUNT}${RESET_PATH} is disabled: RESET_TOKEN is unset, so the route answers 404`,
);
