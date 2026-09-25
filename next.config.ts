import type { NextConfig } from "next";

const config: NextConfig = {
  // The root Dockerfile runs this app; standalone keeps the runtime
  // image to the server plus only the dependencies it actually traced.
  output: "standalone",
  // A second build directory, for a test that boots its own `next dev` while a
  // developer's is running (#4). Next allows one dev server per `distDir` — it
  // holds `<distDir>/lock` — so `app-test/control-plane-app.test.ts` points
  // this under `.next/` (gitignored) and gets a server of its own. Unset
  // everywhere else, which is Next's own `.next`.
  ...(process.env.CG_NEXT_DIST_DIR ? { distDir: process.env.CG_NEXT_DIST_DIR } : {}),
  // `next dev` only, and only the loopback address (#190). Next 16 answers 403
  // to a `/_next/*` request from any origin but `localhost`, so a page opened
  // at `http://127.0.0.1:<port>` never gets its client chunks and never
  // hydrates. Every browser test in `app-test/` opens the app that way. Next 15
  // only warned. The production server (`server.js`) ignores this option.
  allowedDevOrigins: ["127.0.0.1"],
  // No generated agent rules (#9). Next 16's `next dev` writes `AGENTS.md` and
  // `CLAUDE.md` at the root whenever it detects a coding agent in its
  // environment (`AI_AGENT`, `CLAUDECODE` and others). They are gitignored,
  // but a forker's agent would still read instructions nobody wrote for this
  // project. `app-test/agent-rules.test.ts` boots `next dev` as an agent would.
  agentRules: false,
  // The build's type check leaves out the tests, which the Docker builder cannot
  // resolve. The reason is in tsconfig.build.json (#190).
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // The monorepo root, so tracing picks up files linked from packages/. Since
  // #3 that is this app's own directory, named anyway so Turbopack does not
  // have to infer it.
  outputFileTracingRoot: new URL("./", import.meta.url).pathname,
  // `ws` by hand, because tracing cannot find it on its own (#92).
  //
  // `@mastra/core` opens `ws` at module scope, and in the Alpine builder
  // webpack leaves it as a bare `require("ws")` external in
  // `.next/server/app/api/chat/route.js` rather than bundling it. (On macOS the
  // same build inlines it, which is the first reason this was invisible
  // locally.) Next's file tracing does not follow that emitted specifier, so
  // the standalone tree shipped without `ws` and every `POST /api/chat`
  // answered `Cannot find module 'ws'` — measured against the image, not
  // guessed. `next start` on a full `node_modules` resolves it, which is the
  // second reason three reviewers and the tracer bullet all passed.
  //
  // The glob is `./node_modules/ws`, inside this package, and that is the
  // load-bearing part: Node resolves `require("ws")` from the route by walking
  // up to this package's `node_modules` (the repo root's, since #3), so a copy
  // anywhere else — the Bun store — would be present and still unreachable. The path exists only
  // because `ws` is a declared dependency of this package; see the `//ws` note
  // in package.json. Both halves are needed and neither works alone.
  //
  // `scripts/verify-standalone.ts` is what holds this honest. It drives the
  // built image, and `--image <a pre-fix tag>` makes it go red.
  //
  // Since Next 16 (#190) the build is Turbopack, not webpack, and the paragraph
  // above describes webpack. Measured on macOS under Next 16.3: Turbopack
  // inlines `ws` into the server chunks, so they contain no `require("ws")`
  // and no external except Node builtins and Next's own modules. The include
  // stays anyway. The Alpine image's chat route has not been measured under
  // Turbopack, and if a future build leaves `ws` external again, this line is
  // what keeps that require resolvable.
  //
  // `public/**/*` on `/`, because the standalone tree does not carry it either
  // (#177). Next's own docs say to copy `public` beside `.next/static` in the
  // Dockerfile, and that is the obvious fix — but it puts the deployable
  // artifact somewhere only Docker can assemble it, and this repo has already
  // paid for that once: #92 was a standalone gap that every local check was
  // blind to because none of them ran the artifact. Carrying `public` in the
  // trace instead means `bun run build` emits a **complete**
  // `.next/standalone`, and the runner stage copies that one tree — so the
  // thing `app-test/public-assets.test.ts` boots on a socket and the thing the
  // image serves are the same tree, and a fast test can hold it.
  //
  // The glob is relative to this package, so it lands at
  // `.next/standalone/public/` — where `server.js` looks, because
  // `outputFileTracingRoot` makes the standalone tree mirror the monorepo, and
  // since #3 the app is the monorepo's root. It
  // is the whole directory rather than the two wordmarks `app/Frame.tsx`
  // names: the next file added to `public/` must not be able to go missing in
  // production the way these two did.
  //
  // Measured, not assumed. Before this line, `NODE_ENV=production node
  // apps/web/server.js` on the built tree answered `/` with 200 and both
  // `/arcade-wordmark-white.svg` and `/mastra-wordmark.svg` with 404 — the
  // co-brand frame with two missing marks, on a projector.
  outputFileTracingIncludes: {
    "/api/chat": ["./node_modules/ws/**/*"],
    "/": ["./public/**/*"],
  },
};

export default config;
