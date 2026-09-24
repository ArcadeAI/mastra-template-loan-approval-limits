/**
 * A dependency address this service cannot possibly reach is a startup failure.
 *
 * The measurement behind it is #59: `render.yaml` derived `IDENTITY_HOST`
 * with `fromService … property: host`, and Render emitted the bare service name
 * `cg-idp-or5b` rather than `cg-idp-or5b.onrender.com`. `actor.ts` prepends a
 * scheme and nothing else, so every userinfo call went to a name DNS cannot
 * resolve and the API answered 503 "the identity provider could not be
 * reached" — true of the URL, false of the provider, and the reason step 7.1 of
 * the #13 sitting went looking at a healthy service.
 *
 * The three keys are `sync: false` now, which moves the value from a wrong
 * derivation to a human's hands. This is what stops the same string arriving
 * that way again.
 *
 * The table below is shared, verbatim, with `apps/hooks/test/public-host.test.ts`
 * and `app-test/public-host.test.ts` — the three copies of the check are
 * written out rather than imported, so each one is pinned by its own suite.
 */
import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertPublicHost, publicHost, PublicHostError } from "../../lib/loans/public-host.ts";
import { serveOnFreePort } from "../cdp.ts";
import { spawnChild } from "../child.ts";

/** Values a consumer can actually reach, or is free to leave unset. */
const ACCEPTED = [
  "localhost",
  "localhost:8083",
  "localhost:8082",
  "  localhost:8083  ",
  "127.0.0.1:1234",
  "127.0.0.1:4413",
  "127.0.0.53",
  "[::1]",
  "[::1]:9000",
  "[::1]:4413",
  "cg-idp-or5b.onrender.com",
  "cg-web-sa31.onrender.com",
  "cg-hooks.onrender.com:443",
  "example.test",
];

/**
 * Nothing here is reachable. The first five are bare service names — what
 * `fromService` produced, and what a hand-typed key produces again.
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
  "cg-hooks.onrender.com:bad",
  "https://cg-hooks.onrender.com",
];

test.each(ACCEPTED)("%p is a host something can resolve", (value) => {
  expect(() => assertPublicHost("IDENTITY_HOST", value)).not.toThrow();
});

test.each([undefined, "", "   "])("%p is not an error; consumers have defaults", (value) => {
  expect(() => assertPublicHost("IDENTITY_HOST", value)).not.toThrow();
  expect(publicHost("IDENTITY_HOST", value, "localhost:8083")).toBe("localhost:8083");
});

test.each(REFUSED)("%p is refused: it is a service name, not a hostname", (value) => {
  expect(() => assertPublicHost("IDENTITY_HOST", value)).toThrow(PublicHostError);
});

test("the refusal names the variable, its value, and where the real one comes from", () => {
  // The whole worth of this check is the message: whoever reads it is about to
  // go and find the right string, and the right string is on one specific page.
  try {
    assertPublicHost("IDENTITY_HOST", "cg-idp-or5b");
    throw new Error("expected a refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(PublicHostError);
    const { message } = cause as Error;
    expect(message).toContain("IDENTITY_HOST=cg-idp-or5b");
    expect(message).toContain("Render dashboard");
    expect(message).toContain("cg-web-sa31");
  }
});

test("a good value wins over the default, and is trimmed", () => {
  expect(publicHost("IDENTITY_HOST", "  cg-idp-or5b.onrender.com ", "localhost:8083")).toBe(
    "cg-idp-or5b.onrender.com",
  );
});

/** Spawn the real entry point with `IDENTITY_HOST` set to `host`. */
function boot(host: string, port: number, dir: string): Subprocess {
  return spawnChild(["bun", join(import.meta.dir, "..", "..", "scripts", "loans.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      LOANS_DB_PATH: join(dir, "loans.db"),
      IDENTITY_HOST: host,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * Through the service's real entry point, because the check is only worth
 * anything if it runs before the port opens. Exit status, not just stderr: a
 * boot that printed this and then served anyway would pass a message-only
 * assertion, and is exactly what round 1 of #67 found — `IDENTITY_HOST=[::2]`
 * printed nothing, listened, and answered `/health`.
 */
test.each(["cg-idp-or5b", "[::2]", "cg-loan-app:bad", "foo:bar"])(
  "the loan API refuses to start on %p",
  async (host) => {
    const dir = mkdtempSync(join(tmpdir(), "cg-public-host-"));

    try {
      const child = boot(host, 0, dir);
      const status = await child.exited;
      const stderr = await new Response(child.stderr as ReadableStream).text();

      // 78 is sysexits' EX_CONFIG, the same status `scripts/dev-idp.ts` uses.
      expect(status).toBe(78);
      expect(stderr).toContain(`IDENTITY_HOST=${host}`);
      expect(stderr).toContain("Render dashboard");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

/**
 * The other side of the same line. A check that refused everything would pass
 * every test above and stop the demo from starting at all, so each accepted
 * shape is booted too — a hostname, and the three loopback forms.
 *
 * None of these is ever called: booting is the whole assertion.
 */
test.each(["cg-idp-or5b.onrender.com", "localhost:8082", "127.0.0.1:1234", "[::1]:9000"])(
  "the loan API starts on %p",
  async (host) => {
    const dir = mkdtempSync(join(tmpdir(), "cg-public-host-"));

    try {
      // On a port chosen inside `serveOnFreePort`, which boots again on a new
      // one if another process took it first (#9), and fails at once, with the
      // child's output, if it exits instead of serving.
      const { child } = await serveOnFreePort((port) => boot(host, port, dir), {
        ready: async (port) => (await fetch(`http://127.0.0.1:${port}/bank/health`)).ok,
        timeoutMs: 20_000,
      });
      child.kill();
      await child.exited;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
