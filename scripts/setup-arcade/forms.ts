/**
 * The three registrations `bun run setup-arcade` cannot make by API, printed as
 * one paste-ready block per dashboard form (#9, #28), in the order they are
 * filled in.
 *
 * - **The User Source** (hop 1). Arcade's API reference has no User Source
 *   endpoint at all. The fields are the ones docs.arcade.dev lists under
 *   "Operate → Identity → User Sources": Name, Description, Issuer URL, Client
 *   ID, Client Secret, and under Advanced, Scopes and Subject Claim.
 * - **The contextual access hooks** (#28). Real Arcade has no `/v1/plugins`
 *   (the second live run on #7 got 404 `route_not_found`). The live swagger
 *   has plugins and hooks only under `/v1/orgs/{org_id}/projects/{project_id}/…`,
 *   and no route tells a project key its org or project. The form was chosen
 *   over two more required values in `.env` (#28). Its fields carry the live swagger's names
 *   (`schemas.CreatePluginRequest`, its `webhook_config`, and
 *   `schemas.CreateHookRequest`'s `hook_point`), because nobody has read the
 *   dashboard's own labels yet; #7 asks the human to.
 * - **The gateway.** `POST /v1/gateways` exists, but it has no field that
 *   attaches a User Source, and its one other documented authentication mode
 *   is Arcade Headers, which DESIGN.md rules out. So the gateway is a form too,
 *   under a slug this script picks and writes as `ARCADE_GATEWAY_ID`. Fields
 *   from docs.arcade.dev "MCP Gateways → Create via dashboard".
 */
export interface UserSourceForm {
  origin: string;
  clientId: string;
  /** `null` when the client already existed and was not rotated on this run. */
  clientSecret: string | null;
}

export function userSourceForm({ origin, clientId, clientSecret }: UserSourceForm): string {
  return [
    "┌─ Arcade dashboard → your project → User Sources → Create User Source",
    "│  Name            Loan Approval Limits",
    "│  Description     The app's own sign-in (hop 1)",
    `│  Issuer URL      ${origin}`,
    `│  Client ID       ${clientId}`,
    `│  Client Secret   ${
      clientSecret ??
      "(unchanged, and not shown: it is stored hashed. If you have not created this User Source yet, run `bun run oauth-client --client arcade-user-source --rotate` and paste the secret it prints.)"
    }`,
    "│  Advanced → Scopes          openid profile email",
    "│  Advanced → Subject Claim   email          ← not the default `sub`",
    "│",
    "│  Its callback, https://cloud.arcade.dev/oauth2/intermediate_callback, is already",
    "│  allowlisted on the app's `arcade-user-source` client.",
    "└─",
  ].join("\n");
}

/** The name the hooks go by in Arcade (`schemas.CreatePluginRequest.name`). */
export const HOOKS_NAME = "loan-approval-limits-hooks";

/**
 * The three hook points, each a full URL because the extension has no base
 * URL (`schemas.WebhookEndpointRequest`, measured by #4 and recorded on #7).
 * `phase` is what the remote-MCP hooks spike registered, and `failure_mode` is
 * required on every endpoint: fail closed, so an unreachable control plane
 * refuses rather than permits.
 */
export const HOOK_POINTS = [
  { point: "access", hookPoint: "tool.access", phase: "before" },
  { point: "pre", hookPoint: "tool.pre", phase: "before" },
  { point: "post", hookPoint: "tool.post", phase: "after" },
] as const;

/**
 * The bearer Arcade presents on every `/hooks` call is `.env`'s
 * `ARCADE_HOOK_SIGNING_SECRET`, named here and never printed: this output is
 * kept for the dashboard step and ends up in terminals and scrollback.
 */
export function hooksForm({ origin }: { origin: string }): string {
  return [
    "┌─ Contextual access hooks: Arcade dashboard → your project → create a webhook plugin",
    "│  The fields carry the names of Arcade's API (schemas.CreatePluginRequest); the dashboard's",
    "│  labels may read differently.",
    `│  name                  ${HOOKS_NAME}`,
    "│  description           The Loan Approval Limits control plane",
    "│  plugin_type           webhook",
    "│  status                active",
    ...HOOK_POINTS.flatMap(({ point, hookPoint, phase }) => [
      `│  webhook_config.endpoints.${point}   (hook_point ${hookPoint})`,
      `│    url                 ${origin}/hooks/${point}`,
      `│    phase               ${phase}`,
      "│    failure_mode        fail_closed",
      "│    status              active",
    ]),
    "│  webhook_config.health_check_path   /hooks/health",
    "│  webhook_config.auth.type           bearer",
    "│  webhook_config.auth.token          the value of ARCADE_HOOK_SIGNING_SECRET in .env (not printed here)",
    "│",
    "│  Arcade checks /hooks/health, so the app has to be reachable through the tunnel first.",
    "│  Fail closed on all three: an unreachable control plane refuses a call rather than permitting it.",
    "└─",
  ].join("\n");
}

export interface GatewayForm {
  slug: string;
  loanToolkit: string;
  approvalsToolkit: string;
}

export function gatewayForm({ slug, loanToolkit, approvalsToolkit }: GatewayForm): string {
  return [
    "┌─ Arcade dashboard → your project → MCP Gateways → Create Gateway",
    "│  Name              Loan Approval Limits",
    "│  Description       The loan officer's agent",
    `│  Slug              ${slug}        ← written to .env as ARCADE_GATEWAY_ID`,
    "│  LLM Instructions  (leave empty)",
    `│  Allowed Tools     every tool of ${loanToolkit}: SearchLoans, GetLoan, ApproveLoan, DenyLoan`,
    `│                    every tool of ${approvalsToolkit}: RequestApproval, Decide`,
    "│                    (they are listed once `arcade deploy` has run in tools/loan and tools/approvals)",
    "│  Authentication    Who are the users of this Gateway? → Non-Arcade Users → User Source",
    "│                    → Loan Approval Limits (the User Source above)",
    "│",
    "│  If Arcade says the slug is taken, pick another and run",
    "│  `bun run setup-arcade <host> --gateway <slug>` with ARCADE_GATEWAY_ID blanked in .env.",
    "└─",
  ].join("\n");
}

export interface NextSteps {
  host: string;
  origin: string;
  port: string;
}

/**
 * What is left once the run has registered everything it can, in the README
 * Quickstart's order (steps 5 to 7), which `app-test/setup-arcade.test.ts`
 * pins against the README itself (#11). The order is not a preference:
 * Arcade reads the User Source's issuer from the app, and checks the hooks'
 * `/hooks/health`, so the app and the tunnel are up before either form (#28),
 * and the gateway form lists the toolkits' tools only once `arcade deploy` has
 * run, so the deploys come before it.
 */
export function nextSteps({ host, origin, port }: NextSteps): string {
  return [
    "Then:",
    "  1. Start `bun run dev` (or restart it, if it is already running), so the app reads the new .env.",
    `  2. Start the tunnel: ngrok http --url=${host} ${port}`,
    "  3. With the app reachable through the tunnel, fill in the User Source form above.",
    "  4. Fill in the contextual access hooks form above. Arcade checks /hooks/health through the tunnel.",
    "  5. Deploy the toolkits (their secrets are set above): arcade deploy, in tools/loan and in tools/approvals.",
    "  6. Fill in the gateway form above. The toolkits' tools are listed there once both deploys have run.",
    `  7. Open ${origin}, never localhost, and sign in.`,
  ].join("\n");
}
