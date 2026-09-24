/**
 * `/identity/…`: the identity module's own two routes.
 *
 * `GET /identity/health` and `POST /identity/admin/reset` — what `apps/idp` served at `/health` and `/admin/reset`. The app's `/health` is the app's, so these moved under a prefix of their own, as the control plane's are under `/hooks` and the loan module's under `/bank`.
 *
 * Served by the identity module (`lib/identity/provider/`), in-process, since
 * #6 folded `apps/idp` into the app. Every method goes to the provider, which
 * answers what it does not serve itself; when it did not boot, every one of
 * them is a 503 naming why (`instance.ts`).
 */
import { serve } from "../../../lib/identity/provider/instance.ts";

export const dynamic = "force-dynamic";

export const GET = serve;
export const POST = serve;
export const OPTIONS = serve;
