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
 * Since #36 it also holds a two-turn thread through Studio's own API, which
 * is the one place Studio's memory runs as it ships: bundled by `mastra dev`,
 * opening libsql under Node, from a working directory inside `.mastra/`.
 *
 * Nothing leaves the machine. Arcade is the identity suite's stand-in,
 * `MASTRA_SKIP_DOTENV` keeps a developer's own `.env.local` out of it,
 * `MASTRA_TELEMETRY_DISABLED` keeps the CLI from reporting the run, and the
 * model's base URL is a local stand-in for Anthropic's Messages API that
 * records each request and answers with a fixed sentence.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Subprocess } from "bun";

import { serveOnFreePort } from "./cdp.ts";
import { freePort, spawnChild } from "./child.ts";
import { GATEWAY_ID, startArcadeStandIn, type ArcadeStandIn } from "./identity-harness.ts";
import { AGENT_ID, INSTRUCTIONS } from "../lib/agent/agent.ts";
import { STUDIO_AUTHORIZE_PATH, STUDIO_CALLBACK_PATH } from "../lib/agent/studio.ts";

const REPO = join(import.meta.dir, "..");
/** Bundling the entry is the slow part: measured at 10 to 20 seconds on a laptop. */
const BOOT_TIMEOUT_MS = 120_000;

let arcade: ArcadeStandIn;
let studio: Subprocess;
let port: number;

/**
 * Studio's memory store for this run (#36), given as a **relative** path, so the
 * test also shows what it resolves against. Under the gitignored
 * `.test-fixtures/`, and removed afterwards.
 */
const MEMORY_DIR = join(".test-fixtures", `studio-dev-memory-${crypto.randomUUID()}`);
const MEMORY_DB = join(MEMORY_DIR, "memory.db");

/** Every request Studio's model made, as the Messages API received it. */
const modelRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
let anthropic: ReturnType<typeof Bun.serve>;

/**
 * Anthropic's Messages API, as far as `@ai-sdk/anthropic` reaches it: one
 * sentence back, streamed or not, whatever was asked.
 */
function startAnthropicStandIn() {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/messages") return new Response("Not found", { status: 404 });
      const body = (await request.json()) as { stream?: boolean; messages: Array<{ role: string; content: unknown }> };
      modelRequests.push(body);
      const text = `Reply ${modelRequests.length}.`;
      const usage = { input_tokens: 1, output_tokens: 1 };
      if (!body.stream) {
        return Response.json({
          id: `msg_${modelRequests.length}`, type: "message", role: "assistant", model: "claude-sonnet-5",
          content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage,
        });
      }
      const events: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message: { id: `msg_${modelRequests.length}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
}

/** Every file named `name` under `dir`, relative to the repo. */
function findFiles(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : findFiles(path, name);
    return entry === name ? [relative(REPO, path)] : [];
  });
}

beforeAll(async () => {
  arcade = startArcadeStandIn();
  anthropic = startAnthropicStandIn();
  // On a port chosen inside `serveOnFreePort`, which starts Studio again on a
  // new one if another process took it first (#9). A Studio that exits first
  // fails the wait at once, with its output.
  const booted = await serveOnFreePort(
    (studioPort) =>
      // `bun run studio`, the command a developer types, which is `mastra dev`.
      spawnChild(["bun", "run", "studio"], {
        cwd: REPO,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          MASTRA_SKIP_DOTENV: "1",
          MASTRA_TELEMETRY_DISABLED: "1",
          STUDIO_PORT: String(studioPort),
          // What `mastra dev` would otherwise have read from the root `.env.local`,
          // and the reason `STUDIO_PORT` exists: Mastra's own fallback is `PORT`.
          PORT: String(freePort()),
          ARCADE_API_URL: arcade.url,
          ARCADE_GATEWAY_ID: GATEWAY_ID,
          ARCADE_LOAN_TOOLKIT: "Loan",
          ARCADE_APPROVALS_TOOLKIT: "Approvals",
          ANTHROPIC_API_KEY: "anthropic-key-for-studio-dev-tests",
          ANTHROPIC_BASE_URL: `http://localhost:${anthropic.port}`,
          MEMORY_DB_PATH: MEMORY_DB,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    {
      ready: async (studioPort) => (await fetch(`http://localhost:${studioPort}/api/agents`)).ok,
      timeoutMs: BOOT_TIMEOUT_MS - 5_000,
    },
  );
  studio = booted.child;
  port = booted.port;
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  studio?.kill("SIGTERM");
  await studio?.exited;
  arcade?.stop();
  anthropic?.stop(true);
  rmSync(join(REPO, MEMORY_DIR), { recursive: true, force: true });
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

test("a thread in Studio remembers its first turn, in a memory.db beside the other databases", async () => {
  // Hop 1 ran in the test above; the grant is this Studio process's.
  const thread = `studio-dev-${crypto.randomUUID()}`;
  const turn = async (content: string) => {
    const response = await fetch(`http://localhost:${port}/api/agents/${AGENT_ID}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // What Studio's chat sends: one message, and the thread it belongs to.
      body: JSON.stringify({ messages: [{ role: "user", content }], memory: { thread, resource: AGENT_ID } }),
    });
    const body = await response.text();
    expect({ status: response.status, body: response.ok ? "" : body.slice(0, 600) }).toEqual({ status: 200, body: "" });
  };

  const before = modelRequests.length;
  await turn("get me the 95k loan");
  await turn("do it");
  const [first, second] = modelRequests.slice(before);
  expect(first).toBeDefined();
  expect(second).toBeDefined();

  // Turn 2 was handed turn 1, both halves, once each, and then its own message.
  const said = (request: typeof first) =>
    request!.messages.map((message) => [
      message.role,
      typeof message.content === "string"
        ? message.content
        : (message.content as Array<{ type: string; text?: string }>).filter((part) => part.type === "text").map((part) => part.text).join(""),
    ]);
  expect(said(first)).toEqual([["user", "get me the 95k loan"]]);
  const reply = said(first).length === 1 ? `Reply ${modelRequests.indexOf(first!) + 1}.` : "";
  expect(said(second)).toEqual([
    ["user", "get me the 95k loan"],
    ["assistant", reply],
    ["user", "do it"],
  ]);

  // Where Studio put it: the relative path against the project `bun run
  // studio` ran in, and nowhere under `src/` or `.mastra/`, the two
  // directories `mastra dev` runs its server from. The first version of #36
  // put it in `src/mastra/public/`, and this is what found that.
  expect(existsSync(join(REPO, MEMORY_DB))).toBe(true);
  expect([...findFiles(join(REPO, "src"), "memory.db"), ...findFiles(join(REPO, ".mastra"), "memory.db")]).toEqual([]);
}, BOOT_TIMEOUT_MS);
