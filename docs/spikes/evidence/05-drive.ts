/**
 * Spike 05 shared plumbing: a browserless user agent, and the bits of OAuth
 * both 05 scripts need.
 *
 * This is spike 04's `04-oauth-drive.ts` carried forward with one bug fixed and
 * one capability added. It is a separate file rather than an import because #65
 * and #75 are two unmerged branches and a spike script that only runs once its
 * sibling PR lands is a script nobody re-runs. Fold the two into one helper when
 * both are on `main`.
 *
 * **The fix.** `parseForm` read `value="…"` straight out of the HTML without
 * undoing entity escaping. Spike 04 never noticed: its chain stopped at
 * `account.arcade.dev` and never submitted a form to `apps/idp` at all. Every
 * `apps/idp` login page carries a hidden `oauth_query` field holding the signed
 * authorize query, ampersands and all, HTML-escaped as `&amp;`. Post it back
 * unescaped and Better Auth's before-hook rejects the signature and the page
 * says *"That email and password did not match."* — the password was right. Two
 * hours of this spike went into that sentence, so: `unescapeHtml` on every form
 * value and on the action.
 *
 * **The addition.** `driveAuthorize` now takes a set of hosts it is allowed to
 * type a password into, not a single expected host, because a flow that runs
 * through a custom verifier legitimately renders pages on two: the verifier's
 * own tunnel and the IdP behind it.
 */

/**
 * Every field whose value must never reach a committed transcript.
 *
 * One list, three consumers: `redact` for JSON bodies, `redactQuery` for URLs, and
 * `05-redaction.test.ts`, which greps every file under `docs/spikes` for exactly
 * these shapes and fails on a hit. That is deliberate — round 2 of this spike's
 * review found a real OAuth `state` in the committed transcript *and* a helper that
 * omitted `state` and `code_challenge`, which is the same bug twice: a redactor and
 * a reviewer working from different lists. There is now one list, and a test that
 * fails if the transcript disagrees with it.
 *
 * `state` and `code_challenge` are on it even though neither is a bearer credential.
 * A `state` is the CSRF token binding one authorization attempt to one browser, and
 * a `code_challenge` is the public half of a PKCE pair; publishing either teaches a
 * reader that OAuth values are safe to paste, which is the habit that eventually
 * pastes a `code_verifier`. The cost of redacting them is nil — no measurement in
 * this spike depends on the *value* of a `state`, only on whether two of them match.
 *
 * Ordered longest-first so `code_verifier` and `code_challenge` are matched before
 * `code`. The boundary assertions around each name are what keep
 * `code_challenge_method`, `client_secret_state` and `stateMatches` intact.
 */
export const SENSITIVE_FIELDS = [
  "access_token",
  "refresh_token",
  "id_token",
  "code_verifier",
  "code_challenge",
  "client_secret",
  "consent_challenge",
  "login_challenge",
  "flow_state",
  "api_key",
  "password",
  "state",
  "code",
  "sig",
] as const;

const FIELD_ALTERNATION = SENSITIVE_FIELDS.join("|");
/** `"state": "…"` and `"state":"…"`, in a JSON body. */
const JSON_FIELD = new RegExp(`("(?:${FIELD_ALTERNATION})"\\s*:\\s*")[^"]*"`, "g");
/**
 * `state=…`, in a query string or a form body.
 *
 * The value alternation takes an existing `<…>` placeholder first so that
 * re-redacting already-redacted text is a no-op. Without it, `state=<redacted>`
 * matched an empty value and grew a second `<redacted>` every pass.
 */
const QUERY_FIELD = new RegExp(
  `(?<![A-Za-z0-9_])(${FIELD_ALTERNATION})(?![A-Za-z0-9_])=(?:<[^>]*>|[^&\\s"'<>]*)`,
  "g",
);

/**
 * Anything that looks like a secret, gone before it reaches a transcript.
 *
 * Replaces the value outright rather than only values over some length: a short
 * value is not a safe value, and a threshold is one more thing to get wrong. It is
 * idempotent, so re-redacting already-redacted text is a no-op.
 */
export function redact(text: string): string {
  return text.replace(JSON_FIELD, '$1<redacted>"').replace(QUERY_FIELD, "$1=<redacted>");
}

export class Transcript {
  private step = 0;
  hop(title: string, detail?: unknown) {
    this.step += 1;
    console.log(`\n─── ${String(this.step).padStart(2, "0")} ${title}`);
    if (detail !== undefined) {
      console.log(redact(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)));
    }
  }
}

