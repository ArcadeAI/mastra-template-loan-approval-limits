/**
 * `bun run dev` refuses a port that anything answers on, on either loopback address (#30).
 *
 * On the third live run (#7) another project's `astro dev` held `[::1]:3000`
 * and nothing held `127.0.0.1:3000`. Next bound `*:3000` without an error, and
 * ngrok reached Astro. The README had promised "a taken port is an error".
 *
 * Each test holds one loopback address only, then runs the real launcher,
 * `bun scripts/next.ts dev`, on that port. The launcher has to exit non-zero
 * before Next starts, and say which port, where it is held, and the fix. Before
 * #30 it started Next, which bound the port, and the wait for an exit timed out.
 *
 * The launcher's environment is allowlisted and its databases and build
 * directory are throwaway, so a launcher that wrongly starts Next writes
 * nothing into the repo.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childEnv } from "./child-env.ts";
import { captureOutput, spawnChild } from "./child.ts";

const ROOT = join(import.meta.dir, "..");
/** Long enough for the check, far shorter than a Next boot on the old launcher. */
const EXIT_TIMEOUT_MS = 20_000;

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

/** A listener on one address only, the way `astro dev` held `[::1]`. */
function holdOnly(hostname: "::1" | "127.0.0.1") {
  const listener = Bun.listen({ hostname, port: 0, socket: { data() {} } });
  cleanups.push(() => listener.stop(true));
  return listener;
}

/** Whether a connection to `host:port` is answered. */
function answers(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function launch(port: number): Promise<{ code: number | null; output: string }> {
  const data = mkdtempSync(join(tmpdir(), "cg-dev-port-taken-"));
  const distDir = `.next/cg-dev-port-taken-${port}`;
  cleanups.push(() => {
    rmSync(data, { recursive: true, force: true });
    rmSync(join(ROOT, distDir), { recursive: true, force: true });
  });
  const child = spawnChild(["bun", "scripts/next.ts", "dev"], {
    cwd: ROOT,
    env: childEnv({
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(port),
      CG_NEXT_DIST_DIR: distDir,
      GOVERNANCE_DB_PATH: join(data, "governance.db"),
      LOANS_DB_PATH: join(data, "loans.db"),
      IDP_DB_PATH: join(data, "idp.db"),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = captureOutput(child);
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(EXIT_TIMEOUT_MS).then(() => false)]);
  if (!exited) {
    child.kill();
    await child.exited;
    throw new Error(`the launcher was still running ${EXIT_TIMEOUT_MS}ms after it was given port ${port}, which is held:\n${output()}`);
  }
  await Bun.sleep(50);
  return { code: child.exitCode, output: output() };
}

test("a port held only on [::1] is refused, with the port, the address and the fix", async () => {
  const listener = holdOnly("::1");
  const { port } = listener;
  // The shape of the live failure: [::1] answers and 127.0.0.1 does not.
  expect(await answers("::1", port)).toBe(true);
  expect(await answers("127.0.0.1", port)).toBe(false);

  const run = await launch(port);
  console.log(`[dev-port-taken] [::1]:${port} held -> exit ${run.code}\n${run.output.trim()}`);
  expect(run.code).toBe(1);
  expect(run.output).toContain(`Port ${port} is already in use: something is listening on [::1]:${port}.`);
  expect(run.output).toContain(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  expect(run.output).toContain("set PORT in .env to a free port");
  // Refused before Next was started, not by Next.
  expect(run.output).not.toMatch(/Next\.js|EADDRINUSE/);
}, 60_000);

test("a port held only on 127.0.0.1 is refused the same way", async () => {
  const listener = holdOnly("127.0.0.1");
  const { port } = listener;

  const run = await launch(port);
  expect(run.code).toBe(1);
  expect(run.output).toContain(`Port ${port} is already in use: something is listening on 127.0.0.1:${port}.`);
  expect(run.output).not.toMatch(/Next\.js|EADDRINUSE/);
}, 60_000);
