/**
 * The agent in Mastra Studio: the same definition the chat route runs, given
 * its model and its tools the moment Studio asks for them.
 *
 * `src/mastra/index.ts` registers what `studioAgent()` returns. It is
 * `buildAgent` from `agent.ts` — the chat route's own constructor — with the
 * same `INSTRUCTIONS`, the same `AGENT_ID`, and a toolset built by the same
 * three steps the chat route takes: list the gateway through `MCPClient`, keep
 * the project's toolkits (`selectGoverned`), and close the turn when the
 * escalation returns (`closeTurnOnEscalation`). `app-test/studio-entry.test.ts`
 * drives one turn through each entry and fails if the model is handed anything
 * different.
 *
 * ## Where Studio's gateway token comes from (open risk 5)
 *
 * The web UI gets its bearer from a browser sign-in and keeps it in a sealed
 * cookie. Studio has no such cookie: it is a separate Node process on its own
 * origin (`localhost:<STUDIO_PORT>`), and a cookie set by the app's host is
 * not sent to it. Arcade Headers mode would sidestep that with a project key and
 * a user id per request, and it is ruled out (`DESIGN.md` → Two hops).
 *
 * So Studio runs **hop 1 itself, as a loopback MCP client** — the way a local
 * MCP client such as an IDE authorizes against a gateway:
 *
 *   GET  <studio>/arcade/authorize     discovery, dynamic registration for
 *                                      <studio>/arcade/callback, PKCE, and a
 *                                      303 to the gateway's authorize endpoint
 *   ...                                Arcade sends the browser to the gateway's
 *                                      user source (the app's sign-in), then to
 *                                      its consent screen
 *   GET  <studio>/arcade/callback      the code, exchanged for access + refresh
 *
 * Every step is `lib/identity/gateway.ts`, the module the web UI's hop 1 is
 * built from. Only the redirect URI differs, and it differs because the
 * callback has to land on the process that will hold the token. The grant is
 * whoever signed in, and nothing here names a persona: Studio acts as Alice
 * because Alice is who signed in at the app when the gateway asked.
 *
 * **One grant per Studio process**, held in memory and gone on restart. That is
 * the browser rule restated for a process that serves one developer: one
 * persona per browser there, one per Studio here, no fourth database. Signing
 * in again replaces the grant. The redirect must be loopback, so this is a
 * local development surface and nothing else; the routes refuse any other
 * origin rather than hold a bearer for whoever reached them.
 *
 * What this rests on that only a real Arcade account can confirm is listed on
 * #7, and the first line of it is that Arcade's gateway authorization server
 * accepts a dynamically registered `http://localhost` redirect URI.
 */
import type { MCPClient } from "@mastra/mcp";

import { readIdentitySurface, type IdentitySurface } from "../config.ts";
import {
  accessTokenOf,
  exchangeGatewayCode,
  expiryOf,
  gatewayAuthorizeUrl,
  gatewayClient as registerGatewayClient,
  mcpUrl,
  probeGatewayToken,
} from "../identity/gateway.ts";
import { nonce, pkce } from "../identity/oidc.ts";
import { escapeHtml, page, redirect, verbatim } from "../identity/pages.ts";
import type { GatewayToken } from "../identity/session.ts";
import { anthropicModel, buildAgent } from "./agent.ts";
import { authorizationRequired } from "./authorization.ts";
import { closeTurnOnEscalation } from "./escalation.ts";
import { gatewayToken, type GatewayHolder } from "./gateway-token.ts";
import { readNativeUrlElicitations } from "./native-elicitation.ts";
import { gatewayClient, governedToolset } from "./tools.ts";

/** Registered on Studio's own server by `src/mastra/index.ts`. Mastra reserves `/api`. */
export const STUDIO_AUTHORIZE_PATH = "/arcade/authorize";
export const STUDIO_CALLBACK_PATH = "/arcade/callback";

