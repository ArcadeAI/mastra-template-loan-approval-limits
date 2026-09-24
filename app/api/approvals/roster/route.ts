/**
 * `GET /api/approvals/roster` — every subject, so routing can show who was not asked.
 *
 * The approvals store, served by the control-plane module (`lib/control-plane/`)
 * in-process since #4, behind the `APPROVALS_STORE_TOKEN` bearer. Under
 * `/api/approvals` because the app's `/approvals/{id}` is the approval page;
 * the service served it at `/approvals/…`. The contract is in
 * `tools/approvals/README.md`.
 */
import { serve } from "../../../../lib/control-plane/instance.ts";

export const dynamic = "force-dynamic";

// Every method goes to the control plane, which answers the ones it does not
// serve with the same JSON 405 it always has (#4).
export const GET = serve;
export const POST = serve;
export const PUT = serve;
export const PATCH = serve;
export const DELETE = serve;
export const OPTIONS = serve;
