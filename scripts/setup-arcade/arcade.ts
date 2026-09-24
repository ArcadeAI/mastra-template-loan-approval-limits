/**
 * The Arcade admin API, as far as `bun run setup-arcade` uses it (#9).
 *
 * Designed from Arcade's public API reference: the OpenAPI document the
 * public `arcade-js` SDK pins (`.stats.yml`, 2026-09-04; docs.arcade.dev's API
 * reference links the same spec at `api.arcade.dev/v1/swagger`). Nothing here
 * was measured against the real API: every call is exercised against the
 * stand-in in `app-test/setup-arcade.test.ts`, and the assumptions are listed
 * on #7 for the human's live run.
 *
 * Four registrations go through the API, each with its spec path:
 *
 * - the hop-2 provider: `POST /v1/admin/auth_providers`
 *   (`schemas.AuthProviderCreateRequest`), after `GET /v1/admin/auth_providers/{id}`.
 *   **Create-only.** DESIGN.md → "Arcade config is read-only": if the provider
 *   exists it is read back, compared, and never PATCHed;
 * - the hook extension: `POST /v1/plugins` (`schemas.CreatePluginRequest`),
 *   then `PATCH /v1/plugins/{id}` to `status: active`, because a plugin is
 *   created inactive (measured, docs/spikes/02-remote-mcp-hooks-transcript.md);
 * - the tool secrets: `POST /v1/admin/secrets/{secret_key}`
 *   (`schemas.UpsertStoredSecretRequest`);
 * - the custom verifier: `PUT /v1/admin/settings/session_verification`, then
 *   `GET` on the same path, because a verifier that did not take is open
 *   risk 2 (DESIGN.md) and fails where no hook fires.
 *
 * The User Source and the gateway are printed as dashboard forms instead
 * (`forms.ts`): the spec has no User Source endpoint, and `POST /v1/gateways`
 * has no field that attaches one. Nothing here ever creates a gateway, and
 * nothing names the header auth type, which is Arcade Headers mode (DESIGN.md
 * rules it out); `app-test/setup-arcade.test.ts` fails if either appears.
 *
 * Auth is `Authorization: Bearer <ARCADE_API_KEY>`, a project key, which
 * selects the project (spec `securitySchemes.Bearer`).
 */
import { ARCADE_PROVIDER_ID } from "../../lib/identity/provider/client.ts";

export const PROVIDER_ID = ARCADE_PROVIDER_ID;
/** The hook extension's name, which is how a re-run finds the one it made. */
export const PLUGIN_NAME = "loan-approval-limits-hooks";

export interface Registration {
  /** HOST-form `APP_PUBLIC_HOST`. */
  host: string;
  /** `https://<host>`. */
  origin: string;
  /** The `arcade` OAuth client at the app's identity provider. */
  arcadeClientId: string;
  arcadeClientSecret: string;
  /** The bearer Arcade presents to the hooks: `ARCADE_HOOK_SIGNING_SECRET`. */
  hookToken: string;
  approvalsStoreToken: string;
}

/**
 * The hop-2 provider, in the shape the demo's working `cg-idp` registration
 * was read back in (docs/spikes/evidence/05-custom-verifier-transcript.md
 * §11.8) with only the host and the id changed: HTTP Basic on the token
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

/**
 * The hook extension: three full URLs and a health path, because the
 * extension has no base URL (`schemas.WebhookEndpointRequest`, measured by #4
 * and recorded on #7). `failure_mode` is required on every endpoint
 * (docs/spikes/02-remote-mcp-hooks.md): fail closed, so an unreachable control
 * plane refuses rather than permits.
 */
export function pluginBody(registration: Registration) {
  const endpoint = (path: string, phase: "before" | "after") => ({
    url: `${registration.origin}/hooks/${path}`,
    phase,
    failure_mode: "fail_closed",
    status: "active",
  });
  return {
    name: PLUGIN_NAME,
    description: "The Loan Approval Limits control plane: /hooks/access, /hooks/pre, /hooks/post",
    plugin_type: "webhook",
    status: "active",
    webhook_config: {
      auth: { type: "bearer", token: registration.hookToken },
      health_check_path: "/hooks/health",
      endpoints: {
        access: endpoint("access", "before"),
        pre: endpoint("pre", "before"),
        post: endpoint("post", "after"),
      },
    },
  };
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
