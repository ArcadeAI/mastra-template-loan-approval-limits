/**
 * How the rest of the identity module reaches the provider in this process,
 * without importing it (#6).
 *
 * The web sign-in (`handlers.ts`, `oidc.ts`) exchanges its code, reads
 * userinfo and renews its token at the app's own Better Auth. Since the fold
 * that provider runs in the same process, so those calls go to it in-process,
 * never out through `APP_PUBLIC_HOST` and back in through the tunnel (the
 * finding from #4, criterion 7). They cannot import it, though: the provider
 * opens `idp.db` with `bun:sqlite`, and `handlers.ts` is on the token seam's
 * import graph, which Studio loads under Node (`app-test/studio-entry.test.ts`,
 * "reaches no bun: module"). So the provider registers itself here when it
 * opens (`provider/instance.ts`), and the readers ask here.
 *
 * **Fails closed.** A provider that did not boot is linked as failed, and then
 * nothing that depends on it succeeds: the sign-in's calls answer 503, and the
 * sealed-session readers treat every browser as signed out (`session.ts`), so
 * no approval or tool authorization can be made as anybody. Nothing linked at
 * all means nothing in this process opened a provider, which is a harness or a
 * unit test; the app opens it at boot (`instrumentation.ts`).
 */

/** An HTTP request to the identity provider, answered in-process. */
export type IdentityTransport = (request: Request) => Promise<Response>;

export interface IdentityLink {
  fetch: IdentityTransport;
  /** Why the provider did not boot, or `null` while it is up or still opening. */
  failure(): string | null;
}

const KEY = Symbol.for("cg.identity-link");

type Holder = { [KEY]?: IdentityLink };

/** Registers this process's provider. `undefined` unlinks it, which only a test harness does. */
export function linkIdentity(link: IdentityLink | undefined): void {
  const holder = globalThis as Holder;
  if (link === undefined) delete holder[KEY];
  else holder[KEY] = link;
}

export function identityLink(): IdentityLink | undefined {
  return (globalThis as Holder)[KEY];
}

/** The reason the linked provider did not boot, or `null`. */
export function identityFailure(): string | null {
  return identityLink()?.failure() ?? null;
}

/** What a caller gets when there is no provider to ask. Same shape as the provider's own 503. */
function unavailable(reason: string): Response {
  return Response.json({ error: "identity_unavailable", error_description: reason }, { status: 503 });
}

/**
 * The transport every server-side identity read uses: this process's provider,
 * or a 503 saying why there is none. Never the network.
 */
export const identityFetch: IdentityTransport = async (request) => {
  const link = identityLink();
  if (link === undefined) return unavailable("the identity module is not running in this process");
  const failed = link.failure();
  if (failed !== null) return unavailable(`the identity module did not boot: ${failed}`);
  return link.fetch(request);
};