/**
 * A browser's cookie jar, scoped the way a browser scopes them.
 *
 * Spike 04's jar was one flat map for every host. That is wrong in a way that
 * matters here: this spike needs to be able to say whether the IdP session from
 * the verifier's login was **reused** by the tool's own OAuth (#75 question 3),
 * and a jar that hands every cookie to every host cannot tell the difference.
 *
 * It is also wrong in the other direction if you scope by host alone. Ory sets
 * `Domain=.arcade.dev`, so `auth.arcade.dev` and `account.arcade.dev` share a
 * session; a host-keyed jar sends nothing between them and Arcade's own login
 * spins in a redirect loop forever, creating a new flow id every hop. Measured.
 * So: honour the `Domain` attribute, exactly as a browser does.
 */
export class Jar {
  /** One entry per (domain, name). `domain` has no leading dot; `hostOnly` means exact match. */
  private cookies = new Map<string, { domain: string; hostOnly: boolean; name: string; value: string }>();

  store(requestHost: string, res: Response) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const domainAttr = attrs
        .map((a) => a.trim())
        .find((a) => a.toLowerCase().startsWith("domain="))
        ?.slice("domain=".length)
        .trim()
        .replace(/^\./, "")
        .toLowerCase();
      const domain = domainAttr || requestHost.split(":")[0].toLowerCase();
      this.cookies.set(`${domain}|${name}`, { domain, hostOnly: !domainAttr, name, value });
    }
  }

  /** A browser's domain match: exact, or a dot-suffix of a cookie that named a domain. */
  private matching(host: string) {
    const hostname = host.split(":")[0].toLowerCase();
    return [...this.cookies.values()].filter((c) =>
      c.hostOnly ? c.domain === hostname : hostname === c.domain || hostname.endsWith(`.${c.domain}`),
    );
  }

  header(host: string): string {
    return this.matching(host)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  /** Which domains this jar holds a cookie for — question 3 is "was the IdP session reused?". */
  hosts(): string[] {
    return [...new Set([...this.cookies.values()].map((c) => (c.hostOnly ? c.domain : `.${c.domain}`)))].sort();
  }

  /** One request, no automatic redirect following, cookies in and out. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).host;
    const headers = new Headers(init.headers);
    const cookie = this.header(host);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    this.store(host, res);
    return res;
  }
}

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function stripQuery(url: string): string {
  return url.split("?")[0];
}

/**
 * The same rule, for a URL that is being printed as a URL.
 *
 * Separate from `redact` only because a caller reaching for "redact this URL" should
 * not have to know that a URL is a string; both go through `SENSITIVE_FIELDS`.
 */
export function redactQuery(url: string): string {
  return redact(url);
}

/** Undo the escaping a server-rendered HTML attribute went through. See the header note. */
export function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface ParsedForm {
  action: string;
  fields: Record<string, string>;
  /** Every value offered for a name, in document order. A consent form offers two. */
  choices: Record<string, string[]>;
  /** True if any control is a password input — the thing the host guard actually cares about. */
  asksForCredentials: boolean;
}

/** An affirmative answer on a consent form, as opposed to the one next to it that is not. */
const AFFIRMATIVE = /^(allow|approve|accept|consent|authorize|authorise|grant|yes|true|confirm|continue)$/i;

/**
 * The pages in this chain are server-rendered HTML with one form; a regex parse is enough.
 *
 * `choices` exists because of Arcade's gateway consent screen, which submits **one**
 * form with two buttons — `name="action" value="deny"` first, `value="allow"` second.
 * A parser that keeps the last value it saw picks `allow` here by accident of
 * document order, and would pick `deny` on any page that lists them the other way
 * round. That is a coin flip deciding whether a measurement runs, so the choice is
 * made explicitly in `driveAuthorize` instead.
 */
export function parseForm(html: string): ParsedForm | null {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const action = unescapeHtml(/\baction\s*=\s*["']([^"']*)["']/i.exec(form[0])?.[1] ?? "");
  const fields: Record<string, string> = {};
  const choices: Record<string, string[]> = {};
  let asksForCredentials = false;
  for (const match of form[1].matchAll(/<(?:input|button|textarea)\b[^>]*>/gi)) {
    const tag = match[0];
    if (/\btype\s*=\s*["']password["']/i.test(tag)) asksForCredentials = true;
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!name) continue;
    const value = unescapeHtml(/\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "");
    fields[name] = value;
    (choices[name] ??= []).push(value);
  }
  return { action, fields, choices, asksForCredentials };
}

export interface DriveResult {
  /** Every hop, in order, as `status METHOD url`. */
  visited: string[];
  /** Pages a human would have had to look at — the round-trip count question 3 asks for. */
  pagesShown: number;
  /** Hosts that rendered a page, in order: which IdP actually authenticated the user. */
  pageHosts: string[];
  /** The URL the chain ended on, if it never reached the redirect URI. */
  stoppedAt?: string;
  /** Why it stopped, when it stopped early. */
  stoppedBecause?: string;
  /** The redirect URI the chain landed on, query and all — where the code is. */
  landedOn?: string;
}

export interface Persona {
  email: string;
  password: string;
}

/**
 * Walk an authorization chain to completion, filling in whatever forms appear.
 *
 * Stops the moment the chain reaches `redirectUri` — the caller's loopback server
 * has the code by then.
 *
 * `trustedPageHosts` is the guard spike 04 wrote and this one keeps: **it will
 * not type a persona's password into a host that is not on the list.** It stops,
 * names the host that served the page, and the caller reports it. A spike that
 * quietly submits credentials to whatever rendered a form measures nothing and
 * risks something.
 */
export async function driveAuthorize(
  authorizeUrl: string,
  redirectUri: string,
  persona: Persona,
  transcript: Transcript,
  options: { trustedPageHosts?: string[]; jar?: Jar; onPage?: (host: string, url: string, html: string) => void } = {},
): Promise<DriveResult> {
  const jar = options.jar ?? new Jar();
  let url = authorizeUrl;
  const visited: string[] = [];
  const pageHosts: string[] = [];
  let pagesShown = 0;

  for (let i = 0; i < 30; i += 1) {
    if (url.startsWith(redirectUri)) {
      transcript.hop("the chain lands back on the redirect URI", redactQuery(url));
      return { visited, pagesShown, pageHosts, landedOn: url };
    }

    const res = await jar.fetch(url, { headers: { accept: "text/html" } });
    visited.push(`${res.status} GET ${stripQuery(url)}`);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`${res.status} with no Location at ${stripQuery(url)}`);
      const next = new URL(location, url).toString();
      transcript.hop(`${res.status} ${stripQuery(url)} -> ${stripQuery(next)}`, redactQuery(next));
      url = next;
      continue;
    }

    const html = await res.text();
    const host = new URL(url).host;
    options.onPage?.(host, url, html);
    const form = parseForm(html);
    if (!form) {
      transcript.hop(`${res.status} ${stripQuery(url)} — a page with no form, the chain stops here`, html.slice(0, 800));
      return { visited, pagesShown, pageHosts, stoppedAt: url, stoppedBecause: "a page with no form" };
    }

    pagesShown += 1;
    pageHosts.push(host);

    // The guard is about **credentials**, not about hosts in general. Spike 04 wrote
    // it as "stop on any form from an untrusted host", and that was right while the
    // only forms in the chain were logins. It is wrong now: with the User Source
    // working, Arcade renders its own gateway consent screen on `cloud.arcade.dev`
    // — `flow_state` and an `action` button, no password field anywhere — and a
    // blanket host rule stops the measurement at the last step for no safety gain.
    // So: never put a password into a host that was not named, and let a form that
    // asks for no credential through, recording whose it was.
    const untrusted = options.trustedPageHosts && !options.trustedPageHosts.includes(host);
    if (untrusted && form.asksForCredentials) {
      transcript.hop(
        `page ${pagesShown}: ${host} asked for a password, and it is not one of ${options.trustedPageHosts!.join(", ")} — stopping`,
        { action: new URL(form.action || url, url).toString(), fields: Object.keys(form.fields) },
      );
      return {
        visited,
        pagesShown,
        pageHosts,
        stoppedAt: url,
        stoppedBecause: `${host} asked for a password and is not a host this spike will type one into`,
      };
    }

    const action = new URL(form.action || url, url).toString();
    const body = new URLSearchParams(form.fields);
    const identifier = "email" in form.fields ? "email" : "username" in form.fields ? "username" : undefined;
    if (identifier && form.asksForCredentials) {
      body.set(identifier, persona.email);
      body.set("password", persona.password);
      transcript.hop(`page ${pagesShown}: login at ${stripQuery(url)}`, { action, fields: Object.keys(form.fields) });
    } else {
      // A form with no credential field. Where a name offers more than one value —
      // Deny and Allow are two buttons on one form — say which one this is, rather
      // than inheriting whichever the markup happened to list last.
      const chosen: Record<string, string> = {};
      for (const [name, values] of Object.entries(form.choices)) {
        if (values.length < 2) continue;
        const yes = values.find((v) => AFFIRMATIVE.test(v));
        if (yes) {
          body.set(name, yes);
          chosen[name] = yes;
        }
      }

      // On a host we did not name, "no password field" is not enough to submit.
      // Arcade's own account login is a form with no password on it at all: one
      // field, `provider`, offering `github-…`, `google-…` and `microsoft-…`. This
      // walked it once and ended up on `login.microsoftonline.com`, which is a
      // third party's sign-in page and none of this spike's business. So an
      // untrusted host has to be offering an explicit yes/no decision — an
      // affirmative among a set of alternatives — and an identity-provider chooser
      // is not one.
      if (untrusted && Object.keys(chosen).length === 0) {
        transcript.hop(
          `page ${pagesShown}: ${host} offered a choice that is not a consent decision — stopping`,
          { action, fields: Object.keys(form.fields), offered: form.choices },
        );
        return {
          visited,
          pagesShown,
          pageHosts,
          stoppedAt: url,
          stoppedBecause: `${host} rendered a chooser, not a consent decision, and is not a host this spike will act on`,
        };
      }
      transcript.hop(`page ${pagesShown}: consent at ${stripQuery(url)}${untrusted ? ` (${host}, not our IdP — no credential asked for)` : ""}`, {
        action,
        fields: Object.keys(form.fields),
        offered: Object.fromEntries(Object.entries(form.choices).filter(([, v]) => v.length > 1)),
        chosen,
      });
    }

    const post = await jar.fetch(action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: body.toString(),
    });
    visited.push(`${post.status} POST ${stripQuery(action)}`);
    const location = post.headers.get("location");
    if (!location) {
      const text = await post.text();
      transcript.hop(`POST ${stripQuery(action)} answered ${post.status} with no Location`, text.slice(0, 800));
      return { visited, pagesShown, pageHosts, stoppedAt: action, stoppedBecause: `${post.status} with no Location` };
    }
    url = new URL(location, action).toString();
  }
  throw new Error("the authorization chain did not terminate in 30 hops");
}

