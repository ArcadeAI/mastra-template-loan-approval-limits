/**
 * Adapter. The handler is `lib/identity/handlers.ts`, a plain
 * `(Request) => Promise<Response>` that the test suite mounts behind a real
 * server — see the note at the top of that file.
 *
 * Wrapped rather than re-exported: Next calls a route handler with a second
 * argument (`{ params }`), and the handler's second parameter is its
 * `WebConfig`. Aliasing the export would hand it a route context in place of
 * the configuration, and the failure would be a service that reads every
 * identity variable as `undefined` at runtime and nowhere else.
 */
import { gatewayStart } from "../../../../lib/identity/handlers.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return gatewayStart(request);
}
