/**
 * The app's one identity provider, per process (#6).
 *
 * The identity routes (`app/oauth2/…`, `app/login`, `app/consent`,
 * `app/jwks`, `app/.well-known/…`, `app/sign-in/…`, `app/identity/…`) and
 * the app's `/health` reach the provider through here. It lives on
 * `globalThis` rather than in a module-level `let` for the reason the loan
 * book's does (`lib/loans/instance.ts`): Next does not promise one module
 * instance per process, and two instances would be two `idp.db` handles, two
 * Better Auth contexts and two replay guards.
 *
 * `instrumentation.ts` opens it when the server starts, so a provider that
 * cannot boot says so on the first lines the server prints. The lazy path
 * below is the backstop, not the plan.
 *
 * **Refusing to boot, in an app.** `apps/idp` exited. The app cannot: the same
 * process serves the bank, the control plane and the panel. So a refusal is
 * recorded once, logged loudly, reported on `/health` as
 * `identity: { status: "failed", error }`, answered 503 on every identity
 * route, and linked as failed (`lib/identity/link.ts`), which is what makes the
 * sealed-session readers treat every browser as signed out.
 */
import { linkIdentity } from "../link.ts";
import { NO_USERS, openIdentityProvider, type IdentityProvider } from "./server.ts";

const KEY = Symbol.for("cg.identity-provider");

/** The open, or why it did not happen. Recorded once; a restart retries. */
type Opened = { ok: true; provider: IdentityProvider } | { ok: false; error: string };

type Holder = { [KEY]?: { opening: Promise<Opened>; settled?: Opened } };

function open(): Promise<Opened> {
  const holder = globalThis as Holder;
  if (holder[KEY] === undefined) {
    const slot: { opening: Promise<Opened>; settled?: Opened } = {
      opening: openIdentityProvider().then(
        (provider): Opened => ({ ok: true, provider }),
        (cause): Opened => {
          const error = cause instanceof Error ? cause.message : String(cause);
          console.error(
            `[idp] the identity module did not boot, so nobody can sign in, and nothing can be done ` +
              `as anybody, until it does: ${error}`,
          );
          return { ok: false, error };
        },
      ),
    };
    slot.opening.then((settled) => {
      slot.settled = settled;
    });
    holder[KEY] = slot;
    linkIdentity({
      fetch: identityFetch,
      failure: () => (slot.settled?.ok === false ? slot.settled.error : null),
    });
  }
  return holder[KEY].opening;
}

function refusal(error: string): Response {
  return Response.json(
    { error: "identity_unavailable", error_description: `the identity module did not boot: ${error}` },
    { status: 503 },
  );
}

/** Every identity route's handler: the provider's answer, or a 503 naming why there is no provider. */
export async function identityFetch(request: Request): Promise<Response> {
  const opened = await open();
  return opened.ok ? opened.provider.fetch(request) : refusal(opened.error);
}

/**
 * What the app's identity routes export. The request is re-issued with its
 * body read, as `lib/loans/server.ts`'s `mountedFetch` does, so the provider
 * sees the same thing under Next's request wrapper as under `Bun.serve`: same
 * method, headers, query and bytes.
 */
export async function serve(request: Request): Promise<Response> {
  const bodyless = request.method === "GET" || request.method === "HEAD";
  return identityFetch(
    new Request(request.url, {
      method: request.method,
      headers: request.headers,
      ...(bodyless ? {} : { body: await request.arrayBuffer() }),
    }),
  );
}

/** `instrumentation.ts`'s call: open it now, and say why not if it did not. */
export async function identityProviderFailure(): Promise<string | null> {
  const opened = await open();
  return opened.ok ? null : opened.error;
}

/**
 * What the app's `/health` reports under `identity`. Never a bare count, the
 * same rule as `loans`.
 *
 * `no_users` since #33: the provider booted and nobody can sign in, because a
 * fresh `idp.db` seeds nobody. It is degraded, not failed, and it says which
 * command adds somebody, so a first run reads as a step still to take rather
 * than as a crash.
 */
export type IdentityCapability =
  | { status: "ok"; issuer: string; people: number }
  | { status: "no_users"; issuer: string; people: 0; message: string }
  | { status: "failed"; issuer: null; people: null; error: string };

export async function identityCapability(): Promise<IdentityCapability> {
  const opened = await open();
  if (!opened.ok) return { status: "failed", issuer: null, people: null, error: opened.error };
  const { issuer, people } = opened.provider.health();
  if (people === 0) return { status: "no_users", issuer, people: 0, message: NO_USERS };
  return { status: "ok", issuer, people };
}

/**
 * Every address that can sign in, for the app's `/health` to hold against the
 * control plane's subjects (#33). `null` when the provider did not boot, which
 * is not the same as nobody: `identity` already says why.
 */
export async function identityEmails(): Promise<string[] | null> {
  const opened = await open();
  return opened.ok ? opened.provider.emails() : null;
}
