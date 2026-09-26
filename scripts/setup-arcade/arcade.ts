/**
 * The Arcade admin API, as far as `bun run setup-arcade` uses it (#9).
 *
 * Designed from Arcade's public API reference: the OpenAPI document the
 * public `arcade-js` SDK pins (`.stats.yml`, 2026-09-04; docs.arcade.dev's API
 * reference links the same spec at `api.arcade.dev/v1/swagger`). **The spec is
 * not enough on its own.** It says the tool secrets are `POST`, and the first
 * live run (#7, 2026-09-25) got a 404 `route_not_found` for that, while
 * `POST /v1/admin/auth_providers` got 201 a moment earlier with the same key. So
 * every request here is also checked against the official client code wherever
 * one makes the call: the Arcade CLI (`arcade-mcp`), `arcadepy` and `arcade-js`.
 * The table, with file and line for each source, is on #26's pull request. Every
 * call is exercised against the stand-in in `app-test/setup-arcade.test.ts`,
 * which answers anything else with Arcade's own 404.
 *
 * Three registrations go through the API, each with its spec path:
 *
 * - the hop-2 provider: `POST /v1/admin/auth_providers`
 *   (`schemas.AuthProviderCreateRequest`), after `GET /v1/admin/auth_providers/{id}`.
 *   **Create-only.** DESIGN.md → "Arcade config is read-only": if the provider
 *   exists it is read back, compared, and never PATCHed;
 * - the tool secrets: `PUT /v1/admin/secrets/{secret_key}` with
 *   `{ description, value }`, as the Arcade CLI sends it (`arcade_cli/secret.py`
 *   `_upsert_secret`, and `deploy.py` for `arcade deploy`, both through
 *   `utils.py` `build_api_key_scoped_url` under an API key). **Not** the spec's
 *   POST, which Arcade answers 404 (#26);
 * - the custom verifier: `PUT /v1/admin/settings/session_verification`, then
 *   `GET` on the same path, because a verifier that did not take is open
 *   risk 2 (DESIGN.md) and fails where no hook fires.
 *
 * Since #30 two more go through the API, under the org and project
 * `context.ts` resolves, because the human measured that a project key is
 * answered there (`GET …/plugins` and `GET …/gateways`, 200). Field names are
 * the live swagger's (`api.arcade.dev/v1/swagger`, fetched on #30); methods
 * are the swagger's too, and unproven until the live run, which is how the
 * secrets' POST turned out wrong (#26):
 *
 * - the hooks: one webhook plugin, `POST /v1/orgs/{org_id}/projects/{project_id}/plugins`
 *   (`schemas.CreatePluginRequest`), whose `webhook_config.endpoints` are the
 *   three inline hooks. Found by name first (`GET …/plugins`), and `PATCH`ed
 *   (`schemas.PatchPluginRequest`) when it differs: hooks are not the access
 *   model the way the provider is. Read back with `GET …/plugins/{id}` and the
 *   hooks it made, `GET …/hooks?plugin_id=`, which is where a hook's phase and
 *   failure mode are reported;
 * - the gateway: `POST /v1/orgs/{org_id}/projects/{project_id}/gateways`
 *   (`schemas.CreateGatewayRequest`), in the shape the Arcade CLI sends it
 *   (`arcade_cli/connect.py` `create_gateway`: `tool_filter.allowed_tools`,
 *   qualified `Toolkit.Tool` names), with `auth_type: "user_source"` and the
 *   User Source's `us_` id. Found by slug first, and create-only like the
 *   provider: the gateway's authentication is hop 1, the access model itself.
 *   Read back with `GET …/gateways/{id}`.
 *
 * The User Source stays a dashboard form (`forms.ts`): the spec has no User
 * Source route at all. Nothing here calls the bare `/v1/plugins`, which real
 * Arcade answers 404 (#28), and nothing names the header auth type, which is
 * Arcade Headers mode (DESIGN.md rules it out); `app-test/setup-arcade.test.ts`
 * fails if either appears.
 *
 * Auth is `Authorization: Bearer <ARCADE_API_KEY>`, a project key, which
 * selects the project (spec `securitySchemes.Bearer`).
 */
