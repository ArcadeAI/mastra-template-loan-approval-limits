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
 * and Render's injected `PORT` both keep working — because that is Bun's own
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
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("usage: bun scripts/next.ts <dev|start|...> [args]");
  process.exit(64);
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
