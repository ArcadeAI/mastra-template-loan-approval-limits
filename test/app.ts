/**
 * The app, booted for the reset tests: one process, one port, every module.
 *
 * Until #6 these tests booted three services — `apps/idp`, the control plane
 * and the loan module, each on its own port — and handed the reset command a
 * host for each. The identity provider was the last of them to fold in, so
 * the command now resets all three modules at one address, `APP_PUBLIC_HOST`,
 * and this is that address: the real app, under `next dev`, the way a
 * presenter runs it, with its own throwaway `governance.db`, `loans.db` and
 * `idp.db`.
 *
 * Its own `distDir` (`CG_NEXT_DIST_DIR`, as `app-test/control-plane-app.test.ts`
 * does), so it does not fight another `next dev` over `.next`. A port the OS
 * handed out, never a guess, and handed out again if somebody else took it (#9).
 */
import type { Subprocess } from "bun";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveOnFreePort, type Booted } from "../app-test/cdp.ts";
import { spawnChild } from "../app-test/child.ts";
import { childEnv } from "../app-test/child-env.ts";

const ROOT = join(import.meta.dir, "..");
const BOOT_MS = 180_000;

export interface App {
  origin: string;
  /** HOST-form, what the reset command is handed. */
  host: string;
  child: Subprocess;
  /** Everything the app printed, for a failure message. */
  output(): string;
  stop(): Promise<void>;
}

export async function bootApp(env: Record<string, string>): Promise<App> {
  const data = mkdtempSync(join(tmpdir(), "cg-reset-app-"));
  const distDirs: string[] = [];
  const cleanup = () => {
    rmSync(data, { recursive: true, force: true });
    for (const distDir of distDirs) rmSync(join(ROOT, distDir), { recursive: true, force: true });
  };

  // An allowlist, not the developer's shell minus some of it (`child-env.ts`):
  // a PERSONA_* or an IDP_* from a local run would make these tests about
  // their environment, and a host or database path would point the app
  // somewhere else.
  //
  // The port is chosen inside `serveOnFreePort`, which starts the app again on
  // a new one if another process took it first (#9); each attempt gets its own
  // databases and `distDir`. Up means every module answered, not just the
  // page: the three `/health` routes are what the reset tests read back.
  let booted: Booted;
  try {
    booted = await serveOnFreePort(
      (port) => {
        const dir = join(data, String(port));
        mkdirSync(dir);
        const distDir = `.next/cg-reset-${port}`;
        distDirs.push(distDir);
        return spawnChild(["bun", "scripts/next.ts", "dev"], {
          cwd: ROOT,
          env: childEnv({
            NODE_ENV: "development",
            PORT: String(port),
            CG_NEXT_DIST_DIR: distDir,
            NEXT_TELEMETRY_DISABLED: "1",
            APP_PUBLIC_HOST: `127.0.0.1:${port}`,
            GOVERNANCE_DB_PATH: join(dir, "governance.db"),
            LOANS_DB_PATH: join(dir, "loans.db"),
            IDP_DB_PATH: join(dir, "idp.db"),
            ...env,
          }),
          stdout: "pipe",
          stderr: "pipe",
        });
      },
      {
        ready: async (port) => {
          const answers = await Promise.all(
            ["/hooks/health", "/bank/health", "/identity/health"].map((path) => fetch(`http://127.0.0.1:${port}${path}`)),
          );
          return answers.every((answer) => answer.ok);
        },
        timeoutMs: BOOT_MS,
      },
    );
  } catch (error) {
    cleanup();
    throw new Error(`the app did not come up: ${(error as Error).message}`, { cause: error });
  }

  const { child, port, output } = booted;
  const host = `127.0.0.1:${port}`;
  const stop = async () => {
    child.kill();
    await child.exited;
    cleanup();
  };
  return { origin: `http://${host}`, host, child, output, stop };
}
