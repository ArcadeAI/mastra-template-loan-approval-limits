/**
 * A fresh clone boots, and the origin trap is visible (#9).
 *
 * Both boots run the real launcher, `bun scripts/next.ts dev`, which is what
 * `bun run dev` runs, with every variable `.env.example` names passed in
 * exactly as the file has it. An empty value in the environment wins over a
 * value in a developer's `.env` or `.env.local` (Bun and Next both only fill
 * unset keys), so the child sees `cp .env.example .env` and nothing else. The
 * three database paths are the one departure: throwaway files, not the repo's.
 *
 * - Nothing filled: `/health` answers 200, `degraded`, naming each missing
 *   capability, and the issuer is the port the app bound. Before #9,
 *   `.env.example` pinned `APP_PUBLIC_HOST=localhost:3000`, and an app on any
 *   other port named `http://localhost:3000` as its issuer.
 * - `APP_PUBLIC_HOST` set: the launcher prints that URL and the tunnel command,
 *   and the home page served on another host says where to go instead. With
 *   no `BETTER_AUTH_SECRET`, identity refuses the published development
 *   secret on that host and fails closed, and `/health` says why (#9).
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { openInstructions, originMismatch } from "../lib/origin.ts";
import { childEnv } from "./child-env.ts";
import { captureOutput, retryOnPortRace, spawnChild, waitForChildHttp } from "./child.ts";

const ROOT = join(import.meta.dir, "..");
const PUBLIC = "template-test.ngrok.app";

/** Every variable `.env.example` names, as it ships: blank. */
function asCopied(): Record<string, string> {
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  return Object.fromEntries([...example.matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map(([, key]) => [key!, ""]));
}

interface Booted {
  port: number;
  origin: string;
  output(): string;
  stop(): Promise<void>;
}

const running: Booted[] = [];
afterAll(async () => {
  for (const app of running) await app.stop();
});

async function boot(extra: Record<string, string>): Promise<Booted> {
  return retryOnPortRace(async (port) => {
    const data = mkdtempSync(join(tmpdir(), "cg-fresh-clone-"));
    const distDir = `.next/cg-fresh-clone-${port}`;
    const child: Subprocess = spawnChild(["bun", "scripts/next.ts", "dev"], {
      cwd: ROOT,
      env: childEnv({
        ...asCopied(),
        NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
        PORT: String(port),
        CG_NEXT_DIST_DIR: distDir,
        GOVERNANCE_DB_PATH: join(data, "governance.db"),
        LOANS_DB_PATH: join(data, "loans.db"),
        IDP_DB_PATH: join(data, "idp.db"),
        ...extra,
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = captureOutput(child);
    const stop = async () => {
      child.kill();
      await child.exited;
      rmSync(data, { recursive: true, force: true });
      rmSync(join(ROOT, distDir), { recursive: true, force: true });
    };
    try {
      await waitForChildHttp(child, `http://127.0.0.1:${port}/health`, { output, timeoutMs: 180_000 });
    } catch (error) {
      await stop();
      throw error;
    }
    const app = { port, origin: `http://127.0.0.1:${port}`, output, stop };
    running.push(app);
    return app;
  });
}

test("a fresh clone with nothing filled boots, and /health names every missing capability", async () => {
  const app = await boot({});

  expect(app.output()).toContain(`▶ Open http://localhost:${app.port}`);

  const response = await fetch(`${app.origin}/health`);
  expect(response.status).toBe(200);
  const health = (await response.json()) as Record<string, any>;
  expect(health.status).toBe("degraded");
  for (const capability of ["signin", "gateway", "verifier", "agent"]) expect(health[capability], capability).toBe("missing");
  // What does work, works: the policy, the loan book and the identity provider all came up.
  expect(health.policy.status).toBe("ready");
  expect(health.loans).toMatchObject({ status: "ok" });
  // Nobody is seeded (#33): the identity provider is up with nobody in it, and
  // says which command adds somebody — degraded, not failed, not a crash.
  expect(health.identity).toMatchObject({
    status: "no_users",
    people: 0,
    message: "no users: run `bun run users add …` or `bun run users seed-demo`",
  });
  expect(health.warnings).toContain("no users: run `bun run users add …` or `bun run users seed-demo`");
  expect(health.control_plane.counts.subjects).toBe(0);
  // Nobody on either side is agreement, not drift.
  expect(health.user_drift).toBeNull();
  expect(health.fixture_drift).toBeNull();
  // The issuer is the app's own port, not a port pinned in a template.
  expect(health.identity.issuer).toBe(`http://localhost:${app.port}`);

  // The home page renders, with the configuration banner and no origin banner.
  const home = await (await fetch(`${app.origin}/`)).text();
  expect(home).toContain("This deployment is not fully configured");
  expect(home).not.toContain("data-origin-banner");
}, 240_000);

test("with APP_PUBLIC_HOST set, bun run dev prints it and the home page on another host says so", async () => {
  const app = await boot({ APP_PUBLIC_HOST: PUBLIC });

  expect(app.output()).toContain(`▶ Open https://${PUBLIC}`);
  expect(app.output()).toContain(`ngrok http --url=${PUBLIC} ${app.port}`);

  const wrong = await fetch(`${app.origin}/`);
  expect(wrong.status).toBe(200);
  // React separates text from an expression with `<!-- -->` in server HTML.
  const page = (await wrong.text()).replaceAll("<!-- -->", "");
  expect(page).toContain("data-origin-banner");
  expect(page).toContain(`Open this app at https://${PUBLIC}`);
  expect(page).toContain(`This page is open at <code>http://127.0.0.1:${app.port}</code>`);
  expect(page).toContain(`href="https://${PUBLIC}"`);

  // Through the tunnel, the same page carries no such banner.
  const right = await fetch(`${app.origin}/`, { headers: { "x-forwarded-host": PUBLIC, "x-forwarded-proto": "https" } });
  expect(await right.text()).not.toContain("data-origin-banner");

  // No BETTER_AUTH_SECRET on a public host (#9): identity refuses the published
  // development secret and fails closed, and /health names the reason, while
  // the rest of the app stays up.
  const health = await fetch(`${app.origin}/health`);
  expect(health.status).toBe(200);
  const body = (await health.json()) as Record<string, any>;
  expect(body.status).toBe("degraded");
  expect(body.identity.status).toBe("failed");
  expect(body.identity.error).toContain("BETTER_AUTH_SECRET is not set");
  expect(body.identity.error).toContain("the development secret is published in this repository");
  expect(body.policy.status).toBe("ready");
  const token = await fetch(`${app.origin}/oauth2/token`, { method: "POST" });
  expect(token.status).toBe(503);
  expect(await token.text()).toContain("the development secret is published in this repository");
}, 240_000);

test("originMismatch: silent without APP_PUBLIC_HOST and on the right host, specific otherwise", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);
  expect(originMismatch(headers({ host: "localhost:3000" }), {})).toBeNull();
  expect(originMismatch(headers({ host: PUBLIC }), { APP_PUBLIC_HOST: PUBLIC })).toBeNull();
  expect(originMismatch(headers({ host: "Template-Test.ngrok.app" }), { APP_PUBLIC_HOST: PUBLIC })).toBeNull();
  expect(originMismatch(headers({ host: "localhost:4400", "x-forwarded-host": PUBLIC }), { APP_PUBLIC_HOST: PUBLIC })).toBeNull();
  expect(originMismatch(headers({ host: "localhost:3000" }), { APP_PUBLIC_HOST: PUBLIC })).toEqual({
    current: "http://localhost:3000",
    expected: `https://${PUBLIC}`,
  });
  // A local APP_PUBLIC_HOST is a host too: 127.0.0.1 does not carry localhost's cookies.
  expect(originMismatch(headers({ host: "127.0.0.1:4400" }), { APP_PUBLIC_HOST: "localhost:4400" })).toEqual({
    current: "http://127.0.0.1:4400",
    expected: "http://localhost:4400",
  });
});

test("openInstructions names the one URL to open", () => {
  expect(openInstructions({}, "3000")).toStartWith("▶ Open http://localhost:3000");
  expect(openInstructions({ APP_PUBLIC_HOST: "localhost:4400" }, "4400")).toBe("▶ Open http://localhost:4400");
  const tunnel = openInstructions({ APP_PUBLIC_HOST: PUBLIC }, "4400");
  expect(tunnel).toStartWith(`▶ Open https://${PUBLIC}`);
  expect(tunnel).toContain(`ngrok http --url=${PUBLIC} 4400`);
  expect(tunnel).toContain("not on http://localhost:4400");
  expect(openInstructions({ APP_PUBLIC_HOST: "https://oops.example" }, "3000")).toStartWith("▶ APP_PUBLIC_HOST is not usable");
});
