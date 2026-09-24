/**
 * `/bank/…`: the loan module's HTTP API, the bank's system of record.
 *
 * Served by the loan module (`lib/loans/`), in-process, since #5 folded
 * `apps/loan-app` into the app. Under `/bank` because the board page is
 * `/loans`: the service served `/loans`, `/loans/:loan_id`,
 * `/loans/:loan_id/approve`, `/loans/:loan_id/deny`, `/health` and
 * `/admin/reset` at its root, and `mountedFetch` hands the module that path.
 * This is what `tools/loan` calls.
 */
import { serve } from "../../../lib/loans/instance.ts";

export const dynamic = "force-dynamic";

// Every method goes to the loan module, which answers the ones it does not
// serve with the same JSON 405 it always has.
export const GET = serve;
export const POST = serve;
export const PUT = serve;
export const PATCH = serve;
export const DELETE = serve;
export const OPTIONS = serve;
