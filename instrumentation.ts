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
 * Only in the server runtime: the control plane opens `governance.db` with
 * `bun:sqlite`, which is why the app runs on Bun (`scripts/next.ts`).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { controlPlaneFailure } = await import("./lib/control-plane/instance.ts");
  controlPlaneFailure();
}
