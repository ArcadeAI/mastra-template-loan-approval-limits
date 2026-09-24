# Loan Approval Limits with Arcade

A loan officer asks an agent, in plain language, to approve a $95K loan. The agent searches the bank's loan book, reads the application and calls the approval tool as her. Arcade sends that call to this app's control plane before it runs, and the control plane refuses it: $95K is over her $50K approval authority. The refusal tells the agent how to escalate, the request is routed to the one approver with enough authority, and once he approves, her retry goes through. You get a decision the model could not talk its way around, with an audit row for every step on a live panel.

## Why we built this

An agent that writes to a real business system needs limits the model cannot reason around. The thesis is one sentence: **treat the LLM as an adversary, and put the controls somewhere it cannot reason around.**

A limit written into a system prompt is a suggestion, and we measured how fragile it is: one "irreversible, no undo" line made the model stop and ask permission, and one "do not ask the person to confirm" line pushed it the other way. So the prompt carries no behavioural instruction at all, and every control lives outside the model, in hooks Arcade calls on every tool call, keyed on who is signed in. The model never gets a vote.

## Demo

<!-- TODO: REPLACE THIS PLACEHOLDER WITH THE CLOUDINARY DEMO VIDEO URL -->

<video controls width="640" height="360" src="CLOUDINARY_DEMO_VIDEO_URL_REQUIRED"></video>

## Prerequisites

