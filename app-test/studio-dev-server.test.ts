/**
 * `mastra dev`, booted for real, lists the agent — and lists its tools once
 * Studio has run hop 1.
 *
 * `studio-entry.test.ts` imports `src/mastra/index.ts` in-process. This file
 * runs the thing a developer runs: the Mastra CLI bundles the entry, starts
 * Studio's server under Node, and answers Studio's own API. Two failures are
 * only visible this way and both have happened: the bundler cannot load
 * (TypeScript 7 has no JavaScript API, #8), and Studio binds the app's `PORT`
 * because `mastra dev` loads the root `.env.local`.
 *
 * Nothing leaves the machine. Arcade is the identity suite's stand-in,
 * `MASTRA_SKIP_DOTENV` keeps a developer's own `.env.local` out of it,
 * `MASTRA_TELEMETRY_DISABLED` keeps the CLI from reporting the run, and the
 * model's base URL is a closed local port.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { freePort, GATEWAY_ID, startArcadeStandIn, type ArcadeStandIn } from "./identity-harness.ts";
import { AGENT_ID, INSTRUCTIONS } from "../lib/agent/agent.ts";
import { STUDIO_AUTHORIZE_PATH, STUDIO_CALLBACK_PATH } from "../lib/agent/studio.ts";

const REPO = join(import.meta.dir, "..");
/** Bundling the entry is the slow part: measured at 10 to 20 seconds on a laptop. */
const BOOT_TIMEOUT_MS = 120_000;

let arcade: ArcadeStandIn;
let studio: Subprocess<"ignore", "pipe", "pipe">;
let port: number;
let log = "";

beforeAll(async () => {
  arcade = startArcadeStandIn();
  port = freePort();
  // `bun run studio`, the command a developer types, which is `mastra dev`.
  studio = Bun.spawn(["bun", "run", "studio"], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      MASTRA_SKIP_DOTENV: "1",
      MASTRA_TELEMETRY_DISABLED: "1",
      STUDIO_PORT: String(port),
      // What `mastra dev` would otherwise have read from the root `.env.local`,
      // and the reason `STUDIO_PORT` exists: Mastra's own fallback is `PORT`.
      PORT: String(freePort()),
      ARCADE_API_URL: arcade.url,
      ARCADE_GATEWAY_ID: GATEWAY_ID,
      ARCADE_LOAN_TOOLKIT: "Loan",
      ARCADE_APPROVALS_TOOLKIT: "Approvals",
      ANTHROPIC_API_KEY: "anthropic-key-for-studio-dev-tests",
      ANTHROPIC_BASE_URL: `http://localhost:${freePort()}`,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const stream of [studio.stdout, studio.stderr]) {
    void (async () => {
      for await (const chunk of stream) log += new TextDecoder().decode(chunk);
    })();
  }

  const deadline = Date.now() + BOOT_TIMEOUT_MS - 5_000;
  while (Date.now() < deadline) {
    if (studio.exitCode !== null) break;
    const up = await fetch(`http://localhost:${port}/api/agents`).catch(() => null);
    if (up?.ok) return;
    await Bun.sleep(500);
  }
  throw new Error(`mastra dev did not answer on :${port} (exit ${studio.exitCode}). Its output:\n${log}`);
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  studio?.kill("SIGTERM");
  await studio?.exited;
  arcade?.stop();
});

test("Studio lists the agent, with the chat route's instructions, on STUDIO_PORT", async () => {
  const response = await fetch(`http://localhost:${port}/api/agents`);
  expect(response.status).toBe(200);
  const agents = (await response.json()) as Record<string, { name?: string; instructions?: unknown }>;
  expect(Object.keys(agents)).toEqual([AGENT_ID]);
  expect(agents[AGENT_ID]!.instructions).toBe(INSTRUCTIONS);
}, BOOT_TIMEOUT_MS);

test("before hop 1, a turn in Studio fails and names the route that fixes it", async () => {
  const response = await fetch(`http://localhost:${port}/api/agents/${AGENT_ID}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "Which loans are pending?" }] }),
  });
  const body = await response.text();
  console.log(`[studio-dev] generate before hop 1 -> ${response.status} ${body.slice(0, 400)}`);
  expect(response.ok).toBe(false);
  expect(response.status).toBe(500);
  expect(body).toContain(
    `Studio has no gateway token: nobody has authorized this Studio process yet. To authorize, open http://localhost:${port}${STUDIO_AUTHORIZE_PATH} and sign in.`,
  );
}, BOOT_TIMEOUT_MS);

test("after hop 1 through Studio's own routes, Studio lists the gateway's tools", async () => {
  const start = await fetch(`http://localhost:${port}${STUDIO_AUTHORIZE_PATH}`, { redirect: "manual" });
  expect(start.status).toBe(303);
  const consent = await fetch(new URL(start.headers.get("location")!), { method: "POST", redirect: "manual" });
  const callback = new URL(consent.headers.get("location")!);
  expect(`${callback.origin}${callback.pathname}`).toBe(`http://localhost:${port}${STUDIO_CALLBACK_PATH}`);
  const landed = await fetch(callback, { redirect: "manual" });
  expect(landed.status).toBe(200);

  const response = await fetch(`http://localhost:${port}/api/agents/${AGENT_ID}`);
  expect(response.status).toBe(200);
  const agent = (await response.json()) as { tools?: Record<string, unknown> };
  // The stand-in advertises one tool. The full six, compared against the chat
  // route's, is `studio-entry.test.ts`.
  expect(Object.keys(agent.tools ?? {})).toEqual(["Loan_GetLoan"]);
  expect(arcade.bearers.at(-1)).toBe(arcade.issued.at(-1));
}, BOOT_TIMEOUT_MS);
