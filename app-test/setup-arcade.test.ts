/**
 * `bun run setup-arcade <host>` against a stand-in for Arcade's admin API (#9).
 *
 * Never the real API. The stand-in answers the paths `scripts/setup-arcade/arcade.ts`
 * cites from Arcade's published spec, keeps what it is sent, and records every
 * request, so each test can say exactly what reached "Arcade". Each test runs
 * the real script in a throwaway project of its own: a git repository whose
 * `.env` is the repo's `.env.example` copied verbatim with only
 * `ARCADE_API_KEY` filled, which is where a developer stands after the
 * Quickstart's `cp .env.example .env`.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnChild } from "./child.ts";
import { childEnv } from "./child-env.ts";

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "setup-arcade.ts");
const HOST = "template-test.ngrok.app";
const ORIGIN = `https://${HOST}`;
const KEY = "stand-in-project-key";
const CALLBACK = "https://cloud.arcade.dev/api/v1/oauth/stand_in_ap_1/callback";

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/** Arcade's admin API, as far as the spec setup-arcade cites describes it. */
class StandIn {
  requests: Recorded[] = [];
  providers = new Map<string, Record<string, unknown>>();
  secrets = new Map<string, string>();
  plugins = new Map<string, Record<string, unknown>>();
  verifier: Record<string, unknown> = { verifier_url: "", unsafe_skip_verification: false };
  /** When set, a PUT to the verifier settings is accepted and ignored. */
  verifierIgnoresPut = false;
  private readonly server = Bun.serve({ port: 0, fetch: (request) => this.handle(request) });
  readonly url = `http://127.0.0.1:${this.server.port}`;

  stop(): void {
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    this.requests.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization: request.headers.get("authorization"), body });
    if (request.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ message: "unauthorized" }, { status: 401 });

    const [, , ...parts] = url.pathname.split("/"); // "", "v1", ...
    const route = `${request.method} /${parts.map((part, i) => (i > 0 && /^(auth_providers|plugins|secrets)$/.test(parts[i - 1]!) ? ":id" : part)).join("/")}`;
    switch (route) {
      case "GET /admin/auth_providers/:id": {
        const provider = this.providers.get(parts[2]!);
        return provider ? Response.json(provider) : Response.json({ message: "not found" }, { status: 404 });
      }
      case "POST /admin/auth_providers": {
        const sent = body as { id: string; oauth2: Record<string, unknown> };
        const stored = {
          ...sent,
          status: "active",
          oauth2: { ...sent.oauth2, client_secret: { exists: true, editable: true, binding: "project" }, redirect_uri: CALLBACK },
        };
        this.providers.set(sent.id, stored);
        return Response.json(stored, { status: 201 });
      }
      case "POST /admin/secrets/:id":
        this.secrets.set(parts[2]!, (body as { value: string }).value);
        return Response.json({ id: `sec_${parts[2]}`, key: parts[2] });
      case "GET /plugins":
        return Response.json({ items: [...this.plugins.values()], total_count: this.plugins.size });
      case "POST /plugins": {
        const id = `plg_${this.plugins.size + 1}`;
        const created = { ...(body as Record<string, unknown>), id, status: "inactive" };
        this.plugins.set(id, created);
        return Response.json(this.publicPlugin(created), { status: 201 });
      }
      case "PATCH /plugins/:id": {
        const current = this.plugins.get(parts[1]!);
        if (!current) return Response.json({ message: "not found" }, { status: 404 });
        const next = { ...current, ...(body as Record<string, unknown>) };
        this.plugins.set(parts[1]!, next);
        return Response.json(this.publicPlugin(next));
      }
      case "GET /plugins/:id": {
        const current = this.plugins.get(parts[1]!);
        return current ? Response.json(this.publicPlugin(current)) : Response.json({ message: "not found" }, { status: 404 });
      }
      case "PUT /admin/settings/session_verification":
        if (!this.verifierIgnoresPut) this.verifier = { ...(body as Record<string, unknown>) };
        return Response.json(this.verifier);
      case "GET /admin/settings/session_verification":
        return Response.json(this.verifier);
      default:
        return Response.json({ message: `the stand-in has no ${route}` }, { status: 404 });
    }
  }

  /** A plugin as the API answers it: the bearer comes back as `{ exists }`, never the value. */
  private publicPlugin(plugin: Record<string, unknown>): Record<string, unknown> {
    const config = plugin.webhook_config as { auth: { token: string } } & Record<string, unknown>;
    return { ...plugin, webhook_config: { ...config, auth: { type: "bearer", token: { exists: Boolean(config.auth.token) } } } };
  }
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cg-setup-arcade-")));
let arcade: StandIn;

