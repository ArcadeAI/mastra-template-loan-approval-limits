/**
 * How a test starts a process, and how it gets a port for one (#9).
 *
 * **Every child dies with the test.** `spawnChild` is `Bun.spawn` with one
 * difference: the command runs under `app-test/supervise.ts`, which makes it the
 * leader of its own process group and kills that group when the test process
 * goes away, however it goes. Eight `bun` stubs from #4's harnesses outlived
 * their worktree, still listening after the directory was deleted; an
 * `afterAll` that kills the child it spawned covers none of the ways that
 * happened (the test process killed, `beforeAll` throwing, a launcher whose own
 * child holds the port). What comes back is the supervisor's `Subprocess`, and
 * it behaves as the command's: the same stdio, the same exit code, and `kill()`
 * stops the whole group. Any signal is delivered to the supervisor as SIGTERM,
 * because a supervisor killed outright could not stop the group it leads.
 *
 * **A lost port race is retried, not reported.** A harness asks the OS for a
 * free port by binding `:0`, releases it, and starts the child on it, so
 * another process can take the port in between. CI did, once: `EADDRINUSE` in
 * `approval-signed-out.test.ts` on port 44609 (#8's round 2). Having every
 * child bind `:0` itself and report back would close the window, but it would
 * mean changing how `next dev`, Chrome, Mastra Studio and every stub announce
 * their port. `retryOnPortRace` runs a harness's boot again on a new port when
 * the child says `EADDRINUSE`, and rethrows anything else untouched.
 */
import type { Spawn, Subprocess } from "bun";
import { join } from "node:path";

const SUPERVISE = join(import.meta.dir, "supervise.ts");

/** Every supervisor still running, so the test process can stop them on its way out. */
const live = new Set<Subprocess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous, because `exit` handlers are. The supervisors do the waiting:
  // each one SIGTERMs its group and SIGKILLs it after a grace period, and each
  // one also notices on its own that this process is gone, which covers the
  // exits that run no handler at all.
  process.on("exit", () => {
    for (const child of live) child.kill("SIGTERM");
  });
}

type Options<In extends Spawn.Writable, Out extends Spawn.Readable, Err extends Spawn.Readable> = Spawn.SpawnOptions<
  In,
  Out,
  Err
>;

/**
 * `Bun.spawn(command, options)`, supervised. Takes `Bun.spawn`'s two call
 * shapes: `spawnChild(["bun", "x.ts"], { … })` or `spawnChild({ cmd, … })`.
 *
 * The supervisor runs with `--no-env-file`. Bun loads `.env` and `.env.local`
 * from its working directory into any process it starts, and the supervisor
 * hands its environment to the command: without the flag every child would
 * get the developer's files on top of the allowlist `child-env.ts` built. The
 * command itself still loads what it would have loaded without a supervisor.
 */
export function spawnChild<
  const In extends Spawn.Writable = "ignore",
  const Out extends Spawn.Readable = "pipe",
  const Err extends Spawn.Readable = "inherit",
>(command: string[], options?: Options<In, Out, Err>): Subprocess<In, Out, Err>;
export function spawnChild<
  const In extends Spawn.Writable = "ignore",
  const Out extends Spawn.Readable = "pipe",
  const Err extends Spawn.Readable = "inherit",
