/**
 * Runs the Next CLI with the `PORT` from this service's own `.env.local`, which
 * since #3 is the root one: the app is the repo root.
 *
 * The app is the one service that is not `bun <entrypoint>.ts`, and that is
 * the whole problem. The script used to be:
 *
 *     "dev": "next dev --port ${PORT:-3000}"
 *
 * `${PORT:-3000}` is expanded by the *shell* `bun run` spawns, before Next
 * starts and before anything reads `.env.local`, so the default always won and
 * the service cheerfully announced port 3000 while the other three honoured
 * their own file. Dropping the flag is not enough either: Next's `--port`
 * declares `.env('PORT')`, but `bun run <script>` does not export the `.env`
 * files into the spawned shell — it injects them into the *process* Bun itself
 * executes. Measured both ways on #50.
 *
 * So this file is that process. Bun runs it directly, which loads
 * the root `.env.local` into `process.env` exactly the way `bun --watch
 * src/index.ts` does for `hooks`, `loan-app` and `idp`, and the Next CLI
 * inherits that environment and reads `PORT` out of it. A real environment
 * variable still wins over the file — `PORT=4420 bun run dev`
 * and a host's injected `PORT` both keep working — because that is Bun's own
 * precedence, not something re-implemented here.
 *
 * **The Next server runs on Bun, not Node, since #4.** `next`'s bin starts
 * `#!/usr/bin/env node`, and `bun run next` honours that shebang, so until #4
 * the app ran on Node. The control plane is a module of the app now and opens
 * `governance.db` with `bun:sqlite` (DESIGN.md → Database), which Node cannot
 * load: measured on #4, a route importing it answered 500 "Cannot find module
 * 'bun:sqlite'" under `bun run next dev` and 200 under `bun --bun run next
 * dev`. `--bun` is what makes Bun run the bin itself.
 *
 * Production does not run this. The root `Dockerfile` serves the standalone
 * build with `bun server.js`, which reads `process.env.PORT` itself.
 */
import { listenersOn, portTakenMessage } from "./port-in-use.ts";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("usage: bun scripts/next.ts <dev|start|...> [args]");
  process.exit(64);
}

// A port always reaches Next through the environment (#9). Unset, Next's own
// default is 3000 too, but it then moves to 3001 when 3000 is taken, with a
// warning: the tunnel pointed at 3000 would serve somebody else, and the URL
// printed below would be wrong. Named explicitly, a taken port is an error.
if (!process.env.PORT?.trim()) process.env.PORT = "3000";

// And a port something else already answers on is an error too, checked here
// because Next's own check misses half of it (#30). Next binds the wildcard,
// which succeeds beside a listener on one loopback address, so on the third
// live run Next started on 3000 while `astro dev` held `[::1]:3000`, and the
// tunnel reached Astro. `scripts/port-in-use.ts` asks both loopback addresses.
if (args[0] === "dev" || args[0] === "start") {
  const port = Number(portArgument(args) ?? process.env.PORT);
  if (Number.isInteger(port) && port > 0) {
    const held = await listenersOn(port);
    if (held.length > 0) {
      console.error(`[next.ts] ${portTakenMessage(port, held)}`);
      process.exit(1);
    }
  }
}

// The URL to open, before Next's own banner (#9). With APP_PUBLIC_HOST set it
// is the tunnel, never localhost: the sessions and the verifier live there.
// Advisory, so a launcher copied away from `lib/` (app-test/dev-port.test.ts
// runs it in a throwaway project) still starts Next, and says why it printed
// no URL.
if (args[0] === "dev" || args[0] === "start") {
  try {
    const { openInstructions } = await import("../lib/origin.ts");
    console.log(`${openInstructions(process.env, process.env.PORT)}\n`);
  } catch (error) {
    console.error(`[next.ts] could not work out the URL to open: ${(error as Error).message}`);
  }
}

/** A `--port`/`-p` passed through to Next, which wins over `PORT` there too. */
function portArgument(argv: readonly string[]): string | undefined {
  for (const [index, arg] of argv.entries()) {
    if (arg === "--port" || arg === "-p") return argv[index + 1];
    if (arg.startsWith("--port=")) return arg.slice("--port=".length);
  }
  return undefined;
}

// `bun run next` rather than the bin path: it resolves `node_modules/.bin`
// wherever the workspace install put it, and hands the binary this process's
// environment — the point of the exercise. `--bun` runs it on Bun; see above.
const child = Bun.spawn(["bun", "--bun", "run", "next", ...args], {
  cwd: new URL("..", import.meta.url).pathname,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

// A dev server is stopped with Ctrl-C, and killing the launcher without
// passing the signal on leaves Next holding the port — the exact collision
// this whole port scheme exists to prevent.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

process.exit(await child.exited);
