/**
 * `bun run dev:idp-stub` has to bind the identity provider's port, not the
 * app's own.
 *
 * Until #5 the stub lived under `apps/loan-app/scripts/` and the root script
 * ran it with `--cwd apps/loan-app`, so Bun loaded `apps/loan-app/.env.local`
 * into it. Since #5 it is `scripts/dev-idp.ts`, run from the root, so Bun
 * loads the root `.env.local`, whose `PORT` is the app's — the same trap with
 * a different owner. Until #56 it took `PORT` from that file — the loan API's
 * port. In a worktree
 * owning 4410-4419 both processes wanted 4412, and `IDENTITY_HOST` pointed
 * at 4413 where nothing was listening. Sibling of `app-test/dev-port.test.ts`
 * (#50): same family of silent misbinding, different cause — that one was a
 * shell expanding `${PORT:-3000}` before anything read the file, this one read
 * the right file for the wrong service.
 *
 * The first test therefore runs the *packaged* script, verbatim, from the root
 * manifest, in a throwaway tree whose `.env.local` carries a `PORT` and an
 * `IDENTITY_HOST` that disagree. Only one of them can be the one it binds.
 * Before #5 there were two manifests in that chain, the root's and
 * `apps/loan-app`'s; the service's is gone, and so is the one expectation that
 * read a script out of it.
 */
import { afterAll, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveStubPort } from "../../scripts/dev-idp.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const STUB = join(REPO_ROOT, "scripts", "dev-idp.ts");

interface Manifest {
  scripts?: Record<string, string>;
}

async function manifestAt(dir: string): Promise<Manifest> {
  return (await Bun.file(join(dir, "package.json")).json()) as Manifest;
}

/**
 * A port the OS says is free, rather than a guess — the same trick as
 * `test/api.test.ts` and `tools/loan/tests/conftest.py::_free_port`. Several
 * worktrees run `bun test` at once, so a random port is a birthday problem.
 */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") {
    throw new Error(`Bun.serve({ port: 0 }) reported no port (got ${String(port)})`);
  }
  return port;
}

/**
 * What the stub is started with: enough of the caller's environment to run
 * `bun`, and nothing the fixture decides.
 *
 * `bun test` sets `NODE_ENV=test`, and under it Bun skips `.env.local`
 * entirely — a real dev server's environment is the one without it, so
 * `NODE_ENV` is not passed. And the whole question is which of the fixture
 * `.env.local`'s two values the stub picks, so neither `PORT` nor
 * `IDENTITY_HOST` may reach it from the caller: Bun lets a variable already
 * in the environment win over the file. Measured on #50.
 *
 * An allowlist, not a list of exclusions, since round 1 of #5's review: the
 * first cut dropped `PORT` and `NODE_ENV` only, and a shell that had exported
 * the worktree's own `.env.local` (`set -a; . ./.env.local`) handed the stub
 * `IDENTITY_HOST=localhost:4443`, so it bound that and the test timed out on
 * the fixture's port. Every `*_PUBLIC_HOST`, `CG_PORT_*` or anything else a
 * future fixture writes is excluded the same way, by not being on this list.
 */
const PASSED_THROUGH = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "TERM"] as const;

function devEnv(extra: Record<string, string> = {}): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of PASSED_THROUGH) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  return { ...inherited, ...extra };
}

let child: Subprocess | undefined;
let project: string | undefined;

afterAll(() => {
  child?.kill();
  if (project !== undefined) rmSync(project, { recursive: true, force: true });
});

