#!/usr/bin/env bun
/**
 * Spike 05 — a throwaway Arcade **custom user verifier** backed by `apps/idp`.
 *
 * There are two hops in this demo's identity chain and two different mechanisms,
 * and round 1 of this spike conflated them:
 *
 *   hop 1  MCP client → gateway           governed by the **User Source**
 *   hop 2  tool-level OAuth, `cg-idp`     governed by the **custom user verifier**
 *
 * This file is hop 2's mechanism. Arcade's default verifier makes every end user
 * sign in to an Arcade account that is a member of the project, which our personas
 * are not and should not be. A custom verifier replaces that: Arcade sends the
 * browser to a route we own, we decide who the person is, and we post that identity
 * back to Arcade server-side.
 *
 * Nothing here is deployed and nothing here belongs in `apps/`. It exists to
 * answer the questions #75 is now actually asking: on Dana's **first tool
 * authorization**, does Arcade redirect her browser here, does `confirm_user`
 * complete the flow, and is the persona on the `/pre` payload the email this
 * route confirmed?
 *
 *   Arcade  ──303──▶  GET /verify?flow_id=…
 *                       │  start an authorization-code + PKCE login at the IdP
 *                       ▼
 *                     IdP /oauth2/authorize ─▶ /login ─▶ /consent
 *                       │
 *                       ▼
 *                     GET /callback?code&state
 *                       │  exchange the code, read `email` off /oauth2/userinfo
 *                       ▼
 *                     POST cloud.arcade.dev/api/v1/oauth/confirm_user
 *                       │  {flow_id, user_id: <email, lowercase>}
 *                       ▼
 *                     303 to the `next_uri` Arcade answers with
 *
 * ## The IdP it authenticates against, and why it is the live one
 *
 * Round 1 pointed this at a local `apps/idp`, which proved the route's own contract
 * and nothing else. The measurement that matters needs the **live** IdP
 * `https://cg-idp-or5b.onrender.com`: hop 1 already signs Dana in there, so the
 * browser arriving at `/verify` is carrying that session, and whether hop 2 reuses
 * it or asks her to log in a second time is exactly the round-trip count #75 wants.
 * A local IdP is a different origin and would answer a different question.
 *
 * ## Running it
 *
 *   bun docs/spikes/evidence/05-verifier.ts
 *   bun docs/spikes/evidence/05-verifier.ts --no-ngrok    # local port only, no tunnel
 *
 * It binds port **0** and reads the port back — never a guessed port, because every
 * worktree owns a different block — then spawns `ngrok` and prints the public URL.
 *
 * ## Credentials it holds and never shows
 *
 * `IDP_CLIENT_ID` and `IDP_CLIENT_SECRET` are read from **`docs/spikes/evidence/.env.local`**,
 * which the human writes and `.gitignore` excludes at any depth. The implementer of
 * this spike never reads that file and this process never prints either value: the
 * startup banner says only whether they were found. The IdP registers exactly one
 * OAuth client, confidential, `client_secret_post`, and stores the secret hashed
 * since #70, so there is no unattended way to obtain one — see the write-up.
 *
 * ## The one manual step, and why
 *
 * `confirm_user` is authenticated with the Arcade **project API key**, which the
 * implementer does not hold and must not. So:
 *
 *   - with `ARCADE_API_KEY` set, the verifier calls `confirm_user` itself and the
 *     flow completes with no human in it. That is the production shape, and it is
 *     the code path a real deployment runs.
 *   - without it, the verifier prints the exact `curl` — real `flow_id`, real
 *     `user_id` — parks the browser on a waiting page, and resumes the moment
 *     someone posts the response back to `POST /confirm`. One human action per
 *     flow, and the human never has to read anything but the curl.
 *
 * Both paths run the same code after the response arrives, so the manual path is
 * not a different design; it is the same design with one call made by hand.
 */
import { b64url, pkce, redact } from "./05-drive.ts";

const ARCADE_CONFIRM_URL = process.env.ARCADE_CONFIRM_URL ?? "https://cloud.arcade.dev/api/v1/oauth/confirm_user";
const IDP_ISSUER = (process.env.IDP_ISSUER ?? "https://cg-idp-or5b.onrender.com").replace(/\/+$/, "");
const IDP_SCOPES = process.env.IDP_SCOPES ?? "openid email";
/** How long a browser parked on the waiting page will hold before giving up. */
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MS ?? 900_000);