/** A loopback listener for the authorization code. Binds port 0 and reads the port back. */
export function startCallbackServer() {
  let resolve!: (params: URLSearchParams) => void;
  const captured = new Promise<URLSearchParams>((r) => {
    resolve = r;
  });
  const server = Bun.serve({
    port: 0, // never claim a port another worktree owns
    fetch(req) {
      const url = new URL(req.url);
      resolve(url.searchParams);
      return new Response("spike 05: authorization code captured.", { headers: { "content-type": "text/plain" } });
    },
  });
  return { server, captured, redirectUri: `http://localhost:${server.port}/callback` };
}

/** Minimal MCP-over-streamable-HTTP client: enough for initialize, tools/list, tools/call. */
export class McpProbe {
  sessionId?: string;
  constructor(private url: string) {}

  async send(token: string | undefined, body: unknown) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const text = await res.text();
    // Streamable HTTP may answer with an SSE frame rather than bare JSON.
    const payload = /^(event|data|id|:):?/m.test(text)
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
      : text;
    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      /* not JSON; the caller prints the raw text */
    }
    return { status: res.status, text, json, wwwAuthenticate: res.headers.get("www-authenticate") };
  }
}

/**
 * Replay the hook server's log and return the frames produced since `startedAt`.
 *
 * `last-event-id: 0` replays from the beginning (#62), which is a lot of rows, so
 * this filters by timestamp and gives up once a `/pre` frame arrives.
 */
export async function framesSince(hooksUrl: string, startedAt: number, timeoutMs = 60_000): Promise<any[]> {
  const res = await fetch(`${hooksUrl}/events`, { headers: { "last-event-id": "0" } });
  if (!res.ok || !res.body) throw new Error(`GET ${hooksUrl}/events -> ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: any[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const frame = JSON.parse(line.slice(5).trim());
          if (Date.parse(frame.ts) >= startedAt) frames.push(frame);
        } catch {
          /* a comment or keep-alive */
        }
      }
      if (frames.some((f) => f.hook === "pre")) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required. Persona addresses live in Render env vars, never in git.`);
    process.exit(2);
  }
  return value;
}