/**
 * Mastra's own default port for `mastra dev`, and this template's only when
 * nothing says otherwise.
 *
 * Deliberate: a developer who follows Mastra's Quickstart expects Studio at
 * `localhost:4111`, so an unconfigured checkout gets it. It is never a port
 * two things on one machine should share, which is why every Orca worktree
 * gets `STUDIO_PORT` from its own block (`scripts/orca-setup.sh`) and why every
 * test that boots Studio binds a port it was handed.
 */
export const MASTRA_DEFAULT_PORT = 4111;

/**
 * The port Studio's server binds: `STUDIO_PORT`, else {@link MASTRA_DEFAULT_PORT}.
 *
 * Stated rather than left to Mastra, because Mastra's fallback is `PORT` and
 * `mastra dev` loads the root `.env.local`, where `PORT` is the app's. Left to
 * itself, Studio binds the port the Next app is already on.
 */
export function studioPort(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.STUDIO_PORT?.trim());
  return Number.isInteger(configured) && configured > 0 ? configured : MASTRA_DEFAULT_PORT;
}

/** How long an authorization started here stays redeemable. */
const LEG_TTL_MS = 10 * 60_000;
/** Milliseconds for a single MCP request, as the chat route allows. */
const MCP_TIMEOUT_MS = 30_000;

/**
 * Studio's grant, and the authorizations in flight.
 *
 * Module state on purpose: this module is loaded once per Studio process, and
 * the grant belongs to that process. Nothing in the chat route imports it.
 */
const studio: {
  holder: GatewayHolder;
  legs: Map<string, { verifier: string; clientId: string; redirectUri: string; expiresAt: number }>;
  connection: { token: string; client: MCPClient } | null;
  /** Every authorization link the gateway sent as a native URL elicitation, in arrival order. */
  elicited: string[];
} = { holder: {}, legs: new Map(), connection: null, elicited: [] };

