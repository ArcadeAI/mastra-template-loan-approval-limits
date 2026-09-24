/**
 * The app's one control plane, per process (#4).
 *
 * Every control-plane route under `app/` and the app's `/health` reach it
 * through here. It lives on `globalThis` rather than in a module-level `let`
 * because Next does not promise one module instance per process: route bundles
 * and `instrumentation.ts` can each evaluate this file, and two instances would
 * be two `governance.db` handles, two policy caches and — the one that would
 * not crash — two event buses, so a `/pre` decision would be recorded and never
 * reach the panel's `GET /events`.
 *
 * `instrumentation.ts` calls `controlPlane()` when the server starts, so the
 * policy is warm before the first hook arrives. The lazy path below is the
 * backstop, not the plan.
 */
import { bootControlPlane, type BootedControlPlane } from "./index.ts";

const KEY = Symbol.for("cg.control-plane");

/** The boot, or why it did not happen. Recorded once; a restart retries. */
type Boot = { ok: true; booted: BootedControlPlane } | { ok: false; error: string };

type Holder = { [KEY]?: Boot };

/**
 * A control plane that did not boot. Thrown by `bootedControlPlane`, so a
 * caller that forgets to handle it fails loudly rather than governing nothing.
 */
export class ControlPlaneUnavailable extends Error {
  override name = "ControlPlaneUnavailable";
}

function boot(): Boot {
  const holder = globalThis as Holder;
  if (holder[KEY] === undefined) {
    try {
      holder[KEY] = { ok: true, booted: bootControlPlane() };
    } catch (cause) {
      // Kept, not retried per request: a refused configuration (a production
      // deployment with no ARCADE_HOOK_SIGNING_SECRET, an address nothing can
      // reach) does not fix itself, and re-running the boot would reopen
      // `governance.db` on every call. `cg-hooks` refused to start in this
      // case; the app cannot, because the same process serves sign-in and the
      // bank, so it stays up, refuses every hook, and `/health` says why.
      const error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      console.error(`[hooks] THE CONTROL PLANE DID NOT BOOT: ${error}`);
      holder[KEY] = { ok: false, error };
    }
  }
  return holder[KEY];
}

/** Why the control plane is not running, or `null` when it is. */
export function controlPlaneFailure(): string | null {
  const booted = boot();
  return booted.ok ? null : booted.error;
}

/** The booted control plane, booting it on the first call in this process. */
export function bootedControlPlane(): BootedControlPlane {
  const booted = boot();
  if (!booted.ok) throw new ControlPlaneUnavailable(booted.error);
  return booted.booted;
}

export function controlPlane(): BootedControlPlane["plane"] {
  return bootedControlPlane().plane;
}

/**
 * What each control-plane route exports for every method: the module decides.
 *
 * A control plane that did not boot answers **503** on every route. For the
 * three hooks that is a refusal: Arcade's `failure_mode: fail_closed` (#13)
 * turns a 5xx into a denial of every tool the call was about, which is the
 * same answer `cg-hooks` being down produced.
 */
export function serve(request: Request): Promise<Response> {
  const booted = boot();
  if (!booted.ok) {
    return Promise.resolve(
      Response.json(
        { error: `The control plane did not boot, so it refuses every call: ${booted.error}`, code: "CHECK_FAILED" },
        { status: 503 },
      ),
    );
  }
  return booted.booted.plane.fetch(request);
}
