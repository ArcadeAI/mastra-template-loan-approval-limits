/**
 * `GET /hooks/health`: the hook contract's health check (`healthCheck`), in Arcade's own vocabulary: `status` is `healthy`, `degraded` or `unhealthy`. The app's own readiness is `/health`, a different endpoint.
 *
 * Served by the control-plane module (`lib/control-plane/`), in-process, since
 * #4 folded `apps/hooks` into the app. Under `/hooks` by the human's decision
 * on #4. The service served it at `/health`, and `mountedFetch` hands the module
 * that path.
 */
import { serve } from "../../../lib/control-plane/instance.ts";

export const dynamic = "force-dynamic";

// Every method goes to the control plane, which answers the ones it does not
// serve with the same JSON 405 it always has (#4).
export const GET = serve;
export const POST = serve;
export const PUT = serve;
export const PATCH = serve;
export const DELETE = serve;
export const OPTIONS = serve;
