/**
 * `bun run setup-arcade <host>` against a stand-in for Arcade's admin API (#9).
 *
 * Never the real API. The stand-in answers the routes `scripts/setup-arcade/arcade.ts`
 * sends, each with the method the official client uses where one exists, keeps
 * what it is sent, and records every request, so each test can say exactly what
 * reached "Arcade". **Anything else gets the 404 Arcade itself answers** for a
 * route or method it does not serve, byte for byte: until #26 this stand-in
 * served `POST /v1/admin/secrets/{key}` because the pinned spec says POST, and
 * the first live run got that 404 instead. Each test runs
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

/**
 * What Arcade answered `POST /v1/admin/secrets/APP_PUBLIC_HOST` with, on the
 * human's first live run (#7, 2026-09-25). The same body is Arcade's answer to
 * any route it does not serve, so it is this stand-in's too.
 */
const ROUTE_NOT_FOUND = { name: "route_not_found", message: "requested route is not found or method is not allowed" };

/** Arcade's admin API, as far as setup-arcade uses it (the table is on #26's PR). */
class StandIn {
  requests: Recorded[] = [];
  providers = new Map<string, Record<string, unknown>>();
  secrets = new Map<string, string>();
  verifier: Record<string, unknown> = { verifier_url: "", unsafe_skip_verification: false };
  /** When set, a PUT to the verifier settings is accepted and ignored. */
  verifierIgnoresPut = false;
  /**
   * When set, the tool-secret route answers every method with Arcade's 404, the
   * way the live run's POST was answered: the run stops just after the provider
   * is created, which is the state the human's live project is in (#26).
   */
  secretsLikeTheLiveRun = false;
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
      // The Arcade CLI's upsert (`arcade_cli/secret.py` `_upsert_secret`, and
      // `deploy.py` for `arcade deploy`): PUT, `{ description, value }`.
      // `value` is required and at most 5000 characters
      // (`schemas.UpsertStoredSecretRequest`).
      case "PUT /admin/secrets/:id": {
        if (this.secretsLikeTheLiveRun) return Response.json(ROUTE_NOT_FOUND, { status: 404 });
        const sent = body as { value?: unknown; description?: unknown } | undefined;
        if (typeof sent?.value !== "string" || sent.value === "" || sent.value.length > 5000) {
          return Response.json({ name: "malformed_request", message: "value is a required field" }, { status: 400 });
        }
        this.secrets.set(parts[2]!, sent.value);
        return Response.json({ id: `sec_${parts[2]}`, key: parts[2], description: sent.description ?? "" });
      }
      // No `/v1/plugins`, and nothing under `/hooks` (#28): real Arcade answered
      // `GET /v1/plugins?limit=100` with the 404 below on the second live run,
      // and the live swagger serves plugins and hooks only under
      // `/v1/orgs/{org_id}/…`, which a project key cannot name. They fall
      // through to the default.
      case "PUT /admin/settings/session_verification":
        if (!this.verifierIgnoresPut) this.verifier = { ...(body as Record<string, unknown>) };
        return Response.json(this.verifier);
      case "GET /admin/settings/session_verification":
        return Response.json(this.verifier);
      default:
        return Response.json(ROUTE_NOT_FOUND, { status: 404 });
    }
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
    "PUT /v1/admin/secrets/APP_PUBLIC_HOST",
    "PUT /v1/admin/secrets/APPROVALS_STORE_TOKEN",
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

  // The tool secrets, in the CLI's body shape, and the verifier as read back.
  for (const request of arcade.requests.filter((each) => each.path.startsWith("/v1/admin/secrets/"))) {
    expect(Object.keys(request.body as object).sort()).toEqual(["description", "value"]);
  }
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
  // The identity provider's secret (#9): filled, fresh, and never printed.
  expect(env.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
  expect(new Set([env.BETTER_AUTH_SECRET, env.SESSION_SECRET, env.ARCADE_HOOK_SIGNING_SECRET, env.APPROVALS_STORE_TOKEN]).size).toBe(4);
  expect(run.stdout).toMatch(/filled\s+.*\bBETTER_AUTH_SECRET\b/);
  expect(`${run.stdout}${run.stderr}`).not.toContain(env.BETTER_AUTH_SECRET!);
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

/**
 * What is left after the run, in the order the README's Quickstart gives it
 * (#11). Until #11 the printed list put `arcade deploy` after the forms, while
 * its own gateway form says the tools are listed only once the deploys have
 * run. Both texts are read here, so the list cannot drift from the README, or
 * the README from the list, without this failing.
 */
const NEXT_STEPS: Array<[string, RegExp]> = [
  ["start the app", /`bun run dev`/],
  ["start the tunnel", /ngrok http --url=/],
  ["the User Source form", /fill in the User Source form/i],
  ["deploy both toolkits", /arcade deploy/],
  ["the gateway form", /fill in the gateway form/i],
  ["open the app", /open `?https:\/\//i],
];

/** The step names in the order the text first mentions them, or the ones it never does. */
function stepOrder(text: string): string[] {
  const found = NEXT_STEPS.map(([name, pattern]) => ({ name, at: text.search(pattern) }));
  const missing = found.filter(({ at }) => at === -1).map(({ name }) => `missing: ${name}`);
  if (missing.length > 0) return missing;
  return found.sort((a, b) => a.at - b.at).map(({ name }) => name);
}

/** From the Quickstart step that starts the app to the end of the Quickstart. */
function readmeRemainder(): string {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const start = readme.indexOf("5. **Start the app");
  const end = readme.indexOf("\n## ", start);
  if (start === -1 || end === -1) throw new Error("README.md's Quickstart has no step 5 to read from");
  return readme.slice(start, end);
}

test("the steps it prints after the forms are the README's, in the README's order", async () => {
  const run = await setupArcade(project("next-steps"));
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const printed = run.stdout.slice(run.stdout.lastIndexOf("Then:"));
  expect(printed.startsWith("Then:")).toBe(true);

  const order = NEXT_STEPS.map(([name]) => name);
  expect(stepOrder(printed)).toEqual(order);
  expect(stepOrder(readmeRemainder())).toEqual(order);
  expect(printed).toContain(`ngrok http --url=${HOST} `);
  expect(printed).toContain(`Open ${ORIGIN}, never localhost`);
  startsTheApp(printed);

  // The check bites: the pre-#11 order, deploy after both forms, fails it.
  const lines = printed.split("\n");
  const deploy = lines.findIndex((line) => line.includes("arcade deploy"));
  const [moved] = lines.splice(deploy, 1);
  lines.splice(lines.findIndex((line) => /gateway form/i.test(line)) + 1, 0, moved!);
  expect(stepOrder(lines.join("\n"))).not.toEqual(order);
}, 60_000);

test("a dry run ends with the same steps", async () => {
  const run = await setupArcade(project("next-steps-dry"), "--dry-run");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const printed = run.stdout.slice(run.stdout.lastIndexOf("Then:"));
  expect(stepOrder(printed)).toEqual(NEXT_STEPS.map(([name]) => name));
  startsTheApp(printed);
});

/**
 * The first step starts the app; it does not restart it (#26). A developer
 * following the Quickstart runs `setup-arcade` at step 4 and has never started
 * `bun run dev`: "Restart" told them to restart something that was not running.
 */
function startsTheApp(printed: string): void {
  const first = printed.split("\n").find((line) => /^\s*1\./.test(line)) ?? "";
  expect(first).toMatch(/^\s*1\. Start `bun run dev`/);
  expect(printed).not.toMatch(/^\s*\d\. Restart/m);
}

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
    "PUT /v1/admin/secrets/APP_PUBLIC_HOST",
    "PUT /v1/admin/secrets/APPROVALS_STORE_TOKEN",
    "GET /v1/plugins?limit=100",
    "POST /v1/plugins",
    "PATCH /v1/plugins/<id>",
    "GET /v1/plugins/<id>",
    "PUT /v1/admin/settings/session_verification",
    "GET /v1/admin/settings/session_verification",
  ]);
  expect(run.stdout).toContain("Authorization: Bearer <ARCADE_API_KEY>");
  // Each tool secret: PUT, the CLI's `{ description, value }`, and the store
  // token only as a placeholder, because a dry run shows no secret.
  const secret = (key: string) => {
    const at = run.stdout.indexOf(`  PUT ${arcade.url}/v1/admin/secrets/${key}\n`);
    expect(at, `the dry run prints no PUT for ${key}`).toBeGreaterThan(-1);
    const block = run.stdout.slice(at).split("\n");
    const json = block.slice(3, block.findIndex((line, i) => i > 3 && line === "    }") + 1).join("\n");
    return JSON.parse(json) as Record<string, string>;
  };
  expect(Object.keys(secret("APP_PUBLIC_HOST"))).toEqual(["description", "value"]);
  expect(secret("APP_PUBLIC_HOST").value).toBe(HOST);
  expect(Object.keys(secret("APPROVALS_STORE_TOKEN"))).toEqual(["description", "value"]);
  expect(secret("APPROVALS_STORE_TOKEN").value).toBe("<generated APPROVALS_STORE_TOKEN>");
  expect(run.stdout).not.toContain("POST " + arcade.url + "/v1/admin/secrets");
  expect(run.stdout).toMatch(/would fill .*\bBETTER_AUTH_SECRET\b/);
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

/**
 * The hooks are a dashboard form, and no request reaches a plugins or hooks
 * route (#28). Arcade has no `/v1/plugins`; the live swagger has plugins and
 * hooks only under `/v1/orgs/{org_id}/projects/{project_id}/…`, and no route
 * tells a project key its org or project. A request path is Arcade's, so the
 * form's own `https://<host>/hooks/pre` text is not what this looks at.
 */
const PLUGIN_OR_HOOK_ROUTE = /\/(plugins|hooks)(\/|\?|$)/;

test("it never calls a plugins or hooks route, in a fresh run, a rerun or a dry run", async () => {
  const dir = project("no-plugins");
  const first = await setupArcade(dir);
  const again = await setupArcade(dir);
  const dry = await setupArcade(dir, "--dry-run");
  const dryFresh = await setupArcade(project("no-plugins-dry"), "--dry-run");

  const called = arcade.requests.map((each) => `${each.method} ${each.path}`);
  expect(called.filter((each) => PLUGIN_OR_HOOK_ROUTE.test(each))).toEqual([]);
  for (const run of [dry, dryFresh]) {
    const printed = [...run.stdout.matchAll(/^ {2}(GET|POST|PUT|PATCH|DELETE) (\S+)$/gm)].map(([, method, url]) => `${method} ${url}`);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.filter((each) => PLUGIN_OR_HOOK_ROUTE.test(new URL(each.split(" ")[1]!).pathname))).toEqual([]);
  }
  for (const run of [first, again, dry, dryFresh]) expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  // The check bites: the request the pre-#28 script sent first is caught.
  expect(PLUGIN_OR_HOOK_ROUTE.test("GET /v1/plugins?limit=100")).toBe(true);
  expect(PLUGIN_OR_HOOK_ROUTE.test("POST /v1/orgs/o/projects/p/hooks")).toBe(true);
  expect(PLUGIN_OR_HOOK_ROUTE.test("PUT /v1/admin/settings/session_verification")).toBe(false);
}, 90_000);

test("the stand-in has no plugins route: Arcade's own 404, for the old call and the org-scoped ones", async () => {
  for (const [method, path] of [
    ["GET", "/v1/plugins?limit=100"],
    ["POST", "/v1/plugins"],
    ["PATCH", "/v1/plugins/plg_1"],
    ["GET", "/v1/orgs/org_1/projects/prj_1/plugins"],
    ["POST", "/v1/orgs/org_1/projects/prj_1/hooks"],
  ] as const) {
    const answer = await fetch(`${arcade.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    expect(answer.status, `${method} ${path}`).toBe(404);
    expect(await answer.text()).toBe('{"name":"route_not_found","message":"requested route is not found or method is not allowed"}');
  }
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
    "PUT /v1/admin/secrets/APP_PUBLIC_HOST",
    "PUT /v1/admin/secrets/APPROVALS_STORE_TOKEN",
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

test("a BETTER_AUTH_SECRET the developer set is kept, and the clients are minted under it", async () => {
  const mine = "a-developer-chosen-better-auth-secret-0123456789abcdef";
  const dir = project("identity-secret", (env) => env.replace(/^BETTER_AUTH_SECRET=$/m, `BETTER_AUTH_SECRET=${mine}`));
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(envOf(dir).BETTER_AUTH_SECRET).toBe(mine);
  expect(run.stdout).toMatch(/kept\s+.*\bBETTER_AUTH_SECRET\b/);
  expect(`${run.stdout}${run.stderr}`).not.toContain(mine);
}, 60_000);

/**
 * The stand-in is a test double for Arcade, so it refuses what Arcade refused
 * (#26). Until then it served `POST /v1/admin/secrets/{key}`, because the pinned
 * spec (and `arcade-js`, generated from it) says POST, and the real API
 * answered the first live run's POST with this 404.
 */
test("the stand-in answers a tool secret POSTed the spec's way with Arcade's own 404", async () => {
  const post = await fetch(`${arcade.url}/v1/admin/secrets/APP_PUBLIC_HOST`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ value: HOST, description: "d" }),
  });
  expect(post.status).toBe(404);
  expect(await post.text()).toBe('{"name":"route_not_found","message":"requested route is not found or method is not allowed"}');
  expect(arcade.secrets.size).toBe(0);

  const put = await fetch(`${arcade.url}/v1/admin/secrets/APP_PUBLIC_HOST`, {
    method: "PUT",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ description: "d", value: HOST }),
  });
  expect(put.status).toBe(200);
  expect(arcade.secrets.get("APP_PUBLIC_HOST")).toBe(HOST);

  // And a PUT with no value is refused, as `value` is required.
  const empty = await fetch(`${arcade.url}/v1/admin/secrets/APPROVALS_STORE_TOKEN`, {
    method: "PUT",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ description: "d" }),
  });
  expect(empty.status).toBe(400);
});

/** Every `oauthClient` row, whole, hashed secrets included: what "minted nothing" is checked against. */
function clientRows(dir: string): string {
  const db = new Database(join(dir, "idp.db"), { readonly: true });
  try {
    return JSON.stringify(db.query(`select * from oauthClient order by id`).all());
  } finally {
    db.close();
  }
}

/**
 * The human's live project after the first real run (#7, 2026-09-25): the
 * provider was created (201) and its callback allowlisted, `.env`'s second
 * block was filled and `idp.db` minted, and the run stopped at the tool
 * secrets' 404, so no secret, no hooks and no verifier were set. The fixed
 * command must pick up from exactly there (#26).
 */
test("a rerun resumes from the live project's state: the provider matches, nothing is minted or overwritten, and the rest is set", async () => {
  const dir = project("resume-live");

  // How the live project got into that state: the tool secrets answered 404.
  arcade.secretsLikeTheLiveRun = true;
  const first = await setupArcade(dir);
  expect(first.code).toBe(1);
  expect(first.stderr).toContain("setting the tool secret APP_PUBLIC_HOST failed");
  expect(first.stderr).toContain('"name":"route_not_found"');
  expect(first.stderr).toContain("running the same command again picks up from here");

  // The state the issue describes, checked rather than assumed.
  expect(arcade.providers.has("app-identity")).toBe(true);
  expect(existsSync(join(dir, "idp.db"))).toBe(true);
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  const section = example.slice(example.indexOf("# --- Filled in by `bun run setup-arcade"), example.indexOf("# --- Optional"));
  const envBefore = envOf(dir);
  for (const [, key] of section.matchAll(/^([A-Z_][A-Z0-9_]*)=$/gm)) expect(envBefore[key!], `block 2 left ${key} blank`).toMatch(/\S/);
  expect(clientsIn(dir).arcade!.redirectUris).toContain(CALLBACK);
  expect(arcade.secrets.size).toBe(0);
  expect(arcade.plugins.size).toBe(0);
  expect(arcade.verifier).toEqual({ verifier_url: "", unsafe_skip_verification: false });

  const envText = readFileSync(join(dir, ".env"), "utf8");
  const rows = clientRows(dir);
  const provider = JSON.stringify(arcade.providers.get("app-identity"));
  arcade.secretsLikeTheLiveRun = false;
  arcade.requests = [];

  const rerun = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, resuming from the live state ---\n${rerun.stdout}${rerun.stderr}`);

  expect(rerun.code, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
  expect(rerun.stdout).toContain("the provider app-identity is already registered and matches; it is left as it is");
  expect(sequence(arcade.requests)).toEqual([
    "GET /v1/admin/auth_providers/app-identity",
    "PUT /v1/admin/secrets/APP_PUBLIC_HOST",
    "PUT /v1/admin/secrets/APPROVALS_STORE_TOKEN",
    "GET /v1/plugins?limit=100",
    "POST /v1/plugins",
    "PATCH /v1/plugins/<id>",
    "GET /v1/plugins/<id>",
    "PUT /v1/admin/settings/session_verification",
    "GET /v1/admin/settings/session_verification",
  ]);
  // Minted nothing, overwrote nothing, re-created nothing.
  expect(clientRows(dir)).toBe(rows);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(envText);
  expect(rerun.stdout).toContain("filled   (nothing: every value was already set)");
  expect(JSON.stringify(arcade.providers.get("app-identity"))).toBe(provider);
  // And went on to set the secrets, the hooks and the verifier.
  expect(arcade.secrets.get("APP_PUBLIC_HOST")).toBe(HOST);
  expect(arcade.secrets.get("APPROVALS_STORE_TOKEN")).toBe(envBefore.APPROVALS_STORE_TOKEN);
  const [plugin] = [...arcade.plugins.values()] as Array<Record<string, any>>;
  expect(plugin!.status).toBe("active");
  expect(plugin!.webhook_config.auth.token).toBe(envBefore.ARCADE_HOOK_SIGNING_SECRET);
  expect(arcade.verifier).toEqual({ verifier_url: `${ORIGIN}/api/arcade/verify`, unsafe_skip_verification: false });
  expect(rerun.stdout).toContain(`custom verifier: ${ORIGIN}/api/arcade/verify (read back)`);
}, 60_000);
