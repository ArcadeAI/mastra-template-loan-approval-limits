/**
 * Spike 04 shared plumbing: a browserless user agent.
 *
 * `apps/idp`'s login and consent pages are plain server-rendered HTML forms, so a
 * cookie jar, a regex form parser and manual redirect handling are enough to walk
 * an OAuth authorization-code flow the way a browser would. Both spike scripts
 * use this; nothing here is specific to Arcade.
 */

export interface Hop {
  /** `302 https://host/path`, query stripped, so a transcript stays readable. */
  line: string;
  detail?: string;
}

/**
 * Every parameter and JSON field whose value is scrubbed before it reaches a
 * transcript.
 *
 * `code_challenge` and `state` are on this list even though neither is a secret
 * in the OAuth sense: the challenge is a public hash and the state is a dead
 * CSRF nonce the moment the flow ends. They are here because a transcript that
 * is *mostly* redacted is the harder thing to review. A reader should be able to
 * say "no flow value survives" and check it with one grep, rather than deciding
 * per field which leftovers are harmless. `redactionPattern()` is what that grep
 * is made of, and `04-redaction.test.ts` asserts the committed transcript
 * matches none of it.
 *
 * Longer names come first so the alternation prefers `code_challenge` over
 * `code`.
 */
export const REDACTED_PARAMS = [
  "code_challenge",
  "code_verifier",
  "client_secret",
  "refresh_token",
  "access_token",
  "id_token",
  "password",
  "nonce",
  "state",
  "code",
] as const;

/** Minimum value length worth hiding, so `state=p` in prose survives as prose. */
const MIN_SECRET_LENGTH = 8;

/**
 * A pattern matching any unredacted value of a {@link REDACTED_PARAMS} field,
 * in either query-parameter or JSON-field form.
 *
 * Exported so a test can grep the committed transcript with the same rule the
 * scripts redact by, instead of a second rule that can drift from it.
 */
export function redactionPattern(): RegExp {
  const names = REDACTED_PARAMS.join("|");
  // `(?!<redacted>)` so the pattern does not flag its own output: a scrubbed
  // `code_challenge=<redacted>` is the goal, not a finding.
  return new RegExp(
    `(?:"(?:${names})"\\s*:\\s*"(?!<redacted>)[^"]{${MIN_SECRET_LENGTH},}")` +
      `|(?:\\b(?:${names})=(?!<redacted>)[^&\\s"'\`]{${MIN_SECRET_LENGTH},})`,
    "g",
  );
}

/** Anything that looks like a secret, gone before it reaches a transcript. */
export function redact(text: string): string {
  const names = REDACTED_PARAMS.join("|");
  return text
    .replace(
      new RegExp(`("(?:${names})"\\s*:\\s*")([^"]{${MIN_SECRET_LENGTH},})"`, "g"),
      '$1<redacted>"',
    )
    .replace(
      new RegExp(`\\b(${names})=([^&\\s"'\`]{${MIN_SECRET_LENGTH},})`, "g"),
      "$1=<redacted>",
    );
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

/** A browser's cookie jar, flattened: one host at a time is all this needs. */
export class Jar {
  private cookies = new Map<string, string>();

  store(res: Response) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get size() {
    return this.cookies.size;
  }

  /** One request, no automatic redirect following, cookies in and out. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.size) headers.set("cookie", this.header());
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    this.store(res);
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

export function redactQuery(url: string): string {
  const names = [...REDACTED_PARAMS, "login_challenge", "consent_challenge"].join("|");
  return url.replace(new RegExp(`\\b(${names})=[^&]+`, "g"), "$1=<redacted>");
}

export interface ParsedForm {
  action: string;
  fields: Record<string, string>;
}

/** The IdP's pages are server-rendered HTML with one form; a regex parse is enough. */
export function parseForm(html: string): ParsedForm | null {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(form[0])?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const match of form[1].matchAll(/<(?:input|button)\b[^>]*>/gi)) {
    const tag = match[0];
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!name) continue;
    fields[name] = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
  }
  return { action, fields };
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
 */
export async function driveAuthorize(
  authorizeUrl: string,
  redirectUri: string,
  persona: Persona,
  transcript: Transcript,
  options: { expectedPageHost?: string; jar?: Jar } = {},
): Promise<DriveResult> {
  const jar = options.jar ?? new Jar();
  let url = authorizeUrl;
  const visited: string[] = [];
  const pageHosts: string[] = [];
  let pagesShown = 0;

  for (let i = 0; i < 25; i += 1) {
    if (url.startsWith(redirectUri)) {
      transcript.hop("the chain lands back on the redirect URI", redactQuery(url));
      return { visited, pagesShown, pageHosts };
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
    const form = parseForm(html);
    if (!form) {
      transcript.hop(`${res.status} ${stripQuery(url)} — a page with no form, the chain stops here`, html.slice(0, 800));
      return { visited, pagesShown, pageHosts, stoppedAt: url };
    }

    pagesShown += 1;
    const host = new URL(url).host;
    pageHosts.push(host);
    // Refuse to type a persona's password into a host we did not expect. A page
    // from anywhere but the configured issuer means the gateway is not brokering
    // to the user source, and submitting the form would only walk into a third
    // party's login.
    if (options.expectedPageHost && host !== options.expectedPageHost) {
      transcript.hop(`page ${pagesShown}: ${host} rendered the login, not ${options.expectedPageHost} — stopping`, {
        action: new URL(form.action || url, url).toString(),
        fields: Object.keys(form.fields),
      });
      return { visited, pagesShown, pageHosts, stoppedAt: url };
    }
    const action = new URL(form.action || url, url).toString();
    const body = new URLSearchParams(form.fields);
    const identifier = "email" in form.fields ? "email" : "username" in form.fields ? "username" : undefined;
    if (identifier) {
      body.set(identifier, persona.email);
      body.set("password", persona.password);
      transcript.hop(`page ${pagesShown}: login at ${stripQuery(url)}`, { action, fields: Object.keys(form.fields) });
    } else {
      transcript.hop(`page ${pagesShown}: consent at ${stripQuery(url)}`, { action, fields: Object.keys(form.fields) });
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
      return { visited, pagesShown, pageHosts, stoppedAt: action };
    }
    url = new URL(location, action).toString();
  }
  throw new Error("the authorization chain did not terminate in 25 hops");
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
      return new Response("spike 04: authorization code captured.", { headers: { "content-type": "text/plain" } });
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