/** What Studio needs from the environment, and only that: no sign-in, no cookie secret. */
export function studioProblems(config: IdentitySurface): string[] {
  return [
    ...(config.identity.gatewayId ? [] : ["ARCADE_GATEWAY_ID is not set"]),
    ...(config.arcadeApiUrl ? [] : ["ARCADE_API_URL is not set"]),
    ...(config.agent.anthropicApiKey ? [] : ["ANTHROPIC_API_KEY is not set"]),
    ...(config.agent.toolkits.length > 0 ? [] : ["ARCADE_LOAN_TOOLKIT is not set"]),
  ];
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/**
 * `GET /arcade/authorize` on Studio's server: start hop 1 for this process.
 *
 * The redirect URI is this request's own origin, so it is whatever address the
 * developer's browser reached Studio at — `localhost` and `127.0.0.1` register
 * separately, as they must, since the browser will be sent back to exactly one.
 */
export async function studioAuthorize(
  request: Request,
  config: IdentitySurface = readIdentitySurface(),
): Promise<Response> {
  const url = new URL(request.url);
  if (!isLoopback(url)) return notLoopback(url);
  const problems = studioProblems(config).filter((problem) => !problem.startsWith("ANTHROPIC"));
  if (problems.length > 0) return notConfigured(problems);

  const resource = mcpUrl(config.arcadeApiUrl, config.identity.gatewayId);
  const redirectUri = `${url.origin}${STUDIO_CALLBACK_PATH}`;
  let client: Awaited<ReturnType<typeof registerGatewayClient>>;
  try {
    client = await registerGatewayClient(resource, redirectUri);
  } catch (failure) {
    return page("The gateway would not register Studio as a client", verbatim(String(failure)), 502);
  }

  const now = Date.now();
  for (const [state, leg] of studio.legs) if (leg.expiresAt <= now) studio.legs.delete(state);
  const { verifier, challenge } = await pkce();
  const state = nonce();
  studio.legs.set(state, { verifier, clientId: client.clientId, redirectUri, expiresAt: now + LEG_TTL_MS });

  return redirect(gatewayAuthorizeUrl({ client, redirectUri, resource, state, challenge }));
}

/** `GET /arcade/callback` on Studio's server: redeem the code, and hold the grant. */
export async function studioCallback(
  request: Request,
  config: IdentitySurface = readIdentitySurface(),
): Promise<Response> {
  const url = new URL(request.url);
  if (!isLoopback(url)) return notLoopback(url);

  // One use, whatever happens next: a leg read here is a leg nobody can replay.
  const state = url.searchParams.get("state") ?? "";
  const leg = studio.legs.get(state);
  studio.legs.delete(state);

  const error = url.searchParams.get("error");
  if (error) {
    return page(
      "Arcade refused the authorization",
      verbatim(`${error}: ${url.searchParams.get("error_description") ?? ""}`),
      400,
    );
  }
  if (!leg || leg.expiresAt <= Date.now()) {
    return page(
      "This authorization did not start here",
      `<p>This Studio process has no authorization in progress under that <code>state</code>. ` +
        `Start again at <a href="${STUDIO_AUTHORIZE_PATH}">${STUDIO_AUTHORIZE_PATH}</a>.</p>`,
      400,
    );
  }
  const code = url.searchParams.get("code");
  if (!code) return page("No authorization code", "<p>The callback carried no <code>code</code>.</p>", 400);

  const resource = mcpUrl(config.arcadeApiUrl, config.identity.gatewayId);
  const client = await registerGatewayClient(resource, leg.redirectUri, leg.clientId);
  const exchanged = await exchangeGatewayCode({
    client,
    redirectUri: leg.redirectUri,
    resource,
    code,
    codeVerifier: leg.verifier,
  });
  if (!exchanged.ok) {
    return page("The gateway refused the code", verbatim(`${exchanged.status} ${exchanged.body}`), 502);
  }
  const access = accessTokenOf(exchanged.token);
  if (access === null) {
    return page(
      "The gateway issued no access token",
      `<p>The token endpoint answered <code>${exchanged.status}</code> with no usable ` +
        `<code>access_token</code>. Nothing was stored.</p>`,
      502,
    );
  }

  holdGatewayGrant({
    access_token: access,
    ...(exchanged.token.refresh_token ? { refresh_token: exchanged.token.refresh_token } : {}),
    expires_at: expiryOf(exchanged.token),
    client_id: leg.clientId,
  });
  console.info(`[studio] holding a gateway grant for ${config.identity.gatewayId} (${exchanged.status})`);
  return page(
    "Studio is authorized",
    "<p>This Studio process now holds a gateway token for whoever signed in. Every tool call the " +
      "agent makes in Studio is made as that person, and a restart forgets it.</p>" +
      `<p><a href="/">Back to Studio</a></p>`,
  );
}

/**
 * Keep a freshly issued grant as this process's holder.
 *
 * What the callback does with a token, and nothing more. Exported so a suite
 * can hand Studio a bearer its gateway stand-in minted, where the stand-in has
 * no authorization server to drive; the token still goes through `gatewayToken`
 * on the way out like every other.
 */
export function holdGatewayGrant(gateway: GatewayToken): void {
  studio.holder = { gateway };
}

/** Forget the grant and close the connection. For tests, and for nothing else. */
export async function forgetStudioGrant(): Promise<void> {
  studio.holder = {};
  studio.legs.clear();
  studio.elicited = [];
  await studio.connection?.client.disconnect().catch(() => undefined);
  studio.connection = null;
}

/**
 * The governed toolset, resolved when Studio asks for the agent's tools.
 *
 * Throws rather than returning an empty set: an agent with no tools still
 * answers, fluently, about a loan book it never read (`handlers.ts` spells out
 * the four ways that happens). Studio shows the message.
 */
export async function studioTools(
  config: IdentitySurface = readIdentitySurface(),
  origin = `http://localhost:${studioPort()}`,
): Promise<Record<string, unknown>> {
  const problems = studioProblems(config);
  if (problems.length > 0) {
    throw new Error(`The agent is not configured for Studio: ${problems.join("; ")}.`);
  }
  const authorize = `open ${origin}${STUDIO_AUTHORIZE_PATH} and sign in`;
  const gatewayUrl = mcpUrl(config.arcadeApiUrl, config.identity.gatewayId);

  let live = await gatewayToken(studio.holder, config);
  if (live.token === null) {
    // The seam's reasons are worded for a browser. The two that are about
    // having nothing at all get Studio's own sentence; a failed refresh keeps
    // the seam's, which says what the authorization server answered.
    const why = studio.holder.gateway
      ? live.reason
      : studio.holder.gateway_rejected_at
        ? "the gateway refused the token this Studio process held, so it was dropped"
        : "nobody has authorized this Studio process yet";
    throw new Error(`Studio has no gateway token: ${why}. To authorize, ${authorize}.`);
  }
  studio.holder = live.holder;

  // The same one round trip the chat route makes, for the same reason:
  // `listToolsets()` does not say whether the gateway took the bearer (#94).
  // One refresh on a refusal, and no loop after it (#113).
  if ((await probeGatewayToken(gatewayUrl, live.token)).outcome === "rejected") {
    live = await gatewayToken(studio.holder, config, { refresh: true });
    const retried = live.token === null ? null : await probeGatewayToken(gatewayUrl, live.token);
    if (live.token === null || retried?.outcome === "rejected") {
      studio.holder = { gateway_rejected_at: Date.now() };
      const why = live.token === null ? live.reason : `it refused the refreshed one too`;
      throw new Error(`The gateway refused Studio's gateway token, and ${why}. To authorize again, ${authorize}.`);
    }
    studio.holder = live.holder;
  }

  const client = await connection(config, live.token);
  const selected = await governedToolset(client, { toolkits: config.agent.toolkits });
  if (selected.error !== undefined) {
    throw new Error(`The gateway could not be listed: ${selected.error}`);
  }
  if (Object.keys(selected.tools).length === 0) {
    throw new Error(
      `The gateway advertised no tools from ${config.agent.toolkits.join(", ")}` +
        (selected.advertised.length === 0 ? "." : ` (it advertised ${selected.advertised.join(", ")}).`),
    );
  }

  return readableErrors(
    closeTurnOnEscalation(readableAuthorization(selected.tools, webUi(config)), {
      escalationTool: `${config.agent.approvalsToolkit}_RequestApproval`,
      onRefused: (tool) =>
        console.warn(`[studio] ${tool} was asked for after this turn ended on an approval request; nothing reached the gateway`),
    }).tools,
  );
}

/**
 * Layer 2 in Studio: a tool call that needs the person to authorize a toolkit
 * first comes back as **readable text carrying the authorization link** (#30).
 *
 * The chat route draws that challenge as an authorization card (`run.ts`).
 * Studio has no card, and on the third live run (#7) it drew the Loan
 * toolkit's hop-2 challenge as a tool error whose result read `[object
 * Object]`. Two things made that, and neither is ours to change: Arcade's
 * gateway answered with an error ("authorization challenge requires URL
 * elicitation"), and Mastra wraps every tool error in a `TOOL_EXECUTION_FAILED`
 * whose JSON has no top-level `message`, which Studio's page prints with
 * `String(error)`. So a challenge is turned into a result here, inside
 * `execute`, before Mastra wraps anything.
 *
 * A challenge is recognised in any of the shapes the chat route reads: the
 * legacy `authorization_url` JSON, the MCP URL-elicitation error `-32042` with
 * or without `data.elicitations`, Arcade's own wording for it, and a native
 * `elicitation/create` that Studio's handler cancelled during this call. With
 * no link anywhere, the text says so and sends the person to the web UI, whose
 * card can carry one.
 *
 * Everything else passes through untouched: a hook denial still throws, so the
 * model still reads it as a failed call, which is what act 2 depends on.
 */
function readableAuthorization(tools: Record<string, unknown>, webUiOrigin: string): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute?: (...args: unknown[]) => unknown }).execute;
    if (typeof execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    const call = execute.bind(tool);
    wrapped[name] = {
      ...(tool as object),
      async execute(...args: unknown[]) {
        const mark = studio.elicited.length;
        const elicitedDuringCall = () => studio.elicited.slice(mark);
        let result: unknown;
        try {
          result = await call(...args);
        } catch (failure) {
          const challenge = challengeIn(failure, elicitedDuringCall());
          if (challenge === null) throw failure;
          return authorizationText(name, challenge.url, webUiOrigin);
        }
        // A cancelled native elicitation can settle the call with an empty
        // result, which would otherwise reach the model as `{}`.
        const challenge = challengeIn(result, isEmpty(result) ? elicitedDuringCall() : []);
        return challenge === null ? result : authorizationText(name, challenge.url, webUiOrigin);
      },
    };
  }
  return wrapped;
}