/**
 * The hop-2 provider id, fixed because `tools/loan` reads `OAuth2(id=...)` at
 * import. A literal rather than an import of the identity provider's
 * constant: nothing outside `lib/identity/` imports the provider's internals
 * (`only-identity-mints.test.ts`). `app-test/identity/provider-id.test.ts`
 * fails if this, the provider's and `tools/loan`'s ever disagree.
 */
export const PROVIDER_ID = "app-identity";

export interface Registration {
  /** HOST-form `APP_PUBLIC_HOST`. */
  host: string;
  /** `https://<host>`. */
  origin: string;
  /** The `arcade` OAuth client at the app's identity provider. */
  arcadeClientId: string;
  arcadeClientSecret: string;
  approvalsStoreToken: string;
}

/**
 * The hop-2 provider, in the shape the demo's working `cg-idp` registration
 * was read back in (the custom-verifier spike, against a real Arcade project)
 * with only the host and the id changed: HTTP Basic on the token
 * request, the client credentials also kept as request parameters (DESIGN.md:
 * those parameters stay, and the app accepts both), PKCE S256, and the user id
 * read from userinfo at `$.email`, which is what makes the email the join key.
 */
export function providerBody(registration: Registration) {
  const { origin } = registration;
  return {
    id: PROVIDER_ID,
    type: "oauth2",
    description: "The Loan Approval Limits app's own identity provider (hop 2)",
    oauth2: {
      client_id: registration.arcadeClientId,
      client_secret: registration.arcadeClientSecret,
      scope_delimiter: " ",
      pkce: { enabled: true, code_challenge_method: "S256" },
      authorize_request: {
        endpoint: `${origin}/oauth2/authorize`,
        params: {
          response_type: "code",
          client_id: "{{client_id}}",
          redirect_uri: "{{redirect_uri}}",
          scope: "{{scopes}} {{existing_scopes}}",
        },
      },
      token_request: {
        endpoint: `${origin}/oauth2/token`,
        method: "POST",
        auth_method: "client_secret_basic",
        params: {
          grant_type: "authorization_code",
          redirect_uri: "{{redirect_uri}}",
          client_id: "{{client_id}}",
          client_secret: "{{client_secret}}",
        },
        request_content_type: "application/x-www-form-urlencoded",
        response_content_type: "application/json",
      },
      user_info_request: {
        endpoint: `${origin}/oauth2/userinfo`,
        method: "GET",
        auth_method: "bearer_access_token",
        response_content_type: "application/json",
        response_map: { user_id: "$.email" },
        triggers: { on_token_grant: true, on_token_refresh: false },
      },
    },
  };
}

type Json = Record<string, unknown>;

function at(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Json)[part];
  }
  return current;
}

/** The fields that decide whether hop 2 works, compared one by one. The secret cannot be read back. */
const COMPARED = [
  "type",
  "oauth2.client_id",
  "oauth2.pkce.enabled",
  "oauth2.pkce.code_challenge_method",
  "oauth2.authorize_request.endpoint",
  "oauth2.token_request.endpoint",
  "oauth2.token_request.auth_method",
  "oauth2.user_info_request.endpoint",
  "oauth2.user_info_request.auth_method",
  "oauth2.user_info_request.response_map.user_id",
] as const;

/** `path: Arcade has X, this app needs Y`, one line per field that differs. */
export function providerDifferences(existing: unknown, desired: unknown): string[] {
  const differences: string[] = [];
  for (const path of COMPARED) {
    const have = at(existing, path);
    const want = at(desired, path);
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      differences.push(`${path}: Arcade has ${JSON.stringify(have) ?? "nothing"}, this app needs ${JSON.stringify(want)}`);
    }
  }
  if (at(existing, "oauth2.client_secret.exists") === false) {
    differences.push("oauth2.client_secret: Arcade holds no secret");
  }
  return differences;
}

/** The tool secrets the toolkits read, in the order they are set. */
export function toolSecrets(host: string, approvalsStoreToken: string) {
  return [
    { key: "APP_PUBLIC_HOST", description: "The app's public host (setup-arcade)", value: host },
    { key: "APPROVALS_STORE_TOKEN", description: "Bearer for the app's approvals store (setup-arcade)", value: approvalsStoreToken },
  ];
}

