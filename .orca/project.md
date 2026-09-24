# Project context for workers

Implementers and reviewers read this file right after the issue and `DESIGN.md`.
The role prompts are project-agnostic; **everything a worker needs to know about
this codebase goes here.** Update it whenever a worker trips on something it
should have been told — via the driver, who gates the change.

---

## What this project is

**The Mastra partnership template** for Arcade's contextual governance, cut from the
stage demo `ArcadeAI-labs/mastra-contextual-governance`. It is **one TypeScript app** at
the repo root (Next.js plus `src/mastra`, running on Bun) and the two Python toolkits. The
control plane and the loan API are modules of the app. The IdP becomes one in #6. Its
first run is **act 2**: the $95K approval refused by `/hooks/pre`, routed to Charlie in
Slack, and retried by Alice. The goal and every settled decision are in `DESIGN.md`.
"Working" means a developer runs the Quickstart and sees act 2 in Studio and in the UI.

- **The business system must not know about governance.** `lib/loans/` has a
  test that fails if governance vocabulary appears in its source. That is the
  demo's central claim, enforced rather than asserted.
- **A control that silently does nothing is worse than no control.** The
  recurring failure here is a rule that matches nothing, which is
  indistinguishable from a rule that permits. It looks like a working demo. If
  your slice writes or matches a rule, prove it matches.

## Fresh-worktree quickstart

`scripts/orca-setup.sh` has already claimed your port block, written the
`.env.local` files and run the install by the time you start.

```sh
bun install                        # the setup hook already did this
bun test ./app-test/               # one group; see "report per group" for the rest
bun run typecheck
bun run build                      # the app, at the repo root, on Turbopack under Bun
bun run dev                        # the app on the root .env.local's PORT (dev:web is an alias)
bun run studio                     # Mastra Studio on STUDIO_PORT
```

There is no Docker and no Compose in this project. **Do not start Docker
Desktop on this machine.**

## Environment facts that will bite you otherwise

- **One `bun install` at the root.** Every workspace is on zod 4.6.5 (one pinned version).
  If you see `Cannot find module 'better-auth'`, the install did not run.

- **The app runs on Bun, and TypeScript stays on `^6`.** The databases use
  `bun:sqlite`, which Node cannot load, so `next dev`, `next build` and the
  standalone server all run under `bun --bun`. Mastra Studio (`mastra dev`) is a
  separate **Node** process, so the agent's import graph must never reach a `bun:`
  module (no control plane, loan or identity store); a test enforces it. `mastra dev`
  bundles through `typescript-paths`, which needs TypeScript's JS API, and TS 7 does
  not export it. Do not bump TypeScript; a test boots `mastra dev`.

- **Report per group, never as a total.** Workspace runs alone miss the
  non-workspace groups:

  | group | note |
  | --- | --- |
  | `app-test/` | the app at the repo root, with the control plane (`app-test/control-plane/`) and the loan module (`app-test/loans/`) folded in; not a workspace; `bun test ./app-test/` |
  | `packages/governance-core` · `packages/policy-schema` | workspace members |
  | `apps/idp` | workspace member until #6 folds it into `lib/identity/`; it has its own tests |
  | root `test/` | not a workspace; `bun test ./test/` |
  | `docs/spikes/evidence` | not a workspace |

  Beyond these: `tools/loan` and `tools/approvals` under `uv`, plus
  `bun run typecheck` and `bun run build`. The three live-model tests skip
  without `ANTHROPIC_API_KEY`; report them as unverified, never as passes.