/**
 * The one `cause` code Studio's page reads a tool error's text from (#30).
 *
 * Mastra hands Studio a tool error as a plain `Error` whose `message` is not
 * enumerable, so it does not survive the JSON Studio's server streams, and the
 * page falls back to `String(error)`: `[object Object]`, for the act-2 denial
 * as for everything else. Its one other branch reads `cause.message` when
 * `cause.code` is this code, which Mastra uses for a sub-agent's failed tool
 * call. Mastra reads the code in one other place, to find a sub-agent thread
 * in `details`, and this error has no `details`. Studio 1.31's renderer,
 * quoted from the bundle by `app-test/studio-authorization.test.ts`.
 */
const STUDIO_READABLE_CAUSE = "AGENT_AGENT_TOOL_EXECUTION_FAILED";

/**
 * Every tool failure in Studio, rethrown so Studio draws its text. Still a
 * throw, so Mastra still reports a failed call and the model reads the same
 * text it always did: a hook denial stays a denial.
 */
function readableErrors(tools: Record<string, unknown>): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute?: (...args: unknown[]) => unknown }).execute;
    if (typeof execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    const call = execute.bind(tool);
    wrapped[name] = {
      ...(tool as object),
      async execute(...args: unknown[]) {
        try {
          return await call(...args);
        } catch (failure) {
          // The same text Mastra would have handed the model: the failure's own message.
          const text = messagesOf(failure)[0] ?? String(failure);
          throw Object.assign(new Error(text, { cause: failure }), { code: STUDIO_READABLE_CAUSE });
        }
      },
    };
  }
  return wrapped;
}

