/**
 * The two registrations `bun run setup-arcade` cannot make by API, printed as
 * one paste-ready block per dashboard form (#9).
 *
 * - **The User Source** (hop 1). Arcade's API reference has no User Source
 *   endpoint at all. The fields are the ones docs.arcade.dev lists under
 *   "Operate → Identity → User Sources": Name, Description, Issuer URL, Client
 *   ID, Client Secret, and under Advanced, Scopes and Subject Claim.
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
 * Arcade reads the User Source's issuer from the app, so the app and the
 * tunnel are up before that form, and the gateway form lists the toolkits'
 * tools only once `arcade deploy` has run, so the deploys come before it.
 */
export function nextSteps({ host, origin, port }: NextSteps): string {
  return [
    "Then:",
    "  1. Restart `bun run dev`, so the app reads the new .env.",
    `  2. Start the tunnel: ngrok http --url=${host} ${port}`,
    "  3. With the app reachable through the tunnel, fill in the User Source form above.",
    "  4. Deploy the toolkits (their secrets are set above): arcade deploy, in tools/loan and in tools/approvals.",
    "  5. Fill in the gateway form above. The toolkits' tools are listed there once both deploys have run.",
    `  6. Open ${origin}, never localhost, and sign in.`,
  ].join("\n");
}
