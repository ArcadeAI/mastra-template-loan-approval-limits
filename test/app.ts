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
 * handed out, never a guess.
 */
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** A port the OS says is free, rather than a guess. `conftest.py::_free_port`. */
export function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") throw new Error(`Bun.serve({ port: 0 }) reported no port (got ${String(port)})`);
  return port;
}

export async function bootApp(env: Record<string, string>): Promise<App> {
  const port = freePort();
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const data = mkdtempSync(join(tmpdir(), "cg-reset-app-"));
  const distDir = `.next/cg-reset-${port}`;

  // Anything the developer's own shell carries for the app is deliberately
  // dropped: a PERSONA_* or an IDP_* from a local run would make these tests
  // about their environment, and a host or database path would point the app
  // somewhere else.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.startsWith("PERSONA_") &&
        !key.startsWith("IDP_") &&
        !key.endsWith("_PUBLIC_HOST") &&
        !key.endsWith("_DB_PATH") &&
        !["RESET_TOKEN", "IDENTITY_HOST", "CONTROL_PLANE_HOST", "GOVERNANCE_STREAM"].includes(key),
    ),
  ) as Record<string, string>;

  let output = "";
  const child = Bun.spawn(["bun", "scripts/next.ts", "dev"], {
    cwd: ROOT,
    env: {
      ...inherited,
      NODE_ENV: "development",
      PORT: String(port),
      CG_NEXT_DIST_DIR: distDir,
      NEXT_TELEMETRY_DISABLED: "1",
      APP_PUBLIC_HOST: host,
      GOVERNANCE_DB_PATH: join(data, "governance.db"),
      LOANS_DB_PATH: join(data, "loans.db"),
      IDP_DB_PATH: join(data, "idp.db"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const stream of [child.stdout, child.stderr]) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream as ReadableStream<Uint8Array>) output += decoder.decode(chunk, { stream: true });
    })();
  }

  const stop = async () => {
    child.kill();
    await child.exited;
    rmSync(data, { recursive: true, force: true });
    rmSync(join(ROOT, distDir), { recursive: true, force: true });
  };

  // Up means every module answered, not just the page: the three `/health`
  // routes are what the reset tests read back.
  const deadline = Date.now() + BOOT_MS;
  for (;;) {
    try {
      const answers = await Promise.all(
        ["/hooks/health", "/bank/health", "/identity/health"].map((path) => fetch(`${origin}${path}`)),
      );
      if (answers.every((answer) => answer.ok)) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the app did not come up:\n${output}`);
    }
    await Bun.sleep(250);
  }

  return { origin, host, child, output: () => output, stop };
}