/** Arcade's own message for a URL-elicitation challenge, as the third live run showed it. */
const URL_ELICITATION = /\burl elicitation\b/i;

/** A layer-2 challenge in a tool's result or failure, with its link when one came, or `null`. */
function challengeIn(value: unknown, elicited: readonly string[]): { url?: string } | null {
  const native = readNativeUrlElicitations(value)[0]?.url;
  if (native !== undefined) return { url: native };
  const messages = messagesOf(value);
  const legacy = [value, ...messages].map((candidate) => authorizationRequired(candidate)).find((found) => found !== null);
  if (legacy?.url !== undefined) return { url: legacy.url };
  if (elicited.length > 0) return { url: elicited.at(-1)! };
  if (legacy !== undefined && legacy !== null) return {};
  return messages.some((message) => URL_ELICITATION.test(message)) ? {} : null;
}

/** The text of an error and of its causes, which `Object.values` does not reach: `message` is not enumerable. */
function messagesOf(value: unknown): string[] {
  const found: string[] = [];
  let current: unknown = value;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") found.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return found;
}

function isEmpty(result: unknown): boolean {
  if (result === undefined || result === null) return true;
  if (typeof result !== "object") return false;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) return content.length === 0;
  return Object.keys(result).length === 0;
}

/**
 * What Studio shows, and what the model reads, in place of the challenge.
 * Addressed to the person: it says what happened and where to go, and nothing
 * about what the model should do (`DESIGN.md` → No model-side controls).
 */