beforeEach(() => {
  arcade?.stop();
  arcade = new StandIn();
});
afterAll(() => {
  arcade?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], { cwd, env: childEnv({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" }) });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
}

/** A fresh project: `.env.example` copied to `.env`, `ARCADE_API_KEY` filled, `.env` gitignored. */
function project(name: string, edit: (env: string) => string = (env) => env): string {
  const dir = join(scratch, name);
  Bun.spawnSync(["mkdir", "-p", dir]);
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".env\n*.db\n*.db-*\n");
  copyFileSync(join(ROOT, ".env.example"), join(dir, ".env.example"));
  const env = readFileSync(join(ROOT, ".env.example"), "utf8").replace(/^ARCADE_API_KEY=$/m, `ARCADE_API_KEY=${KEY}`);
  if (env === readFileSync(join(ROOT, ".env.example"), "utf8")) throw new Error(".env.example has no blank ARCADE_API_KEY= line");
  writeFileSync(join(dir, ".env"), edit(env));
  return dir;
}

async function setupArcade(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawnChild(["bun", "--no-env-file", SCRIPT, HOST, ...args], {
    cwd,
    env: childEnv({ ARCADE_API_URL: arcade.url }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function envOf(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(dir, ".env"), "utf8").split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

function clientsIn(dir: string): Record<string, { clientId: string; redirectUris: string[] }> {
  const db = new Database(join(dir, "idp.db"), { readonly: true });
  try {
    const rows = db.query(`select id, clientId, redirectUris from oauthClient`).all() as Array<{ id: string; clientId: string; redirectUris: string }>;
    return Object.fromEntries(
      rows.map((row) => [row.id, { clientId: row.clientId, redirectUris: row.redirectUris.startsWith("[") ? (JSON.parse(row.redirectUris) as string[]) : row.redirectUris.split(",") }]),
    );
  } finally {
    db.close();
  }
}

const sequence = (requests: Recorded[]) => requests.map((each) => `${each.method} ${each.path.replace(/plg_\d+/, "<id>")}`);

test("a real run registers every API-able piece, fills .env's blanks, and prints the two forms", async () => {
  const mine = "the-developer-chose-this-session-secret-0123456789";
  const dir = project("full", (env) => env.replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${mine}`));
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

  expect(sequence(arcade.requests)).toEqual([
    "GET /v1/admin/auth_providers/app-identity",
    "POST /v1/admin/auth_providers",
    "POST /v1/admin/secrets/APP_PUBLIC_HOST",
    "POST /v1/admin/secrets/APPROVALS_STORE_TOKEN",
    "GET /v1/plugins?limit=100",
    "POST /v1/plugins",
    "PATCH /v1/plugins/<id>",
    "GET /v1/plugins/<id>",
    "PUT /v1/admin/settings/session_verification",
    "GET /v1/admin/settings/session_verification",
  ]);
  for (const request of arcade.requests) expect(request.authorization).toBe(`Bearer ${KEY}`);

  const env = envOf(dir);
  const clients = clientsIn(dir);
  expect(Object.keys(clients).sort()).toEqual(["arcade", "arcade-user-source", "web"]);

  // The provider: the app's own endpoints, its own `arcade` client, Basic plus PKCE, email as the user id.
  const provider = arcade.requests[1]!.body as { id: string; oauth2: Record<string, any> };
  expect(provider.id).toBe("app-identity");
  expect(provider.oauth2.client_id).toBe(clients.arcade!.clientId);
  expect(provider.oauth2.client_secret).toMatch(/^\S{16,}$/);
  expect(provider.oauth2.authorize_request.endpoint).toBe(`${ORIGIN}/oauth2/authorize`);
  expect(provider.oauth2.token_request.endpoint).toBe(`${ORIGIN}/oauth2/token`);
  expect(provider.oauth2.token_request.auth_method).toBe("client_secret_basic");
  expect(provider.oauth2.user_info_request.endpoint).toBe(`${ORIGIN}/oauth2/userinfo`);
  expect(provider.oauth2.user_info_request.response_map).toEqual({ user_id: "$.email" });
  expect(provider.oauth2.pkce).toEqual({ enabled: true, code_challenge_method: "S256" });
  // Arcade's generated callback came back and is now allowlisted on that client.
  expect(clients.arcade!.redirectUris).toContain(CALLBACK);
  expect(env.IDP_OAUTH_REDIRECT_URIS_ARCADE).toBe(CALLBACK);

  // The hooks: three full URLs, the health path, active, and the bearer the app will check.
  const [plugin] = [...arcade.plugins.values()] as Array<Record<string, any>>;
  expect(plugin!.status).toBe("active");
  expect(plugin!.webhook_config.health_check_path).toBe("/hooks/health");
  for (const point of ["access", "pre", "post"]) {
    expect(plugin!.webhook_config.endpoints[point].url).toBe(`${ORIGIN}/hooks/${point}`);
    expect(plugin!.webhook_config.endpoints[point].failure_mode).toBe("fail_closed");
  }
  expect(plugin!.webhook_config.auth).toEqual({ type: "bearer", token: env.ARCADE_HOOK_SIGNING_SECRET });

  // The tool secrets, and the verifier as read back.
  expect(arcade.secrets.get("APP_PUBLIC_HOST")).toBe(HOST);
  expect(arcade.secrets.get("APPROVALS_STORE_TOKEN")).toBe(env.APPROVALS_STORE_TOKEN);
  expect(arcade.verifier).toEqual({ verifier_url: `${ORIGIN}/api/arcade/verify`, unsafe_skip_verification: false });

  // .env: every blank this run owns is filled, and the developer's value is not touched.
  expect(env.APP_PUBLIC_HOST).toBe(HOST);
  expect(env.ARCADE_HOOK_SIGNING_SECRET).toMatch(/^[0-9a-f]{64}$/);
  expect(env.APPROVALS_STORE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(new Set([env.SESSION_SECRET, env.ARCADE_HOOK_SIGNING_SECRET, env.APPROVALS_STORE_TOKEN]).size).toBe(3);
  expect(env.IDP_OAUTH_CLIENTS).toBe("arcade,arcade-user-source,web");
  expect(env.IDP_CLIENT_ID).toBe(clients.web!.clientId);
  expect(env.IDP_CLIENT_SECRET).toMatch(/^\S{16,}$/);
  expect(clients.web!.redirectUris).toEqual([`${ORIGIN}/api/auth/callback`]);
  expect(clients["arcade-user-source"]!.redirectUris).toEqual(["https://cloud.arcade.dev/oauth2/intermediate_callback"]);
  expect(env.ARCADE_GATEWAY_ID).toBe("loan-approval-limits");
  expect(env.GOVERNANCE_STREAM).toBe("hooks");
  // Every key .env.example says setup-arcade fills is filled.
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  const section = example.slice(example.indexOf("# --- Filled in by `bun run setup-arcade"), example.indexOf("# --- Optional"));
  const owned = [...section.matchAll(/^([A-Z_][A-Z0-9_]*)=$/gm)].map(([, key]) => key!);
  expect(owned.length).toBeGreaterThan(5);
  for (const key of owned) expect(env[key], `setup-arcade left ${key} blank`).toMatch(/\S/);
  expect(env.ARCADE_API_KEY).toBe(KEY);
  // A value setup-arcade would otherwise have written, set by hand first: kept.
  expect(env.SESSION_SECRET).toBe(mine);
  expect(run.stdout).toMatch(/kept\s+SESSION_SECRET/);

  // The two forms the API cannot fill.
  expect(run.stdout).toContain("User Sources → Create User Source");
  expect(run.stdout).toContain(`Issuer URL      ${ORIGIN}`);
  expect(run.stdout).toContain(`Client ID       ${clients["arcade-user-source"]!.clientId}`);
  expect(run.stdout).toMatch(/Subject Claim\s+email/);
  expect(run.stdout).toContain("MCP Gateways → Create Gateway");
  expect(run.stdout).toContain("Non-Arcade Users → User Source");
  // Nothing printed carries the API key.
  expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
}, 60_000);

test("--dry-run prints the same requests a real run makes, in order, and writes and sends nothing", async () => {
  const dir = project("dry");
  const before = readFileSync(join(dir, ".env"), "utf8");
  const run = await setupArcade(dir, "--dry-run");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

  expect(arcade.requests).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  expect(existsSync(join(dir, "idp.db"))).toBe(false);

  const printed = [...run.stdout.matchAll(/^ {2}(GET|POST|PUT|PATCH|DELETE) \S+?(\/v1\/\S+)$/gm)].map(([, method, path]) => `${method} ${path}`);
  expect(printed).toEqual([
    "GET /v1/admin/auth_providers/app-identity",
    "POST /v1/admin/auth_providers",
    "POST /v1/admin/secrets/APP_PUBLIC_HOST",
    "POST /v1/admin/secrets/APPROVALS_STORE_TOKEN",
    "GET /v1/plugins?limit=100",
    "POST /v1/plugins",
    "PATCH /v1/plugins/<id>",
    "GET /v1/plugins/<id>",
    "PUT /v1/admin/settings/session_verification",
    "GET /v1/admin/settings/session_verification",
  ]);
  expect(run.stdout).toContain("Authorization: Bearer <ARCADE_API_KEY>");
  expect(run.stdout).not.toContain(KEY);
  expect(run.stdout).toContain(`"url": "${ORIGIN}/hooks/pre"`);
});

test("it never creates a gateway and never names Arcade Headers mode, in a real run or a dry one", async () => {
  const real = await setupArcade(project("no-headers"));
  const dry = await setupArcade(project("no-headers-dry"), "--dry-run");
  expect(real.code).toBe(0);
  expect(dry.code).toBe(0);
  const everything = [real.stdout, real.stderr, dry.stdout, dry.stderr, JSON.stringify(arcade.requests)].join("\n");
  expect(everything).not.toMatch(/arcade_header/i);
  expect(arcade.requests.filter((request) => request.path.startsWith("/v1/gateways"))).toEqual([]);
  expect(dry.stdout).not.toContain("/v1/gateways");
});

test("a tracked .env is refused before anything is read, written or sent", async () => {
  const dir = project("tracked");
  git(dir, "add", "-f", ".env");
  git(dir, "commit", "-q", "-m", "a developer's mistake");
  const before = readFileSync(join(dir, ".env"), "utf8");

  const run = await setupArcade(dir);

  expect(run.code).toBe(1);
  expect(run.stderr).toContain(".env is tracked by git");
  expect(arcade.requests).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  expect(existsSync(join(dir, "idp.db"))).toBe(false);
});

test("a .env that is not gitignored is refused", async () => {
  const dir = project("not-ignored");
  writeFileSync(join(dir, ".gitignore"), "*.db\n");
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(".env is not gitignored");
  expect(arcade.requests).toEqual([]);
});

test("an existing provider that differs is reported and never edited, and nothing is written", async () => {
  const dir = project("provider-differs");
  arcade.providers.set("app-identity", {
    id: "app-identity",
    type: "oauth2",
    oauth2: {
      client_id: "somebody-elses-client",
      client_secret: { exists: true },
      pkce: { enabled: true, code_challenge_method: "S256" },
      authorize_request: { endpoint: "https://old-host.example/oauth2/authorize" },
      token_request: { endpoint: "https://old-host.example/oauth2/token", auth_method: "client_secret_basic" },
      user_info_request: { endpoint: "https://old-host.example/oauth2/userinfo", auth_method: "bearer_access_token", response_map: { user_id: "$.email" } },
      redirect_uri: CALLBACK,
    },
  });
  const before = readFileSync(join(dir, ".env"), "utf8");

  const run = await setupArcade(dir);

  expect(run.code).toBe(1);
  expect(run.stdout).toContain("oauth2.token_request.endpoint: Arcade has \"https://old-host.example/oauth2/token\", this app needs \"https://template-test.ngrok.app/oauth2/token\"");
  expect(run.stdout).toContain("oauth2.client_id: Arcade has \"somebody-elses-client\"");
  expect(run.stderr).toContain("never edits an existing provider");
  // One read, and nothing after it: no PATCH, no DELETE, no re-create, no hooks.
  expect(sequence(arcade.requests)).toEqual(["GET /v1/admin/auth_providers/app-identity"]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
});

test("running it again changes nothing that is registered and rotates nothing Arcade holds", async () => {
  const dir = project("twice");
  expect((await setupArcade(dir)).code).toBe(0);
  const envAfterFirst = readFileSync(join(dir, ".env"), "utf8");
  const providerAfterFirst = JSON.stringify(arcade.providers.get("app-identity"));
  arcade.requests = [];

  const again = await setupArcade(dir);

  expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
  expect(again.stdout).toContain("already registered and matches");
  expect(sequence(arcade.requests)).toEqual([
    "GET /v1/admin/auth_providers/app-identity",
    "POST /v1/admin/secrets/APP_PUBLIC_HOST",
    "POST /v1/admin/secrets/APPROVALS_STORE_TOKEN",
    "GET /v1/plugins?limit=100",
    "PATCH /v1/plugins/<id>",
    "GET /v1/plugins/<id>",
    "PUT /v1/admin/settings/session_verification",
    "GET /v1/admin/settings/session_verification",
  ]);
  expect(JSON.stringify(arcade.providers.get("app-identity"))).toBe(providerAfterFirst);
  expect(arcade.plugins.size).toBe(1);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(envAfterFirst);
  // The User Source's secret was shown once, on the first run, and is not re-minted.
  expect(again.stdout).toContain("(unchanged, and not shown");
}, 60_000);

test("a verifier setting that does not read back fails the run, naming open risk 2", async () => {
  const dir = project("verifier");
  arcade.verifierIgnoresPut = true;
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("the custom verifier did not take");
  expect(run.stderr).toContain("open risk 2");
});
