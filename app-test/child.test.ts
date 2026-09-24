/**
 * `app-test/child.ts`: every child dies with its test, and a lost port race is
 * retried (#9).
 *
 * The first test is the one the old harnesses fail. It runs a stand-in harness
 * in a process of its own, has it start a launcher that starts a grandchild
 * (the shape of `bun scripts/next.ts dev`), and then kills the harness with
 * SIGKILL, so no `afterAll`, `exit` handler or signal handler in it runs. With
 * `Bun.spawn`, which every harness used before #9, both descendants survive;
 * the test asserts that too, as its control, then stops them itself.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childEnv } from "./child-env.ts";
import { captureOutput, freePort, liveChildren, retryOnPortRace, spawnChild, waitForChildHttp } from "./child.ts";

const CHILD = join(import.meta.dir, "child.ts");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cg-child-")));
const strays: number[] = [];

afterAll(() => {
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}

/** A launcher that starts a grandchild and records both pids, then waits. */
function writeLauncher(dir: string): string {
  writeFileSync(join(dir, "sleeper.ts"), "setInterval(() => {}, 1000);\n");
  const launcher = join(dir, "launcher.ts");
  writeFileSync(
    launcher,
    `const grandchild = Bun.spawn(["bun", ${JSON.stringify(join(dir, "sleeper.ts"))}], { stdio: ["ignore", "ignore", "ignore"] });
await Bun.write(${JSON.stringify(join(dir, "pids"))}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
`,
  );
  return launcher;
}

async function readPids(dir: string): Promise<{ child: number; grandchild: number }> {
  const file = join(dir, "pids");
  if (!(await until(() => existsSync(file) && readFileSync(file, "utf8").length > 0, 10_000))) {
    throw new Error(`the launcher in ${dir} never wrote its pids`);
  }
  const pids = JSON.parse(readFileSync(file, "utf8")) as { child: number; grandchild: number };
  strays.push(pids.child, pids.grandchild);
  return pids;
}

/** A stand-in harness, in its own process: starts the launcher one way or the other and waits to be killed. */
function runHarness(dir: string, how: "spawnChild" | "Bun.spawn"): ReturnType<typeof Bun.spawn> {
  const launcher = writeLauncher(dir);
  const harness = join(dir, "harness.ts");
  writeFileSync(
    harness,
    how === "spawnChild"
      ? `import { spawnChild } from ${JSON.stringify(CHILD)};
spawnChild(["bun", ${JSON.stringify(launcher)}], { stdio: ["ignore", "ignore", "ignore"] });
setInterval(() => {}, 1000);
`
      : `Bun.spawn(["bun", ${JSON.stringify(launcher)}], { stdio: ["ignore", "ignore", "ignore"] });
setInterval(() => {}, 1000);
`,
  );
  return Bun.spawn(["bun", "--no-env-file", harness], { cwd: dir, env: childEnv({}), stdio: ["ignore", "ignore", "ignore"] });
}

test("a child and its grandchild die when the test process is SIGKILLed", async () => {
  const supervised = mkdtempSync(join(scratch, "supervised-"));
  const plain = mkdtempSync(join(scratch, "plain-"));
  const harnesses = [runHarness(supervised, "spawnChild"), runHarness(plain, "Bun.spawn")];
  const [kept, orphaned] = await Promise.all([readPids(supervised), readPids(plain)]);
  for (const pid of [kept.child, kept.grandchild, orphaned.child, orphaned.grandchild]) expect(alive(pid)).toBe(true);

  for (const harness of harnesses) harness.kill("SIGKILL");
  await Promise.all(harnesses.map((harness) => harness.exited));

  // The supervisor polls every 200ms and gives the group 3s after SIGTERM.
  await until(() => !alive(kept.child) && !alive(kept.grandchild), 6_000);
  expect(alive(kept.child), "the supervised child outlived its test process").toBe(false);
  expect(alive(kept.grandchild), "the supervised grandchild outlived its test process").toBe(false);

  // Control: the old way leaves both running. If this ever fails, the test
  // above has stopped proving anything.
  expect(alive(orphaned.child)).toBe(true);
  expect(alive(orphaned.grandchild)).toBe(true);
}, 30_000);

test("kill() stops the whole group, not just the process it spawned", async () => {
  const dir = mkdtempSync(join(scratch, "group-"));
  const child = spawnChild(["bun", writeLauncher(dir)], { env: childEnv({}), stdio: ["ignore", "ignore", "ignore"] });
  const { grandchild } = await readPids(dir);
  expect(alive(grandchild)).toBe(true);

  child.kill();
  await child.exited;

  expect(await until(() => !alive(grandchild), 5_000)).toBe(true);
  expect(liveChildren()).toBe(0);
}, 30_000);

test("the child sees exactly the environment it was given, not the supervisor's .env files", async () => {
  const dir = mkdtempSync(join(scratch, "env-"));
  // A developer's file in the child's working directory. The supervisor must
  // not read it and pass it on; a `bun` command would load it itself, so the
  // probe is `node`, which does not.
  writeFileSync(join(dir, ".env"), "CG_FROM_DOT_ENV=leaked\n");
  const child = spawnChild(["node", "-e", "console.log(JSON.stringify(process.env.CG_FROM_DOT_ENV ?? null))"], {
    cwd: dir,
    env: childEnv({}),
    stdout: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect((await new Response(child.stdout as ReadableStream).text()).trim()).toBe("null");
});

test("a lost port race is retried on a new port, and the child that answers is ours", async () => {
  const dir = mkdtempSync(join(scratch, "race-"));
  const server = join(dir, "server.ts");
  writeFileSync(
    server,
    `Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response(process.env.NONCE) });\n`,
  );
  // Somebody else took the port between the probe and the bind.
  const thief = Bun.serve({ port: 0, fetch: () => new Response("not yours", { status: 503 }) });
  const taken = thief.port!;
  const handed = [taken];

  const boot = async (port: number) => {
    const child = spawnChild(["bun", server], {
      env: childEnv({ PORT: String(port), NONCE: `child-on-${port}` }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = captureOutput(child);
    try {
      await waitForChildHttp(child, `http://127.0.0.1:${port}/`, { output, timeoutMs: 15_000 });
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    }
    return { child, port };
  };

  try {
    // Control: without the retry, the boot on the taken port fails, naming the cause.
    expect(boot(taken)).rejects.toThrow(/EADDRINUSE/);

    const booted = await retryOnPortRace(boot, { ports: () => handed.shift() ?? freePort() });
    try {
      expect(booted.port).not.toBe(taken);
      expect(await (await fetch(`http://127.0.0.1:${booted.port}/`)).text()).toBe(`child-on-${booted.port}`);
    } finally {
      booted.child.kill();
      await booted.child.exited;
    }
  } finally {
    thief.stop(true);
  }
}, 60_000);