function authorizationText(tool: string, url: string | undefined, webUiOrigin: string): string {
  const toolkit = tool.includes("_") ? tool.slice(0, tool.indexOf("_")) : tool;
  if (url !== undefined) {
    return (
      `${tool} did not run: Arcade needs you to authorize the ${toolkit} toolkit first. ` +
      `Open this link, sign in as the person you authorized Studio as, and allow it: ${url} ` +
      "Then send your message again."
    );
  }
  return (
    `${tool} did not run: Arcade needs you to authorize the ${toolkit} toolkit first, and sent Studio no link to show. ` +
    `Authorize it in the web UI: open ${webUiOrigin}, sign in as the same person, ask for a loan, and authorize when the chat asks. ` +
    "Then send your message here again."
  );
}

/** The web UI, where the chat can carry an authorization card: the app's public origin. */
function webUi(config: IdentitySurface): string {
  return config.identity.publicUrl || "the web UI";
}

/**
 * One MCP connection per bearer, replaced when the bearer changes.
 *
 * The chat route builds a client per request because each request may be a
 * different persona. Studio has one grant, and Studio asks for the tools more
 * than once per turn (listing the agent, then running it), so a connection per
 * resolution would close the one a running turn is using.
 */
async function connection(config: IdentitySurface, token: string): Promise<MCPClient> {
  if (studio.connection?.token === token) return studio.connection.client;
  await studio.connection?.client.disconnect().catch(() => undefined);
  const client = gatewayClient({
    arcadeApiUrl: config.arcadeApiUrl,
    gatewayId: config.identity.gatewayId,
    token,
    timeoutMs: MCP_TIMEOUT_MS,
    // A native URL elicitation has no chat card to land on here. It is written
    // where the developer running Studio will see it, kept for the tool call it
    // interrupted to show as its result (`readableAuthorization`), and
    // cancelled — nothing is accepted on anyone's behalf.
    inputRequests: async (params) => {
      const links = readNativeUrlElicitations(params).map((request) => request.url);
      studio.elicited.push(...links);
      console.warn(`[studio] the gateway asked for an authorization${links.length > 0 ? `: ${links.join(", ")}` : ""}`);
      return { action: "cancel" };
    },
  });
  studio.connection = { token, client };
  return client;
}

/**
 * The agent Studio registers.
 *
 * Model and tools are resolved per request rather than at import, so
 * `mastra dev` boots on an unconfigured checkout and says what is missing when
 * someone asks the agent something, rather than refusing to start.
 */
export function studioAgent(
  options: { port?: number; config?: () => IdentitySurface } = {},
) {
  const config = options.config ?? (() => readIdentitySurface());
  const origin = `http://localhost:${options.port ?? studioPort()}`;
  return buildAgent({
    model: () => {
      const surface = config();
      if (!surface.agent.anthropicApiKey) throw new Error("The agent is not configured for Studio: ANTHROPIC_API_KEY is not set.");
      return anthropicModel({ modelId: surface.agent.modelId, apiKey: surface.agent.anthropicApiKey });
    },
    tools: () => studioTools(config(), origin),
  });
}

function notLoopback(url: URL): Response {
  return page(
    "Studio authorizes on loopback only",
    `<p>This Studio server was reached at <code>${escapeHtml(url.host)}</code>. Studio holds one gateway ` +
      "grant for the whole process, so it only runs hop 1 for a browser on the same machine. Open it " +
      "at <code>localhost</code>.</p>",
    403,
  );
}

function notConfigured(problems: string[]): Response {
  return page(
    "Studio's gateway hop is not configured",
    `<ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>`,
    503,
  );
}
