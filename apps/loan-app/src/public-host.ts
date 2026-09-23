/**
 * The address of a dependency, checked at boot instead of at the first call.
 *
 * `render.yaml` used to derive every cross-service address with
 * `fromService … property: host`. Measured on 2026-09-10 (#59): Render emits
 * the **bare service name**, never the FQDN — `IDP_PUBLIC_HOST` arrived here as
 * `cg-idp-or5b`. Consumers prepend a scheme and nothing else, so the request
 * went to `https://cg-idp-or5b/oauth2/userinfo`, DNS failed, `fetch` threw, and
 * this service reported that the identity provider could not be reached. That
 * message was honest and misleading at once: the provider was healthy and the
 * URL was malformed.
 *
 * The three cross-service keys are `sync: false` now and typed in by hand per
 * environment, which means a human can type a bare name too. So: a service that
 * cannot possibly reach its dependency says so at startup, naming the variable
 * and where the real value is read from.
 *
 * The check below is written out once per service rather than shared, because
 * `apps/loan-app` depends on nothing outside itself on purpose — it is the part
 * a forker throws away, and a shared module would be a dependency edge it must
 * not have. The copies are kept byte-identical instead:
 * `apps/web/test/public-host.test.ts` diffs the three marked regions, and all
 * three test files run the same table of accepted and refused values.
 */

// --- shared check: byte-identical in all three services ---------------------
// `apps/web/test/public-host.test.ts` compares the region between these two
// markers across the three files and fails if any copy drifts. Edit one, run
// `bun test`, paste into the other two.

/** A `*_PUBLIC_HOST` nothing can be reached at. Its own class, so a caller can tell it apart. */
export class PublicHostError extends Error {}

/**
 * The only dotless hostnames a consumer can actually reach. Round 1 of #67
 * found the first cut of this check testing for a colon instead, which let
 * `[::2]` — not loopback, no dot — boot and serve.
 */
function isLoopback(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower);
}

/**
 * HOST-form, split. `[v6]` and `[v6]:port` are bracketed. An unbracketed value
 * with two or more colons is a bare IPv6 literal, which has nowhere to put a
 * port; one colon separates a host from its port.
 */
function splitHostPort(value: string): { hostname: string; port?: string | undefined } {
  const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(value);
  if (bracketed) return { hostname: bracketed[1] as string, port: bracketed[2] };

  const at = value.indexOf(":");
  if (at === -1 || value.indexOf(":", at + 1) !== -1) return { hostname: value };
  return { hostname: value.slice(0, at), port: value.slice(at + 1) };
}

/** Digits, and a port something can listen on. `0` is not an address. */
function isPort(port: string): boolean {
  return /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

/**
 * Every refusal says the same three things: which variable, what it holds, and
 * the one place the right value is written down. Whoever reads this is about to
 * go and find that value.
 */
function refusal(name: string, host: string, problem: string): PublicHostError {
  return new PublicHostError(
    `${name}=${host} is not an address this service can reach: ${problem}. Read the value off ` +
      "that service's page in the Render dashboard (the host part of the URL shown there) and " +
      "set it by hand; the key is `sync: false` for this reason. Never derive or guess it: " +
      "onrender.com subdomains are global, so Render silently suffixes a name that is taken — " +
      "cg-web is cg-web-sa31 and cg-idp is cg-idp-or5b.",
  );
}

/**
 * Refuse anything that is not a reachable HOST-form address: a hostname, or a
 * hostname and a numeric port. A dotless name is the shape `fromService`
 * produced and the shape a hand-typed `cg-idp` produces again, and loopback is
 * the only dotless exception because it is the only one that resolves.
 *
 * Unset is not an error. Every consumer carries a localhost default, and a
 * local run configures nothing.
 */
export function assertPublicHost(name: string, value: string | undefined): void {
  const host = value?.trim();
  if (!host) return;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    throw refusal(name, host, "it is a URL, and these are HOST-form: the consumer adds the scheme");
  }

  const { hostname, port } = splitHostPort(host);

  if (port !== undefined && !isPort(port)) {
    throw refusal(name, host, `\`${port}\` is not a port number in 1-65535`);
  }

  if (hostname.includes(".") || isLoopback(hostname)) return;

  throw refusal(
    name,
    host,
    "it has no dot and is not loopback, which is what a Render service *name* looks like " +
      "(`cg-idp-or5b`) rather than its hostname (`cg-idp-or5b.onrender.com`)",
  );
}

/** `value`, or `fallback` when unset. Throws `PublicHostError` on anything unreachable. */
export function publicHost(name: string, value: string | undefined, fallback: string): string {
  assertPublicHost(name, value);
  return value?.trim() || fallback;
}

// --- end shared check -------------------------------------------------------

/**
 * Run `read`, turning an unreachable `*_PUBLIC_HOST` into one line on stderr
 * and sysexits' EX_CONFIG — the environment is wrong, not the invocation. Same
 * exit status `apps/loan-app/scripts/dev-idp.ts` uses for the same class of
 * mistake. Anything else propagates untouched.
 */
export function orExitConfig<T>(service: string, read: () => T): T {
  try {
    return read();
  } catch (cause) {
    if (!(cause instanceof PublicHostError)) throw cause;
    console.error(`[${service}] ${cause.message}`);
    process.exit(78);
  }
}