const NO_NGROK = process.argv.includes("--no-ngrok");
const ENV_FILE = new URL("./.env.local", import.meta.url).pathname;

/** Parse `docs/spikes/evidence/.env.local`, if the human has written it yet. */
async function readEnvFile(): Promise<Record<string, string>> {
  const file = Bun.file(ENV_FILE);
  const values: Record<string, string> = {};
  if (!(await file.exists())) return values;
  for (const line of (await file.text()).split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

/**
 * Read the IdP client credentials out of `docs/spikes/evidence/.env.local`.
 *
 * **Read per flow, not once at startup.** The ordering this spike lives under is:
 * the tunnel has to be up before the human can paste its URL into the Arcade
 * dashboard, and the human writes `.env.local` in the same sitting. A process that
 * demanded credentials before it would bind would force a restart afterwards, and
 * a restart on ngrok's free tier means a new hostname and a dashboard field that
 * is now wrong. So the route comes up first and picks the file up whenever it
 * appears. A flow that arrives before the file does is refused loudly, which is
 * the right failure: it says exactly what is missing instead of half-completing.
 *
 * The human writes that file; nobody else opens it. Values are never echoed, not
 * even truncated — a client id is not a secret but printing one teaches the habit,
 * and this process has no reason to say more than where it found them.
 */
interface CredentialsFound {
  ok: true;
  clientId: string;
  clientSecret: string;
  source: string;
}
interface CredentialsMissing {
  ok: false;
  missing: string[];
}
type Credentials = CredentialsFound | CredentialsMissing;

async function readCredentials(): Promise<Credentials> {
  const fromFile = await readEnvFile();
  const seen: string[] = [];
  const pick = (name: string) => {
    if (fromFile[name]) seen.push("docs/spikes/evidence/.env.local");
    else if (process.env[name]) seen.push("the environment");
    return (fromFile[name] ?? process.env[name] ?? "").trim();
  };
  let clientId = pick("IDP_CLIENT_ID");
  const clientSecret = pick("IDP_CLIENT_SECRET");

  // The client id is not a secret — `apps/idp` publishes it on `/health` — so ask
  // the IdP rather than asking a human for something they can get wrong. One fewer
  // value to copy is one fewer value to mistype, and this spike lost a measurement
  // to exactly that: a placeholder reached `/oauth2/authorize` as a literal
  // `client_id=<the cg-idp client id>` and came back `client_id is required`.
  if (!clientId || isPlaceholder(clientId)) {
    const published = await fetch(`${IDP_ISSUER}/health`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: any) => body?.oauth?.client_id as string | undefined)
      .catch(() => undefined);
    if (published) {
      clientId = published;
      seen.push(`${IDP_ISSUER}/health`);
    }
  }

  const missing = [
    ...(clientId ? [] : ["IDP_CLIENT_ID"]),
    ...(clientSecret ? [] : ["IDP_CLIENT_SECRET"]),
  ];
  if (missing.length) return { ok: false, missing };

  // A placeholder is worse than an absence: it produces a flow that runs, fails
  // somewhere downstream, and looks like the counterparty's fault. Refuse it by
  // shape — the shape is all this process is willing to know about the value.
  const placeholders = [
    ...(isPlaceholder(clientId) ? ["IDP_CLIENT_ID"] : []),
    ...(isPlaceholder(clientSecret) ? ["IDP_CLIENT_SECRET"] : []),
  ];
  if (placeholders.length) return { ok: false, missing: placeholders.map((name) => `${name} (looks like a placeholder, not a value)`) };

  return { ok: true, clientId, clientSecret, source: [...new Set(seen)].join(" and ") };
}

/** Angle brackets, whitespace, ellipses: the shapes a "fill this in" marker takes. */
function isPlaceholder(value: string): boolean {
  return /[<>\s]/.test(value) || /^\.{3}|\.{3}$/.test(value) || /^(your|the|todo|changeme|placeholder)[-_ ]/i.test(value);
}

/** What to say, to a browser and to the log, when the file is not there yet. */
function credentialsMissing(missing: string[]): Response {
  note(`a flow arrived before the credentials did — missing ${missing.join(", ")}`);
  return page(
    "The verifier is not configured yet",
    `<p>${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set.</p>` +
      `<p>Whoever holds the <code>cg-idp</code> OAuth client writes ` +
      `<code>docs/spikes/evidence/.env.local</code> with <code>IDP_CLIENT_ID</code> and ` +
      `<code>IDP_CLIENT_SECRET</code>. No restart is needed — this route re-reads the file ` +
      `on every flow, so the tunnel URL already in the dashboard stays valid.</p>`,
    503,
  );
}

/**
 * The Arcade project API key, read from the same untracked file as the IdP
 * credentials and never printed.
 *
 * Read **per flow**, for a reason this spike measured rather than assumed. Without
 * a key, `confirm_user` has to be run by a human, and Arcade only accepts it while
 * the flow is still awaiting verification — a window narrower than a human's
 * turnaround. Measured: the same call succeeded once at ~8 minutes and returned a
 * bare `{"code":400,"msg":"Bad request"}` the next time, for a flow that was still
 * live enough for Arcade to keep handing back its id. A verifier that holds the key
 * closes that window to milliseconds, which is why the production shape is the only
 * shape that reliably works.
 */
async function arcadeApiKey(): Promise<string | undefined> {
  const fromFile = await readEnvFile();
  return (fromFile.ARCADE_API_KEY ?? process.env.ARCADE_API_KEY ?? "").trim() || undefined;
}

interface Flow {
  /** Everything Arcade put on the query string, so the transcript records the real contract. */
  arcadeQuery: Record<string, string>;
  flowId: string;
  verifier: string;
  startedAt: string;
  email?: string;
  confirm?: { auth_id?: string; next_uri?: string; [k: string]: unknown };
  /** True between printing the curl and `POST /confirm` arriving. */
  pending?: boolean;
  resolve?: (response: Record<string, unknown>) => void;
}

/** state → flow. `state` is this verifier's CSRF token for the IdP leg, and its flow key. */
const flows = new Map<string, Flow>();
/** Every request Arcade or the IdP made, in order, for the transcript. */
const log: { at: string; line: string; detail?: unknown }[] = [];

function note(line: string, detail?: unknown) {
  const at = new Date().toISOString();
  log.push({ at, line, detail });
  console.log(`[verifier] ${line}${detail === undefined ? "" : ` ${redact(JSON.stringify(detail))}`}`);
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:34rem"><h1>${title}</h1>${body}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

let publicUrl = "";
const redirectUri = () => `${publicUrl}/callback`;

/**
 * Arcade's entry point. The query string is recorded whole rather than picking
 * `flow_id` out of it: what Arcade actually sends a verifier is one of the things
 * this spike is measuring, and a script that reads only the field it expected
 * would not notice the rest.
 */
async function verify(url: URL): Promise<Response> {
  const arcadeQuery = Object.fromEntries(url.searchParams);
  const flowId = url.searchParams.get("flow_id") ?? "";
  note(`GET /verify — Arcade sent ${Object.keys(arcadeQuery).length} parameter(s)`, arcadeQuery);
  if (!flowId) {
    note("no flow_id on the query string — refusing to start a login for a flow that does not exist");
    return page("No flow_id", "<p>Arcade calls this route with <code>?flow_id=…</code>.</p>", 400);
  }

  const credentials = await readCredentials();
  if (!credentials.ok) return credentialsMissing(credentials.missing);

  const { verifier, challenge } = await pkce();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  flows.set(state, { arcadeQuery, flowId, verifier, startedAt: new Date().toISOString() });

  const authorize = `${IDP_ISSUER}/oauth2/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: credentials.clientId,
    redirect_uri: redirectUri(),
    scope: IDP_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  note(`303 to the IdP for flow ${flowId}`, { issuer: IDP_ISSUER, redirect_uri: redirectUri(), scope: IDP_SCOPES });
  return new Response(null, { status: 303, headers: { Location: authorize } });
}

/** The IdP's return leg: code → token → `email`, then Arcade's `confirm_user`. */
async function callback(url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const flow = flows.get(state);
  if (!flow) {
    note("GET /callback with a state this verifier did not issue — dropping it");
    return page("Unknown state", "<p>This login did not start here.</p>", 400);
  }
  const error = url.searchParams.get("error");
  if (error) {
    note("the IdP returned an error", { error, error_description: url.searchParams.get("error_description") });
    return page("The IdP refused", `<pre>${error}: ${url.searchParams.get("error_description") ?? ""}</pre>`, 400);
  }
  const code = url.searchParams.get("code");
  if (!code) return page("No code", "<p>No authorization code on the callback.</p>", 400);

  const credentials = await readCredentials();
  if (!credentials.ok) return credentialsMissing(credentials.missing);

  const { res: tokenRes, text: tokenText } = await exchangeCode(code, flow.verifier, credentials);
  if (!tokenRes.ok) return page("Token exchange failed", `<pre>${redact(tokenText)}</pre>`, 502);
  const token = JSON.parse(tokenText) as { access_token: string; id_token?: string };

  const userinfoRes = await fetch(`${IDP_ISSUER}/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const userinfo = (await userinfoRes.json()) as { email?: string; sub?: string };
  note(`IdP /oauth2/userinfo -> ${userinfoRes.status}`, { sub: userinfo.sub, email: userinfo.email });
  if (!userinfo.email) return page("No email", "<p>The IdP returned no <code>email</code> claim.</p>", 502);

  // DESIGN.md rule 3: the Arcade user_id, the OAuth subject and the loan book's
  // actor are one string. Lowercase here as well as at the IdP, because this is
  // the value Arcade ends up holding.
  const userId = userinfo.email.toLowerCase();
  flow.email = userId;

  const apiKey = await arcadeApiKey();
  if (!apiKey) {
    // Without a key the confirm is a human's to run, and a human takes minutes. An
    // earlier version parked the browser on this request until the answer came back;
    // measured, that does not work — the connection dies first (Bun caps idleTimeout
    // at 255s), the walker gives up, and the flow is left half-done with nobody
    // holding it. So: print the curl, answer the browser now, and let `POST /confirm`
    // finish the job server-side. The browser is not the thing that has to wait.
    printConfirmCurl(flow, userId);
    flow.pending = true;
    return page(
      "Waiting for confirm_user",
      `<p>Identity established: <code>${userId}</code>.</p>` +
        `<p>This verifier holds no Arcade API key, so <code>confirm_user</code> is run by hand. ` +
        `The exact command is on this process's stdout; <code>POST /confirm</code> finishes the flow.</p>`,
    );
  }

  const confirmed = await confirmUser(flow, userId, apiKey);
  if ("failed" in confirmed) return page("confirm_user failed", `<pre>${redact(confirmed.failed)}</pre>`, 502);

  flow.confirm = confirmed.response;
  const next = typeof confirmed.response.next_uri === "string" ? confirmed.response.next_uri : undefined;
  note("confirm_user answered", { auth_id: confirmed.response.auth_id, next_uri: next });
  if (!next) {
    return page("Verified", `<p>Confirmed <code>${userId}</code>. Arcade returned no <code>next_uri</code>.</p>`);
  }
  // A real browser would follow this 303 itself. Returning it is correct, and the
  // redirect is what a deployed verifier should emit — but a scripted user agent
  // that stops at the redirect leaves the grant unfinalised, so say where it goes.
  note("303 to Arcade's next_uri", next);
  return new Response(null, { status: 303, headers: { Location: next } });
}

/**
 * Trade the code for a token, authenticating the client the way this IdP wants.
 *
 * `apps/idp` enforces **one** client-authentication method per client and refuses
 * the other outright rather than accepting either. This project has now been bitten
 * by that in both directions within one afternoon: Arcade sent `client_secret_basic`
 * to a `client_secret_post` registration (#61), and after #61 flipped the client,
 * this verifier sent `client_secret_post` to a `client_secret_basic` registration
 * and got `client registered for client_secret_basic cannot use client_secret_post`.
 *
 * So it is not hardcoded. The method comes from what the IdP publishes on `/health`,
 * and if that is wrong or absent the other method is tried once — because the
 * failure mode otherwise is a relying party that looks correctly configured, fails
 * at a step no hook observes, and gets blamed on whoever owns the other end.
 */
async function exchangeCode(
  code: string,
  codeVerifier: string,
  credentials: { clientId: string; clientSecret: string },
): Promise<{ res: Response; text: string }> {
  const advertised = await fetch(`${IDP_ISSUER}/health`)
    .then((r) => (r.ok ? r.json() : null))
    .then((b: any) => b?.oauth?.token_endpoint_auth_method as string | undefined)
    .catch(() => undefined);
  const order = advertised === "client_secret_post" ? (["post", "basic"] as const) : (["basic", "post"] as const);

  let last!: { res: Response; text: string };
  for (const method of order) {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const form: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: credentials.clientId,
      code_verifier: codeVerifier,
    };
    if (method === "basic") {
      headers.authorization = `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`;
    } else {
      form.client_secret = credentials.clientSecret;
    }
    const res = await fetch(`${IDP_ISSUER}/oauth2/token`, {
      method: "POST",
      headers,
      body: new URLSearchParams(form).toString(),
    });
    const text = await res.text();
    note(`IdP token exchange, client_secret_${method} -> ${res.status}`, redact(text).slice(0, 400));
    last = { res, text };
    if (res.ok) return last;
    // Only a method mismatch is worth a second attempt. A wrong secret, a spent code
    // or an expired one must not be retried — that doubles the noise in the IdP's
    // log and tells the reader nothing.
    if (!/cannot use client_secret_(post|basic)/.test(text)) return last;
    note(`the IdP refuses client_secret_${method} for this client; trying the other`);
  }
  return last;
}

/**
 * The `confirm_user` call, for the case where this process holds the API key.
 *
 * That is the production shape and the code a real deployment runs. This spike does
 * not hold one, so it takes the other path — see `/callback` and `POST /confirm`.
 */
async function confirmUser(
  flow: Flow,
  userId: string,
  apiKey: string,
): Promise<{ response: Record<string, unknown> } | { failed: string }> {
  const res = await fetch(ARCADE_CONFIRM_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ flow_id: flow.flowId, user_id: userId }),
  });
  const text = await res.text();
  note(`POST confirm_user -> ${res.status}`, text.slice(0, 400));
  if (!res.ok) return { failed: `${res.status} ${text}` };
  return { response: JSON.parse(text) as Record<string, unknown> };
}

