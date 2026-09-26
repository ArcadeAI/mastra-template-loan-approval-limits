/**
 * `bun run setup-arcade <host>` against a stand-in for Arcade's admin API (#9, #30).
 *
 * Never the real API, never the real Arcade CLI, never the real `~/.arcade`.
 *
 * - **The stand-in** answers the routes `scripts/setup-arcade/arcade.ts`
 *   sends, each with the method the official client uses where one exists,
 *   keeps what it is sent, and records every request, so each test can say
 *   exactly what reached "Arcade". **Anything else gets the 404 Arcade itself
 *   answers** for a route or method it does not serve, byte for byte: until #26
 *   this stand-in served `POST /v1/admin/secrets/{key}` because the pinned spec
 *   says POST, and the first live run got that 404 instead. Since #30 it serves
 *   the plugins, hooks and gateways under one org and project, as the live
 *   swagger has them, and still 404s the bare `/v1/plugins` the second live run
 *   was refused.
 * - **The Arcade CLI** is a shell script first on `PATH` that records where it
 *   was run and with what, so `arcade deploy` is observed and never performed.
 * - **The CLI's context** is a `credentials.yaml` in a throwaway `HOME`, in the
 *   shape `arcade_core.config_model.Config` writes, holding fake tokens that
 *   must never be printed.
 *
 * Each test runs the real script in a throwaway project of its own: a git
 * repository whose `.env` is the repo's `.env.example` copied verbatim with only
 * `ARCADE_API_KEY` filled, which is where a developer stands after the
 * Quickstart's `cp .env.example .env`.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
/** The one org and project the stand-in's key belongs to. */
const ORG = "org_standin";
const PROJECT = "prj_standin";
const SCOPED = `/v1/orgs/${ORG}/projects/${PROJECT}`;
const USER_SOURCE = "us_2standinusersource";
/** What the faked CLI's credentials hold besides the ids: never to be printed. */
const CLI_TOKENS = ["cli-access-token-must-not-leak", "cli-refresh-token-must-not-leak", "cli-api-key-must-not-leak"];

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

/**
 * What Arcade answered the fourth live run's `POST …/plugins` with, byte for
 * byte (#30, F6): the body sent `health_check_path: "/hooks/health"`.
 */
const HEALTH_CHECK_NOT_A_URL = {
  name: "malformed_request",
  message: "failed to validate request body: webhook_config: health_check_path must be a valid URL",
  field_errors: [{ field: "webhook_config.health_check_path", rule: "url", message: "health_check_path must be a valid URL" }],
};

/** Arcade's `url` rule, as far as anyone has seen it: an absolute http(s) URL. */
function isUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

type Json = Record<string, any>;

/** Arcade's admin API, as far as setup-arcade uses it (the table is on #26's PR; the org routes on #30's). */
class StandIn {
  requests: Recorded[] = [];
  providers = new Map<string, Json>();
  secrets = new Map<string, string>();
  verifier: Json = { verifier_url: "", unsafe_skip_verification: false };
  /** Plugins as stored, bearer token included, which no read ever returns. */
  plugins = new Map<string, Json>();
  /** Hooks, as `schemas.HookResponse`, made from each plugin's endpoints. */
  hooks: Json[] = [];
  gateways = new Map<string, Json>();
  /** Slugs another project already holds: a POST for one answers 409. */
  takenSlugs = new Set<string>();
  /** When set, the next plugin create answers this instead of creating anything. */
  nextPluginCreate: { status: number; body: Json } | null = null;
  /**
   * What a plugin read-back says `health_check_path` is. `undefined` leaves the
   * field out, which is what real Arcade did on the fourth live run's retry
   * (#30), so it is the default; `"stored"` echoes what was sent.
   */
  healthCheckReadBack: string | undefined = undefined;
  /** When set, a plugin read-back leaves this endpoint's URL out. */
  omitEndpointUrl: string | null = null;
  /** When set, a PUT to the verifier settings is accepted and ignored. */
  verifierIgnoresPut = false;
  /**
   * When set, the tool-secret route answers every method with Arcade's 404, the
   * way the live run's POST was answered: the run stops just after the provider
   * is created, which is the state the human's live project is in (#26).
   */
  secretsLikeTheLiveRun = false;
  private ids = 0;
  // On 127.0.0.1, the address the script is pointed at, not the default
  // 0.0.0.0: macOS lets another process hold 127.0.0.1 on the same port, and
  // it then answers in the stand-in's place (a 403 from somebody else, seen
  // once on #28's full run).
  private readonly server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handle(request) });
  readonly url = `http://127.0.0.1:${this.server.port}`;

  stop(): void {
    this.server.stop(true);
  }

  /** A plugin as `GET` returns it (`schemas.PluginResponse`): the bearer only as `{ exists }`. */
  private pluginResponse(stored: Json): Json {
    const { token, ...auth } = stored.webhook_config?.auth ?? {};
    const endpoints = Object.fromEntries(
      Object.entries(stored.webhook_config?.endpoints ?? {}).map(([point, endpoint]) => [point, point === this.omitEndpointUrl ? {} : { url: (endpoint as Json).url }]),
    );
    const health = this.healthCheckReadBack === "stored" ? stored.webhook_config?.health_check_path : this.healthCheckReadBack;
    return {
      id: stored.id,
      name: stored.name,
      description: stored.description,
      plugin_type: stored.plugin_type,
      status: stored.status,
      health_status: "unknown",
      webhook_config: {
        ...(health === undefined ? {} : { health_check_path: health }),
        auth: { ...auth, token: { exists: typeof token === "string" && token !== "", editable: true, binding: "project" } },
        endpoints,
      },
    };
  }

  private writeHooks(pluginId: string, endpoints: Json): void {
    this.hooks = this.hooks.filter((hook) => hook.plugin_id !== pluginId);
    for (const [point, endpoint] of Object.entries(endpoints)) {
      this.hooks.push({
        id: `hk_${point}_${pluginId}`,
        plugin_id: pluginId,
        hook_point: `tool.${point}`,
        name: `${point}`,
        phase: (endpoint as Json).phase,
        failure_mode: (endpoint as Json).failure_mode,
        status: (endpoint as Json).status ?? "active",
      });
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = await request.text();
    const body = text ? (JSON.parse(text) as Json) : undefined;
    this.requests.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization: request.headers.get("authorization"), body });
    if (request.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ message: "unauthorized" }, { status: 401 });

    // The org and project routes: only the key's own project is there.
    const scoped = /^\/v1\/orgs\/([^/]+)\/projects\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (scoped) {
      const [, org, project, rest] = scoped;
      if (org !== ORG || project !== PROJECT) return Response.json({ name: "not_found", message: "project not found" }, { status: 404 });
      return this.project(request.method, rest!, url.searchParams, body);
    }

    const [, , ...parts] = url.pathname.split("/"); // "", "v1", ...
    const route = `${request.method} /${parts.map((part, i) => (i > 0 && /^(auth_providers|secrets)$/.test(parts[i - 1]!) ? ":id" : part)).join("/")}`;
    switch (route) {
      case "GET /admin/auth_providers/:id": {
        const provider = this.providers.get(parts[2]!);
        return provider ? Response.json(provider) : Response.json({ message: "not found" }, { status: 404 });
      }
      case "POST /admin/auth_providers": {
        const sent = body as { id: string; oauth2: Json };
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
      // No bare `/v1/plugins`, and nothing under a bare `/hooks` (#28): real
      // Arcade answered `GET /v1/plugins?limit=100` with the 404 below on the
      // second live run. They fall through to the default.
      case "PUT /admin/settings/session_verification":
        if (!this.verifierIgnoresPut) this.verifier = { ...(body as Json) };
        return Response.json(this.verifier);
      case "GET /admin/settings/session_verification":
        return Response.json(this.verifier);
      default:
        return Response.json(ROUTE_NOT_FOUND, { status: 404 });
    }
  }

  /** `/v1/orgs/{org}/projects/{project}<rest>`, in the live swagger's shapes (fetched on #30). */
  private project(method: string, rest: string, query: URLSearchParams, body: Json | undefined): Response {
    const page = (items: Json[]) => Response.json({ items, limit: Number(query.get("limit") ?? 20), offset: 0, total_count: items.length });
    const pluginId = /^\/plugins\/([^/]+)$/.exec(rest)?.[1];
    const gatewayId = /^\/gateways\/([^/]+)$/.exec(rest)?.[1];
    if (method === "GET" && rest === "/plugins") return page([...this.plugins.values()].map((each) => this.pluginResponse(each)));
    if ((method === "POST" && rest === "/plugins") || (pluginId !== undefined && method === "PATCH")) {
      const health = body?.webhook_config?.health_check_path;
      if ((method === "POST" || health !== undefined) && !isUrl(health)) return Response.json(HEALTH_CHECK_NOT_A_URL, { status: 400 });
    }
    if (method === "POST" && rest === "/plugins" && this.nextPluginCreate !== null) {
      const { status, body: answer } = this.nextPluginCreate;
      this.nextPluginCreate = null;
      return Response.json(answer, { status });
    }
    if (method === "POST" && rest === "/plugins") {
      if (!body?.name || !body.plugin_type || !body.webhook_config?.endpoints) {
        return Response.json({ name: "malformed_request", message: "name, plugin_type and webhook_config.endpoints are required" }, { status: 400 });
      }
      const id = `plg_${++this.ids}`;
      const stored = { ...body, id };
      this.plugins.set(id, stored);
      this.writeHooks(id, body.webhook_config.endpoints);
      return Response.json({ ...this.pluginResponse(stored), hooks: this.hooks.filter((hook) => hook.plugin_id === id) }, { status: 201 });
    }
    if (pluginId !== undefined && (method === "GET" || method === "PATCH")) {
      const stored = this.plugins.get(pluginId);
      if (!stored) return Response.json({ name: "not_found", message: "plugin not found" }, { status: 404 });
      if (method === "PATCH") {
        const merged = { ...stored, ...body, webhook_config: { ...stored.webhook_config, ...body?.webhook_config } };
        this.plugins.set(pluginId, merged);
        if (body?.webhook_config?.endpoints) this.writeHooks(pluginId, merged.webhook_config.endpoints);
        return Response.json(this.pluginResponse(merged));
      }
      return Response.json(this.pluginResponse(stored));
    }
    if (method === "GET" && rest === "/hooks") {
      const plugin = query.get("plugin_id");
      return page(this.hooks.filter((hook) => plugin === null || hook.plugin_id === plugin));
    }
    if (method === "GET" && rest === "/gateways") return page([...this.gateways.values()]);
    if (method === "POST" && rest === "/gateways") {
      if (!body?.name) return Response.json({ name: "malformed_request", message: "name is required" }, { status: 400 });
      if (body.auth_type === "user_source" && !/^us_/.test(body.user_source_id ?? "")) {
        return Response.json({ name: "malformed_request", message: "user_source_id is required and must be a us_-prefixed KSUID" }, { status: 400 });
      }
      if ([...this.gateways.values()].some((each) => each.slug === body.slug) || this.takenSlugs.has(body.slug)) {
        return Response.json({ name: "conflict", message: "slug is already in use" }, { status: 409 });
      }
      const id = `gw_${++this.ids}`;
      const stored = { ...body, id, status: "active" };
      this.gateways.set(id, stored);
      return Response.json(stored, { status: 201 });
    }
    if (gatewayId !== undefined && method === "GET") {
      const stored = this.gateways.get(gatewayId);
      return stored ? Response.json(stored) : Response.json({ name: "not_found", message: "gateway not found" }, { status: 404 });
    }
    return Response.json(ROUTE_NOT_FOUND, { status: 404 });
  }
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cg-setup-arcade-")));
let arcade: StandIn;

