/**
 * The app routes every path the identity provider answers, and nothing else
 * to it (#6).
 *
 * The provider's handler decides its own paths (`IDENTITY_PATHS` in
 * `lib/identity/provider/server.ts`) and the runner (`scripts/identity.ts`)
 * serves exactly those, so the carried tests exercise exactly those. The app
 * reaches the handler through Next routes, one per path, and a path the
 * handler answers with no route in front of it is a path that works in every
 * test and 404s in the app — `/.well-known/openid-configuration` is the one an
 * Arcade User Source reads first. So the two lists are compared here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { IDENTITY_PATHS, isIdentityPath } from "../../lib/identity/provider/server.ts";

const REPO = join(import.meta.dir, "..", "..");

/** `/login` → `app/login/route.ts`; `/oauth2/` → `app/oauth2/[...path]/route.ts`. */
function routeFileFor(path: string): string {
  const trimmed = path.replace(/^\/|\/$/g, "");
  return path.endsWith("/") ? `app/${trimmed}/[...path]/route.ts` : `app/${trimmed}/route.ts`;
}

/**
 * The exact paths under a prefix are served by the prefix's catch-all, the way
 * Next resolves them: `/identity/health` is `app/identity/[...path]`.
 */
function servingRoute(path: string): string {
  const exact = routeFileFor(path);
  if (existsSync(join(REPO, exact))) return exact;
  const first = `/${path.split("/")[1]}/`;
  return routeFileFor(first);
}

describe("every identity path has a route in front of it", () => {
  const paths = [...IDENTITY_PATHS.exact, ...IDENTITY_PATHS.prefixes];

  test.each(paths)("%s", (path) => {
    const route = servingRoute(path);
    expect(existsSync(join(REPO, route))).toBe(true);
    const source = readFileSync(join(REPO, route), "utf8");
    // Handed to the provider's door, for both methods an OAuth client uses.
    expect(source).toContain('from "');
    expect(source).toMatch(/lib\/identity\/provider\/instance\.ts"/);
    expect(source).toMatch(/export const GET = serve;/);
    expect(source).toMatch(/export const POST = serve;/);
  });
});

describe("and the app sends the provider nothing it does not answer", () => {
  /** Each mounted route, and a path under it the provider serves. */
  const MOUNTED: Array<[string, string]> = [
    ["app/oauth2/[...path]/route.ts", "/oauth2/token"],
    ["app/.well-known/[...path]/route.ts", "/.well-known/openid-configuration"],
    ["app/sign-in/[...path]/route.ts", "/sign-in/email"],
    ["app/identity/[...path]/route.ts", "/identity/health"],
    ["app/login/route.ts", "/login"],
    ["app/consent/route.ts", "/consent"],
    ["app/jwks/route.ts", "/jwks"],
  ];

  test("each mounted route is one the handler claims", () => {
    for (const [route, path] of MOUNTED) {
      expect(existsSync(join(REPO, route))).toBe(true);
      expect(servingRoute(path)).toBe(route);
      expect({ route, claimed: isIdentityPath(path) }).toEqual({ route, claimed: true });
    }
    // Under /identity only the module's own two routes: anything else there
    // is the provider's 404, not a Better Auth endpoint nobody meant to expose.
    expect(isIdentityPath("/identity/anything")).toBe(false);
  });

  test("the app's own paths are not the provider's", () => {
    for (const path of ["/", "/health", "/chat", "/loans", "/panel", "/approvals/apr_x", "/api/auth/signin", "/bank/loans", "/hooks/pre", "/sign-up/email", "/get-session"]) {
      expect({ path, claimed: isIdentityPath(path) }).toEqual({ path, claimed: false });
    }
  });
});
