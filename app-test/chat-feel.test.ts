/**
 * #37 — the chat as a conversation, through the real `Chat` component.
 *
 * Launches `chat-feel-worker.tsx` in a Bun test worker of its own, for the
 * reason `chat-conversation.test.tsx` gives: happy-dom's globals are shared
 * between files in one runner. The worker's own pass count is checked, so a
 * worker that ran nothing is a failure here rather than a pass.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

import { spawnChild } from "./child.ts";

/** The tests in the worker. A change in the count is a change in coverage, and should be seen. */
const WORKER_TESTS = 11;

test("the real chat, stepped event by event, runs in an isolated DOM worker", async () => {
  const workerPath = join(import.meta.dir, "chat-feel-worker.tsx");
  const worker = spawnChild({
    cmd: ["bun", "test", "--isolate", workerPath],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_ENV: "test" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
  ]);
  const exitCode = await worker.exited;
  if (exitCode !== 0) {
    throw new Error(`chat feel worker exited ${exitCode}\n${stdout}\n${stderr}`);
  }
  const output = `${stdout}\n${stderr}`;
  expect(output).toMatch(new RegExp(`\\b${WORKER_TESTS} pass\\b`));
  expect(output).toMatch(/\b0 fail\b/);
}, 120_000);
