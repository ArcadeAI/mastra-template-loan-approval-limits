/**
 * `bun run dev:idp-stub` has to bind the identity provider's port, not this
 * service's own.
 *
 * The stub lives under `apps/loan-app/scripts/` and the root script runs it
 * with `--cwd apps/loan-app`, so Bun loads `apps/loan-app/.env.local` into it.
 * Until #56 it took `PORT` from that file — the loan API's port. In a worktree
 * owning 4410-4419 both processes wanted 4412, and `IDP_PUBLIC_HOST` pointed
 * at 4413 where nothing was listening. Sibling of `apps/web/test/dev-port.test.ts`
 * (#50): same family of silent misbinding, different cause — that one was a
 * shell expanding `${PORT:-3000}` before anything read the file, this one read
 * the right file for the wrong service.
 *
 * The first test therefore runs the *packaged* scripts, verbatim, from both
 * manifests, in a throwaway tree whose `.env.local` carries a `PORT` and an
 * `IDP_PUBLIC_HOST` that disagree. Only one of them can be the one it binds.
 */
import { afterAll, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveStubPort } from "../scripts/dev-idp.ts";

const LOAN_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(LOAN_ROOT, "..", "..");
const STUB = join(LOAN_ROOT, "scripts", "dev-idp.ts");

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
 * `bun test` sets `NODE_ENV=test`, and under it Bun skips `.env.local`
 * entirely — a real dev server's environment is the one without it. `PORT` is
 * dropped too: the whole question is which of two values in the file the stub
 * picks, so neither may reach it from the caller. Measured on #50.
 */
function devEnv(extra: Record<string, string> = {}): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && key !== "PORT" && key !== "NODE_ENV",
    ),
  ) as Record<string, string>;
  return { ...inherited, ...extra };
}

let child: Subprocess | undefined;
let project: string | undefined;

afterAll(() => {
  child?.kill();
  if (project !== undefined) rmSync(project, { recursive: true, force: true });
});

test("the packaged dev:idp-stub script binds IDP_PUBLIC_HOST's port, not PORT", async () => {
  const idpPort = freePort();
  const loanPort = freePort();
  expect(idpPort).not.toBe(loanPort);

  const root = await manifestAt(REPO_ROOT);
  const loanApp = await manifestAt(LOAN_ROOT);
  const stubScript = root.scripts?.["dev:idp-stub"];
  const devIdp = loanApp.scripts?.["dev:idp"];
  expect(stubScript).toBeString();
  expect(devIdp).toBeString();

  // Both manifests, reproduced with the real script strings, so the test
  // exercises the whole chain: the root script's `--cwd`, which decides which
  // `.env.local` Bun loads, and the service script it delegates to.
  project = mkdtempSync(join(tmpdir(), "cg-dev-idp-port-"));
  const service = join(project, "apps", "loan-app");
  mkdirSync(service, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify(
      { name: "cg-dev-idp-port-fixture", private: true, scripts: { "dev:idp-stub": stubScript } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(service, "package.json"),
    `${JSON.stringify(
      {
        name: "cg-dev-idp-port-service",
        private: true,
        type: "module",
        scripts: { "dev:idp": devIdp },
      },
      null,
      2,
    )}\n`,
  );
  cpSync(join(LOAN_ROOT, "scripts"), join(service, "scripts"), { recursive: true });

  // The only two ports in the fixture, and they disagree on purpose: `PORT` is
  // the loan API's, the way `scripts/orca-setup.sh` writes it.
  writeFileSync(
    join(service, ".env.local"),
    `PORT=${loanPort}\nIDP_PUBLIC_HOST=localhost:${idpPort}\n`,
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
      `\`${stubScript as string}\` did not answer on ${idpPort}, the port in IDP_PUBLIC_HOST.\n` +
        `stdout:\n${out}\nstderr:\n${err}`,
    );
  }

  expect(body).toEqual({ status: "ok", service: "dev-idp" });

  // And the other half of the bug: the loan API's port is still free, so
  // `dev:loan-app` can have it.
  await expect(fetch(`http://127.0.0.1:${loanPort}/health`)).rejects.toThrow();
}, 60_000);

test("a missing IDP_PUBLIC_HOST falls back to the same default the loan API uses", () => {
  expect(resolveStubPort({})).toBe(8083);
  expect(resolveStubPort({ IDP_PUBLIC_HOST: "  " })).toBe(8083);
});

test("the port is read out of the host, in any of the forms IDP_PUBLIC_HOST takes", () => {
  expect(resolveStubPort({ IDP_PUBLIC_HOST: "localhost:4413" })).toBe(4413);
  expect(resolveStubPort({ IDP_PUBLIC_HOST: " localhost:4413 " })).toBe(4413);
  expect(resolveStubPort({ IDP_PUBLIC_HOST: "127.0.0.1:4413" })).toBe(4413);
  expect(resolveStubPort({ IDP_PUBLIC_HOST: "http://localhost:4413" })).toBe(4413);
  expect(resolveStubPort({ IDP_PUBLIC_HOST: "[::1]:4413" })).toBe(4413);
});

/**
 * The refusal matters as much as the binding. A host with no port is a real
 * identity provider somewhere else, and a stub that quietly fell back to 8083
 * there would be listening where nobody is calling — the #56 failure again,
 * wearing a different hat.
 */
test("a host with no port is refused rather than defaulted", () => {
  expect(() => resolveStubPort({ IDP_PUBLIC_HOST: "cg-idp.example.test" })).toThrow(
    /names no port/,
  );
  expect(() => resolveStubPort({ IDP_PUBLIC_HOST: "https://cg-idp.example.test" })).toThrow(
    /names no port/,
  );
});

test("the stub exits EX_CONFIG, and binds nothing, when the host names no port", async () => {
  const refused = Bun.spawn(["bun", STUB], {
    env: devEnv({ IDP_PUBLIC_HOST: "cg-idp.example.test" }),
    stdout: "pipe",
    stderr: "pipe",
  });

  const status = await refused.exited;
  const stderr = await new Response(refused.stderr as ReadableStream).text();

  // Exit status, not just the message: a script that printed this and then
  // served anyway would pass a stderr-only assertion.
  expect(status).toBe(78);
  expect(stderr).toContain("IDP_PUBLIC_HOST=cg-idp.example.test");
}, 30_000);
