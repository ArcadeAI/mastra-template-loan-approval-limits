/**
 * The issuer is `APP_PUBLIC_HOST` with its scheme (#6): http for localhost and
 * 127.0.0.1, so a local run needs no tunnel, and https for anything else, so
 * the ngrok host is https. Decided with #6's Q2.
 *
 * Two places compute it and they must agree byte for byte: the provider
 * (`lib/identity/provider/config.ts`, which names it in discovery and puts it
 * on every token as `iss`) and the web sign-in (`lib/config.ts`, which sends
 * the browser to it and builds every `redirect_uri` from the same origin). An
 * Arcade User Source matches `iss` exactly, so a provider saying
 * `http://host` while everything else said `https://host` would pass every
 * test that ran on one side of it.
 */
import { describe, expect, test } from "bun:test";

import { appOrigin, readIdentitySurface } from "../../lib/config.ts";
import { issuerOf, readConfig } from "../../lib/identity/provider/config.ts";

const CASES: Array<[string, string]> = [
  ["localhost:3000", "http://localhost:3000"],
  ["localhost:4400", "http://localhost:4400"],
  ["127.0.0.1:4403", "http://127.0.0.1:4403"],
  ["cg-template.ngrok.app", "https://cg-template.ngrok.app"],
  ["loans-demo.ngrok-free.app", "https://loans-demo.ngrok-free.app"],
  ["cg-web-sa31.onrender.com", "https://cg-web-sa31.onrender.com"],
];

describe("the issuer's scheme", () => {
  test.each(CASES)("APP_PUBLIC_HOST=%s is %s, on both sides", (host, origin) => {
    const env = { APP_PUBLIC_HOST: host };
    expect(issuerOf(env)).toBe(origin);
    expect(readConfig(env).baseURL).toBe(origin);
    expect(appOrigin(env)).toBe(origin);
    const surface = readIdentitySurface(env);
    expect(surface.identity.idpIssuer).toBe(origin);
    expect(surface.identity.publicUrl).toBe(origin);
  });

  test("unset, both sides fall back to the app's own port on localhost", () => {
    const env = { PORT: "4400" };
    expect(readConfig(env).baseURL).toBe("http://localhost:4400");
    expect(readConfig(env).baseURLIsFallback).toBe(true);
    expect(appOrigin(env)).toBe("http://localhost:4400");
    // But the web sign-in will not run on the fallback: see
    // `configuration-banner.test.tsx` and `identity-flow.test.ts`.
    expect(readIdentitySurface(env).identity.publicHostConfigured).toBe(false);
  });

  test("a URL is refused rather than given a second scheme", () => {
    expect(() => issuerOf({ APP_PUBLIC_HOST: "https://cg-template.ngrok.app" })).toThrow(/HOST-form/);
    expect(() => appOrigin({ APP_PUBLIC_HOST: "https://cg-template.ngrok.app" })).toThrow(/it is a URL/);
  });
});
