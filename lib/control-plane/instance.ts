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

type Holder = { [KEY]?: BootedControlPlane };

/** The booted control plane, booting it on the first call in this process. */
export function bootedControlPlane(): BootedControlPlane {
  const holder = globalThis as Holder;
  return (holder[KEY] ??= bootControlPlane());
}

export function controlPlane(): BootedControlPlane["plane"] {
  return bootedControlPlane().plane;
}

/** What each control-plane route exports for every method: the module decides. */
export function serve(request: Request): Promise<Response> {
  return controlPlane().fetch(request);
}