/**
 * The Arcade CLI, faked: it records its working directory and arguments, and
 * fails where a test asks it to. First on `PATH`, so the real `arcade` is never
 * reached, and run under a throwaway `HOME`, so it could not find a login if it were.
 */
const FAKE_BIN = join(scratch, "bin");
mkdirSync(FAKE_BIN, { recursive: true });
writeFileSync(
  join(FAKE_BIN, "arcade"),
  [
    "#!/bin/sh",
    'echo "fake arcade: $* (in $PWD)"',
    'echo "$PWD|$*" >> "$FAKE_ARCADE_LOG"',
    'case "$PWD" in *"${FAKE_ARCADE_FAIL_IN:-no such directory}") echo "fake arcade: deploy failed" >&2; exit 3 ;; esac',
    "exit 0",
    "",
  ].join("\n"),
);
chmodSync(join(FAKE_BIN, "arcade"), 0o755);

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

/** A `credentials.yaml` the way the Arcade CLI 1.16 writes it: named contexts, and the active one flat as well. */
function credentials(orgId: string, projectId: string): string {
  const [access, refresh, apiKey] = CLI_TOKENS;
  const context = [
    "      auth:",
    `        access_token: ${access}`,
    `        refresh_token: ${refresh}`,
    "        expires_at: '2026-09-26T00:00:00Z'",
    `      api_key: ${apiKey}`,
    "      context:",
    `        org_id: ${orgId}`,
    "        org_name: Stand-in Org",
    `        project_id: ${projectId}`,
    "        project_name: Stand-in Project",
    "      coordinator_url: https://cloud.arcade.dev",
    "      kind: cloud",
    "      user:",
    "        email: developer@example.com",
  ];
  return ["cloud:", "  active_context: cloud.arcade.dev", "  contexts:", "    cloud.arcade.dev:", ...context, ...context.map((line) => line.slice(4)), ""].join("\n");
}

interface Project {
  dir: string;
  /** The throwaway `HOME` the script and the fake CLI see. */
  home: string;
  /** Every `arcade` invocation, as `<dir relative to the project>|<args>`. */
  deploys(): string[];
}
const projects = new Map<string, Project>();

/**
 * A fresh project: `.env.example` copied to `.env`, `ARCADE_API_KEY` filled,
 * `.env` gitignored, the two toolkit directories `arcade deploy` runs in, and a
 * `HOME` whose Arcade CLI is logged in with the stand-in's project active.
 * `cli: null` is a CLI that was never logged in.
 */
function project(
  name: string,
  edit: (env: string) => string = (env) => env,
  cli: { orgId: string; projectId: string } | null = { orgId: ORG, projectId: PROJECT },
): string {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "tools", "loan"), { recursive: true });
  mkdirSync(join(dir, "tools", "approvals"), { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".env\n*.db\n*.db-*\n");
  copyFileSync(join(ROOT, ".env.example"), join(dir, ".env.example"));
  const env = readFileSync(join(ROOT, ".env.example"), "utf8").replace(/^ARCADE_API_KEY=$/m, `ARCADE_API_KEY=${KEY}`);
  if (env === readFileSync(join(ROOT, ".env.example"), "utf8")) throw new Error(".env.example has no blank ARCADE_API_KEY= line");
  writeFileSync(join(dir, ".env"), edit(env));
  const home = join(scratch, `${name}.home`);
  mkdirSync(home, { recursive: true });
  if (cli !== null) {
    mkdirSync(join(home, ".arcade"), { recursive: true });
    writeFileSync(join(home, ".arcade", "credentials.yaml"), credentials(cli.orgId, cli.projectId));
  }
  const log = join(scratch, `${name}.arcade.log`);
  projects.set(dir, {
    dir,
    home,
    deploys: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => line.replace(`${realpathSync(dir)}/`, "").replace(`${dir}/`, ""))
        : [],
  });
  return dir;
}

/** `failDeployIn`: the toolkit directory the fake CLI fails in. `shell`: variables the developer's shell exports. */
type RunOptions = { failDeployIn?: string; shell?: Record<string, string> };