- **Test harnesses: allowlist the child's environment, and kill every child.**
  Run the app group both with `set -a; . ./.env.local; set +a` exported and under
  `env -i PATH="$PATH" HOME="$HOME"`. A stub that inherited `IDP_PUBLIC_HOST` from
  the exported file listened on the wrong port and failed a review (#5), so a
  spawned process gets an allowlisted environment, not the parent's minus one
  variable. Stubs spawned by an earlier slice's harnesses outlived their deleted
  worktree and had to be stopped by hand, so every child dies with its test, and
  your `pgrep` proof includes harness-spawned stubs. The free-port helpers bind
  `:0`, release, then reuse, which raced once in CI (`EADDRINUSE`, finding on #9).

- **Run the root group as `bun test ./test/`.** `bun test test/<file>.ts`
  matches paths as **substrings** and silently also runs other files named
  `test/…`, inflating the group. A merge worker caught this only because the
  count was 33 instead of the expected 23. `bun test ./app-test/` is the app's
  group; the two directory names differ by more than a letter on purpose.

- **Tool identifiers are PascalCase**, measured off a real deployment: toolkit
  `Loan`, tools `SearchLoans`, `GetLoan`, `ApproveLoan`, `DenyLoan`; through a
  gateway the wire name is `Loan_GetLoan`. A rule keyed on `get_loan` matches
  nothing and reads exactly like a rule that permits.

- **`tool.metadata` is never populated** in hook payloads, for any tool. Do not
  key anything on `behavior.operations` or `read_only`.

- **Tool descriptions and the system prompt carry no behavioural instruction**
  (`DESIGN.md` "No model-side controls"). The guard for it once read a stand-in's
  copy while the deployed Python still said "there is no undo" (#8). The guards
  now read the Python toolkits' registered descriptions; keep it that way.

- **Arcade evaluates auth requirements before `/hooks/pre`.** A refusal there fires
  no hook, writes no audit row, and shows nothing on the panel. If something you
  expect to see is invisible, check the OAuth registration before you suspect
  the control plane.

- **Two health vocabularies, on purpose.** `/hooks/health` is Arcade's hook
  health check and answers `healthy|degraded|unhealthy`. The app's `/health` is
  the readiness page and answers `ok|degraded`, HTTP 200 either way, with one
  field per capability. Never merge them, and never put one's vocabulary on the
  other's path.

- **The app never calls itself through the public host.** The app's own
  server-side readers of the control plane use `CONTROL_PLANE_HOST` (default
  `localhost:$PORT`), and after #6 identity readers use `IDENTITY_HOST` the same
  way. The public host (`APP_PUBLIC_HOST` after #6) is the ngrok tunnel, for
  Arcade only. A test fails if a server-side reader targets it.

- **Ports.** Your worktree owns ten, claimed by `scripts/orca-setup.sh` from
  4400–4559 and released by `scripts/orca-archive.sh`. The root `.env.local`
  carries the app's `PORT`, `STUDIO_PORT` (the block's base + 5), `CG_PORT_*`
  and the host strings; `apps/idp` keeps its **own** `.env.local` with its own
  `PORT` until #6 folds it. A worktree created before #3 must re-run
  `bash scripts/orca-setup.sh`, which is idempotent and keeps its block, or
  `bun run dev` falls back to port 3000. Never hard-code 3000, 4111, 8081, 8082
  or 8083, and never pick a port at random — bind `:0` and read it back, as
  `tools/loan/tests/conftest.py::_free_port` does. Mastra's own 4111 is only the
  default for a checkout outside Orca.
  Claims live in `~/.cache/mastra-contextual-governance/portblocks/`, a directory
  name shared with the stage demo's worktrees (finding on #9). The hook reaps a
  claim whose worktree directory is gone.

- **`bun run reset` no longer touches the IdP; `--hard` does**, and costs four
  logins and four cards. Never run `bun run reset --target render`.

- **Databases are SQLite on disk and gitignored.** They seed *if empty*, in one
  transaction with the schema. Never commit a `.db` file.

## What this project fails at

The recurring failure is **silent**, not loud, and it has claimed six slices in
a row. Every one is a path that is only exercised where nobody looks. Weight
your attention accordingly.

- **A rule that is under-scoped, not misspelled.** #184: both output rules
  matched `{ toolkit: "$LOAN", tool: "GetLoan" }` while `ApproveLoan` and
  `DenyLoan` returned the same `SELECT *` record, so every approve and deny
  leaked the data the rules exist to protect. **Ask of every slice: which paths
  return this data, and is the control on all of them?** `SearchLoans` is the
  model that works — it projects six safe columns and never reads the sensitive
  ones, so there is nothing for a hook to miss.
- **Enforcement written but never demonstrated.** If a slice adds a denial path,
  demand evidence it actually denied, not that the code exists.
- **The business system learning about governance.** `lib/loans/` must not
  contain policy, role, limit, redaction or authority vocabulary, and must not
  import `@cg/*`. There is a test, keyed on its manifest's `"cg": { "governed": true }`;
  check it was not weakened to pass.
- **A guard that checks a copy.** A test passed for months against a stand-in's
  copy of the tool descriptions while the real toolkits were wrong (#8). A guard
  reads the thing that ships, and is shown failing on the old version.
- **Seeding.** A slice once shipped DDL outside the seed transaction: a failed
  seed rolled back its rows but left the tables, so every later boot came up
  green with zero rows, permanently, on a disk that persists. Try a
  deliberately broken fixture.
- **State from a previous run.** A test that passes because of what an earlier
  run left on disk is not passing. You have a clean worktree; use it.
- **A fixture change that never reaches the deployed service.** Durable policy
  lives in the database, so editing a fixture does not change a running
  environment.
- **The production image is not `next dev`.** A slice shipped no `public/` and
  nobody saw it, because `next dev` serves those files off disk. The image is
  built from the root `Dockerfile`, and its entry is `.next/standalone/server.js`
  run under Bun.
- **A fold that loses a boundary.** When a service becomes a module, the test that proved
  the boundary (no governance vocabulary in the loan module, no app dependency in
  `governance-core`, the identity module knowing people and not loans) must still run
  and still bite. A folded module keeps its own workspace manifest with its `cg` flag
  so the `policy-schema` sweep still finds it. Plant a violation and show it fail.

## Non-negotiables

Gate through the human regardless of slice:

- **No external state, ever, by any worker.** Do not deploy (`arcade deploy`
  included), provision, log in, authenticate, use or create credentials, or
  alter Arcade, Render, Slack, Google, ngrok or OAuth configuration. The one narrow
  exception, and only with the driver's say-so: a freshly random,
  environment-only, never-committed `BETTER_AUTH_SECRET`/`SESSION_SECRET` to
  boot a **local** throwaway identity instance, killed afterwards with `pgrep` proof.
- **Never point anything at the stage demo** (`cg-idp-or5b`, `cg-web-sa31`, `cg-loan-app`,
  `cg-hooks` on `onrender.com`) **or its Arcade project.** They are live and belong to the
  other repo. This repo gets its own.
- **Anything touching the four acts or the demo narrative** (`DESIGN.md` §"The
  four acts").
- **Anything a new user or forker sees first:** the README quickstart, the
  rehearsal runbook, shipped defaults and config templates.
- **Anything touching identity, authorization or the access model** — the two
  hops, the User Source gateway hop, the verifier tool hop.
- **The only Python in this project is `tools/`.** A slice once turned the loan
  tools into Python against an explicit constraint and no gate caught it.
- `docs/PRESENTATION-BRIEF.md` is untracked and excluded on purpose because it
  names live persona addresses. Do not commit it and do not remove the
  exclusion.
- The personas are **Alice, Bob, Charlie and Michael at `@megaforce.tech`**.
  `dana`/`sam`/`riley`/`morgan` are internal keys only, and `@bank.example` is
  the local fixture — it must never reach anything audience-facing.
- **Never Arcade Headers mode**, for any gateway, as an option, fallback or aside.
- **The README follows Mastra's exact outline** (see
  `.orca/local/human/mastra-contributing-guide.md`) and is rewritten in its own slice.
  Don't edit it piecemeal.

## Where things live

- Repo root (`app/`, `components/`, `lib/`, `public/`, `scripts/`, `app-test/`) —
  the Next.js app, running on Bun: the chat, the control-plane panel, the
  approval pages. Its old service README is `docs/app.md`.
- `src/mastra/index.ts` — the Studio entry, registering the chat route's own
  agent. Every gateway bearer comes from `gatewayToken()`
  (`lib/agent/gateway-token.ts`).
- `lib/control-plane/` — the control plane, served under `/hooks/*`
  (`/hooks/pre`, `/hooks/post`, `/hooks/access`, `/hooks/health` in Arcade's
  enum, the audit log, the event stream). The approvals store is
  `/api/approvals/*`. `lib/control-plane/fixtures/governance.json` is the policy
  fixture.
- `lib/loans/` — the bank, served under `/bank/*`, read in-process by the
  `/loans` board. Knows nothing about governance, and a test enforces that.
- `apps/idp` — the IdP (Better Auth), a workspace member until #6 folds it into
  `lib/identity/`. The Loan toolkit's provider id is `app-identity`.
- `packages/governance-core`, `packages/policy-schema` — policy types and
  evaluation shared by the hooks.
- `tools/loan`, `tools/approvals` — the Arcade toolkits, Python, `uv`.
- `test/` — root-level reset tests. `docs/spikes/evidence` — spike evidence
  tests. Neither is a workspace.
- `scripts/orca-setup.sh`, `scripts/orca-archive.sh` — the port-block hooks.
- `DESIGN.md` — architecture, the four acts, contracts. Law for workers; never
  edit it. The driver records decisions in it.
