# Loan Approval Limits with Arcade

The Mastra partnership template for Arcade's contextual governance: an agent does real
work in a real business system, and Arcade enforces deterministic control on every tool
call. It is cut from the stage demo `ArcadeAI-labs/mastra-contextual-governance` at
`26b0cc9`, with the same thesis, the same four control points and the same policies. It is
reshaped into **one TypeScript app plus the two Python toolkits**, so a developer can run it
from Mastra's Quickstart.

**The story is act 2.** A loan officer asks the agent to approve a $95K loan. The control
plane refuses it as over her limit and routes it to the one approver with enough authority,
who approves in Slack, and her retry succeeds. The model never gets a vote. Acts 1, 3 and 4
still run, and every policy that drives them stays in force. They are not what the README,
the Studio first run or the demo video lead with.

The goal and its order are tracked on issue #1. The decision trail is on the stage demo's
#186, #187, #188 and #190.

## Thesis

Treat the LLM as an adversary. Controls it cannot reason around must live outside it.
Arcade provides **four** identity-keyed control points on every tool call, and the model
sits inside all of them:

| # | Layer | Keyed on | Mechanism | Act |
|---|---|---|---|---|
| 1 | Whether you can see the tool | identity | `/access` → `deny` list | 1 |
| 2 | Whether you hold the credential to call it at all | identity | per-tool auth requirement, OAuth scopes | — |
| 3 | Whether you have the authority for *this* call | identity + policy | `/pre` → `CHECK_FAILED` | 2 |
| 4 | What comes back | policy | `/post` → `override.output` | 3, 4 |