/** The exact command, with the real values, for whoever does hold the key. */
function printConfirmCurl(flow: Flow, userId: string) {
  const body = JSON.stringify({ flow_id: flow.flowId, user_id: userId });
  console.log(
    [
      "",
      "══════════════════════════════════════════════════════════════════════",
      "  ARCADE_API_KEY is not set. Run this, then paste the response back:",
      "",
      `  curl -sS -X POST ${ARCADE_CONFIRM_URL} \\`,
      '    -H "Authorization: Bearer $ARCADE_API_KEY" \\',
      '    -H "Content-Type: application/json" \\',
      `    -d '${body}'`,
      "",
      "  Then, from this machine:",
      "",
      `  curl -sS -X POST ${publicUrl || "http://localhost:<port>"}/confirm \\`,
      '    -H "Content-Type: application/json" \\',
      `    -d '{"flow_id":"${flow.flowId}","response":<the JSON body above>}'`,
      "══════════════════════════════════════════════════════════════════════",
      "",
    ].join("\n"),
  );
  note("waiting for POST /confirm", { flow_id: flow.flowId, user_id: userId });
}

/**
 * Where the human's `confirm_user` response comes back in. Local use only.
 *
 * It also **follows `next_uri` server-side**, because Arcade does not finalise the
 * grant until something lands there. Measured: a `confirm_user` that returned
 * `{auth_id, next_uri}` left the tool still unauthorized, because the browser had
 * already given up and nothing ever fetched that URL.
 */
