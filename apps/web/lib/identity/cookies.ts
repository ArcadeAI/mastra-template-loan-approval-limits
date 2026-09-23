/**
 * Cookies read off a `Request` and written onto a `Response`, rather than
 * through `next/headers`.
 *
 * That is a deliberate shape, not an avoidance of the framework. Every handler
 * in this slice is a plain `(Request) => Promise<Response>` living in
 * `lib/identity/handlers.ts`, and `app/api/**` is a one-line adapter onto it.
 * The reason is testability of the exact thing that has to be right: the tests
 * mount those same functions behind a real `Bun.serve` and drive them with a
 * cookie jar over real HTTP, so what the suite exercises is the Set-Cookie
 * header a browser would actually receive. `cookies()` would tie the flow to a
 * request context only Next can create, and the alternative to a real server
 * would be asserting on a mock's arguments.
 *
 * One consequence worth stating: a handler that reads cookies from its own
 * `Request` can never accidentally read *another* browser's session, because
 * there is no ambient store to reach into.
 */

/** The request's `Cookie` header, parsed. Duplicate names: the first wins, as a browser sends them. */
export function readCookies(request: Request): Map<string, string> {
  const jar = new Map<string, string>();
  const header = request.headers.get("cookie");
  if (!header) return jar;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name || jar.has(name)) continue;
    jar.set(name, pair.slice(eq + 1).trim());
  }
  return jar;
}

export interface CookieOptions {
  /** Seconds. `0` expires it. */
  maxAge: number;
  /**
   * `Secure` is on for every cookie this service writes except over loopback.
   *
   * Not a preference: the session cookie holds gateway bearer tokens, and the
   * deployment is HTTPS-only (`PUBLIC_URL` is the Render URL). The exception is
   * narrow on purpose — a browser silently drops a `Secure` cookie sent over
   * plain http, so a local run against `http://localhost:4400` would look like
   * a sign-in that does nothing.
   */
  secure: boolean;
}

/**
 * One `Set-Cookie` value.
 *
 * `HttpOnly` always, `SameSite=Lax` always. Lax rather than Strict because
 * every cookie here has to survive a cross-site *navigation* back from the IdP
 * and from Arcade — Strict would withhold the sign-in leg's cookie on the
 * callback that needs it, and the flow would fail with a state mismatch that
 * looks like a CSRF attack rather than a cookie policy.
 */
export function cookieHeader(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAge}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Append a `Set-Cookie`. `Headers.append` is the only correct way: `set` would drop the others. */
export function appendCookie(headers: Headers, name: string, value: string, options: CookieOptions) {
  headers.append("set-cookie", cookieHeader(name, value, options));
}

/** Expire a cookie: empty value, `Max-Age=0`, same attributes so the browser matches it. */
export function expireCookie(headers: Headers, name: string, secure: boolean) {
  appendCookie(headers, name, "", { maxAge: 0, secure });
}