Layer 2 was added on #32. It is not a gap in governance — it is a cheaper, earlier gate on
the same identity, and defence in depth is the point. **It has one consequence the other
three do not:** Arcade evaluates auth requirements *before* `/pre`, so a refusal there fires
no hook, writes no audit row, and shows nothing on the panel (measured, spike #2). Never
stage a beat we want to *show* as a layer-2 refusal. See open risk 2.

## The four acts

| # | Beat | Control | Mechanism |
|---|------|---------|-----------|
| 1 | Bob (analyst) literally cannot see `approve_loan` | Access | `POST /access` → `deny` list |
| 2 | Alice's $95K exceeds her $50K authority → blocked → routed to Charlie → retry succeeds | Pre | `POST /pre` → `CHECK_FAILED` + remediation message |
| 3 | `get_loan` returns a bank account number → redacted before it reaches the model | Post | `POST /post` → `override.output` |
| 4 | Seeded underwriter note contains an injected instruction → stripped | Post | `POST /post` → regex scanner |

**Measured on #14 (2026-09-12), and it reorders the build:** acts 2 and 4 share `LN-2291`.
Until `/post` strips the injected note (act 4's control, #16/#17), the model reads it, refuses
it, and about two runs in three ends the turn asking the officer whether to proceed, so
`ApproveLoan` is never called and `/pre` never fires. The same prompt on a clean over-limit
loan (`LN-2299`) reaches the hook 12 of 12. Act 4's control therefore lands **before** act 2 is
rehearsed, and #16 re-measures the $95K rate with `/post` live (#91). Act 2's second half
additionally needs the agent to hold `Approvals_*` and the remediation text to name the tool
as the wire spells it (#89). No prompt steering is an acceptable fix for either.

## Decisions

| Area | Decision |
|---|---|
| Format | **A Mastra partnership template.** The Mastra site builds the template page from `README.md`, which follows Mastra's outline exactly: title `# Loan Approval Limits with Arcade`, a Demo placeholder until Mastra gives us a Cloudinary URL, and a Quickstart through `npx create-mastra@latest --template`. The aim is for people to work with Arcade as much as possible. |
| **Shape** | **One TypeScript app: Next.js plus `src/mastra/index.ts`.** Mastra Studio and the web UI run the same agent. The control plane and the loan API are modules of the app, not services. Decided 2026-09-23. |
| Topology | **Arcade Cloud reaches the developer's machine through one ngrok host.** Hooks, the loan API and the OAuth endpoints are all on it. The tunnel is a Prerequisite, and a static ngrok domain keeps the host fixed across restarts. This reverses the demo's "no tunnels", on purpose. Decided 2026-09-23. |
| Integration | Mastra `MCPClient` (`@mastra/mcp` 2) → `https://api.arcade.dev/mcp/{gateway}`, with `protocolVersion: "legacy"` pinned so the handshake stays `initialize` and never probes `server/discover`. Elicitation handlers are passed as `inputRequests` at construction (#187). |
| Model | Claude Sonnet 5 via `@ai-sdk/anthropic`, temperature 0, model id from env |
| **Tool layer** | **Both toolkits are Python `arcade-mcp`, shipped with `arcade deploy` into one Arcade project and exposed through one gateway. `arcade-mcp` is the tool-authoring framework; it is Python-only, which is why the TS-everywhere rule does not reach the toolkits. Decided on #32, confirmed in session.** |
| **Business system** | **The loan module is the bank's system of record: a plain HTTP API under the app, owning `loans.db`. It is not an MCP server and knows nothing about Arcade or governance. `tools/loan` is a stateless client of it, reaching it through `APP_PUBLIC_HOST`.** The demo split this into its own service to make "governance is outside the business system" literal. The template keeps that claim as a **module** boundary enforced by a test (see **Services**), not a process boundary. The bank UI's loan cards and `/loans` board read the loan module directly as the signed-in person, never through the gateway (#157 in the demo), so every MCP call still originates in the chat. |
| **Identity** | **Every persona is a user of the app's own Better Auth, with a real email, and the web UI signs in against it.** Each persona runs in its own browser profile, so there is no persona switcher (#176 in the demo). `context.user_id` on every hook payload is that email, lowercase. Personas are *not* Arcade project members, unless the members-mode fallback is taken (below). |
| **Two hops, two mechanisms** | **Hop 1, MCP client → gateway: a User Source whose issuer is the app's own Better Auth.** Tried first because it already works in the demo. **The fallback is members mode**, taken only if the live sitting shows the User Source can't be set up easily: then the README asks for two Arcade accounts (Alice and Charlie) whose emails match the app's users. **Arcade Headers mode is ruled out and never proposed.** **Hop 2, tool-level OAuth: the Loan toolkit's `requires_auth` names the app's provider under a fixed generic id**, and a custom user verifier route in the app binds the signed-in email. Neither hop's mechanism moves the other. Decided 2026-09-23. |
| **Gateway token storage** | **`apps/web` drives the gateway OAuth itself (Mastra's `MCPClient.authenticate()` refuses non-loopback redirects) and hands `MCPClient` a static token. The gateway access + refresh token and the persona email live in a sealed, HTTP-only, per-browser cookie (AES-GCM under `SESSION_SECRET`, chunked when over 4KB). One persona per browser. No fourth database. Refresh is server-side. Decided 2026-09-11.** |
| **Arcade config is read-only** | **The auth provider's advanced configuration is never edited; its `client_id`/`client_secret` request parameters stay. The app's Better Auth adapts instead (the demo's #79: Basic header plus identical body credentials accepted). Read provider config back through `GET /v1/admin/auth_providers/<id>`, not off dashboard labels.** |
| **Authorization** | **The loan tools require OAuth against the app's own provider, so they call the loan module on behalf of the user, not as a service account.** The loan module derives the actor from the token, never from a parameter. OAuth carries *identity*; hooks carry *authority*. **The provider is Better Auth inside the app**, which reverses the demo's #36. See **Identity and OAuth** for the objection that reverses, and what now answers it. |
| **One identity, not two** | **The Arcade `user_id`, the OAuth subject, and the actor `apps/loan-app` records are the same person, joined on email. If these ever diverge, `governance.db` and `loans.db` describe different people and the audit trail is fiction.** |
| Policy source | Policy DB owned by the hook server. Editable live on stage. |
| HITL | Custom `request_approval` tool posts Block Kit to Slack; approval link carries **no authority** |
| Approval authz | `approvals.decide` is itself a governed tool call — pre-hook enforces role, limit, and requester ≠ approver |
| Approver routing | Deterministic minimum-sufficient-clearance, requester excluded. The LLM does not choose the approver. |
| The wait | Agent ends its turn; SSE `approval.granted` event auto-resumes it |
| Determinism | The **hook** writes the remediation instruction, not the system prompt |
| **No model-side controls** | **The agent's system prompt and every tool description carry no behavioural instruction in either direction: nothing about confirming, refusing, escalating, retrying, caution or irreversibility. Measured on #14: one "irreversible, no undo" line made Claude ask permission and `/pre` never fired; one "do not ask the person to confirm" line pushed it the other way. Both removed. The prompt states role, tools, how to resolve a loan named by amount, and how to report verbatim. `tools/loan` descriptions follow (#90).** |
| **Readiness** | **The app answers `/health` with one field per capability and `status: ok|degraded`, HTTP 200 either way, so a human can always read it. The fields are those the four demo services reported, under one response: `signin, gateway, verifier, agent, panel_stream, policy, loans, reset`. A missing capability is named; the home page and panel show it; nothing falls back silently. Decided across #81, #82, #14.** |
| Redaction | Declarative per-tool field rules + regex over free text |
| Database | `bun:sqlite`, three files, each owned by one module: `loans.db` (the loan module), `governance.db` (the control plane), `idp.db` (identity). One process, three owners; no module opens another's file. |
| Durability | Data persists; resetting is something you deliberately run. The databases sit on local disk and seed from their fixture only when empty. Reset is a script (#23), never a redeploy. Decided on #29. **Consequence measured 2026-09-14 (#106): a fixture change does not reach a live disk, and acts 3 and 4 were not live while `/health` said armed. Amended: `/health` reports `fixture_drift` as degraded whenever on-disk policy differs from the shipped fixture, and a presenter-only Reset control in the panel runs the reset. Policy stays durable; the silence does not.** **Reset contract, ratified at the #23 gate 2026-09-14 (aaccdc0): every database-owning module exposes `POST /admin/reset` behind one shared `RESET_TOKEN` — route absent (404) when the variable is unset, `/health` reports `reset: enabled|disabled`, the response names what was not reset. hooks takes `{policy|demo}`; loan-app reseeds the loan book from the fixture inside the running image; idp clears people, sessions, tokens and consents and re-seeds the four personas but never touches the `oauthClient` row, and fails if the client id moved. The root `bun run reset` is idempotent and exits non-zero on any refusal. The demo's `--target render` goes with Render, at submission cleanup. A redeploy is not a reset; a reset is not a re-registration. **Amended 2026-09-19 (#123, human's decision): the reset is two resets.** The default calls hooks `demo` → loan-app and **leaves idp alone**; `--hard` adds idp and is the list `#174`'s second panel button reuses. The split is argued on stage time rather than safety: a hard reset signs all four personas out, costing four logins plus four authorization cards before the next take. *Not* a reason for the split: the #123 fault it was originally drawn to avoid, which does not reproduce — that was #100's replay revocation killing a fresh grant at `85e96b1`, fixed by `bbfb162` the same day. Measured separately and worth knowing: the hop-2 token is `expires_in` 3600 with no refresh token, so **any rehearsal longer than an hour costs one authorization card per persona regardless of resets**. The rehearsal script is `docs/RUNBOOK.md`.** |
| Visualization | Hook server → SSE → live three-lane Access/Pre/Post panel at `/panel`, **full-screen and on its own**. The Access lane renders **one card per persona listing** (`tools/list`), naming the tools disabled for that person; grouping is presentation-only in `apps/web` (#156). Amended 2026-09-18 from webinar rehearsal: decisions arriving one card at a time were too fast to narrate. |
| Design | Bank app deliberately boring enterprise UI; control plane unmistakably Arcade. **No split view** (reverses #22, 2026-09-18): the bank app is full-screen at `/`, the control plane full-screen at `/panel`, the loan board full-screen at `/loans`, and the presenter switches between them deliberately. Two panes updating at once could not be narrated on a webinar (#155). The panel visual is cut down for the back of the room (#158). |
| **Hosting** | **The developer's machine plus ngrok. `arcade deploy` for `tools/loan` and `tools/approvals`.** Whether `render.yaml` survives in the submitted repo is decided at submission cleanup. |
| **Toolkit configuration** | **One Arcade tool secret, `APP_PUBLIC_HOST`** (the ngrok host), replaces `LOAN_APP_PUBLIC_HOST`, `HOOKS_PUBLIC_HOST` and `WEB_PUBLIC_HOST`. A developer never edits tool code. The auth provider id is not configurable, because `OAuth2(id=...)` is read at import: it is a fixed generic id, and the README says "register the provider under this id". Decided 2026-09-23. |
| **Languages** | **TypeScript for the app and everything under `packages/`. Python for both `arcade-mcp` toolkits. The boundary is *tool authoring*, not *domain*.** |

## Services

**Target shape.** Slices 1 to 3 on issue #1 fold the services in. Until they land, the tree
still has `apps/hooks`, `apps/loan-app` and `apps/idp` as separate services.

**The app lives at the repo root** (decided 2026-09-23, #3). The root `package.json` is
the app, with `src/mastra/` and the Next.js routes at the root, so Mastra's Quickstart and
`mastra dev` run from the top of a fresh clone. `packages/*` stay workspaces.

    app (Next.js + src/mastra)
      agent            one Mastra agent, registered in src/mastra/index.ts. The same one
                       answers in Studio and in the chat route.
      control plane    /access /pre /post, policy engine, audit, SSE, /approvals.
                       Owns governance.db.
      loan module      the bank's HTTP API. Owns loans.db. No MCP, no Arcade, no governance.
      identity         Better Auth: users, OAuth 2.1 provider, login and consent pages,
                       the custom verifier. Owns idp.db.

    tools/loan       Python arcade-mcp: search_loans, get_loan, approve_loan, deny_loan.
                     Stateless client of the loan module, via APP_PUBLIC_HOST. → arcade deploy
    tools/approvals  Python arcade-mcp: request_approval, decide. → arcade deploy

    packages/governance-core    Hook framework, policy engine, audit, event bus. Zero loan references.
    packages/policy-schema      Shared zod types for policy, events, hook payloads.

**One install, one zod (the demo's #187).** Every workspace is on zod 4.6.5, pinned exactly
in the root `overrides`, so a fresh clone needs one `bun install`. The old zod 3 pin was a
precaution, and it had become a blocker: `@mastra/mcp` 2 sits on `@modelcontextprotocol/*` 2,
which requires zod 4.2 or later. Better Auth was held at 1.7.2 in the demo because 1.7.5
drops `account.issuer` and would need a migration on a live disk (#188 there). Here
`idp.db` starts fresh, so the identity fold takes 1.7.5 with a fresh schema.

**The boundaries survive the fold; only the process boundary goes.** The demo argued that
separate processes *were* the proof that governance lives outside the business system. The
template makes the same claim with module boundaries, each enforced by a test that must
still bite after the fold. A slice that moves a service in has to show its boundary test
failing on a planted violation.

- **The loan module knows nothing about governance.** It declares `"cg": { "governed": true }`.
  `knows-nothing-about-governance.test.ts` fails if governance vocabulary or a `@cg/*`
  import appears in its source, and `policy-schema`'s workspace sweep exempts it. Both
  halves read the same flag, so they cannot drift apart (#33 in the demo).
- **`governance-core` depends on no app.** `no-app-dependencies.test.ts` holds.
- **Only the identity module mints tokens.** No other module imports its signing keys or its
  token issuance. This is new with the fold, and its test is part of slice 3.

Forking means replacing the loan module, `tools/loan` and the seed data, and touching
nothing under `packages/`.

## Identity and OAuth

There are **two authentication hops** with two different mechanisms. Conflating them
cost a day on #75.

    Alice, in her own browser profile
      → the app  "Sign in"  (OIDC code + PKCE against the app's own Better Auth; Alice
                    types her own password, and the page never names her)
        → sealed cookie { email, gateway tokens }
      → hop 1: the app drives the gateway OAuth against the template's User Source gateway (
               HTTPS redirect /api/arcade/callback, PKCE); Arcade renders its own
               consent screen once per persona per MCP client id
      → Mastra MCPClient → https://api.arcade.dev/mcp/<gateway>   bearer = gateway token
        → /access   hooks see user_id = alice@…            ← layer 1
        → auth requirement: does Alice hold the provider's token? ← layer 2 (no hook fires)
          first time: Arcade 303s the browser to the custom verifier
            GET /api/arcade/verify?flow_id=…   (the app)
              · session present → POST cloud.arcade.dev/api/v1/oauth/confirm_user
                {flow_id, user_id: <session email>} server-side, then fetch next_uri
                server-side exactly once, then send the browser to the app's own
                Authorized page, which links to / (never to Arcade's continuation;
                human decision at the #100 gate, landed #118 e23bf57). The grant does
                not store unless next_uri is fetched (measured, #75). Arcade's Location
                from that fetch is logged and otherwise ignored.
              · no session → park flow_id in a short-lived signed cookie, send the
                browser to sign-in, and complete the same two calls from the sign-in
                callback. The verifier never reads the persona from the query string.
          then Arcade exchanges the code at the app's Better Auth (hop 2)
        → /pre      hooks see user_id = alice@…            ← layer 3
          → tools/loan (arcade deploy) receives Alice's OAuth token
            → the loan module validates it, actor = alice@…
        → /post     hooks rewrite the output               ← layer 4

Arcade's default verifier demands an Arcade account that is a project member. Our
personas are not, and a persona verified against the wrong account binds the grant to
the wrong user and the tool re-challenges forever (observed 2026-09-11 15:40Z). The
custom verifier is what makes the IdP-asserted email the identity on hop 2, exactly as
the User Source makes it the identity on hop 1.

Three rules this has to hold to:

1. **The loan module derives the actor from the token, never from a request parameter.**
   An actor passed as an argument is an actor the model can forge, and act 4 is
   specifically about the model trying to.
2. **Scopes are not the governance gate.** A layer-2 refusal is invisible to the control
   plane. Every beat we intend to *show* is an `/access` or `/pre` decision.
3. **Email is the join key.** Arcade `user_id`, OAuth subject, and `loans.db`'s actor
   column are the same string.

**The provider lives inside the app, and that reverses the demo's #36.** The demo kept
Better Auth in its own service, `apps/idp`, as a stand-in for the enterprise IdP. It refused
to fold it into `apps/web` because an enterprise audience would ask whether the web app
could mint itself a token, and the answer would be yes. Folding it into the loan app was
ruled out because Better Auth's own vocabulary trips the loan boundary test.

The template folds it into the app anyway, on the human's decision (2026-09-23): one app is
what makes a Mastra Quickstart possible. The objection is answered by a module boundary,
not a process one. **Only the identity module mints tokens,** and a test fails if any other
module imports its signing keys or issuance (see **Services**). The loan-module rule is
unchanged, and the identity module is never folded into the loan module.

A forker who has a real IdP replaces the identity module and points both hops at it.

Arcade is an OAuth *client* here: it needs a client id and secret, an authorize URL, a
token URL, and its own generated redirect URI allowlisted on our side. It does not consume
OIDC discovery — endpoints are configured explicitly. It extracts the user's identity from
`/oauth2/userinfo` via a JSONPath expression, **which is what turns rule 3 from a
convention into a mechanism**.

⚠️ **Resetting `idp.db` must not rotate the OAuth client credentials. Rotating them and silently breaks the
registration held in Arcade** at the authorize step, which fires no hook,
so the panel stays dark and nothing on screen explains why. The reset must leave the OAuth
client alone. Owned by #36, stated in #23's runbook.

## Tool surface

**loan** (Python, `arcade deploy`; reads `APP_PUBLIC_HOST`)
- `search_loans(status?, min_amount?, max_amount?)`
- `get_loan(loan_id)` → includes `bank_account_number`, `tax_id`, `underwriter_notes`
- `approve_loan(loan_id, amount)`
- `deny_loan(loan_id, reason)`

**approvals** (Python, `arcade deploy`; reads `APP_PUBLIC_HOST`)
- `request_approval(action, resource_id, amount, justification)` — routes deterministically, posts Block Kit
- `decide(request_id, decision, note?)` — called from the approval page as the clicker

**Names, as measured on the wire (#35, #82, #14).** Toolkits deploy as `Loan` and `Approvals`.
MCP advertises `Loan_SearchLoans`, `Loan_GetLoan`, `Loan_ApproveLoan`, `Loan_DenyLoan`,
`Approvals_RequestApproval`, `Approvals_Decide` (underscore). Hook payloads and audit rows name
the same tools with a dot: `Loan.GetLoan`. Policy rules are keyed the dot way; remediation text
that tells the model which tool to call must use the underscore spelling the model actually
sees (#89). A gateway `tools/list` carries **eight** entries: the six above plus Arcade's
built-ins `System_ManageAuthorization` and `Arcade_ListApps`; the agent filters to the two
project toolkits (`ARCADE_LOAN_TOOLKIT`, `ARCADE_APPROVALS_TOOLKIT`).

## Cast

Presentation names are Alice, Bob, Charlie and Michael. The keys `dana`, `sam`, `riley` and
`morgan` are internal only (fixture keys, `PERSONA_*` variables) and never reach anything a
reader sees. The local fixture domain is `@bank.example`.

| Persona | Key | Role | Limit | Notes |
|---|---|---|---:|---|
| Alice | `dana` | Loan Officer | $50,000 | The protagonist of act 2 |
| Bob | `sam` | Credit Analyst | $0 | `approve_loan` hidden entirely: act 1 |
| Charlie | `riley` | VP Credit | $250,000 | The minimum-sufficient approver for $95K |
| Michael | `morgan` | Chief Credit Officer | $5,000,000 | Deliberately *not* bothered, which proves routing |

Each persona is a user of the app's Better Auth, not an Arcade project member unless the
members-mode fallback is taken. Each accepts Arcade's gateway consent screen once per
browser profile per MCP client id.

Seed loan `LN-2291`, Northwind Bakery LLC, $95,000. Carries `bank_account_number` and
`tax_id` (act 3) and an `underwriter_notes` field containing an injected instruction (act 4).

## Event contract

Audit row and SSE frame (confirmed on the wire on #14; `redactions` added on #16, ca9e17f):

    { id, ts, execution_id, hook: 'access'|'pre'|'post',
      user_id, tool, decision: 'allow'|'deny'|'modify',
      reason, rule_id, redactions?: RedactionRecord[] }

    RedactionRecord = { path, rule_id, pattern_id, kind }     // where and why, never what

A `/post` `modify` says what it did through `redactions[]`, one record per thing removed:
JSONPath into the tool output, the rule and pattern that fired, and the strategy. **There is
no field for the removed value, and `before`/`after` are gone from the wire.** Both were the
obvious place to put the raw tool output, and this row is written to `audit_log` and streamed
on `GET /events`; a shape that *could* carry the account number eventually would, into the two
places most likely to be read aloud. The panel renders the mask from `redactions[]`. The
panel's fixture replay still emits the old `before`/`after` shape and `@cg/policy-schema`
still types it; #101 aligns both. Decided on #16 (driver option A), measured on the wire 2026-09-14.

What each layer answers, as measured:

- `POST /pre` denial: HTTP 200, `{ code: "CHECK_FAILED", error_message: "DENIED: … [ref evt_…]" }`;
  allow: `{ code: "OK" }`. The `[ref evt_…]` token is the correlation to the audit row (#6).
- Over MCP the denial flattens to `{ isError: true, content: [{ type: "text", text:
  "Tool execution was denied by an extension policy: DENIED: … [ref evt_…]" }] }`. Mastra
  surfaces it as a tool-error with the text in `payload.error.cause.message`.
- Layer 2 (no token yet) is the same `isError: true` envelope whose text is JSON carrying
  `authorization_url` and `llm_instructions`. No hook fires, no audit row. The chat renders
  it as an authorization link, never as a denial.
- The chat stream (`POST /api/chat`) is `application/x-ndjson`, one event per line, kinds
  `text`, `tool-call`, `tool-result`, `denied`, `fault`, `authorization`, `error`, `done`.
  `denied` requires positive evidence of a hook decision (Arcade's prefix, `CHECK_FAILED`,
  `CONTEXT_DENIED`, or the `[ref evt_…]` token); every other tool failure is `fault` and the
  UI says no decision was made. A control surface must never assert a control-plane action
  that did not happen (#14 review).

## Open risks

**Carried over from the demo, still true:**

1. **Layer-2 refusals are invisible to the control plane.** An unmet auth requirement returns
   `tool_requirements_not_met`, and no hook fires (spike #2). Never stage a beat we want to
   show as an auth failure.
2. **Identity could silently split.** The Arcade `user_id` and the OAuth subject must be the
   same email. The User Source binds it on hop 1 and the custom verifier on hop 2. With the
   verifier disabled, a browser signed into account.arcade.dev as someone else binds the
   grant to that someone. Check the verifier through the admin API, not the dashboard label.
3. **Arcade replays the authorization code once per flow.** Better Auth answers the replay
   `invalid_grant` but does not revoke the first exchange's tokens (the demo's #100 and
   #127). The identity fold must carry that guard over, with its test.
4. **The hop-2 token lasts an hour with no refresh token**, so any session over an hour
   costs each persona one authorization card (the demo's #164 is the fix).

**New with the template, measured at the live sitting before slice 3:**

5. **Studio versus hop 1.** The web UI gets its gateway token from a browser sign-in, and
   Studio has none. What token does the Studio agent use, without Headers mode?
6. **The rule for hop 1.** A User Source if Arcade's API can create the provider, the User
   Source and the gateway (so one `setup-arcade <ngrok url>` does it), or if a setup page
   can print at most two paste-ready dashboard forms beyond the provider. Members mode
   otherwise.
7. **The join key**, in members mode only. The pre-hook sees the Arcade account, and the
   loan module sees the app user. Measure what each receives, and write the must-match rule
   into the README.
8. **Registration by API.** This decides whether the Quickstart is about 5 steps or 8.
9. **The chat route on the production image under Turbopack is unverified** (the demo's
   #190). It needs `bun run --cwd apps/web verify:standalone` with Docker, or the first
   live run.

## Sequence

Tracked on issue #1.

0b. Apply the demo's #190 range `26b0cc9..4809b99` (Next 16 on Turbopack, TypeScript 7,
    React 19.3, `@types/bun`, `arcade-mcp-server` 1.32), with a fresh review. **Skip
    `55622c4`:** its `DESIGN.md` record is already in this document.
0c. Move `apps/web` to the repo root as the one app (#3), before the folds.
1. Fold `apps/hooks` into the app. It sets the contract Arcade calls, so it gates before merge.
2. Fold `apps/loan-app` into the loan module. Runs in parallel with 1.
3. Fold `apps/idp` into the identity module, with hop 1 as a User Source (or the fallback)
   and `APP_PUBLIC_HOST`. It touches the access model, so it gates. **Blocked by the live
   sitting.**
4. The Studio entry, `src/mastra/index.ts`. Its first run is Alice's $95K approval, refused.
5. Collapse setup: a minimal `.env.example`, one `dev` command, and `setup-arcade` if risk 8
   allows it.
6. The README in Mastra's exact outline.
7. Submission cleanup: `render.yaml`, `docs/spikes`, `docs/evidence`, `.orca/`.
8. The human records the 2 to 3 minute video and sends the repo to Alex Booker.