async function confirm(req: Request): Promise<Response> {
  const payload = (await req.json().catch(() => null)) as { flow_id?: string; response?: any } | null;
  if (!payload?.flow_id || typeof payload.response !== "object" || payload.response === null) {
    return Response.json({ error: "expected {flow_id, response}" }, { status: 400 });
  }
  const flow = [...flows.values()].find((f) => f.flowId === payload.flow_id);
  if (!flow) return Response.json({ error: `no flow ${payload.flow_id} is known here` }, { status: 404 });

  flow.confirm = payload.response;
  flow.pending = false;
  flow.resolve?.(payload.response);
  flow.resolve = undefined;
  note("POST /confirm", { flow_id: payload.flow_id, auth_id: payload.response.auth_id });

  const next = typeof payload.response.next_uri === "string" ? payload.response.next_uri : undefined;
  if (!next) return Response.json({ confirmed: payload.flow_id, followed: null });
  const res = await fetch(next, { redirect: "manual" });
  const followed = { url: next, status: res.status, location: res.headers.get("location") };
  note("followed next_uri so Arcade finalises the grant", followed);
  return Response.json({ confirmed: payload.flow_id, followed });
}

const server = Bun.serve({
  // Port 0 by default — never claim a port another worktree owns. `PORT` exists for
  // exactly one case: restarting this process without losing the tunnel. `ngrok`
  // runs as its own OS process pointing at a local port, so killing only the Bun
  // server and rebinding the same port keeps the public URL alive — which matters
  // because that URL is pasted into a dashboard by a human, and on the free tier a
  // new tunnel means a new hostname and a field that is now silently wrong.
  port: Number(process.env.PORT ?? 0),
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/verify") return verify(url);
    if (url.pathname === "/callback") return callback(url);
    if (url.pathname === "/confirm" && req.method === "POST") return confirm(req);
    if (url.pathname === "/state") {
      const credentials = await readCredentials();
      return Response.json({
        public_url: publicUrl,
        issuer: IDP_ISSUER,
        idp_credentials: credentials.ok ? `present, from ${credentials.source}` : `MISSING: ${credentials.missing.join(", ")}`,
        arcade_api_key_present: Boolean(await arcadeApiKey()),
        flows: [...flows.values()].map((f) => ({
          flow_id: f.flowId,
          started_at: f.startedAt,
          arcade_query: f.arcadeQuery,
          email: f.email,
          confirm: f.confirm,
          waiting: Boolean(f.pending),
        })),
        log,
      });
    }
    if (url.pathname === "/health") {
      const credentials = await readCredentials();
      return Response.json({
        status: "ok",
        public_url: publicUrl,
        idp_credentials: credentials.ok ? "present" : `missing: ${credentials.missing.join(", ")}`,
      });
    }
    note(`${req.method} ${url.pathname} — no route`);
    return page("Not found", `<p>This verifier serves <code>/verify</code> and <code>/callback</code>.</p>`, 404);
  },
});

