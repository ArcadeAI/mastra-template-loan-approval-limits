/**
 * The app's control-plane module on a port of its own.
 *
 * Not a service: the app serves `/access`, `/pre`, `/post` and the rest itself,
 * in-process, since #4. This runner exists for the test harnesses under
 * `app-test/` and `test/` (and anyone who wants the module on a socket without
 * booting Next): it calls the same `bootControlPlane` the app calls and puts
 * the same request handler behind `Bun.serve`. There is one implementation of
 * every route, and this is the second way to reach it.
 *
 * Laid out exactly as the app lays it out (`mountedFetch`): the hooks under
 * `/hooks/…`, the approvals store under `/api/approvals/…`, nothing at the
 * root. So a consumer pointed at this runner and one pointed at the app use
 * the same paths.
 *
 * It binds `PORT` (`0` for whatever the OS gives) and prints
 * `listening on :<port>` on its boot line, which is how the harnesses learn the
 * port — never a literal and never a guess.
 *
 * The configuration is checked before the socket opens. The socket then opens
 * before the boot so the boot line can name the port, and the boot runs
 * synchronously straight after it, before this process yields to the event
 * loop, so no request is served ahead of the warm cache.
 */
import { bootControlPlane } from "../lib/control-plane/index.ts";
import { readConfig } from "../lib/control-plane/config.ts";
import { orExitConfig } from "../lib/control-plane/public-host.ts";
import { mountedFetch, SERVICE, type ControlPlane } from "../lib/control-plane/server.ts";

// A configuration the boot would refuse is refused before the port opens, the
// way the service always did — `EX_CONFIG` for an unreachable address, a throw
// for anything else. The boot below reads it again; that is the cheap half.
orExitConfig(SERVICE, () => readConfig());

let plane: ControlPlane | undefined;

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8081),
  idleTimeout: 30,
  fetch(request) {
    if (plane === undefined) return Response.json({ error: "Booting" }, { status: 503 });
    return mountedFetch(plane)(request);
  },
});

plane = bootControlPlane({ where: () => `listening on :${server.port}` }).plane;