/**
 * One tool secret, the way the Arcade CLI upserts it: `PUT`, and the body in
 * the CLI's key order, `description` then `value`.
 */
export function secretRequest(secret: { key: string; description: string; value: string }) {
  return {
    method: "PUT",
    path: `/v1/admin/secrets/${secret.key}`,
    body: { description: secret.description, value: secret.value },
  } as const;
}

export function verifierBody(origin: string) {
  return { verifier_url: `${origin}/api/arcade/verify`, unsafe_skip_verification: false };
}

export class ArcadeError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} answered ${status}: ${body.slice(0, 500)}`);
  }
}

export interface Answer {
  status: number;
  json: Json | null;
}

/**
 * One request helper for both modes. Under `--dry-run` it prints the request,
 * headers included (the key as a placeholder), and sends nothing. For real it
 * sends, prints one line per call, and never prints a body: bodies carry
 * secrets.
 */
export class ArcadeAdmin {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly dryRun: boolean,
    private readonly log: (line: string) => void,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<Answer> {
    const url = `${this.baseUrl}${path}`;
    if (this.dryRun) {
      this.log(`  ${method} ${url}`);
      this.log(`    Authorization: Bearer <ARCADE_API_KEY>`);
      if (body !== undefined) {
        this.log(`    Content-Type: application/json`);
        for (const line of JSON.stringify(body, null, 2).split("\n")) this.log(`    ${line}`);
      }
      return { status: 0, json: null };
    }
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await response.text();
    this.log(`  ${method} ${path} → ${response.status}`);
    let json: Json | null = null;
    try {
      json = text ? (JSON.parse(text) as Json) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  /** `request`, and throw unless the answer is 2xx (or a dry run). */
  async expect(method: string, path: string, body?: unknown): Promise<Json | null> {
    const answer = await this.request(method, path, body);
    if (this.dryRun) return null;
    if (answer.status < 200 || answer.status >= 300) {
      throw new ArcadeError(method, path, answer.status, JSON.stringify(answer.json));
    }
    return answer.json;
  }
}

// --- The org and project routes (#30) ---------------------------------------

export interface ProjectScope {
  orgId: string;
  projectId: string;
}

/** `/v1/orgs/{org_id}/projects/{project_id}<suffix>`. */
export function projectPath(scope: ProjectScope, suffix: string): string {
  return `/v1/orgs/${encodeURIComponent(scope.orgId)}/projects/${encodeURIComponent(scope.projectId)}${suffix}`;
}

/** The name the hooks go by in Arcade, which is how a rerun finds them. */
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

export const HEALTH_CHECK_PATH = "/hooks/health";

/** The webhook plugin, with the three hooks inline and `.env`'s bearer. */
export function pluginBody(origin: string, hookToken: string) {
  return {
    name: HOOKS_NAME,
    description: "The Loan Approval Limits control plane: /hooks/access, /hooks/pre, /hooks/post",
    plugin_type: "webhook",
    status: "active",
    webhook_config: webhookConfig(origin, hookToken),
  };
}

/** The same configuration as a `PATCH` (`schemas.PatchPluginRequest`), which has no `name` or `plugin_type` to change. */
export function pluginPatch(origin: string, hookToken: string) {
  const { description, status, webhook_config } = pluginBody(origin, hookToken);
  return { description, status, webhook_config };
}

function webhookConfig(origin: string, hookToken: string) {
  return {
    auth: { type: "bearer", token: hookToken },
    health_check_path: HEALTH_CHECK_PATH,
    endpoints: Object.fromEntries(
      HOOK_POINTS.map(({ point, phase }) => [
        point,
        { url: `${origin}/hooks/${point}`, phase, failure_mode: "fail_closed", status: "active" },
      ]),
    ),
  };
}

/**
 * `path: Arcade has X, this app needs Y`, one line per difference between a
 * plugin as Arcade reads it back (`schemas.PluginResponse`) plus the hooks it
 * made (`schemas.HookResponse`), and what this app needs. The bearer cannot be
 * read back (`schemas.SecretResponse`), so only its presence is compared.
 */
export function pluginDifferences(plugin: unknown, hooks: unknown[], origin: string): string[] {
  const differences: string[] = [];
  const compare = (path: string, have: unknown, want: unknown) => {
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      differences.push(`${path}: Arcade has ${JSON.stringify(have) ?? "nothing"}, this app needs ${JSON.stringify(want)}`);
    }
  };
  compare("plugin_type", at(plugin, "plugin_type"), "webhook");
  compare("status", at(plugin, "status"), "active");
  compare("webhook_config.health_check_path", at(plugin, "webhook_config.health_check_path"), HEALTH_CHECK_PATH);
  compare("webhook_config.auth.type", at(plugin, "webhook_config.auth.type"), "bearer");
  if (at(plugin, "webhook_config.auth.token.exists") !== true) differences.push("webhook_config.auth.token: Arcade holds no bearer token");
  for (const { point, hookPoint, phase } of HOOK_POINTS) {
    compare(`webhook_config.endpoints.${point}.url`, at(plugin, `webhook_config.endpoints.${point}.url`), `${origin}/hooks/${point}`);
    const hook = hooks.find((each) => at(each, "hook_point") === hookPoint);
    if (hook === undefined) {
      differences.push(`hooks: Arcade has no ${hookPoint} hook on this plugin`);
      continue;
    }
    compare(`${hookPoint}.phase`, at(hook, "phase"), phase);
    compare(`${hookPoint}.failure_mode`, at(hook, "failure_mode"), "fail_closed");
    compare(`${hookPoint}.status`, at(hook, "status"), "active");
  }
  return differences;
}

/** The six tools the agent is given, as a gateway's `tool_filter` names them: `Toolkit.Tool`. */
export function gatewayTools(loanToolkit: string, approvalsToolkit: string): string[] {
  return [
    ...["SearchLoans", "GetLoan", "ApproveLoan", "DenyLoan"].map((tool) => `${loanToolkit}.${tool}`),
    ...["RequestApproval", "Decide"].map((tool) => `${approvalsToolkit}.${tool}`),
  ];
}

/** The authentication hop 1 needs: the app's own sign-in, through the User Source. */
export const GATEWAY_AUTH_TYPE = "user_source";

export interface GatewaySpec {
  slug: string;
  userSourceId: string;
  loanToolkit: string;
  approvalsToolkit: string;
}

export function gatewayBody(spec: GatewaySpec) {
  return {
    name: "Loan Approval Limits",
    description: "The loan officer's agent",
    slug: spec.slug,
    auth_type: GATEWAY_AUTH_TYPE,
    user_source_id: spec.userSourceId,
    tool_filter: { allowed_tools: gatewayTools(spec.loanToolkit, spec.approvalsToolkit) },
  };
}

/** The same form of report as {@link pluginDifferences}, for a gateway read back (`schemas.GatewayResponse`). */
export function gatewayDifferences(gateway: unknown, spec: GatewaySpec): string[] {
  const differences: string[] = [];
  const compare = (path: string, have: unknown, want: unknown) => {
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      differences.push(`${path}: Arcade has ${JSON.stringify(have) ?? "nothing"}, this app needs ${JSON.stringify(want)}`);
    }
  };
  compare("slug", at(gateway, "slug"), spec.slug);
  compare("auth_type", at(gateway, "auth_type"), GATEWAY_AUTH_TYPE);
  compare("user_source_id", at(gateway, "user_source_id"), spec.userSourceId);
  const tools = at(gateway, "tool_filter.allowed_tools");
  compare(
    "tool_filter.allowed_tools",
    Array.isArray(tools) ? [...tools].sort() : tools,
    [...gatewayTools(spec.loanToolkit, spec.approvalsToolkit)].sort(),
  );
  return differences;
}

/** The `items` of one of Arcade's offset pages (`schemas.OffsetPage-*`). */
export function pageItems(json: unknown): unknown[] {
  const items = at(json, "items");
  return Array.isArray(items) ? items : [];
}