test("the packaged dev:idp-stub script binds IDENTITY_HOST's port, not PORT", async () => {
  const idpPort = freePort();
  const loanPort = freePort();
  expect(idpPort).not.toBe(loanPort);

  const root = await manifestAt(REPO_ROOT);
  const stubScript = root.scripts?.["dev:idp-stub"];
  expect(stubScript).toBeString();

  // The root manifest, reproduced with the real script string, so the test
  // exercises the whole chain: where the script runs from decides which
  // `.env.local` Bun loads.
  project = mkdtempSync(join(tmpdir(), "cg-dev-idp-port-"));
  mkdirSync(join(project, "scripts"), { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify(
      { name: "cg-dev-idp-port-fixture", private: true, scripts: { "dev:idp-stub": stubScript } },
      null,
      2,
    )}\n`,
  );
  cpSync(STUB, join(project, "scripts", "dev-idp.ts"));

  // The only two ports in the fixture, and they disagree on purpose: `PORT` is
  // the app's, the way `scripts/orca-setup.sh` writes the root `.env.local`.
  writeFileSync(
    join(project, ".env.local"),
    `PORT=${loanPort}\nIDENTITY_HOST=localhost:${idpPort}\n`,
  );

  child = Bun.spawn(["bun", "run", "--cwd", project, "dev:idp-stub"], {
    env: devEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 30_000;
  let body: { status?: string; service?: string } | undefined;
  while (body === undefined) {
    try {
      const response = await fetch(`http://127.0.0.1:${idpPort}/health`);
      if (response.ok) body = (await response.json()) as { status?: string; service?: string };
    } catch {
      // Not listening yet.
    }
    if (body !== undefined) break;
    if (Date.now() > deadline) break;
    await Bun.sleep(50);
  }

  // The child's own output is the only thing that says *why* nothing answered
  // — "bound the loan port instead" and "crashed on startup" look identical
  // from out here. Kill it first: the pipes stay open while it runs.
  if (body === undefined) {
    child.kill();
    await child.exited;
    const [out, err] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
    ]);
    throw new Error(
      `\`${stubScript as string}\` did not answer on ${idpPort}, the port in IDENTITY_HOST.\n` +
        `stdout:\n${out}\nstderr:\n${err}`,
    );
  }

  expect(body).toEqual({ status: "ok", service: "dev-idp" });

  // And the other half of the bug: the app's port is still free, so `bun run
  // dev` can have it.
  await expect(fetch(`http://127.0.0.1:${loanPort}/health`)).rejects.toThrow();
}, 60_000);

/**
 * Unset, the loan API validates against the app itself, `localhost:$PORT`,
 * which serves the real identity provider since #6. That is the one port the
 * stub must never take (#56), so there is no default to fall back to: until #6
 * this asserted 8083, where `apps/idp` listened.
 */
test("a missing IDENTITY_HOST is refused, because the loan API's default is the app itself", () => {
  expect(() => resolveStubPort({})).toThrow(/IDENTITY_HOST is not set/);
  expect(() => resolveStubPort({ IDENTITY_HOST: "  " })).toThrow(/IDENTITY_HOST is not set/);
});

test("the port is read out of the host, in any of the forms IDENTITY_HOST takes", () => {
  expect(resolveStubPort({ IDENTITY_HOST: "localhost:4413" })).toBe(4413);
  expect(resolveStubPort({ IDENTITY_HOST: " localhost:4413 " })).toBe(4413);
  expect(resolveStubPort({ IDENTITY_HOST: "127.0.0.1:4413" })).toBe(4413);
  expect(resolveStubPort({ IDENTITY_HOST: "http://localhost:4413" })).toBe(4413);
  expect(resolveStubPort({ IDENTITY_HOST: "[::1]:4413" })).toBe(4413);
});

/**
 * The refusal matters as much as the binding. A host with no port is a real
 * identity provider somewhere else, and a stub that quietly fell back to 8083
 * there would be listening where nobody is calling — the #56 failure again,
 * wearing a different hat.
 */
test("a host with no port is refused rather than defaulted", () => {
  expect(() => resolveStubPort({ IDENTITY_HOST: "cg-idp.example.test" })).toThrow(
    /names no port/,
  );
  expect(() => resolveStubPort({ IDENTITY_HOST: "https://cg-idp.example.test" })).toThrow(
    /names no port/,
  );
});

test("the stub exits EX_CONFIG, and binds nothing, when the host names no port", async () => {
  const refused = Bun.spawn(["bun", STUB], {
    env: devEnv({ IDENTITY_HOST: "cg-idp.example.test" }),
    stdout: "pipe",
    stderr: "pipe",
  });

  const status = await refused.exited;
  const stderr = await new Response(refused.stderr as ReadableStream).text();

  // Exit status, not just the message: a script that printed this and then
  // served anyway would pass a stderr-only assertion.
  expect(status).toBe(78);
  expect(stderr).toContain("IDENTITY_HOST=cg-idp.example.test");
}, 30_000);
