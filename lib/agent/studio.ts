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
 * origin (`localhost:4111` by default), and a cookie set by the app's host is
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
import { closeTurnOnEscalation } from "./escalation.ts";
import { gatewayToken, type GatewayHolder } from "./gateway-token.ts";
import { gatewayClient, governedToolset } from "./tools.ts";

/** Registered on Studio's own server by `src/mastra/index.ts`. Mastra reserves `/api`. */
export const STUDIO_AUTHORIZE_PATH = "/arcade/authorize";
export const STUDIO_CALLBACK_PATH = "/arcade/callback";

/**
 * The port Studio's server binds: `STUDIO_PORT`, else Mastra's own default.
 *
 * Stated rather than left to Mastra, because Mastra's fallback is `PORT` and
 * `mastra dev` loads the root `.env.local`, where `PORT` is the app's. Left to
 * itself, Studio binds the port the Next app is already on.
 */
export function studioPort(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.STUDIO_PORT?.trim());
  return Number.isInteger(configured) && configured > 0 ? configured : 4111;
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
} = { holder: {}, legs: new Map(), connection: null };

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

  return closeTurnOnEscalation(selected.tools, {
    escalationTool: `${config.agent.approvalsToolkit}_RequestApproval`,
    onRefused: (tool) =>
      console.warn(`[studio] ${tool} was asked for after this turn ended on an approval request; nothing reached the gateway`),
  }).tools;
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
    // where the developer running Studio will see it, and cancelled — nothing
    // is accepted on anyone's behalf.
    inputRequests: async (params) => {
      const link = (params as { url?: unknown }).url;
      console.warn(`[studio] the gateway asked for an authorization${typeof link === "string" ? `: ${link}` : ""}`);
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
