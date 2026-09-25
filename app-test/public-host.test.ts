/**
 * A cross-service address this service cannot possibly reach is refused where
 * the environment is read, not when the browser fails to open a stream.
 *
 * The measurement behind it is #59: the stage demo's deployment derived every
 * cross-service host from its host's service references, and what arrived was
 * the bare service name — `IDENTITY_HOST` on `cg-loan-app` was `cg-idp-or5b`,
 * not its FQDN. Consumers prepend a scheme and nothing else, so
 * the request went somewhere DNS cannot resolve.
 *
 * `APP_PUBLIC_HOST` is the worst of the three to get wrong, because the panel
 * opens `GET /events` from the browser: the failure would land in a visitor's
 * DevTools console, where nobody running the demo is looking.
 *
 * The table below is shared, verbatim, with
 * `app-test/loans/public-host.test.ts` and `app-test/control-plane/public-host.test.ts`
 * — the three copies of the check are written out rather than imported, so each
 * one is pinned by its own suite.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readWebConfig } from "../lib/config.ts";
import { resolvePanelStream } from "../lib/governance/stream-url.ts";
import { assertPublicHost, publicHost, PublicHostError } from "../lib/public-host.ts";

/** Values a consumer can actually reach, or is free to leave unset. */
const ACCEPTED = [
  "localhost",
  "localhost:8081",
  "localhost:8082",
  "  localhost:8081  ",
  "127.0.0.1:1234",
  "127.0.0.1:4421",
  "127.0.0.53",
  "[::1]",
  "[::1]:9000",
  "[::1]:4421",
  "cg-hooks.example.com",
  "cg-web-sa31.example.com",
  "cg-hooks.example.com:443",
  "example.test",
];

/**
 * Nothing here is reachable. The first five are bare service names — what
 * a derived service reference produced (#59), and what a hand-typed key
 * produces again.
 *
 * The rest are round 1 of #67. The first cut of this check let any value
 * through once bracket-stripping left a colon in it, so `[::2]` — no dot, not
 * loopback — booted the loan API and served `/health` on it. `cg-loan-app:bad`
 * and `foo:bar` got in the same way. A dotless non-loopback host is refused
 * whatever punctuation it carries, and a port that is not a port number is
 * refused too.
 */
const REFUSED = [
  "cg-idp",
  "cg-idp-or5b",
  "cg-loan-app",
  "cg-web-sa31",
  "cg-loan-app:8080",
  "[::2]",
  "::2",
  "[fe80::1]",
  "cg-loan-app:bad",
  "foo:bar",
  "localhost:bad",
  "localhost:0",
  "localhost:65536",
  "cg-hooks.example.com:bad",
  "https://cg-hooks.example.com",
];

test.each(ACCEPTED)("%p is a host something can resolve", (value) => {
  expect(() => assertPublicHost("APP_PUBLIC_HOST", value)).not.toThrow();
});

test.each([undefined, "", "   "])("%p is not an error; consumers have defaults", (value) => {
  expect(() => assertPublicHost("APP_PUBLIC_HOST", value)).not.toThrow();
  expect(publicHost("APP_PUBLIC_HOST", value, "localhost:8081")).toBe("localhost:8081");
});

test.each(REFUSED)("%p is refused: it is a service name, not a hostname", (value) => {
  expect(() => assertPublicHost("APP_PUBLIC_HOST", value)).toThrow(PublicHostError);
});

test("the refusal names the variable, its value, and where the real one comes from", () => {
  // The whole worth of this check is the message: whoever reads it is about to
  // go and find the right string, and the right string is the app's own public host.
  try {
    assertPublicHost("APP_PUBLIC_HOST", "cg-hooks");
    throw new Error("expected a refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(PublicHostError);
    const { message } = cause as Error;
    expect(message).toContain("APP_PUBLIC_HOST=cg-hooks");
    expect(message).toContain("the host part of its public URL");
    expect(message).toContain("Never derive or guess it");
  }
});

test("readWebConfig refuses a bare service name, and passes a hostname through", () => {
  expect(() => readWebConfig({ APP_PUBLIC_HOST: "cg-hooks" })).toThrow(PublicHostError);
  expect(readWebConfig({ APP_PUBLIC_HOST: "cg-hooks.example.com" }).hooksHost).toBe(
    "cg-hooks.example.com",
  );
  // The app's own host since #4, when the control plane folded into it.
  expect(readWebConfig({}).hooksHost).toBe("localhost:3000");
});

/**
 * The stream address is worked out in `stream-url.ts`, which reads the variable
 * itself rather than going through `readWebConfig` — so it needs its own check,
 * or the one path that hands this host to a browser is the one path with no
 * check on it.
 *
 * Refused in *either* mode, deliberately. A bare name is wrong the moment it is
 * set, and letting the fixture default swallow it would leave the panel looking
 * fine on a deployment that cannot reach the control plane at all.
 */
test("the panel's stream source refuses a bare service name in either mode", () => {
  expect(() => resolvePanelStream({ APP_PUBLIC_HOST: "cg-hooks" })).toThrow(PublicHostError);
  expect(() =>
    resolvePanelStream({ GOVERNANCE_STREAM: "hooks", APP_PUBLIC_HOST: "cg-hooks" }),
  ).toThrow(PublicHostError);

  const live = resolvePanelStream({
    GOVERNANCE_STREAM: "hooks",
    APP_PUBLIC_HOST: "cg-hooks.example.com",
  });
  expect(live).toHaveProperty("url", "https://cg-hooks.example.com/hooks/events");
  expect(resolvePanelStream({}).mode).toBe("fixture");
});

/**
 * The three copies of the check are written out rather than shared, because
 * the loan module (`lib/loans/`) depends on nothing outside itself on purpose and a shared
 * module would be the dependency edge it must not have. The cost of a copy is
 * drift, and drift in *this* code is a control that silently permits — so the
 * marked region is compared byte for byte here.
 *
 * Round 1 of #67 is what this is for: one wrong condition, `hostname.includes
 * (":")`, let `[::2]` boot and serve. Three copies of that is three times the
 * chance of fixing it in one place and believing it fixed everywhere.
 *
 * `apps/web` reads the other two services' sources, the same way
 * `app-test/config.test.ts` already reads `apps/hooks` to pin the duplicated
 * development token. That is cheaper than a dependency edge between the
 * governed UI, the control plane and the business system.
 */
test("the three copies of the check are byte-identical", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  const START = "// --- shared check: byte-identical in all three services";
  const END = "// --- end shared check";

  const region = (...parts: string[]) => {
    const path = join(root, ...parts);
    const source = readFileSync(path, "utf8");
    const from = source.indexOf(START);
    const to = source.indexOf(END);
    if (from === -1 || to <= from) throw new Error(`${path} has no marked shared region`);
    return source.slice(from, to);
  };

  const web = region("lib", "public-host.ts");

  expect(region("lib", "control-plane", "public-host.ts")).toBe(web);
  // The loan module's copy, in `lib/loans/` since #5. Still a copy rather than
  // an import of `lib/public-host.ts`: the module depends on nothing else in
  // the app, because it is the part a forker replaces.
  expect(region("lib", "loans", "public-host.ts")).toBe(web);
});