>(options: Options<In, Out, Err> & { cmd: string[] }): Subprocess<In, Out, Err>;
export function spawnChild(
  commandOrOptions: string[] | (Options<Spawn.Writable, Spawn.Readable, Spawn.Readable> & { cmd: string[] }),
  maybeOptions: Options<Spawn.Writable, Spawn.Readable, Spawn.Readable> = {},
): Subprocess {
  const [command, options] = Array.isArray(commandOrOptions)
    ? [commandOrOptions, maybeOptions]
    : [commandOrOptions.cmd, (({ cmd: _cmd, ...rest }) => rest)(commandOrOptions)];
  installExitHook();
  const supervisor = Bun.spawn(["bun", "--no-env-file", SUPERVISE, String(process.pid), "--", ...command], options);
  live.add(supervisor);
  void supervisor.exited.then(() => live.delete(supervisor));
  return new Proxy(supervisor, {
    get(target, property) {
      if (property === "kill") {
        return () => {
          if (target.exitCode === null && target.signalCode === null) target.kill("SIGTERM");
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** How many supervised children are still running: zero after every test file. */
export function liveChildren(): number {
  return live.size;
}

/** A port the OS says is free right now, rather than a guess. `conftest.py::_free_port`. */
export function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
  const { port } = probe;
  probe.stop(true);
  if (typeof port !== "number") throw new Error(`Bun.serve({ port: 0 }) reported no port (got ${String(port)})`);
  return port;
}

/**
 * Whether a child's output or a boot error says it lost the port to somebody else.
 *
 * Two spellings of the same loss: the socket's own `EADDRINUSE`, and, since
 * #30, `scripts/next.ts` refusing the port itself before Next can bind it
 * (`portTakenMessage` in `scripts/port-in-use.ts`: "Port N is already in use").
 * Only the first was recognised until the #33 review, so a `bun run dev` child
 * that lost the race exited 1 and the boot failed instead of retrying — seen
 * once in a full `env -i` run on a shared machine (`users-live.test.ts`).
 */
export function lostPortRace(text: string): boolean {
  return /EADDRINUSE|address already in use|Port \d+ is already in use/i.test(text);
}

/** Thrown by {@link retryOnPortRace} when every attempt lost the race. */
export class PortRaceError extends Error {}

/**
 * Runs `boot` on a free port, and again on a new one each time it fails with
 * `EADDRINUSE` in its error. `boot` must throw when its child exits before it is
 * ready, with the child's output in the message; {@link waitForChild} does
 * exactly that. Anything that is not a lost race is rethrown at once.
 *
 * `ports` is for this module's own test, which needs the first port to be one
 * it already holds.
 */
export async function retryOnPortRace<T>(
  boot: (port: number) => Promise<T>,
  { attempts = 5, ports = freePort }: { attempts?: number; ports?: () => number } = {},
): Promise<T> {
  const lost: number[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = ports();
    try {
      return await boot(port);
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${String(error.cause ?? "")}` : String(error);
      if (!lostPortRace(message)) throw error;
      lost.push(port);
      console.warn(`[harness] port ${port} was taken before the child bound it (EADDRINUSE); retrying on a new port`);
    }
  }
  throw new PortRaceError(`lost the port race ${attempts} times in a row (ports ${lost.join(", ")})`);
}

/** Collects a piped child's stdout and stderr as they arrive. */
export function captureOutput(child: Subprocess): () => string {
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    if (!(stream instanceof ReadableStream)) continue;
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream as ReadableStream<Uint8Array>) output += decoder.decode(chunk, { stream: true });
    })();
  }
  return () => output;
}

/**
 * Waits until `ready()` answers true, and fails at once, with the child's
 * output, if the child exits first — which is how a lost port race reaches
 * {@link retryOnPortRace}, instead of as a timeout a minute later. Also fails if
 * the child is gone by the time `ready()` passed: then something else answered.
 */
export async function waitForChild(
  child: Subprocess,
  ready: () => Promise<boolean>,
  { description, output = () => "", timeoutMs = 60_000 }: { description: string; output?: () => string; timeoutMs?: number },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  for (;;) {
    if (exited) {
      // Give the pipes a moment to deliver the child's last words.
      await Bun.sleep(50);
      throw new Error(`${description}: the child exited with ${child.exitCode} before it was ready:\n${output()}`);
    }
    let answered = false;
    try {
      answered = await ready();
    } catch {
      // Not listening yet.
    }
    if (answered) {
      if (exited || child.exitCode !== null) {
        throw new Error(`${description}: answered, but the child had exited (${child.exitCode}); something else holds the port:\n${output()}`);
      }
      return;
    }
    if (Date.now() > deadline) throw new Error(`${description}: not ready after ${timeoutMs}ms:\n${output()}`);
    await Bun.sleep(50);
  }
}

/** `waitForChild` with the usual readiness: any HTTP answer under 500 from `url`. */
export function waitForChildHttp(
  child: Subprocess,
  url: string,
  options: { output?: () => string; timeoutMs?: number } = {},
): Promise<void> {
  return waitForChild(child, async () => (await fetch(url)).status < 500, { description: `HTTP ${url}`, ...options });
}
