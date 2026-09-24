/**
 * Runs once when the app's server starts (Next's instrumentation hook).
 *
 * It boots the control plane (#4): the policy is loaded into memory, a stale
 * policy is recovered and the boot lines are printed before the first request,
 * which is the order `apps/hooks` kept when it was a service — Arcade's first
 * `/access` may be the 1.6 MB one, and it should meet a warm cache. A
 * configuration the control plane refuses is reported here, loudly, and then
 * on `/health` and in every hook's 503 (`lib/control-plane/instance.ts`).
 *
 * It opens the loan book (#5): `loans.db` is seeded from the fixture when it is
 * empty, inside one transaction with the schema, before the first request. A
 * loan book that will not open — a fixture that does not parse, a seed that
 * fails, a disk written by a newer build — is reported here, loudly, and then
 * on `/health` and in every `/bank/…` route's 503 (`lib/loans/instance.ts`).
 * It never comes up empty.
 *
 * It boots the identity module (#6): `idp.db` is opened (seeded from the
 * fixture when it is empty), Better Auth is built over it, the replay guard is
 * installed and the OAuth clients are reconciled, before the first request. A
 * provider that will not boot — `BETTER_AUTH_SECRET` unset in production, a
 * disk written by another schema — is reported here, loudly, and then on
 * `/health` and in every identity route's 503, and every browser reads as
 * signed out until it does (`lib/identity/provider/instance.ts`).
 *
 * Only in the server runtime: the control plane, the loan module and the
 * identity module open `governance.db`, `loans.db` and `idp.db` with
 * `bun:sqlite`, which is why the app runs on Bun (`scripts/next.ts`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // First, so no request is served before a closed client can be noticed.
  // See the file for the Bun behaviour it corrects.
  const { installResponseClose } = await import("./lib/runtime/response-close.ts");
  installResponseClose();
  const { controlPlaneFailure } = await import("./lib/control-plane/instance.ts");
  controlPlaneFailure();
  const { loanModuleFailure } = await import("./lib/loans/instance.ts");
  loanModuleFailure();
  const { identityProviderFailure } = await import("./lib/identity/provider/instance.ts");
  await identityProviderFailure();
}
