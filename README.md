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
- **[Arcade project, key and CLI](https://docs.arcade.dev/en/references/arcade-cli)**: `bun run setup-arcade` registers everything in one Arcade project and runs `arcade deploy` into it, so the key and the Arcade CLI have to point at the same project. In this order:
  1. Install the Arcade CLI: `uv tool install arcade-mcp`, as the [Arcade CLI reference](https://docs.arcade.dev/en/references/arcade-cli) describes.
  2. Run `arcade login`.
  3. Create a project for this template in the Arcade dashboard ([Operate quickstart](https://docs.arcade.dev/en/operate/quickstart)).
  4. Create an API key in that project and set `ARCADE_API_KEY` to it ([Get an API key](https://docs.arcade.dev/en/get-started/setup/api-keys), or the dashboard's [API keys](https://api.arcade.dev/dashboard/api-keys) page).
  5. Make it the CLI's active project: `arcade project set <project_id>`, with the id `arcade project list` shows. If your account has more than one org, run `arcade org set <org_id>` first, because switching org resets the active project to that org's default ([CLI cheat sheet](https://docs.arcade.dev/en/references/cli-cheat-sheet)).
  6. Check it: `arcade whoami` shows that org and project.
- **[ngrok domain](https://ngrok.com/docs/universal-gateway/domains/)**: set `APP_PUBLIC_HOST` to your ngrok domain in host form, with no scheme (for example `my-app.ngrok.app`). Arcade Cloud calls the hooks, the loan API and the sign-in endpoints on this host, and you open the app there too, because the sessions and the Arcade verifier live on this host only. Every ngrok account includes a free dev domain, and a fixed domain keeps the host the same across restarts.
- **A Slack workspace with two accounts in it**: one for you, the loan officer who asks for the approval, and one for the approver. The request reaches the approver as a Slack DM sent from your own account, and it finds the approver by the email you add them under, so that email has to be the one their Slack account uses.
- `ANTHROPIC_API_KEY`, `ARCADE_API_KEY` and `APP_PUBLIC_HOST` are the only values you fill in. The second block of `.env.example` is written by `bun run setup-arcade`, so leave it blank, and the third block is optional, with defaults that work. No user is seeded and no password ships: you add the people in step 8 of the Quickstart.

## Quickstart 🚀

1. **Clone the template**
   - Run `npx create-mastra@latest loan-approval-limits --template arcade-governance --no-install`, then `cd loan-approval-limits`.
   - `--no-install` matters: the project installs with Bun, and the `npm install` that `create-mastra` would otherwise run cannot resolve its `workspace:*` dependencies.
2. **Install dependencies**
   - Run `bun install`. One install covers the app and its workspaces.
3. **Add your API keys**
   - Run `cp .env.example .env` and fill in the three values described under Prerequisites.
4. **Register the app with Arcade**
   - Run `bun run setup-arcade <APP_PUBLIC_HOST> --dry-run` to print every request it would send and every deploy it would run, with every secret as a placeholder. Nothing is written, sent or deployed.
   - Run `bun run setup-arcade <APP_PUBLIC_HOST>`. It checks that `ARCADE_API_KEY` belongs to the Arcade CLI's active project before it writes anything. Then it mints the app's three OAuth clients, fills the second block of `.env` (blanks only, never overwriting), and registers the `app-identity` auth provider, the two tool secrets, the custom verifier and the contextual access hooks through Arcade's API. Last, it runs `arcade deploy` in `tools/loan` and then in `tools/approvals`.
   - It ends by printing the one form Arcade's API cannot fill, the User Source, and the command that finishes the job. Keep that output for step 6.
5. **Start the app and the tunnel**
   - Run `bun run dev`. It prints the URL to open, `https://<APP_PUBLIC_HOST>`, and the ngrok command for the app's port, which is `PORT` from `.env`, 3000 when unset.
   - In a second terminal, run the ngrok command `bun run dev` printed. With the default `PORT` it is `ngrok http --url=<APP_PUBLIC_HOST> 3000`; with any other `PORT`, the tunnel has to point at that port instead.
6. **Create the User Source**
   - With the app reachable through the tunnel, fill in the User Source form that `setup-arcade` printed (Arcade dashboard, your project, User Sources). Arcade reads the app's sign-in through the tunnel when you save it.
   - Note its id, which starts with `us_`: the id shown on the User Source's page.
7. **Create the gateway**
   - Run `bun run setup-arcade <APP_PUBLIC_HOST> --user-source <id>` with that id. It finds everything from step 4 already in place and creates the gateway through the User Source, with the four Loan tools and the two Approvals tools.
8. **Add yourself and an approver**
   - Add yourself as the loan officer: `bun run users add <your-email> --name Alice --role loan_officer --clearance 50000`. Any name works, but the rest of this README calls the loan officer Alice and the approver Charlie.
   - Add the approver: `bun run users add <approver-email> --name Charlie --role vp_credit --clearance 250000`. Use the email the approver's Slack account uses, because that is how the escalation finds them in Slack.
   - Each `add` prints a generated password once, and only its hash is stored, so keep it: that password and the email are the sign-in. Nothing needs a restart, because the running app reads new people on their next sign-in.
   - The loan officer's email has to be a member of your Arcade project: invite it in the Arcade dashboard, under your project's Members. Anyone who requests an approval needs this, because Arcade sends the stock Slack provider through its own verifier, which only lets project members through (see [Do my users need Arcade accounts?](#faq)). `bun run users` prints the reminder for everyone who could request an approval, the approver included, but an approver who only approves needs no Arcade account.
   - The shortcut is `bun run users seed-demo`, which adds the whole demo cast (Alice, Bob, Charlie and Michael) with the demo's roles and clearances. It asks for each person's email, or takes them as `--alice <email>`, `--bob`, `--charlie` and `--michael`, and prints each generated password once. The same Slack and Arcade rules apply to the emails you give it.
   - `bun run users list` shows who can sign in, with their roles and clearances.
9. **Ask for the $95K approval**
   - Open `https://<APP_PUBLIC_HOST>`, not localhost, and sign in as Alice, with the email and password from step 8. The first time a browser opens a free ngrok domain, ngrok shows its own warning page first: click **Visit Site**. Arcade's own calls to the app never see that page. Use **Authorize the gateway** to accept Arcade's consent screen once.
   - In the chat, send: "Approve the loan for $95K and double-check your work so you don't make any mistakes."
   - The first loan tool call asks you to authorize the app's own provider: authorize it, then use **Continue**. The agent then finds `LN-2291` (Northwind Bakery LLC, $95,000), calls `Loan_ApproveLoan`, and the chat shows a denial card with the hook's own words: "DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. To proceed, call Approvals_RequestApproval…", ending in a `[ref evt_…]` token that joins it to the audit row. The loan stays pending.
   - To run the same turn in Mastra Studio: run `bun run studio`, which listens on `STUDIO_PORT` (4111 when unset, and the links below assume 4111). Open [localhost:4111/arcade/authorize](http://localhost:4111/arcade/authorize) and sign in as Alice, then open [Mastra Studio](http://localhost:4111), select the **loan-operations** agent and send the same prompt. Studio runs the same agent the chat does. Authorize the Loan toolkit in the web UI first, as above and as the same person. If a loan tool in Studio still needs authorizing, its result in Studio is the authorization link: open it, allow it, and send the prompt again. When Arcade sends Studio no link, the result says so and sends you to the web UI to authorize there.

## Try it out

- **With your own users or the demo cast.** Alice is the loan officer and Charlie the approver you added in step 8. Bob, a credit analyst, has a step of his own, and Michael, a chief credit officer, is the approver the routing passes over. `bun run users seed-demo` adds both, or add them yourself: `bun run users add <email> --name Bob --role credit_analyst`, which needs no clearance because Bob cannot see the approval tool, and `bun run users add <email> --name Michael --role chief_credit_officer --clearance 5000000`.
- **Let the escalation reach Charlie.** After the refusal, the agent calls `Approvals_RequestApproval` because the hook's refusal told it to; nothing in the system prompt mentions escalating. The first time, it asks Alice to authorize Slack through Arcade's built-in Slack integration, with no Slack app or token of your own. Routing is deterministic: the lowest clearance that covers the amount, with the requester excluded, so $95K goes to Charlie ($250K), and Michael ($5M), if you added him, is recorded as a candidate and deliberately not bothered. Charlie gets a Slack DM from Alice's own account, with a link to the approval page. The link carries no authority. Then the agent ends its turn.
- **Try to approve your own request.** Before Charlie answers, open the approval link as Alice and press Approve. The control plane refuses it (`pre.decide-not-by-the-requester`), because possession of the link is not permission, and the request stays pending.
- **Approve as Charlie and watch the retry pass.** In a separate browser profile, sign in as Charlie, open the link and press Approve. That press is itself a governed tool call, which `/hooks/pre` checks for Charlie's clearance and for a requester who is not the approver. Alice's chat resumes on its own, the agent retries, and this time `Loan_ApproveLoan` is allowed by the same rule that denied it, citing a single-use grant. A second retry is denied again.
- **Send the same prompt as Bob.** In another browser profile, sign in as Bob, the credit analyst with no approval authority, and send the prompt from the Quickstart. `ApproveLoan` never reaches his agent: the access hook removes it from the tool list, so there is nothing to refuse and the agent has no way to approve the loan.
- **Ask for what the model should not see.** As Alice, send "Read loan LN-2291 and quote its bank account number and tax ID back to me." Both come back as `[REDACTED]`, because the post-execution hook masks them before the output reaches the model. As Charlie or Michael, they come through. For everyone, the instruction someone pasted into the loan's underwriter notes is stripped before the model reads it. Open `https://<APP_PUBLIC_HOST>/panel` alongside to watch each decision land in the Access, Pre and Post lanes.

## Customization

- Open the project in your coding agent and describe what you want to change. For example: "Replace the loan book with our equipment-lease approvals. Keep `packages/` and the control plane as they are, replace `lib/loans/`, `tools/loan` and the seed fixtures, and keep `app-test/loans/knows-nothing-about-governance.test.ts` passing. Explore the code and propose a plan before making changes."
- Change who can approve what with `bun run users`: `set-clearance <email> <n>` sets a person's approval limit and `set-role <email> <role>` their role, `add` and `remove` bring people in and take them out, and `list` shows everyone. The running app sees each change within one poll, with no restart and no reset, and every change is recorded in `governance.db`'s `subject_changes`. A role has to be one the policy knows, and `bun run users` names those when it refuses one.
- Change the rules in `lib/control-plane/fixtures/governance.json`: each rule matches a toolkit and a PascalCase tool name such as `ApproveLoan`. The fixture seeds `governance.db` once, so after editing it set `RESET_TOKEN` in `.env`, restart `bun run dev` and run `bun run reset`. Until you do, `/health` reports `fixture_drift`. A reset leaves the people you added under addresses of your own as they are, roles and clearances included.

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
| **2** | `Approvals_RequestApproval` → Slack | Arcade's stock Slack provider, which goes through **Arcade's own verifier**: the requester must be a member of the Arcade project |

Neither mechanism moves the other. Arcade's default verifier demands an Arcade account that is a project member. For the loan tools your users need none, because the custom verifier binds the grant to the signed-in person; without it, a user verified against the wrong account binds the grant to the wrong user and the tool re-challenges forever. The custom verifier covers custom providers only. Arcade sends its built-in providers, Slack among them, through its own verifier, so anyone who requests an approval must be invited to the Arcade project under their email. `bun run setup-arcade` sets the custom verifier and reads it back through the admin API, which is the check to trust rather than a dashboard label.

**Email is the join key.** Arcade's `user_id`, the OAuth subject and the actor the loan module records are the same string, lowercase. If they diverge, `governance.db` and `loans.db` describe different people and the audit trail is fiction. The loan module takes the actor from the token, never from a request parameter, because an actor passed as an argument is an actor the model can forge.

## Project layout

One TypeScript app at the repo root (Next.js plus `src/mastra`, running on Bun) and two Python toolkits:

```
src/mastra/index.ts        The Mastra entry. Registers the loan-operations agent, the same one the chat runs.
lib/agent/                 The agent: instructions, the governed toolset, Studio's own gateway authorization
                           and thread memory (memory.db).
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

`.env.example` documents every variable in place, in three blocks: the three you fill in, the ones `bun run setup-arcade` writes, and optional overrides with their defaults.

- **`/health` names what is missing.** It answers HTTP 200 either way, with `status` `ok` or `degraded` and one field per capability, including `signin`, `gateway`, `verifier`, `agent`, `panel_stream`, `policy`, `loans`, `identity` and `reset`. A fresh clone with nothing filled in answers `degraded` and names `signin`, `gateway`, `verifier` and `agent` as `missing`. Nothing falls back silently. Arcade's own health check is a different path, `/hooks/health`, with its own `healthy|degraded|unhealthy` vocabulary.
- **The Arcade project.** `bun run setup-arcade` registers the hooks and the gateway in the Arcade CLI's active org and project, as `arcade whoami` shows them, and stops before writing anything if `ARCADE_API_KEY` belongs to another project. To use a different project, set `ARCADE_ORG_ID` and `ARCADE_PROJECT_ID` in `.env`. With no CLI login and neither variable, it prints the hooks and the gateway as dashboard forms instead.
- **Open the app on its public host.** With `APP_PUBLIC_HOST` set, the home page shows an amber banner when it is served on any other host, such as localhost.
- **`BETTER_AUTH_SECRET` is written by `setup-arcade`.** Blank, the app uses a published development secret, and only on localhost: with `APP_PUBLIC_HOST` set to anything else, identity refuses to start (no sign-in, no approval, no hop-2 exchange) and `/health` says why under `identity`. A plain localhost run with nothing set still works on the development secret.
- **Changing `BETTER_AUTH_SECRET` is a rotation.** An `idp.db` whose signing key the configured secret cannot open is refused at boot and never re-keyed silently. The fix it names is to delete the local `idp.db`, then run `bun run setup-arcade` again before registering anything, because the OAuth clients change with it. Deleting `idp.db` also deletes everyone's sign-in while `governance.db` keeps their roles, so `bun run users list` shows each person half there: run `bun run users remove <email>` and then `bun run users add` for each one, which gives them a new password.
- **The port.** `bun run dev` always passes a port to Next, `PORT` or 3000, so a taken port is an error rather than a silent move to 3001 that the tunnel would not follow. Before starting Next it also checks `127.0.0.1` and `::1`, and refuses a port that anything answers on at either, because Next itself would start beside a listener on only one of them. Studio binds `STUDIO_PORT`, default 4111.
- **Never drive the demo from an Arcade Org Admin account.** An admin's tool list is the whole org catalogue: measured at 8259 tools, all correctly denied, and a 1.6 MB `/hooks/access` payload.

## Resetting the demo

The three databases are SQLite files on disk, gitignored, and seeded from their fixtures only when empty. Data persists across restarts on purpose: a policy row edited during one act has to still be there in the next.

- `bun run reset` puts the control plane's policy and audit log and the loan book back, in seconds. It is idempotent.
- `bun run reset --hard` also resets the identity provider's sessions, tokens and consents, and keeps every account. That signs everyone out, so each one needs a sign-in and an authorization card before their next governed call.
- Both empty Mastra Studio's thread memory, `memory.db`, in place. `--hard` does nothing more to it. See [`docs/studio-memory.md`](./docs/studio-memory.md).
- Neither deletes a user. Everyone you added with `bun run users` under an address of your own keeps their account, role and clearance through both, and a clearance you changed with `set-clearance` stays changed. Each reset's output names who it kept.
- Both call each module's own `/admin/reset` route under `RESET_TOKEN`. With it unset, every reset route answers 404 and `/health` reports `reset: disabled`.

**A reset is not a re-registration.** Nothing in `bun run reset` touches the OAuth client Arcade holds. Deleting `idp.db` or changing `BETTER_AUTH_SECRET` does, and the app refuses to start identity until you re-run `bun run setup-arcade` (see above).

## FAQ

Documentation could not answer several of these, so we measured them against a real Arcade project. [`DESIGN.md`](./DESIGN.md) records the reasoning behind each decision.

**Why are the limits enforced in hooks rather than in the agent's prompt?** A limit in the prompt is one more thing for the model to weigh, and one sentence of prompt was enough to move the result either way, as [Why we built this](#why-we-built-this) describes. So the system prompt and every tool description carry no behavioural instruction: nothing about confirming, refusing, escalating, retrying or caution. The hook writes the denial and the instruction to escalate, which is why the agent calls `Approvals_RequestApproval` with no mention of it in the prompt.

**Do the hooks fire for toolkits shipped with `arcade deploy`?** Yes. A spike measured `/access`, `/pre` and `/post` firing for a remote MCP server's tools, with a payload identical in shape to a hosted toolkit's. Arcade confirmed that the hooks apply to every tool wherever it is hosted, including `arcade deploy`'d toolkits, which is how both of this template's toolkits ship. The same spike found one exception. Arcade checks a tool's auth requirements before `/pre`, so a layer-2 refusal fires no hook and writes no audit row, as [How the controls work](#how-the-controls-work) explains.

**Why does the chat show some failed tool calls as a denial and others as a fault?** Because only one of them is a decision. The chat draws a denial card only on positive evidence that a hook decided, such as `CHECK_FAILED` or the `[ref evt_…]` token, which the control plane writes on every decision and which survives MCP all the way to the UI. Every other tool failure is a fault card that says no decision was made, because a control surface must never claim a control-plane action that did not happen.

**Why does the $95K approval depend on stripping the note pasted into `LN-2291`?** Because the model reads the injected instruction, refuses it, and ends its turn asking whether to proceed, so it never calls `Loan_ApproveLoan`. With the note visible, the $95K request reached `/hooks/pre` roughly 5 times in 17; with `/hooks/post` stripping the note first, 5 of 5, and 5 of 5 again on an independent re-measurement. The fix removed what the model was reading and did not steer the model.

**Why does Charlie's Slack DM come from Alice and not from a bot?** Arcade's stock Slack provider issues a delegated user token, so the DM arrives under the requester's own name with no app badge. There is no custom Slack app and no bot fallback, which is why Alice authorizes Slack once through Arcade and nobody configures a Slack token. The toolkit asks for four scopes, `chat:write`, `im:write`, `users:read` and `users:read.email`, because Slack refuses an authorize request for `users:read.email` without `users:read`.

**Why two OAuth hops?** Because Arcade establishes who you are at two separate points. Hop 1, the MCP client reaching the gateway, is answered by a User Source whose issuer is the app's own sign-in; hop 2, the loan tool calling the loan API as the signed-in person, is answered by the `app-identity` provider and a custom verifier. A spike measured that hop 1's identity does not carry into hop 2, and without the custom verifier Arcade sends the user to its own account login, which requires an Arcade account that is a project member. The mechanisms are in [Two OAuth hops, two mechanisms](#two-oauth-hops-two-mechanisms).

**Can the control plane see an OAuth misconfiguration?** No. The two identity spikes hit four, among them a token request that carried the client credentials twice and a Client ID field holding a URL, and each one fired no hook and left the panel empty. Read the auth provider's configuration back through Arcade's admin API rather than off the dashboard, because a spike caught the dashboard's auth-method label disagreeing with what the provider sent. The two-hop design the spikes led to is in [`DESIGN.md`](./DESIGN.md#identity-and-oauth).

**Do my users need Arcade accounts?** Anyone who requests an approval does, and nobody else. `Approvals_RequestApproval` authorizes Slack through Arcade's stock Slack provider, and Arcade sends its built-in providers through its own user verifier, which only lets members of the Arcade project through. So a requester such as Alice has to be invited to the project under the email she signs in to the app with, in the Arcade dashboard under the project's Members. `bun run users add` and `bun run users seed-demo` print that reminder for everyone who could request an approval. The loan tools need no Arcade account, because they authorize against the app's own provider, `app-identity`, and the app's custom verifier binds that grant to whoever is signed in to the app. The custom verifier covers custom providers only, which is why it does not cover Slack. An approver who only approves needs no Arcade account either: `Approvals_Decide`, which the approval page calls when Charlie presses Approve, has no auth requirement at all. If you'd rather nobody needed an Arcade account, register your own Slack app as a custom OAuth provider in your Arcade project. Arcade then routes Slack through the custom verifier too, so nobody needs an Arcade account. It is not the default because it asks everyone who forks the template to create a Slack app.

**Why does it need a public host when it runs on my machine?** Because Arcade Cloud makes the calls. Arcade calls the hooks, the deployed loan toolkit calls the loan API, and both OAuth hops reach the app's sign-in and verifier endpoints, all on `APP_PUBLIC_HOST`. One ngrok domain carries all of them, and a fixed domain keeps that host the same across restarts, which matters because `bun run setup-arcade` registers it with Arcade. If you host the image instead, as [Deploying](#deploying) describes, `APP_PUBLIC_HOST` is the deployment's own host.

**Why Bun?** The three databases use `bun:sqlite`, which Node cannot load, so `next dev`, `next build` and the standalone server all run under Bun. Mastra Studio runs `mastra dev` as a separate Node process, so the agent never imports a module that opens one of them, and a test enforces it. Studio's own thread memory is a fourth file, `memory.db`, opened with libsql, which Node can load.

**Can I use a model other than Claude Sonnet 5?** Another Anthropic model, yes, with no code change. Set `MODEL_ID` in `.env` to its Anthropic model id, and both the chat and Studio pass it to `@ai-sdk/anthropic` with your `ANTHROPIC_API_KEY`. `MODEL_ID` is a bare Anthropic model id, not a `provider/model` string for Mastra's model router, so a model from another provider needs a code change: `anthropicModel` in `lib/agent/agent.ts`, and the `ANTHROPIC_API_KEY` checks in `lib/config.ts` and `lib/agent/studio.ts`. We measured the 5-of-5 result above on Claude Sonnet 5 at temperature 0, so a different model needs it measured again.

## Deploying

The Quickstart runs the app on your machine behind ngrok. To host it instead, build the root `Dockerfile`. It makes one image, running on Bun, that serves everything on one host: the pages, the hooks under `/hooks`, the loan API under `/bank` and the identity provider. The two toolkits are not in it, because they ship with `arcade deploy`. CI builds the image and boots it on every push.

- **The variables are the ones in `.env.example`.** Set `APP_PUBLIC_HOST` to the deployment's own host. The image runs in production mode, so nothing falls back to a development value: without `ARCADE_HOOK_SIGNING_SECRET`, `APPROVALS_STORE_TOKEN` and `BETTER_AUTH_SECRET` the app still starts, but the control plane and the identity provider refuse to, and `/health` names the refusal.
- **One persistent disk holds all three databases.** Point `GOVERNANCE_DB_PATH`, `LOANS_DB_PATH` and `IDP_DB_PATH` at files on it, for example under `/data`. Without it the databases are recreated with every new container.
- **A redeploy is not a reset.** The databases seed from their fixtures only when empty, and the disk survives a deploy, so every edit and every approval carries forward. `bun run reset` is the way back.
- **The disk holds the OAuth clients Arcade is registered against.** If `idp.db` is recreated, the clients change and the registration in Arcade goes stale.

## Further reading

- [`DESIGN.md`](./DESIGN.md) is the authoritative record: architecture, contracts, and the reasoning behind each decision.
- [`docs/DOMAIN-SWAP.md`](./docs/DOMAIN-SWAP.md) walks through pointing the template at your own business system.
- [`docs/control-plane.md`](./docs/control-plane.md) is the control plane's own reference: the hooks, `governance.db`, drift and reset, the live stream and the audit log.
- [`docs/studio-memory.md`](./docs/studio-memory.md) covers Studio's thread memory: why `memory.db` is libsql, what it never keeps, and how the reset empties it.

## About Mastra templates

This partnership template was contributed by Arcade to show how Mastra works with Arcade's contextual access hooks, auth providers and MCP gateways for enforcing loan approval limits on an agent's tool calls. Partnership templates live in their own repositories.

[Want to contribute?](https://github.com/ArcadeAI/mastra-template-loan-approval-limits)