/**
 * Put the local port on the public internet.
 *
 * Arcade has to reach `/verify` and the IdP has to reach `/callback`, so a
 * loopback port is not enough — spike #2 used `ngrok` for the same reason. The
 * URL is read out of ngrok's own JSON log rather than guessed or scraped from
 * its inspector, which binds a fixed port this worktree does not own.
 */
async function startNgrok(port: number): Promise<string> {
  const proc = Bun.spawn(["ngrok", "http", String(port), "--log", "stdout", "--log-format", "json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 30_000;
  let buffer = "";
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      let entry: Record<string, string>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.lvl === "eror" || entry.err) console.error(`[ngrok] ${line}`);
      const url = entry.url ?? entry.addr;
      if (entry.msg === "started tunnel" && url?.startsWith("https://")) {
        // Drain the rest in the background so ngrok's pipe never fills and blocks it.
        void (async () => {
          try {
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
          } catch {
            /* the process went away */
          }
        })();
        return url;
      }
    }
  }
  throw new Error("ngrok did not report a tunnel within 30s");
}

publicUrl = process.env.VERIFIER_PUBLIC_URL?.replace(/\/+$/, "")
  ?? (NO_NGROK ? `http://localhost:${server.port}` : await startNgrok(server.port!));

const startupCredentials = await readCredentials();
const CREDENTIAL_BANNER = startupCredentials.ok
  ? `read from ${startupCredentials.source} (never printed)`
  : `NOT YET SET (${startupCredentials.missing.join(", ")}) — write docs/spikes/evidence/.env.local\n` +
    `                     when you have them; this route re-reads it per flow, no restart, URL unchanged`;

console.log(
  [
    "",
    `spike 05 verifier — local :${server.port}, public ${publicUrl}`,
    `  IdP issuer         ${IDP_ISSUER}`,
    `  IdP credentials    ${CREDENTIAL_BANNER}`,
    `  tunnel             ${NO_NGROK ? "off (--no-ngrok): this URL is not reachable from Arcade" : "ngrok"}`,
    `  confirm_user       ${(await arcadeApiKey()) ? "automatic — this process holds the key and calls it in-flow" : "manual — the curl is printed per flow (see the note in /callback)"}`,
    "",
    "  ═══ the two values the human enters, exactly as written ═══",
    "",
    `  1. Arcade dashboard → Auth → Settings → Custom verifier route:`,
    `       ${publicUrl}/verify`,
    "",
    `  2. cg-idp on Render → IDP_OAUTH_REDIRECT_URIS → append, keeping every existing entry:`,
    `       ${publicUrl}/callback`,
    "",
    `  Verify (2) landed without opening the dashboard:`,
    `       bun docs/spikes/evidence/05-redirect-allowlist.ts "${publicUrl}/callback"`,
    "",
    `  Everything this route has seen:  curl -s ${publicUrl}/state | jq`,
    "",
  ].join("\n"),
);
