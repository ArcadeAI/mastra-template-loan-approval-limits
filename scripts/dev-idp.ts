/**
 * A stand-in identity provider for local development. NOT the real one.
 *
 * The loan module (`lib/loans/`) validates every bearer token by asking the issuer's
 * `/oauth2/userinfo` who it belongs to. The real issuer is the app's own
 * identity module since #6, which the app serves on its own port; this serves
 * that one endpoint for the loan module on a port of its own (`bun run loans`),
 * so its API can be driven by hand without the app:
 *
 *     IDENTITY_HOST=localhost:4403 bun run dev:idp-stub   # binds 4403
 *     IDENTITY_HOST=localhost:4403 PORT=4402 bun run loans
 *     curl -H 'Authorization: Bearer dev:alice@example.test' "localhost:4402/bank/loans"
 *
 * A token is `dev:<email>`; the email after the prefix is who you are. That
 * is the whole protocol, so this must never run anywhere but a laptop. It
 * lives under the repo's `scripts/`, outside the `lib/loans/` the boundary test
 * scans, and outside the Docker image. It lived in `apps/loan-app/scripts/`
 * until #5 folded that service into the app.
 */

/** An example value, for the error messages. Never a fallback — see `resolveStubPort`. */
const EXAMPLE_IDP_HOST = "localhost:4403";

/**
 * The port comes from `IDENTITY_HOST` — the address the loan API is pointed
 * at for userinfo — and deliberately not from `PORT`.
 *
 * `PORT` here belongs to somebody else. Since #5 this script runs from the
 * root, so Bun loads the root `.env.local`, whose `PORT` is the app's. Before
 * #5 it lived under `apps/loan-app/scripts/` and `dev:idp-stub` ran it with
 * `--cwd apps/loan-app`, so Bun loaded `apps/loan-app/.env.local` into it: the
 * right file for the wrong service, and the `PORT` in it was the loan API's. Until #56 it read `PORT` out of that file and
 * bound the loan API's port — measured in a worktree owning 4410-4419, both
 * processes wanted 4412, whichever started second lost, and nothing was
 * listening on 4413 where `IDENTITY_HOST` pointed. It failed silently: the
 * stub announced a port and answered on it, just not the one anybody was
 * calling.
 *
 * Reading the host the API already asks for makes the two agree by
 * construction — there is no second value left to keep in step, in a worktree
 * or anywhere else. Move `IDENTITY_HOST` and both sides follow.
 *
 * `env` is a parameter so the resolution can be tested without a subprocess;
 * the running stub passes `process.env`, which Bun has already merged
 * `.env.local` into.
 */
export function resolveStubPort(env: Record<string, string | undefined> = process.env): number {
  const host = env.IDENTITY_HOST?.trim() ?? "";

  // Unset, the loan module validates against the app itself (`localhost:$PORT`),
  // which serves the real identity provider since #6. There is no port of the
  // stub's own to fall back to, and taking the app's would be the #56 collision
  // again, so it says so rather than binding something.
  if (host === "") {
    throw new Error(
      `IDENTITY_HOST is not set, so the loan module validates tokens against the app itself, which ` +
        `serves the real identity provider. Set IDENTITY_HOST to a free local port (e.g. ` +
        `${EXAMPLE_IDP_HOST}) for both this stub and \`bun run loans\` to use it instead.`,
    );
  }

  // `IDENTITY_HOST` is host-form by convention (`.env.example` documents it
  // that way), but a scheme is accepted rather than parsed as one: `new
  // URL("localhost:4413")` reads `localhost` as the *scheme* and hands back an
  // empty port, which would refuse a perfectly good value.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(host);

  let port: string;
  try {
    ({ port } = new URL(hasScheme ? host : `http://${host}`));
  } catch {
    throw new Error(
      `IDENTITY_HOST=${host} is not a host — expected something like ${EXAMPLE_IDP_HOST}.`,
    );
  }

  // A host with no port is a real, remote identity provider on 80 or 443, not
  // something this stub can stand in for. Falling back to a default here would
  // bind a port nothing is calling and look like it worked, which is the bug
  // this function exists to end.
  if (port === "") {
    throw new Error(
      `IDENTITY_HOST=${host} names no port, so there is nothing here for the stub to bind. ` +
        `It wants a local host:port, e.g. ${EXAMPLE_IDP_HOST}.`,
    );
  }

  return Number(port);
}

function userinfo(request: Request): Response {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return Response.json({ status: "ok", service: "dev-idp" });
  if (pathname !== "/oauth2/userinfo") return new Response("Not found", { status: 404 });

  const token = /^Bearer\s+dev:(\S+@\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (token === null) {
    return Response.json(
      { error: "invalid_token", error_description: "Use `Bearer dev:<email>`." },
      { status: 401 },
    );
  }

  const email = token[1]!;
  return Response.json({ sub: email, email, email_verified: true });
}

if (import.meta.main) {
  let port: number;
  try {
    port = resolveStubPort();
  } catch (cause) {
    console.error(`[dev-idp] ${cause instanceof Error ? cause.message : String(cause)}`);
    // 78 is sysexits' EX_CONFIG: the environment is wrong, not the invocation.
    // `scripts/next.ts` exits 64, EX_USAGE, for the other case.
    process.exit(78);
  }

  const server = Bun.serve({ port, fetch: userinfo });

  console.log(
    `[dev-idp] listening on :${server.port} — the port in IDENTITY_HOST. ` +
      "Tokens are `dev:<email>`. Not for anything real.",
  );
}