- **[Anthropic API key](https://platform.claude.com/settings/keys)**: set `ANTHROPIC_API_KEY`. The agent runs Claude Sonnet 5 at temperature 0.
- **[Arcade API key](https://api.arcade.dev/dashboard/api-keys)**: set `ARCADE_API_KEY` to a key for the Arcade project you want to use. `bun run setup-arcade` registers everything in the project that key belongs to. Deploying the two toolkits also needs the Arcade CLI, installed as the [Arcade Deploy guide](https://docs.arcade.dev/en/build/arcade-deploy) describes.
- **[ngrok domain](https://ngrok.com/docs/universal-gateway/domains/)**: set `APP_PUBLIC_HOST` to your ngrok domain in host form, with no scheme (for example `my-app.ngrok.app`). Arcade Cloud calls the hooks, the loan API and the sign-in endpoints on this host, and you open the app there too, because the sessions and the Arcade verifier live on this host only. Every ngrok account includes a free dev domain, and a fixed domain keeps the host the same across restarts.
- Four persona emails: set `PERSONA_LOAN_OFFICER_EMAIL` (Alice), `PERSONA_CREDIT_ANALYST_EMAIL` (Bob), `PERSONA_VP_CREDIT_EMAIL` (Charlie) and `PERSONA_CHIEF_CREDIT_OFFICER_EMAIL` (Michael) to four addresses you control. Each persona is a user of the app's own sign-in, and the email is what joins Arcade's user id, the OAuth subject and the loan book's actor. Set them before the first `bun run setup-arcade` or `bun run dev`, because the identity and policy databases seed them once. All four sign in with the demo-only fixture password `megaforce-demo-2026`. For the approval step in Try it out, Charlie's address must also be his account in your Slack workspace.
- Those seven are the only values you fill in. The second block of `.env.example` is written by `bun run setup-arcade`, so leave it blank, and the third block is optional, with defaults that work.

## Quickstart 🚀

1. **Clone the template**
   - Run `npx create-mastra@latest loan-approval-limits --template arcade-governance --no-install`, then `cd loan-approval-limits`.
   - `--no-install` matters: the project installs with Bun, and the `npm install` that `create-mastra` would otherwise run cannot resolve its `workspace:*` dependencies.
2. **Install dependencies**
   - Run `bun install`. One install covers the app and its workspaces.
3. **Add your API keys**
   - Run `cp .env.example .env` and fill in the seven values described under Prerequisites.
4. **Register the app with Arcade**
   - Run `bun run setup-arcade <APP_PUBLIC_HOST> --dry-run` to print every request it would send, with every secret as a placeholder. Nothing is written and nothing is sent.
   - Run `bun run setup-arcade <APP_PUBLIC_HOST>`. It mints the app's three OAuth clients, fills the second block of `.env` (blanks only, never overwriting), and registers the `app-identity` auth provider, the two tool secrets, the hooks and the custom verifier through Arcade's API.
   - It ends by printing two dashboard forms that Arcade's API cannot fill: the User Source and the gateway. Keep that output for step 6.
5. **Start the app and the tunnel**
   - Run `bun run dev`. It prints the URL to open, `https://<APP_PUBLIC_HOST>`, and the ngrok command for this port.
   - In a second terminal, run that command: `ngrok http --url=<APP_PUBLIC_HOST> 3000`.
6. **Finish the Arcade side**
   - With the app reachable through the tunnel, fill in the User Source form that `setup-arcade` printed (Arcade dashboard, your project, User Sources).
   - Deploy both toolkits: run `arcade deploy` in `tools/loan`, then again in `tools/approvals`. Their tool secrets were already set in step 4.
   - Fill in the gateway form that `setup-arcade` printed (MCP Gateways). The toolkits' tools are listed there once both deploys have run.
7. **Ask for the $95K approval**
   - Open `https://<APP_PUBLIC_HOST>`, not localhost, and sign in as Alice. Use **Authorize the gateway** to accept Arcade's consent screen once.
   - In the chat, send: "Approve the loan for $95K and double-check your work so you don't make any mistakes."
   - The first loan tool call asks you to authorize the app's own provider: authorize it, then use **Continue**. The agent then finds `LN-2291` (Northwind Bakery LLC, $95,000), calls `Loan_ApproveLoan`, and the chat shows a denial card with the hook's own words: "DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. To proceed, call Approvals_RequestApproval…", ending in a `[ref evt_…]` token that joins it to the audit row. The loan stays pending.
   - To run the same turn in Mastra Studio: run `bun run studio`, open [localhost:4111/arcade/authorize](http://localhost:4111/arcade/authorize) and sign in as Alice, then open [Mastra Studio](http://localhost:4111), select the **loan-operations** agent and send the same prompt. Studio runs the same agent the chat does.

## Try it out

- **Let the escalation reach Charlie.** After the refusal, the agent calls `Approvals_RequestApproval` because the hook's refusal told it to; nothing in the system prompt mentions escalating. The first time, it asks Alice to authorize Slack through Arcade's built-in Slack integration, with no Slack app or token of your own. Routing is deterministic: the lowest clearance that covers the amount, with the requester excluded, so $95K goes to Charlie ($250K) and Michael ($5M) is recorded as a candidate and deliberately not bothered. Charlie gets a Slack DM from Alice's own account, with a link to the approval page. The link carries no authority. Then the agent ends its turn.
- **Try to approve your own request.** Before Charlie answers, open the approval link as Alice and press Approve. The control plane refuses it (`pre.decide-not-by-the-requester`), because possession of the link is not permission, and the request stays pending.
- **Approve as Charlie and watch the retry pass.** In a separate browser profile, sign in as Charlie, open the link and press Approve. That press is itself a governed tool call, which `/hooks/pre` checks for Charlie's clearance and for a requester who is not the approver. Alice's chat resumes on its own, the agent retries, and this time `Loan_ApproveLoan` is allowed by the same rule that denied it, citing a single-use grant. A second retry is denied again.
- **Send the same prompt as Bob.** In another browser profile, sign in as Bob, the credit analyst with no approval authority, and send the prompt from the Quickstart. `ApproveLoan` never reaches his agent: the access hook removes it from the tool list, so there is nothing to refuse and the agent has no way to approve the loan.
- **Ask for what the model should not see.** As Alice, send "Read loan LN-2291 and quote its bank account number and tax ID back to me." Both come back as `[REDACTED]`, because the post-execution hook masks them before the output reaches the model. As Charlie or Michael, they come through. For every persona, the instruction someone pasted into the loan's underwriter notes is stripped before the model reads it. Open `https://<APP_PUBLIC_HOST>/panel` alongside to watch each decision land in the Access, Pre and Post lanes.

## Customization

- Open the project in your coding agent and describe what you want to change. For example: "Replace the loan book with our equipment-lease approvals. Keep `packages/` and the control plane as they are, replace `lib/loans/`, `tools/loan` and the seed fixtures, and keep `app-test/loans/knows-nothing-about-governance.test.ts` passing. Explore the code and propose a plan before making changes."
- Change who can approve what in `lib/control-plane/fixtures/governance.json`: each subject's `clearance` is an approval limit, and each rule matches a toolkit and a PascalCase tool name such as `ApproveLoan`. The fixture seeds `governance.db` once, so after editing it set `RESET_TOKEN` in `.env`, restart `bun run dev` and run `bun run reset`. Until you do, `/health` reports `fixture_drift`.

## How the controls work

Arcade gives every tool call four control points, each keyed on the signed-in person. The model sits inside all of them:

| # | Layer | Keyed on | Mechanism |
|---|---|---|---|
| 1 | Whether you can see the tool | identity | `/hooks/access` → `deny` list |
| 2 | Whether you hold the credential to call it at all | identity | per-tool auth requirement, OAuth scopes |
| 3 | Whether you have the authority for *this* call | identity + policy | `/hooks/pre` → `CHECK_FAILED` |
| 4 | What comes back | policy | `/hooks/post` → `override.output` |

Layers 1, 3 and 4 are HTTP endpoints this app serves under `/hooks`, and Arcade calls them. Layer 2 is Arcade's own.

**Layer 2 is invisible to the control plane, and that constrains what you can stage.** Arcade evaluates auth requirements before `/hooks/pre`, so a refusal there fires no hook, writes no audit row and shows nothing on the panel. If something you expected to see is missing, check the OAuth registration before you suspect the control plane.

**Two spellings of one tool name, and they are not interchangeable.** MCP advertises `Loan_GetLoan`, which is what the model can call. Hook payloads, audit rows and policy rules use `Loan.GetLoan`. Key rules the dot way, and write the underscore spelling in any text addressed to the model, such as a denial's remediation sentence. A rule keyed on `get_loan` matches nothing, and a rule that matches nothing is indistinguishable from a rule that permits.

Two claims are enforced by tests rather than asserted:

- **The business system does not know it is governed.** `app-test/loans/knows-nothing-about-governance.test.ts` fails if governance vocabulary (`policy`, `role`, `limit`, `redact`, `authority`, `approver`, `permission`) appears in `lib/loans/`, or if it imports a `@cg/*` package. The pull to add "just one guard" there is real, and that test is the thing that says no.
- **`packages/governance-core` depends on no app.** `packages/governance-core/test/no-app-dependencies.test.ts` fails if it declares a dependency on an app package or imports from one.

A control that silently does nothing is worse than no control. Every identifier in the policy is measured off a real deployment rather than derived, and every `/hooks/post` pattern is proved to fire against a corpus.

## Two OAuth hops, two mechanisms

Conflating them cost a day. The full diagram is in [`DESIGN.md`](./DESIGN.md#identity-and-oauth).

| | hop | mechanism |
|---|---|---|
| **1** | MCP client → gateway | the gateway's **User Source**, whose issuer is the app's own sign-in |
| **2** | tool → the loan API | the `app-identity` auth provider, plus a **custom user verifier** route in the app, `/api/arcade/verify` |

Neither mechanism moves the other. Arcade's default verifier demands an Arcade account that is a project member. The personas are not, so a persona verified against the wrong account binds the grant to the wrong user and the tool re-challenges forever. `bun run setup-arcade` sets the custom verifier and reads it back through the admin API, which is the check to trust rather than a dashboard label.

**Email is the join key.** Arcade's `user_id`, the OAuth subject and the actor the loan module records are the same string, lowercase. If they diverge, `governance.db` and `loans.db` describe different people and the audit trail is fiction. The loan module takes the actor from the token, never from a request parameter, because an actor passed as an argument is an actor the model can forge.

## Project layout

One TypeScript app at the repo root (Next.js plus `src/mastra`, running on Bun) and two Python toolkits:

```
src/mastra/index.ts        The Mastra entry. Registers the loan-operations agent, the same one the chat runs.
lib/agent/                 The agent: instructions, the governed toolset, Studio's own gateway authorization.
lib/control-plane/         /hooks/access, /hooks/pre, /hooks/post: the policy engine, audit log and event
                           stream. Owns governance.db. The policy fixture is fixtures/governance.json.
lib/loans/                 The bank's system of record, a plain HTTP API under /bank. Owns loans.db.
                           No MCP, no Arcade, no governance.
lib/identity/              Sign-in, sessions and the custom verifier. lib/identity/provider/ is the app's
                           own OAuth 2.1 provider (Better Auth). Owns idp.db.
app/                       The pages: the bank at /, the loan board at /loans, the panel at /panel,
                           approval pages at /approvals/<id>, readiness at /health.

tools/loan                 Python arcade-mcp: SearchLoans, GetLoan, ApproveLoan, DenyLoan.
                           A stateless client of /bank, via APP_PUBLIC_HOST.     → arcade deploy
tools/approvals            Python arcade-mcp: RequestApproval, Decide.         → arcade deploy

packages/governance-core   Hook framework, policy engine, audit, event bus. No loan references.
packages/policy-schema     Shared zod types for policy, events and hook payloads.
```

`lib/loans/` is not an MCP server on purpose. Banks have APIs, not MCP servers, and keeping the tool layer in `tools/loan` means pointing a thin toolkit at an API you already have. The toolkits are Python because `arcade-mcp`, the tool-authoring framework, is Python-only. Nothing else in the repo is Python.

The toolkits have their own READMEs: [`tools/loan`](./tools/loan/README.md) and [`tools/approvals`](./tools/approvals/README.md).

## Configuration and readiness

`.env.example` documents every variable in place, in three blocks: the seven you fill in, the ones `bun run setup-arcade` writes, and optional overrides with their defaults.

- **`/health` names what is missing.** It answers HTTP 200 either way, with `status` `ok` or `degraded` and one field per capability, including `signin`, `gateway`, `verifier`, `agent`, `panel_stream`, `policy`, `loans`, `identity` and `reset`. A fresh clone with nothing filled in answers `degraded` and names `signin`, `gateway`, `verifier` and `agent` as `missing`. Nothing falls back silently. Arcade's own health check is a different path, `/hooks/health`, with its own `healthy|degraded|unhealthy` vocabulary.
- **Open the app on its public host.** With `APP_PUBLIC_HOST` set, the home page shows an amber banner when it is served on any other host, such as localhost.
- **`BETTER_AUTH_SECRET` is written by `setup-arcade`.** Blank, the app uses a published development secret, and only on localhost: with `APP_PUBLIC_HOST` set to anything else, identity refuses to start (no sign-in, no approval, no hop-2 exchange) and `/health` says why under `identity`. A plain localhost run with nothing set still works on the development secret.
- **Changing `BETTER_AUTH_SECRET` is a rotation.** An `idp.db` whose signing key the configured secret cannot open is refused at boot and never re-keyed silently. The fix it names is to delete the local `idp.db`, then run `bun run setup-arcade` again before registering anything, because the OAuth clients change with it.
- **The port.** `bun run dev` always passes a port to Next, `PORT` or 3000, so a taken port is an error rather than a silent move to 3001 that the tunnel would not follow. Studio binds `STUDIO_PORT`, default 4111.
- **Never drive the demo from an Arcade Org Admin account.** An admin's tool list is the whole org catalogue: measured at 8259 tools, all correctly denied, and a 1.6 MB `/hooks/access` payload.

## Resetting the demo

The three databases are SQLite files on disk, gitignored, and seeded from their fixtures only when empty. Data persists across restarts on purpose: a policy row edited during one act has to still be there in the next.

- `bun run reset` puts the control plane's policy and audit log and the loan book back, in seconds. It is idempotent.
- `bun run reset --hard` also resets the identity provider's people, sessions, tokens and consents. That signs all four personas out, so each one needs a sign-in and an authorization card before their next governed call.
- Both call each module's own `/admin/reset` route under `RESET_TOKEN`. With it unset, every reset route answers 404 and `/health` reports `reset: disabled`.

**A reset is not a re-registration.** Nothing in `bun run reset` touches the OAuth client Arcade holds. Deleting `idp.db` or changing `BETTER_AUTH_SECRET` does, and the app refuses to start identity until you re-run `bun run setup-arcade` (see above).

## What we measured

Some questions could not be answered from documentation, so they were spiked against a real Arcade project. The transcripts are in [`docs/spikes/`](./docs/spikes/).

- **Do contextual-access hooks fire for tools we do not host ourselves?** Yes. `/access`, `/pre` and `/post` fire for a remote MCP server's tools with a payload identical in shape to a hosted toolkit's, and Arcade confirmed they apply to `arcade deploy`'d toolkits, which is the path this template runs on. The same spike found that layer-2 refusals fire no hook. See [`02-remote-mcp-hooks.md`](./docs/spikes/02-remote-mcp-hooks.md).
- **Does Arcade's stock Slack provider grant a user token that can post?** Yes, a delegated user token, so the approval DM arrives under the requester's own name with no app badge, and there is no custom Slack app and no bot fallback. The toolkit requests four scopes, not three: `users:read` is a prerequisite for `users:read.email`, and Slack refuses the authorize request without it. See [`03-slack-scopes.md`](./docs/spikes/03-slack-scopes.md).
- **What survives a hook denial, over MCP, all the way to the UI?** Enough to tell a decision from an outage. The `[ref evt_…]` token survives every layer, so the chat draws a denial card only on positive evidence of a hook decision, and every other tool failure is a fault card that says no decision was made. A control surface must never assert a control-plane action that did not happen.
- **The model reads an injected note and stops.** With `LN-2291`'s pasted instruction visible, the $95K request reached `/pre` roughly 5 times in 17: the model read the injection, refused it, and ended the turn asking whether to proceed. With `/hooks/post` stripping the note first, 5 of 5. Act 4's control is act 2's prerequisite, and the fix was removing what the model was reading, never steering it.
- The two identity spikes, [`04-user-source.md`](./docs/spikes/04-user-source.md) and [`05-custom-verifier.md`](./docs/spikes/05-custom-verifier.md), are the working record of the two-hop design, including OAuth misconfigurations that each fire no hook and leave the control plane dark.

## Deploying to Render

The Quickstart runs on your machine behind ngrok. [`render.yaml`](./render.yaml) is the stage demo's Render blueprint, reshaped for the one app: a single service, `cg-web`, built from the root `Dockerfile` with `runtime: docker` (Render does not detect Bun) and holding all three databases on one 1 GB disk. The toolkits are not in it, because they ship with `arcade deploy`. Secrets are `sync: false`, so a blueprint sync prompts for them rather than committing them.

- **A redeploy is not a reset.** The databases seed from their fixtures only when empty, and the disk survives a deploy, so every stage edit and every approval carries forward.
- **The disk holds the OAuth clients Arcade is registered against.** Without it, `idp.db` is recreated on every restart, the clients change, and the registration in Arcade goes stale.
- **A service with a disk gives up zero-downtime deploys.** Render stops the old instance before starting the new one.

## Further reading

- [`DESIGN.md`](./DESIGN.md) is the authoritative record: architecture, contracts, and the reasoning behind each decision.
- [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) is the rehearsal script for all four acts, with the prompts as measured and a failure playbook. It was written for the stage demo's Render deployment, so its hostnames and service names predate the one-app shape.
- [`docs/DOMAIN-SWAP.md`](./docs/DOMAIN-SWAP.md) walks through pointing the template at your own business system. Its `apps/*` paths predate the one-app shape: `apps/loan-app` is now `lib/loans/`, `apps/idp` is `lib/identity/provider/`, and `apps/web` is the repo root.

## About Mastra templates

This partnership template was contributed by Arcade to show how Mastra works with Arcade's contextual access hooks, auth providers and MCP gateways for enforcing loan approval limits on an agent's tool calls. Partnership templates live in their own repositories.

[Want to contribute?](https://github.com/ArcadeAI/mastra-template-loan-approval-limits)
