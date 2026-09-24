/**
 * Runs one command for a test and makes sure it dies with the test (#9).
 *
 *     bun app-test/supervise.ts <test-pid> -- <command> [args…]
 *
 * Eight `bun` stubs spawned by #4's harnesses outlived their worktree, still
 * listening after the directory was deleted. A harness that kills its child in
 * `afterAll` misses three cases, and all three happened: the test process is
 * killed (a timeout, a Ctrl-C, CI cancelling a run), `afterAll` never runs
 * because `beforeAll` threw, or the child it kills is a launcher whose own child
 * holds the port (`bun scripts/next.ts dev` → `next dev` → its server worker).
 *
 * So `app-test/child.ts` never spawns a command directly. It spawns this, which:
 *
 * - starts the command as the leader of a **new process group**, so one signal
 *   reaches every process under it, however deep the launcher chain;
 * - polls the test process, and when it is gone kills the group — the case no
 *   `afterAll` can cover, because there is no test process left to run it;
 * - on SIGTERM or SIGINT, signals the group, waits, then SIGKILLs it;
 * - when the command exits by itself, kills whatever it left behind in the
 *   group, and exits with its code.
 *
 * stdin, stdout and stderr are the command's own, passed straight through.
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const parent = Number(argv[0]);
const command = argv.slice(separator + 1);
if (separator !== 1 || !Number.isInteger(parent) || parent <= 1 || command.length === 0) {
  console.error("usage: bun app-test/supervise.ts <test-pid> -- <command> [args…]");
  process.exit(64);
}

/** How long a group gets between SIGTERM and SIGKILL. */
const GRACE_MS = 3_000;
const POLL_MS = 200;

const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", detached: true, env: process.env });
const group = child.pid;
if (group === undefined) {
  console.error(`[supervise] could not start ${command.join(" ")}`);
  process.exit(70);
}

function groupAlive(): boolean {
  try {
    process.kill(-group!, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(signal: NodeJS.Signals): void {
  try {
    process.kill(-group!, signal);
  } catch {
    // Already gone.
  }
}

let stopping: Promise<never> | null = null;

/** SIGTERM the group, SIGKILL it after the grace period, and exit. */
function stop(code: number): Promise<never> {
  stopping ??= (async () => {
    signalGroup("SIGTERM");
    const deadline = Date.now() + GRACE_MS;
    while (groupAlive() && Date.now() < deadline) await Bun.sleep(50);
    if (groupAlive()) signalGroup("SIGKILL");
    while (groupAlive()) await Bun.sleep(20);
    process.exit(code);
  })();
  return stopping;
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => void stop(143));
}

child.on("exit", (code, signal) => {
  void stop(code ?? (signal ? 128 + 15 : 1));
});

// The test process is gone: nobody is left to stop this group but us.
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    void stop(143);
  }
}, POLL_MS);
