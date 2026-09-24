/**
 * `/.well-known/…`: OIDC discovery.
 *
 * `openid-configuration`, which an Arcade User Source reads and which must carry a `jwks_uri` (#65).
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
