/**
 * The app's identity module on a port of its own.
 *
 * Not a service: the app serves every identity path itself, in-process, since
 * #6. This runner exists for the test harnesses under `app-test/` and `test/`,
 * and for anyone who wants the identity provider on a socket without booting
 * Next. It opens `idp.db` the way the app does and puts the same request
 * handler behind `Bun.serve`. There is one implementation of every route, and
 * this is the second way to reach it.
 *
 * Laid out exactly as the app lays it out (`IDENTITY_PATHS`): the OAuth
 * endpoints, discovery, `/jwks`, `/login` and `/consent` at the root, and the
 * module's own `/identity/health` and `/identity/admin/reset`. Anything else
 * is a 404, as it is in the app, where those paths are somebody else's.
 *
 * It binds `PORT` (`0` for whatever the OS gives) and prints
 * `listening on :<port>` on its boot line, which is how the harnesses learn the
 * port — never a literal and never a guess. The issuer is `APP_PUBLIC_HOST`
 * with its scheme, as it is in the app, so a harness that serves the identity
 * module here sets `APP_PUBLIC_HOST` to this runner's own host.
 *
 * Unlike the app, it refuses to start when the provider will not boot — an
 * unset `BETTER_AUTH_SECRET` in production, a disk this build cannot read —
 * exactly as `apps/idp` did: there is nothing else in this process to keep
 * serving.
 */
import { openIdentityProvider } from "../lib/identity/provider/server.ts";

let provider: Awaited<ReturnType<typeof openIdentityProvider>>;
try {
  provider = await openIdentityProvider();
} catch (cause) {
  console.error(`[idp] ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 60,
  fetch: provider.fetch,
});

console.log(`[idp] listening on :${server.port} — issuer ${provider.config.baseURL}`);
