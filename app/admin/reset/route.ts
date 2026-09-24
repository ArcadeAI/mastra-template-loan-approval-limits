/**
 * `POST /admin/reset` — put the policy (or the whole demo) back to the fixture; 404 when `RESET_TOKEN` is unset.
 *
 * Served by the control-plane module (`lib/control-plane/`), in-process, since
 * #4 folded `apps/hooks` into the app. The path is the one the service had.
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
