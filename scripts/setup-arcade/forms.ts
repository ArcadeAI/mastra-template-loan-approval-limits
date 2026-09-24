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
