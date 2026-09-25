/**
 * Which port `bun run arcade-stand-in` binds (#22).
 *
 * The script runs from the root, so Bun loads the root `.env.local` into it,
 * and `PORT` in that file is the app's. Until #22 the stand-in read it, so next
 * to a running `bun run dev` it died on the app's own port:
 *
 *     error: Failed to start server. Is port 4560 in use?
 *      code: "EADDRINUSE"
 *
 * #56's bug, and `gateway-stand-in`'s fix: the port comes from
 * `ARCADE_API_URL`, the address the app is told to reach Arcade at.
 *
 * These run the packaged script verbatim, from a throwaway tree whose
 * `.env.local` is written the way `scripts/orca-setup.sh` writes the root one,
 * with `PORT` held by a listener standing in for the app. `scripts/` is a link
 * to the real one, so the stand-in and its imports are the ones that ship.
 * The children get an allowlisted environment without `NODE_ENV`, because
 * under `NODE_ENV=test` Bun skips `.env.local` and the file would prove nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveOnFreePort, stopProcess } from "./cdp.ts";
import { captureOutput, spawnChild, waitForChildHttp } from "./child.ts";
import { childEnv } from "./child-env.ts";
import { REPO, readPort } from "./harness.ts";

describe("the port the stand-in binds", () => {
  let project: string;
  let app: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    const root = (await Bun.file(join(REPO, "package.json")).json()) as { scripts: Record<string, string> };
    const script = root.scripts["arcade-stand-in"];
    expect(script).toBeString();

    project = mkdtempSync(join(tmpdir(), "cg-arcade-stand-in-port-"));
    writeFileSync(
      join(project, "package.json"),
      `${JSON.stringify({ name: "cg-arcade-stand-in-port-fixture", private: true, scripts: { "arcade-stand-in": script } }, null, 2)}\n`,
    );
    symlinkSync(join(REPO, "scripts"), join(project, "scripts"));

    // The app, running: it holds the port `.env.local` calls PORT.
    app = Bun.serve({ port: 0, fetch: () => new Response("the app") });
  });

  afterAll(() => {
    app?.stop(true);
    if (project !== undefined) rmSync(project, { recursive: true, force: true });
  });

  const envFile = (lines: Record<string, string>) =>
    writeFileSync(
      join(project, ".env.local"),
      Object.entries(lines)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );

  const packaged = () =>
    spawnChild(["bun", "run", "--cwd", project, "arcade-stand-in"], {
      env: childEnv({}),
      stdout: "pipe",
      stderr: "pipe",
    });

  test("next to a running app, it leaves the app's PORT alone and binds one of its own", async () => {
    envFile({ PORT: String(app.port), APP_PUBLIC_HOST: `localhost:${app.port}` });

    const child = packaged();
    try {
      const boot = await readPort(child).catch(async (error: unknown) => {
        // The old behaviour lands here: the child exits on EADDRINUSE without
        // a banner, and its stderr is the only thing that says so.
        throw new Error(`${(error as Error).message}\n${await new Response(child.stderr).text()}`);
      });
      expect(boot.port).not.toBe(app.port);
      await waitForChildHttp(child, `http://127.0.0.1:${boot.port}/`);
      expect(boot.banner).toContain(`ARCADE_API_URL=http://localhost:${boot.port}`);

      // And the app still has its port.
      expect(await (await fetch(`http://127.0.0.1:${app.port}/`)).text()).toBe("the app");
    } finally {
      await stopProcess(child);
    }
  }, 30_000);

  test("ARCADE_API_URL decides the port, whatever PORT says", async () => {
    const booted = await serveOnFreePort(
      (port) => {
        envFile({
          PORT: String(app.port),
          APP_PUBLIC_HOST: `localhost:${app.port}`,
          ARCADE_API_URL: `http://localhost:${port}`,
        });
        return packaged();
      },
      { timeoutMs: 20_000 },
    );
    try {
      expect(booted.port).not.toBe(app.port);
      expect(booted.output()).toContain(`listening on :${booted.port}`);
    } finally {
      await stopProcess(booted.child);
    }
  }, 60_000);

  test("an ARCADE_API_URL with no port is refused with EX_CONFIG, and nothing is bound", async () => {
    // Real Arcade on 443 is not something this stands in for, and a default
    // would bind a port nothing is calling and look like it worked.
    envFile({ PORT: String(app.port), ARCADE_API_URL: "https://api.arcade.dev" });

    const child = packaged();
    const output = captureOutput(child);
    const status = await child.exited;
    await Bun.sleep(50);

    // The exit status, not only the message: a script that printed this and
    // then served anyway would pass a stderr-only assertion.
    expect(status).toBe(78);
    expect(output()).toContain("ARCADE_API_URL=https://api.arcade.dev names no port");
    expect(output()).not.toContain("listening on");
  }, 30_000);
});