async function setupArcade(cwd: string, ...args: Array<string | RunOptions>): Promise<{ code: number; stdout: string; stderr: string }> {
  const project = projects.get(cwd);
  if (!project) throw new Error(`${cwd} was not made by project()`);
  const options = args.find((arg): arg is RunOptions => typeof arg === "object") ?? {};
  const child = spawnChild(["bun", "--no-env-file", SCRIPT, HOST, ...args.filter((arg): arg is string => typeof arg === "string")], {
    cwd,
    env: childEnv({
      ...options.shell,
      ARCADE_API_URL: arcade.url,
      HOME: project.home,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}`,
      FAKE_ARCADE_LOG: join(scratch, `${cwd.slice(scratch.length + 1)}.arcade.log`),
      ...(options.failDeployIn ? { FAKE_ARCADE_FAIL_IN: options.failDeployIn } : {}),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text(),
    child.exited,
  ]);
  // The CLI's tokens are in the file the script reads: none may come out of it.
  for (const token of CLI_TOKENS) expect(`${stdout}${stderr}`, `the run printed the CLI's ${token}`).not.toContain(token);
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

/** `METHOD /path`, with the ids Arcade minted written `{id}`, so a real run and a dry run compare. */
const normalise = (line: string) => line.replace(/(plg|gw)_\d+|<plugin_id>|<gateway_id>/g, "{id}");
const sequence = (requests: Recorded[]) => requests.map((each) => normalise(`${each.method} ${each.path}`));

/** The key's check, the first call of every run that found a project (#30). */
const GUARD = `GET ${SCOPED}/plugins?limit=100`;
/** A fresh project's registrations, after the guard, up to the hooks. */
const FIRST_RUN = [
  GUARD,
  "GET /v1/admin/auth_providers/app-identity",
  "POST /v1/admin/auth_providers",
  "PUT /v1/admin/secrets/APP_PUBLIC_HOST",
  "PUT /v1/admin/secrets/APPROVALS_STORE_TOKEN",
  "PUT /v1/admin/settings/session_verification",
  "GET /v1/admin/settings/session_verification",
  `POST ${SCOPED}/plugins`,
  `GET ${SCOPED}/plugins/{id}`,
  `GET ${SCOPED}/hooks?plugin_id={id}`,
];
/** A rerun's, once everything the first run did is there. */
const RERUN = [
  GUARD,
  "GET /v1/admin/auth_providers/app-identity",
  "PUT /v1/admin/secrets/APP_PUBLIC_HOST",
  "PUT /v1/admin/secrets/APPROVALS_STORE_TOKEN",
  "PUT /v1/admin/settings/session_verification",
  "GET /v1/admin/settings/session_verification",
  `GET ${SCOPED}/hooks?plugin_id={id}`,
];
const DEPLOYS = ["tools/loan|deploy", "tools/approvals|deploy"];

/**
 * The hooks as Arcade holds them, field by field: the three URLs on the
 * public host, fail closed, the health path, and `.env`'s bearer, which the
 * stand-in keeps and never returns.
 */
function hooksAreRegistered(dir: string): void {
  const plugins = [...arcade.plugins.values()];
  expect(plugins.map((each) => each.name)).toEqual(["loan-approval-limits-hooks"]);
  const [plugin] = plugins as [Json];
  expect(plugin.plugin_type).toBe("webhook");
  expect(plugin.status).toBe("active");
  expect(plugin.webhook_config.health_check_path).toBe(`${ORIGIN}/hooks/health`);
  expect(plugin.webhook_config.auth).toEqual({ type: "bearer", token: envOf(dir).ARCADE_HOOK_SIGNING_SECRET });
  expect(plugin.webhook_config.endpoints).toEqual({
    access: { url: `${ORIGIN}/hooks/access`, phase: "before", failure_mode: "fail_closed", status: "active" },
    pre: { url: `${ORIGIN}/hooks/pre`, phase: "before", failure_mode: "fail_closed", status: "active" },
    post: { url: `${ORIGIN}/hooks/post`, phase: "after", failure_mode: "fail_closed", status: "active" },
  });
  expect(arcade.hooks.map((hook) => `${hook.hook_point} ${hook.phase} ${hook.failure_mode}`).sort()).toEqual([
    "tool.access before fail_closed",
    "tool.post after fail_closed",
    "tool.pre before fail_closed",
  ]);
}

/**
 * The contextual access hooks form (#28), field by field, for a run that found
 * no org and project. Every name on the left is the live swagger's, and the
 * bearer is named, never printed.
 */
function hooksFormIsComplete(stdout: string): void {
  const start = stdout.indexOf("┌─ Contextual access hooks");
  expect(start, "no contextual access hooks form").toBeGreaterThan(-1);
  const form = stdout.slice(start, stdout.indexOf("└─", start));
  expect(form).toMatch(/│ {2}name +loan-approval-limits-hooks$/m);
  expect(form).toMatch(/│ {2}plugin_type +webhook$/m);
  expect(form).toMatch(/│ {2}status +active$/m);
  for (const [point, phase] of [["access", "before"], ["pre", "before"], ["post", "after"]] as const) {
    const at = form.indexOf(`│  webhook_config.endpoints.${point}   (hook_point tool.${point})`);
    expect(at, `the form has no ${point} endpoint`).toBeGreaterThan(-1);
    const block = form.slice(at).split("\n").slice(1, 5).join("\n");
    expect(block).toMatch(new RegExp(`│ {4}url +${ORIGIN.replace(/\./g, "\\.")}/hooks/${point}$`, "m"));
    expect(block).toMatch(new RegExp(`│ {4}phase +${phase}$`, "m"));
    expect(block).toMatch(/│ {4}failure_mode +fail_closed$/m);
    expect(block).toMatch(/│ {4}status +active$/m);
  }
  expect(form).toMatch(new RegExp(`│ {2}webhook_config\\.health_check_path +${ORIGIN.replace(/\./g, "\\.")}/hooks/health$`, "m"));
  expect(form).toMatch(/│ {2}webhook_config\.auth\.type +bearer$/m);
  expect(form).toMatch(/│ {2}webhook_config\.auth\.token +the value of ARCADE_HOOK_SIGNING_SECRET in \.env \(not printed here\)$/m);
}

/** The forms in the order the output prints them. */
function formOrder(stdout: string): string[] {
  return [...stdout.matchAll(/^┌─ (.*)$/gm)].map(([, title]) =>
    /User Sources/.test(title!) ? "User Source" : /Contextual access hooks/.test(title!) ? "hooks" : /MCP Gateways/.test(title!) ? "gateway" : title!,
  );
}

test("a real run registers every API-able piece, deploys both toolkits, and prints the one form left", async () => {
  const mine = "the-developer-chose-this-session-secret-0123456789";
  const dir = project("full", (env) => env.replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${mine}`));
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

  expect(run.stdout).toContain(`arcade        org ${ORG}, project ${PROJECT} (from the Arcade CLI's active context, `);
  expect(run.stdout).toContain(`.arcade/credentials.yaml, context cloud.arcade.dev)`);
  expect(sequence(arcade.requests)).toEqual(FIRST_RUN);
  for (const request of arcade.requests) expect(request.authorization).toBe(`Bearer ${KEY}`);

  const env = envOf(dir);
  const clients = clientsIn(dir);
  expect(Object.keys(clients).sort()).toEqual(["arcade", "arcade-user-source", "web"]);

  // The provider: the app's own endpoints, its own `arcade` client, Basic plus PKCE, email as the user id.
  const provider = arcade.requests[2]!.body as { id: string; oauth2: Record<string, any> };
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

  // The hooks: by API since #30, with the bearer the app checks, which is never printed.
  hooksAreRegistered(dir);
  expect(run.stdout).toContain(`hooks: ${ORIGIN}/hooks/access, /hooks/pre and /hooks/post, fail closed (read back)`);
  expect(run.stdout).toContain(`hooks: Arcade doesn't echo webhook_config.health_check_path back; it was sent as ${ORIGIN}/hooks/health and can't be verified`);
  expect(`${run.stdout}${run.stderr}`).not.toContain(env.ARCADE_HOOK_SIGNING_SECRET!);

  // The deploys: both toolkits, in order, streamed, after the hooks.
  expect(projects.get(dir)!.deploys()).toEqual(DEPLOYS);
  expect(run.stdout).toContain("arcade deploy   (in tools/loan):\nfake arcade: deploy (in ");
  expect(run.stdout.indexOf("arcade deploy   (in tools/loan):")).toBeGreaterThan(run.stdout.indexOf("hooks: created"));
  expect(run.stdout.indexOf("arcade deploy   (in tools/approvals):")).toBeGreaterThan(run.stdout.indexOf("arcade deploy   (in tools/loan):"));

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

  // No gateway yet: it needs the User Source, whose form is the one left, and the run ends on the command that follows it.
  expect(arcade.gateways.size).toBe(0);
  expect(formOrder(run.stdout)).toEqual(["User Source"]);
  expect(run.stdout).toContain("User Sources → Create User Source");
  expect(run.stdout).toContain(`Issuer URL      ${ORIGIN}`);
  expect(run.stdout).toContain(`Client ID       ${clients["arcade-user-source"]!.clientId}`);
  expect(run.stdout).toMatch(/Subject Claim\s+email/);
  expect(run.stdout.trimEnd().split("\n").slice(-2)).toEqual([
    `  bun run setup-arcade ${HOST} --user-source <id>`,
    `  (or set ARCADE_USER_SOURCE_ID in .env and run bun run setup-arcade ${HOST})`,
  ]);
  // Nothing printed carries the API key.
  expect(`${run.stdout}${run.stderr}`).not.toContain(KEY);
}, 60_000);

/**
 * What is left after the first run, in the order the README's Quickstart
 * gives it (#11, #30): the app and the tunnel, the User Source form (Arcade
 * reads its issuer through the tunnel), the second run that creates the
 * gateway through it, then the app. Both texts are read here, so the list
 * cannot drift from the README, or the README from the list, without this failing.
 */
const NEXT_STEPS: Array<[string, RegExp]> = [
  ["start the app", /`bun run dev`/],
  ["start the tunnel", /ngrok http --url=/],
  ["the User Source form", /fill in the User Source form/i],
  ["the gateway, by the second run", /setup-arcade \S+ --user-source/],
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

/** The printed "Then:" list, from its heading to the blank line after it. */
function thenList(stdout: string): string {
  const start = stdout.lastIndexOf("Then:");
  expect(start, "no Then: list").toBeGreaterThan(-1);
  const rest = stdout.slice(start);
  const end = rest.indexOf("\n\n");
  return end === -1 ? rest.trimEnd() : rest.slice(0, end);
}

test("the steps it prints after the form are the README's, in the README's order", async () => {
  const run = await setupArcade(project("next-steps"));
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const printed = thenList(run.stdout);

  const order = NEXT_STEPS.map(([name]) => name);
  expect(stepOrder(printed)).toEqual(order);
  expect(stepOrder(readmeRemainder())).toEqual(order);
  expect(printed).toContain(`ngrok http --url=${HOST} `);
  expect(printed).toContain(`Open ${ORIGIN}, never localhost`);
  expect(printed).toContain(`bun run setup-arcade ${HOST} --user-source <id>, with the id shown on the User Source's page`);
  startsTheApp(printed);
  // Nothing about deploying or the hooks is left: this run did both.
  expect(printed).not.toMatch(/arcade deploy|hooks form|gateway form/);

  // The check bites: the gateway command ahead of the form it needs fails it,
  // and so does the User Source form ahead of the tunnel Arcade reads it through.
  const lines = printed.split("\n");
  const [gateway] = lines.splice(lines.findIndex((line) => line.includes("--user-source")), 1);
  lines.splice(lines.findIndex((line) => /User Source form/i.test(line)), 0, gateway!);
  expect(stepOrder(lines.join("\n"))).not.toEqual(order);
  const early = printed.split("\n");
  const [form] = early.splice(early.findIndex((line) => /User Source form/i.test(line)), 1);
  early.splice(early.findIndex((line) => /ngrok http/.test(line)), 0, form!);
  expect(stepOrder(early.join("\n"))).not.toEqual(order);
}, 60_000);

test("a dry run ends with the same steps", async () => {
  const run = await setupArcade(project("next-steps-dry"), "--dry-run");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const printed = thenList(run.stdout);
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

test("--dry-run from a fresh project prints the requests a real run makes, in order, and writes, sends and deploys nothing", async () => {
  const dir = project("dry");
  const before = readFileSync(join(dir, ".env"), "utf8");
  const run = await setupArcade(dir, "--dry-run");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

  expect(arcade.requests).toEqual([]);
  expect(projects.get(dir)!.deploys()).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  expect(existsSync(join(dir, "idp.db"))).toBe(false);

  expect(printedRequests(run.stdout)).toEqual(FIRST_RUN);
  expect(run.stdout).toContain("Authorization: Bearer <ARCADE_API_KEY>");
  // Each tool secret: PUT, the CLI's `{ description, value }`, and the store
  // token only as a placeholder, because a dry run shows no secret.
  const secret = (key: string) => bodyAfter(run.stdout, `  PUT ${arcade.url}/v1/admin/secrets/${key}\n`);
  expect(Object.keys(secret("APP_PUBLIC_HOST"))).toEqual(["description", "value"]);
  expect(secret("APP_PUBLIC_HOST").value).toBe(HOST);
  expect(Object.keys(secret("APPROVALS_STORE_TOKEN"))).toEqual(["description", "value"]);
  expect(secret("APPROVALS_STORE_TOKEN").value).toBe("<generated APPROVALS_STORE_TOKEN>");
  // The hooks: the whole body, with the bearer as a placeholder.
  const plugin = bodyAfter(run.stdout, `  POST ${arcade.url}${SCOPED}/plugins\n`);
  expect(plugin.webhook_config.auth).toEqual({ type: "bearer", token: "<generated ARCADE_HOOK_SIGNING_SECRET>" });
  expect(plugin.webhook_config.endpoints.pre).toEqual({ url: `${ORIGIN}/hooks/pre`, phase: "before", failure_mode: "fail_closed", status: "active" });
  expect(run.stdout).toContain("Deploys, after the hooks and before the gateway, each stopping the run if it fails:\n  arcade deploy   (in tools/loan)\n  arcade deploy   (in tools/approvals)");
  expect(run.stdout).not.toContain("POST " + arcade.url + "/v1/admin/secrets");
  expect(run.stdout).toMatch(/would fill .*\bBETTER_AUTH_SECRET\b/);
  expect(run.stdout).not.toContain(KEY);
  expect(formOrder(run.stdout)).toEqual(["User Source"]);
});

/** The JSON body a dry run prints under a request line. */
function bodyAfter(stdout: string, line: string): Json {
  const at = stdout.indexOf(line);
  expect(at, `the dry run prints no ${line.trim()}`).toBeGreaterThan(-1);
  const block = stdout.slice(at).split("\n");
  const json = block.slice(3, block.findIndex((each, i) => i > 3 && each === "    }") + 1).join("\n");
  return JSON.parse(json) as Json;
}

test("--user-source creates the gateway through the User Source, with the six tools, and a third run leaves it", async () => {
  const dir = project("gateway");
  expect((await setupArcade(dir)).code).toBe(0);
  arcade.requests = [];

  const run = await setupArcade(dir, "--user-source", USER_SOURCE);
  console.log(`--- setup-arcade ${HOST} --user-source ${USER_SOURCE} ---\n${run.stdout}${run.stderr}`);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(sequence(arcade.requests)).toEqual([...RERUN, `GET ${SCOPED}/gateways?limit=100`, `POST ${SCOPED}/gateways`, `GET ${SCOPED}/gateways/{id}`]);
  const [gateway] = [...arcade.gateways.values()] as [Json];
  expect(gateway).toMatchObject({
    name: "Loan Approval Limits",
    slug: "loan-approval-limits",
    auth_type: "user_source",
    user_source_id: USER_SOURCE,
    tool_filter: {
      allowed_tools: ["Loan.SearchLoans", "Loan.GetLoan", "Loan.ApproveLoan", "Loan.DenyLoan", "Approvals.RequestApproval", "Approvals.Decide"],
    },
  });
  expect(run.stdout).toContain(`gateway: created loan-approval-limits, through the User Source ${USER_SOURCE}, with the six tools of Loan and Approvals (read back)`);
  expect(envOf(dir).ARCADE_USER_SOURCE_ID).toBe(USER_SOURCE);
  // Nothing is left for the dashboard, and the run ends on opening the app.
  expect(formOrder(run.stdout)).toEqual([]);
  expect(thenList(run.stdout).split("\n").slice(1)).toEqual([
    "  1. Start `bun run dev` (or restart it, if it is already running), so the app reads the new .env.",
    `  2. Start the tunnel: ngrok http --url=${HOST} 3000`,
    `  3. Open ${ORIGIN}, never localhost, and sign in.`,
  ]);
  // The deploys ran again, before the gateway.
  expect(projects.get(dir)!.deploys()).toEqual([...DEPLOYS, ...DEPLOYS]);

  // A third run, the id now in .env: the gateway is found and left.
  arcade.requests = [];
  const again = await setupArcade(dir);
  expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
  expect(sequence(arcade.requests)).toEqual([...RERUN, `GET ${SCOPED}/gateways?limit=100`]);
  expect(again.stdout).toContain("gateway: loan-approval-limits is already registered and matches; it is left as it is");
  expect(arcade.gateways.size).toBe(1);
}, 90_000);

test("a gateway under the slug that differs is reported and never edited", async () => {
  const dir = project("gateway-differs");
  arcade.gateways.set("gw_theirs", {
    id: "gw_theirs",
    slug: "loan-approval-limits",
    name: "Somebody else's",
    auth_type: "arcade",
    tool_filter: { allowed_tools: ["Loan.GetLoan"] },
  });
  const run = await setupArcade(dir, "--user-source", USER_SOURCE);
  expect(run.code).toBe(1);
  expect(run.stdout).toContain('auth_type: Arcade has "arcade", this app needs "user_source"');
  expect(run.stdout).toContain(`user_source_id: Arcade has nothing, this app needs "${USER_SOURCE}"`);
  expect(run.stderr).toContain("never edits an existing gateway");
  expect(run.stderr).toContain("--gateway <another-slug>");
  expect(arcade.requests.filter((each) => each.path.includes("/gateways") && each.method !== "GET")).toEqual([]);
}, 60_000);

test("a slug Arcade says is taken names the way out", async () => {
  const dir = project("gateway-taken");
  arcade.takenSlugs.add("loan-approval-limits");
  const run = await setupArcade(dir, "--user-source", USER_SOURCE);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("the gateway slug loan-approval-limits is taken");
  expect(run.stderr).toContain("--gateway <another-slug>");
}, 60_000);

test("--user-source takes only a User Source id", async () => {
  const run = await setupArcade(project("gateway-bad-id"), "--user-source", "Loan Approval Limits");
  expect(run.code).toBe(64);
  expect(run.stderr).toContain("a User Source id starts with us_");
  expect(arcade.requests).toEqual([]);
});

test("it creates the gateway only through the User Source and never names Arcade Headers mode, in a real run or a dry one", async () => {
  const real = await setupArcade(project("no-headers"), "--user-source", USER_SOURCE);
  const dry = await setupArcade(project("no-headers-dry"), "--dry-run", "--user-source", USER_SOURCE);
  expect(real.code, `${real.stdout}\n${real.stderr}`).toBe(0);
  expect(dry.code, `${dry.stdout}\n${dry.stderr}`).toBe(0);
  const everything = [real.stdout, real.stderr, dry.stdout, dry.stderr, JSON.stringify(arcade.requests), readFileSync(join(ROOT, "scripts", "setup-arcade", "arcade.ts"), "utf8")].join("\n");
  expect(everything).not.toMatch(/arcade_header/i);
  const created = arcade.requests.filter((each) => each.method === "POST" && each.path.endsWith("/gateways"));
  expect(created.map((each) => (each.body as Json).auth_type)).toEqual(["user_source"]);
  expect(bodyAfter(dry.stdout, `  POST ${arcade.url}${SCOPED}/gateways\n`).auth_type).toBe("user_source");
  // Only ever under the project: the bare route has no gateway either.
  expect(arcade.requests.filter((each) => each.path.startsWith("/v1/gateways"))).toEqual([]);
}, 90_000);

/** The routes real Arcade does not have (#28): a bare `/v1/plugins`, and a bare `/v1/hooks`. */
const BARE_PLUGIN_OR_HOOK_ROUTE = /^\/v1\/(plugins|hooks)(\/|\?|$)/;

test("it never calls the bare plugins or hooks route, in a fresh run, a rerun or a dry run: only the project's", async () => {
  const dir = project("no-bare-plugins");
  const first = await setupArcade(dir);
  const again = await setupArcade(dir);
  const dry = await setupArcade(dir, "--dry-run");
  const dryFresh = await setupArcade(project("no-bare-plugins-dry"), "--dry-run");

  const paths = arcade.requests.map((each) => each.path);
  expect(paths.filter((each) => BARE_PLUGIN_OR_HOOK_ROUTE.test(each))).toEqual([]);
  expect(paths.filter((each) => /\/(plugins|hooks)\b/.test(each)).every((each) => each.startsWith(`${SCOPED}/`))).toBe(true);
  for (const run of [dry, dryFresh]) {
    const printed = [...run.stdout.matchAll(/^ {2}(GET|POST|PUT|PATCH|DELETE) (\S+)$/gm)].map(([, , url]) => new URL(url!).pathname);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.filter((each) => BARE_PLUGIN_OR_HOOK_ROUTE.test(each))).toEqual([]);
  }
  for (const run of [first, again, dry, dryFresh]) expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  // The check bites: the request the pre-#28 script sent first is caught.
  expect(BARE_PLUGIN_OR_HOOK_ROUTE.test("/v1/plugins")).toBe(true);
  expect(BARE_PLUGIN_OR_HOOK_ROUTE.test(`${SCOPED}/plugins`)).toBe(false);
}, 120_000);

test("the stand-in has no bare plugins route, and only the key's own project under the org routes", async () => {
  const call = (method: string, path: string) =>
    fetch(`${arcade.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
  for (const [method, path] of [
    ["GET", "/v1/plugins?limit=100"],
    ["POST", "/v1/plugins"],
    ["PATCH", "/v1/plugins/plg_1"],
    ["POST", "/v1/hooks"],
    ["GET", `/v1/orgs/${ORG}/plugins`],
  ] as const) {
    const answer = await call(method, path);
    expect(answer.status, `${method} ${path}`).toBe(404);
    expect(await answer.text()).toBe('{"name":"route_not_found","message":"requested route is not found or method is not allowed"}');
  }
  expect((await call("GET", `${SCOPED}/plugins`)).status).toBe(200);
  expect((await call("GET", `/v1/orgs/${ORG}/projects/prj_somebody_else/plugins`)).status).toBe(404);
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
  // Two reads, and nothing after them: no PATCH, no DELETE, no re-create, no hooks, no deploys.
  expect(sequence(arcade.requests)).toEqual([GUARD, "GET /v1/admin/auth_providers/app-identity"]);
  expect(projects.get(dir)!.deploys()).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
});

test("running it again changes nothing that is registered and rotates nothing Arcade holds", async () => {
  const dir = project("twice");
  expect((await setupArcade(dir)).code).toBe(0);
  const envAfterFirst = readFileSync(join(dir, ".env"), "utf8");
  const providerAfterFirst = JSON.stringify(arcade.providers.get("app-identity"));
  const pluginAfterFirst = JSON.stringify([...arcade.plugins.values()]);
  arcade.requests = [];

  const again = await setupArcade(dir);

  expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(0);
  expect(again.stdout).toContain("the provider app-identity is already registered and matches");
  expect(again.stdout).toContain("hooks: loan-approval-limits-hooks is already registered and matches; it is left as it is");
  expect(sequence(arcade.requests)).toEqual(RERUN);
  expect(JSON.stringify(arcade.providers.get("app-identity"))).toBe(providerAfterFirst);
  expect(JSON.stringify([...arcade.plugins.values()])).toBe(pluginAfterFirst);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(envAfterFirst);
  // The User Source's secret was shown once, on the first run, and is not re-minted.
  expect(again.stdout).toContain("(unchanged, and not shown");
}, 60_000);

test("hooks that differ are updated, because they are not the access model, and read back", async () => {
  const dir = project("hooks-differ");
  expect((await setupArcade(dir)).code).toBe(0);
  // Somebody set the pre hook to fail open in the dashboard, and pointed post elsewhere.
  const [plugin] = [...arcade.plugins.values()] as [Json];
  plugin.webhook_config.endpoints.pre.failure_mode = "fail_open";
  plugin.webhook_config.endpoints.post.url = "https://old-host.example/hooks/post";
  arcade.hooks.find((hook) => hook.hook_point === "tool.pre")!.failure_mode = "fail_open";
  arcade.requests = [];

  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain("hooks: loan-approval-limits-hooks is registered and differs from what this app needs, so it is updated:");
  expect(run.stdout).toContain(`webhook_config.endpoints.post.url: Arcade has "https://old-host.example/hooks/post", this app needs "${ORIGIN}/hooks/post"`);
  expect(run.stdout).toContain('tool.pre.failure_mode: Arcade has "fail_open", this app needs "fail_closed"');
  expect(sequence(arcade.requests).slice(-4)).toEqual([
    `GET ${SCOPED}/hooks?plugin_id={id}`,
    `PATCH ${SCOPED}/plugins/{id}`,
    `GET ${SCOPED}/plugins/{id}`,
    `GET ${SCOPED}/hooks?plugin_id={id}`,
  ]);
  hooksAreRegistered(dir);
  expect(arcade.plugins.size).toBe(1);
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

// --- The org and project, and the key's check (#30) --------------------------

test("with no org and project anywhere, the hooks and the gateway fall back to the forms, and the run says why", async () => {
  const dir = project("no-context", (env) => env, null);
  const run = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, with no Arcade CLI context ---\n${run.stdout}${run.stderr}`);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);

  expect(run.stdout).toContain(
    `arcade        no org and project: ARCADE_ORG_ID and ARCADE_PROJECT_ID are unset, and there is no ${projects.get(dir)!.home}/.arcade/credentials.yaml: run \`arcade login\`.`,
  );
  expect(run.stdout).toContain("The hooks and the gateway are printed as dashboard forms instead.");
  expect(run.stdout).toContain("  hooks: no org and project, so the form below");
  // Nothing under any org, and the rest as before.
  expect(arcade.requests.filter((each) => each.path.startsWith("/v1/orgs/"))).toEqual([]);
  expect(sequence(arcade.requests)).toEqual(FIRST_RUN.slice(1, 7));
  expect(projects.get(dir)!.deploys()).toEqual(DEPLOYS);
  expect(formOrder(run.stdout)).toEqual(["User Source", "gateway", "hooks"]);
  hooksFormIsComplete(run.stdout);
  expect(thenList(run.stdout).split("\n").slice(1)).toEqual([
    "  1. Start `bun run dev` (or restart it, if it is already running), so the app reads the new .env.",
    `  2. Start the tunnel: ngrok http --url=${HOST} 3000`,
    "  3. With the app reachable through the tunnel, fill in the User Source form above.",
    "  4. Fill in the gateway form above. It authenticates through the User Source, and lists the toolkits' tools once they are deployed.",
    "  5. Fill in the contextual access hooks form above. Arcade checks /hooks/health through the tunnel.",
    `  6. Open ${ORIGIN}, never localhost, and sign in.`,
  ]);
}, 60_000);

test("ARCADE_ORG_ID and ARCADE_PROJECT_ID win over the CLI's active project", async () => {
  const dir = project(
    "context-from-env",
    (env) => `${env}\nARCADE_ORG_ID=${ORG}\nARCADE_PROJECT_ID=${PROJECT}\n`,
    { orgId: "org_the_cli_has", projectId: "prj_the_cli_has" },
  );
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain(`arcade        org ${ORG}, project ${PROJECT} (from ARCADE_ORG_ID and ARCADE_PROJECT_ID)`);
  expect(run.stdout).toContain("warning       arcade deploy uses the Arcade CLI's active project, not these variables");
  expect(sequence(arcade.requests)).toEqual(FIRST_RUN);
  expect(JSON.stringify(arcade.requests)).not.toContain("prj_the_cli_has");
}, 60_000);

test("one of ARCADE_ORG_ID and ARCADE_PROJECT_ID alone is not enough, and says so", async () => {
  const dir = project("context-half", (env) => `${env}\nARCADE_PROJECT_ID=${PROJECT}\n`);
  const run = await setupArcade(dir, "--dry-run");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain("no org and project: ARCADE_PROJECT_ID is set without ARCADE_ORG_ID; set both, or neither to use the Arcade CLI's active project");
});

test("a key from another project is stopped by the check before anything is written", async () => {
  const dir = project("key-mismatch", (env) => env, { orgId: ORG, projectId: "prj_not_the_keys" });
  const before = readFileSync(join(dir, ".env"), "utf8");
  const run = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, with the CLI on another project ---\n${run.stdout}${run.stderr}`);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`ARCADE_API_KEY and the Arcade project this run resolved disagree: GET /v1/orgs/${ORG}/projects/prj_not_the_keys/plugins?limit=100 answered 404.`);
  expect(run.stderr).toContain(`The project is prj_not_the_keys in the org ${ORG} (from the Arcade CLI's active context`);
  expect(run.stderr).toContain("`arcade project set <project_id>`");
  expect(run.stderr).toContain("or create an API key in the project prj_not_the_keys and put it in ARCADE_API_KEY. Nothing was written.");
  // One read, and nothing else at all.
  expect(sequence(arcade.requests)).toEqual([`GET /v1/orgs/${ORG}/projects/prj_not_the_keys/plugins?limit=100`]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  expect(existsSync(join(dir, "idp.db"))).toBe(false);
  expect(projects.get(dir)!.deploys()).toEqual([]);
});

test("a key Arcade does not accept is stopped by the same check", async () => {
  const dir = project("key-refused", (env) => env.replace(`ARCADE_API_KEY=${KEY}`, "ARCADE_API_KEY=somebody-elses-key"));
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`GET ${SCOPED}/plugins?limit=100 answered 401.`);
  expect(arcade.requests).toHaveLength(1);
  expect(existsSync(join(dir, "idp.db"))).toBe(false);
});

// --- The deploys (#30) ------------------------------------------------------

test("a deploy that fails stops the run there: after the hooks, and before the gateway", async () => {
  const dir = project("deploy-fails");
  const run = await setupArcade(dir, "--user-source", USER_SOURCE, { failDeployIn: "tools/approvals" });
  expect(run.code).toBe(1);
  expect(projects.get(dir)!.deploys()).toEqual(DEPLOYS);
  expect(run.stdout).toContain("fake arcade: deploy (in");
  expect(run.stderr).toContain("fake arcade: deploy failed");
  expect(run.stderr).toContain("arcade deploy in tools/approvals exited 3; its output is above, and nothing after it ran.");
  expect(run.stderr).toContain("or pass --skip-deploy");
  // The hooks were registered first, and the gateway never asked for.
  hooksAreRegistered(dir);
  expect(arcade.requests.filter((each) => each.path.includes("/gateways"))).toEqual([]);
}, 60_000);

test("--skip-deploy runs no deploy, and the steps left say to deploy before the gateway", async () => {
  const dir = project("skip-deploy");
  const run = await setupArcade(dir, "--skip-deploy");
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(projects.get(dir)!.deploys()).toEqual([]);
  expect(run.stdout).toContain("Deploys: skipped (--skip-deploy).");
  const steps = thenList(run.stdout);
  expect(steps).toContain("3. Deploy both toolkits (their secrets are set above): arcade deploy, in tools/loan and in tools/approvals.");
  expect(steps.indexOf("arcade deploy")).toBeLessThan(steps.indexOf("--user-source"));
}, 60_000);

// --- Resuming from the live project -----------------------------------------

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
test("a rerun resumes from the live project's state after run 1: the provider matches, nothing is minted or overwritten, and the rest is set", async () => {
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
  expect(sequence(arcade.requests)).toEqual(FIRST_RUN.filter((each) => each !== "POST /v1/admin/auth_providers"));
  // Minted nothing, overwrote nothing, re-created nothing.
  expect(clientRows(dir)).toBe(rows);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(envText);
  expect(rerun.stdout).toContain("filled   (nothing to fill: every value was already set)");
  expect(JSON.stringify(arcade.providers.get("app-identity"))).toBe(provider);
  // And went on to set the secrets, the verifier and the hooks.
  expect(arcade.secrets.get("APP_PUBLIC_HOST")).toBe(HOST);
  expect(arcade.secrets.get("APPROVALS_STORE_TOKEN")).toBe(envBefore.APPROVALS_STORE_TOKEN);
  hooksAreRegistered(dir);
  expect(arcade.verifier).toEqual({ verifier_url: `${ORIGIN}/api/arcade/verify`, unsafe_skip_verification: false });
  expect(rerun.stdout).toContain(`custom verifier: ${ORIGIN}/api/arcade/verify (read back)`);
}, 60_000);

/** The requests a dry run prints, as `METHOD /path`. */
const printedRequests = (stdout: string) =>
  [...stdout.matchAll(/^ {2}(GET|POST|PUT|PATCH|DELETE) \S+?(\/v1\/\S+)$/gm)].map(([, method, path]) => normalise(`${method} ${path}`));

/** What a dry run says only when it is about to create what a resumed project already has (#28). */
const FRESH_ONLY = [
  "would mint the OAuth clients",
  "would fill ",
  "IDP_CLIENT_ID, IDP_CLIENT_SECRET",
  "minted by this run>",
  "/v1/admin/auth_providers\n",
];

test("a dry run of a fresh project describes the real run that follows it", async () => {
  const dir = project("dry-fresh-truth");
  const dry = await setupArcade(dir, "--dry-run");
  expect(dry.code, `${dry.stdout}\n${dry.stderr}`).toBe(0);
  expect(arcade.requests).toEqual([]);

  expect(dry.stdout).toContain("idp.db: would mint the OAuth clients arcade, arcade-user-source, web");
  expect(dry.stdout).toMatch(/would fill .*\bIDP_CLIENT_ID, IDP_CLIENT_SECRET\b.*\bIDP_OAUTH_REDIRECT_URIS_ARCADE\b/);
  expect(dry.stdout).toContain("Client Secret   <its secret, minted by this run>");
  expect(dry.stdout).toContain(`  POST ${arcade.url}/v1/admin/auth_providers\n`);

  const real = await setupArcade(dir);
  expect(real.code, `${real.stdout}\n${real.stderr}`).toBe(0);
  expect(printedRequests(dry.stdout)).toEqual(sequence(arcade.requests));
}, 60_000);

/**
 * The human's live project as #30 describes it: after run 3, the provider,
 * both tool secrets and the verifier are set, `.env`'s second block is filled
 * and `idp.db` minted, and there is no plugin and no gateway, because both
 * were dashboard forms. That state is built here by a whole run with the
 * plugin then taken back out, and checked rather than assumed. From it, the
 * dry run and the real rerun must agree, and the second invocation must make
 * the gateway (#28, #30).
 */
test("from the live project's state after run 3, the dry run tells the truth, the rerun adds the hooks, and --user-source the gateway", async () => {
  const dir = project("resume-run-3");
  expect((await setupArcade(dir)).code).toBe(0);
  arcade.plugins.clear();
  arcade.hooks = [];

  expect(arcade.providers.has("app-identity")).toBe(true);
  expect([...arcade.secrets.keys()].sort()).toEqual(["APPROVALS_STORE_TOKEN", "APP_PUBLIC_HOST"]);
  expect(arcade.verifier).toEqual({ verifier_url: `${ORIGIN}/api/arcade/verify`, unsafe_skip_verification: false });
  expect(arcade.gateways.size).toBe(0);
  expect(existsSync(join(dir, "idp.db"))).toBe(true);
  const envBefore = envOf(dir);
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  const block2 = example.slice(example.indexOf("# --- Filled in by `bun run setup-arcade"), example.indexOf("# --- Optional"));
  for (const [, key] of block2.matchAll(/^([A-Z_][A-Z0-9_]*)=$/gm)) expect(envBefore[key!], `block 2 left ${key} blank`).toMatch(/\S/);
  const secretsBefore = new Map(arcade.secrets);
  const envText = readFileSync(join(dir, ".env"), "utf8");
  const rows = clientRows(dir);
  const provider = JSON.stringify(arcade.providers.get("app-identity"));
  arcade.requests = [];

  // The dry run: what a real run does from here, and nothing a fresh one does.
  const dry = await setupArcade(dir, "--dry-run");
  console.log(`--- setup-arcade ${HOST} --dry-run, from the live state after run 3 ---\n${dry.stdout}${dry.stderr}`);
  expect(dry.code, `${dry.stdout}\n${dry.stderr}`).toBe(0);
  expect(arcade.requests).toEqual([]);
  for (const phrase of FRESH_ONLY) expect(dry.stdout, `the resumed dry run says ${JSON.stringify(phrase)}`).not.toContain(phrase);
  expect(dry.stdout).toContain(".env: nothing to fill: every value is already set, and none is overwritten");
  expect(dry.stdout).toContain("idp.db: already holds the OAuth clients");
  expect(dry.stdout).toContain("  no secret is minted or rotated");
  expect(dry.stdout).toContain("(expected 200: .env holds the callback Arcade made for this provider.");
  expect(dry.stdout).toContain("If Arcade answers 404 instead, a real run mints a new secret for the");
  expect(dry.stdout).toContain("Client Secret   (unchanged, and not shown");
  expect(bodyAfter(dry.stdout, `  POST ${arcade.url}${SCOPED}/plugins\n`).webhook_config.auth.token).toBe("<ARCADE_HOOK_SIGNING_SECRET from .env>");
  expect(formOrder(dry.stdout)).toEqual(["User Source"]);
  // The check bites: the fresh project's dry run says every one of them.
  const fresh = await setupArcade(project("resume-run-3-fresh"), "--dry-run");
  for (const phrase of FRESH_ONLY) expect(fresh.stdout).toContain(phrase);

  // The real rerun.
  const rerun = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, from the live state after run 3 ---\n${rerun.stdout}${rerun.stderr}`);
  expect(rerun.code, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
  const called = sequence(arcade.requests);
  expect(called).toEqual(FIRST_RUN.filter((each) => each !== "POST /v1/admin/auth_providers"));
  expect(printedRequests(dry.stdout)).toEqual(called);
  hooksAreRegistered(dir);

  // In this order: the project, the key's check, provider matches, .env has nothing to fill, both secrets, the verifier, the hooks, the deploys, the form.
  const at = (text: string) => {
    const index = rerun.stdout.indexOf(text);
    expect(index, `the rerun never printed ${JSON.stringify(text)}`).toBeGreaterThan(-1);
    return index;
  };
  const marks = [
    at(`arcade        org ${ORG}, project ${PROJECT}`),
    at(`the key answers for the project ${PROJECT}`),
    at("the provider app-identity is already registered and matches"),
    at("filled   (nothing to fill: every value was already set)"),
    at("PUT /v1/admin/secrets/APP_PUBLIC_HOST → 200"),
    at("PUT /v1/admin/secrets/APPROVALS_STORE_TOKEN → 200"),
    at(`custom verifier: ${ORIGIN}/api/arcade/verify (read back)`),
    at("hooks: created loan-approval-limits-hooks"),
    at("arcade deploy   (in tools/loan):"),
    at("arcade deploy   (in tools/approvals):"),
    at("┌─ Arcade dashboard → your project → User Sources"),
    at("Then:"),
  ];
  expect([...marks].sort((a, b) => a - b)).toEqual(marks);

  // Idempotent: the same secrets, nothing minted, nothing overwritten, nothing re-created.
  expect(arcade.secrets).toEqual(secretsBefore);
  expect(clientRows(dir)).toBe(rows);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(envText);
  expect(JSON.stringify(arcade.providers.get("app-identity"))).toBe(provider);
  expect(`${rerun.stdout}${dry.stdout}`).not.toContain(envBefore.ARCADE_HOOK_SIGNING_SECRET!);

  // And the second invocation, once the User Source exists: the gateway.
  const withUserSource = await setupArcade(dir, "--user-source", USER_SOURCE);
  expect(withUserSource.code, `${withUserSource.stdout}\n${withUserSource.stderr}`).toBe(0);
  expect([...arcade.gateways.values()].map((each) => `${each.slug} ${each.auth_type} ${each.user_source_id}`)).toEqual([
    `loan-approval-limits user_source ${USER_SOURCE}`,
  ]);
}, 120_000);

// --- What the run is told, and by whom (#30, F6 and F7) ----------------------

test("the stand-in refuses a health_check_path that is not a URL with the body Arcade sent the fourth live run", async () => {
  const create = (health: string) =>
    fetch(`${arcade.url}${SCOPED}/plugins`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", plugin_type: "webhook", webhook_config: { health_check_path: health, endpoints: {} } }),
    });
  const path = await create("/hooks/health");
  expect(path.status).toBe(400);
  expect(await path.text()).toBe(
    '{"name":"malformed_request","message":"failed to validate request body: webhook_config: health_check_path must be a valid URL","field_errors":[{"field":"webhook_config.health_check_path","rule":"url","message":"health_check_path must be a valid URL"}]}',
  );
  expect((await create(`${ORIGIN}/hooks/health`)).status).toBe(201);
});

test("a refusal that is not about reaching the app prints Arcade's own message, and no advice about the tunnel", async () => {
  const dir = project("hooks-refused");
  arcade.nextPluginCreate = { status: 400, body: HEALTH_CHECK_NOT_A_URL };
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("creating the contextual access hooks failed: POST");
  expect(run.stderr).toContain("Arcade says: failed to validate request body: webhook_config: health_check_path must be a valid URL");
  expect(run.stderr).not.toMatch(/tunnel|bun run dev/);
});

test("a refusal about reaching the app says to start it and the tunnel", async () => {
  const dir = project("hooks-unreachable");
  // Nobody has seen Arcade's answer for an unreachable health check: this is the wording the check looks for.
  arcade.nextPluginCreate = { status: 422, body: { name: "health_check_failed", message: `health check failed: dial tcp: lookup ${HOST}: no such host` } };
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`Arcade says: health check failed: dial tcp: lookup ${HOST}: no such host`);
  expect(run.stderr).toContain(`Arcade could not reach ${ORIGIN}/hooks/health: start \`bun run dev\` and the tunnel first.`);
});

test("setup-arcade manages exactly .env.example's required values and its second block", async () => {
  const { REQUIRED_KEYS, WRITTEN_KEYS } = await import("../scripts/setup-arcade/env-file.ts");
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  const block = (from: string, to: string) =>
    [...example.slice(example.indexOf(from), example.indexOf(to)).matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map(([, key]) => key!).sort();
  expect(([...REQUIRED_KEYS] as string[]).sort()).toEqual(block("# --- Required", "# --- Filled in by `bun run setup-arcade"));
  expect(([...WRITTEN_KEYS] as string[]).sort()).toEqual(block("# --- Filled in by `bun run setup-arcade", "# --- Optional"));
});

/**
 * The fourth live run (#7, F7): a fresh clone, a fresh `.env` with its second
 * block blank, and a shell that still exported the previous clone's `.env`
 * (`set -a; . ./.env`). The shell won, the run said ".env: nothing to fill",
 * the provider was created with the shell's old `arcade` client, and
 * `bun run dev`, which reads `.env`, had no BETTER_AUTH_SECRET. The run now
 * stops before it sends or writes anything, and names the keys, never the values.
 */
test("a shell that still exports an old .env is refused before anything is sent or written, naming the keys and not the values", async () => {
  const old = project("old-clone");
  expect((await setupArcade(old)).code).toBe(0);
  const exported = envOf(old);
  const managed = (await import("../scripts/setup-arcade/env-file.ts")).MANAGED_KEYS;
  const shell = Object.fromEntries(Object.entries(exported).filter(([key, value]) => managed.includes(key) && value !== ""));
  expect(Object.keys(shell)).toContain("BETTER_AUTH_SECRET");
  arcade.requests = [];

  // The seven filled in, as the human's were, and the second block blank.
  const dir = project("fresh-clone", (env) => env.replace(/^APP_PUBLIC_HOST=$/m, `APP_PUBLIC_HOST=${HOST}`));
  const before = readFileSync(join(dir, ".env"), "utf8");
  const run = await setupArcade(dir, { shell });
  console.log(`--- setup-arcade ${HOST}, with the old clone's .env exported ---\n${run.stdout}${run.stderr}`);
  expect(run.code).toBe(1);
  const refused = Object.keys(shell).filter((key) => (envOf(dir)[key] ?? "") !== shell[key]);
  expect(refused.length).toBeGreaterThan(5);
  expect(run.stderr).toContain(`${refused.join(", ")} are exported in this shell with a value .env does not hold`);
  expect(run.stderr).toContain(`Open a new terminal, or run: unset ${refused.join(" ")}`);
  expect(run.stderr).toContain("Nothing was sent or written.");
  // The keys an old .env shares with this one (the API key, the host, the personas) are no conflict.
  expect(run.stderr).not.toMatch(/\bARCADE_API_KEY\b|\bAPP_PUBLIC_HOST\b/);
  // Names only.
  for (const key of refused) expect(`${run.stdout}${run.stderr}`, `the run printed ${key}'s value`).not.toContain(shell[key]!);
  expect(arcade.requests).toEqual([]);
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(before);
  expect(existsSync(join(dir, "idp.db"))).toBe(false);
  expect(projects.get(dir)!.deploys()).toEqual([]);
  // A dry run says the same.
  expect((await setupArcade(dir, "--dry-run", { shell })).code).toBe(1);

  // In a new terminal: the second block is filled into this .env, BETTER_AUTH_SECRET included,
  // and the provider's callback is allowlisted with no "add it yourself" warning. The
  // provider the old clone made names the old client, so it is taken away first, as a
  // human would delete it in the dashboard (the next test is what happens if not).
  arcade.providers.clear();
  arcade.plugins.clear();
  const clean = await setupArcade(dir);
  expect(clean.code, `${clean.stdout}\n${clean.stderr}`).toBe(0);
  const env = envOf(dir);
  expect(env.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
  expect(env.BETTER_AUTH_SECRET).not.toBe(exported.BETTER_AUTH_SECRET);
  expect(env.IDP_OAUTH_REDIRECT_URIS_ARCADE).toBe(CALLBACK);
  expect(clean.stdout).not.toContain("add it to IDP_OAUTH_REDIRECT_URIS_ARCADE yourself");
  expect(clean.stdout).toContain("allowlisted the provider's callback on the arcade client");
  expect((arcade.providers.get("app-identity") as Json).oauth2.client_id).toBe(clientsIn(dir).arcade!.clientId);
}, 120_000);

test("in a new terminal, a provider the old clone created is reported, and never edited", async () => {
  expect((await setupArcade(project("old-clone-2"))).code).toBe(0);
  const run = await setupArcade(project("fresh-clone-2"));
  expect(run.code).toBe(1);
  expect(run.stdout).toContain("The provider app-identity already exists in this Arcade project, and it is not what this app needs:");
  expect(run.stdout).toContain("oauth2.client_id: Arcade has");
  expect(run.stderr).toContain("never edits an existing provider");
}, 60_000);

test("a shell that exports the same values as .env is no conflict", async () => {
  const dir = project("shell-agrees");
  const run = await setupArcade(dir, { shell: { ARCADE_API_KEY: KEY, SESSION_SECRET: "" } });
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(envOf(dir).SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
}, 60_000);

// --- A read-back that leaves fields out (#30, run 4's retry) ------------------

/**
 * Real Arcade, on the fourth live run's retry: `POST …/plugins → 201`, both
 * read-backs 200, and no `webhook_config.health_check_path` in the plugin's.
 * The run stopped with "the hooks did not take". The stand-in's read-back has
 * that shape by default, and this is the live project's state from there.
 */
test("a read-back without health_check_path is a warning, and a rerun from that state neither re-creates nor loops", async () => {
  const dir = project("health-not-echoed");
  const first = await setupArcade(dir);
  console.log(`--- setup-arcade ${HOST}, Arcade not echoing health_check_path ---\n${first.stdout}${first.stderr}`);
  expect(first.code, `${first.stdout}\n${first.stderr}`).toBe(0);
  const warning = `hooks: Arcade doesn't echo webhook_config.health_check_path back; it was sent as ${ORIGIN}/hooks/health and can't be verified`;
  expect(first.stdout).toContain(warning);
  expect(first.stdout).not.toContain("the hooks did not take");
  // It carried on: the deploys ran, and the run ended on the User Source form.
  expect(projects.get(dir)!.deploys()).toEqual(DEPLOYS);
  expect(formOrder(first.stdout)).toEqual(["User Source"]);
  // What was sent is what the app needs, whatever the read-back says.
  hooksAreRegistered(dir);

  for (const attempt of [1, 2]) {
    arcade.requests = [];
    const rerun = await setupArcade(dir);
    expect(rerun.code, `rerun ${attempt}: ${rerun.stdout}\n${rerun.stderr}`).toBe(0);
    expect(rerun.stdout).toContain("hooks: loan-approval-limits-hooks is already registered and matches; it is left as it is");
    expect(rerun.stdout).toContain(warning);
    // Found by name: no second plugin, and no PATCH for a field it cannot see.
    expect(sequence(arcade.requests)).toEqual(RERUN);
    expect(arcade.plugins.size).toBe(1);
  }
}, 120_000);

test("a health_check_path read back present but different still fails the run", async () => {
  const dir = project("health-differs");
  arcade.healthCheckReadBack = "https://old-host.example/hooks/health";
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("the hooks did not take: Arcade reads back");
  expect(run.stderr).toContain(`webhook_config.health_check_path: Arcade has "https://old-host.example/hooks/health", this app needs "${ORIGIN}/hooks/health"`);
  expect(projects.get(dir)!.deploys()).toEqual([]);
}, 60_000);

test("a health_check_path Arcade does echo is checked, and the line says so", async () => {
  const dir = project("health-echoed");
  arcade.healthCheckReadBack = "stored";
  const run = await setupArcade(dir);
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain(`hooks: ${ORIGIN}/hooks/access, /hooks/pre and /hooks/post, fail closed, health check ${ORIGIN}/hooks/health (read back)`);
  expect(run.stdout).not.toContain("doesn't echo webhook_config.health_check_path");
}, 60_000);

test("an endpoint URL missing from the read-back means the hooks did not take", async () => {
  const dir = project("endpoint-missing");
  arcade.omitEndpointUrl = "pre";
  const run = await setupArcade(dir);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain(`webhook_config.endpoints.pre.url: Arcade has nothing, this app needs "${ORIGIN}/hooks/pre"`);
  expect(projects.get(dir)!.deploys()).toEqual([]);
}, 60_000);
