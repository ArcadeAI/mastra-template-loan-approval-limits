/**
 * What `bun run setup-arcade` prints for the registrations it cannot make by
 * API (#9, #28, #30).
 *
 * - **The User Source** (hop 1), always. Arcade's API has no User Source route
 *   at all. The fields are the ones docs.arcade.dev lists under "Operate →
 *   Identity → User Sources": Name, Description, Issuer URL, Client ID, Client
 *   Secret, and under Advanced, Scopes and Subject Claim.
 * - **The gateway and the contextual access hooks**, only when the run found no
 *   Arcade org and project to register them in (`context.ts`). With one, both
 *   go through the API (`arcade.ts`, #30). The hooks form carries the live
 *   swagger's field names (`schemas.CreatePluginRequest`, its `webhook_config`,
 *   and `schemas.CreateHookRequest`'s `hook_point`), because nobody has read
 *   the dashboard's own labels yet. The gateway form's fields are from
 *   docs.arcade.dev "MCP Gateways → Create via dashboard", under a slug this
 *   script picks and writes as `ARCADE_GATEWAY_ID`.
 */
import { healthCheckUrl, HOOKS_NAME, HOOK_POINTS } from "./arcade.ts";

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
    `│  webhook_config.health_check_path   ${healthCheckUrl(origin)}`,
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
  /**
   * Where the gateway stands after this run: made by API (`created`), left
   * for a second run once the User Source exists (`needs-user-source`), or a
   * dashboard form because no org and project were found (`form`).
   */
  gateway: "created" | "needs-user-source" | "form";
  /** False under `--skip-deploy`: the toolkits still have to be deployed before the gateway lists them. */
  deployed: boolean;
}

/** The command that creates the gateway once the User Source exists. */
export function userSourceCommand(host: string): string {
  return `bun run setup-arcade ${host} --user-source <id>`;
}

/**
 * What is left once the run has registered everything it can, in the README
 * Quickstart's order (steps 5 to 8), which `app-test/setup-arcade.test.ts`
 * pins against the README itself (#11). The order is not a preference, and
 * since #30 it is the shortest one the dependencies allow: Arcade reads the
 * User Source's issuer from the app, so the app and the tunnel are up before
 * that form; the gateway authenticates through the User Source, so it waits
 * for the User Source's id; and it lists the toolkits' tools only once they
 * are deployed, which this run has done unless `--skip-deploy` said not to.
 */
export function nextSteps({ host, origin, port, gateway, deployed }: NextSteps): string {
  const steps = [
    "Start `bun run dev` (or restart it, if it is already running), so the app reads the new .env.",
    `Start the tunnel: ngrok http --url=${host} ${port}`,
    ...(deployed || gateway === "created"
      ? []
      : ["Deploy both toolkits (their secrets are set above): arcade deploy, in tools/loan and in tools/approvals."]),
    ...(gateway === "created"
      ? []
      : ["With the app reachable through the tunnel, fill in the User Source form above."]),
    ...(gateway === "needs-user-source"
      ? [`Create the gateway through that User Source: ${userSourceCommand(host)}, with the id shown on the User Source's page.`]
      : []),
    ...(gateway === "form"
      ? [
          "Fill in the gateway form above. It authenticates through the User Source, and lists the toolkits' tools once they are deployed.",
          "Fill in the contextual access hooks form above. Arcade checks /hooks/health through the tunnel.",
        ]
      : []),
    `Open ${origin}, never localhost, and sign in.`,
  ];
  return ["Then:", ...steps.map((step, index) => `  ${index + 1}. ${step}`)].join("\n");
}
