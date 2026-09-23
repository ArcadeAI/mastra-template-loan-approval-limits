#!/usr/bin/env bun
/**
 * Spike 04, question 4 — can Mastra's MCPClient drive an Arcade gateway's OAuth
 * flow from a server process that has no browser?
 *
 * Measures three things against the live gateway, in order:
 *
 *   a. what `MCPClient` does on first contact with a 401 gateway
 *      (`getServerAuthState` -> `needs-auth`, no tools)
 *   b. whether `authenticate()` accepts a non-loopback (HTTPS) redirect URL —
 *      the shape a Next.js route handler would need — and the exact refusal
 *   c. with a loopback redirect URL, whether the flow can be completed with no
 *      browser: `authenticate()` hands the authorization URL to
 *      `onRedirectToAuthorization`, this script walks it with the same headless
 *      form driver the main spike script uses, and Mastra's own loopback server
 *      collects the code
 *
 * `@mastra/mcp` is not a dependency of this repo yet (that is #14's job), so
 * install it anywhere and point the script at it:
 *
 *   mkdir -p /tmp/mastra-probe && cd /tmp/mastra-probe
 *   echo '{"name":"p","private":true,"type":"module"}' > package.json && bun add @mastra/mcp
 *   MASTRA_MCP_MODULE=/tmp/mastra-probe/node_modules/@mastra/mcp \
 *   PERSONA_EMAIL=… PERSONA_PASSWORD=… \
 *     bun docs/spikes/evidence/04-mastra-authprovider.ts
 */
import { Transcript, driveAuthorize, required } from "./04-oauth-drive.ts";

const MCP_URL = process.env.ARCADE_MCP_URL ?? "https://api.arcade.dev/mcp/cg-demo-us";
const IDP_ISSUER = process.env.IDP_ISSUER ?? "https://cg-idp-or5b.onrender.com";
const MASTRA_MCP_MODULE = process.env.MASTRA_MCP_MODULE ?? "@mastra/mcp";
const persona = { email: required("PERSONA_EMAIL"), password: required("PERSONA_PASSWORD") };
const t = new Transcript();

const mastra: any = await import(MASTRA_MCP_MODULE).catch((error) => {
  console.error(`cannot import ${MASTRA_MCP_MODULE}: ${error.message}`);
  console.error("See the header of this file: install @mastra/mcp and set MASTRA_MCP_MODULE.");
  process.exit(2);
});
const { MCPClient, MCPOAuthClientProvider } = mastra;

const version = await Bun.file(
  `${MASTRA_MCP_MODULE.startsWith(".") || MASTRA_MCP_MODULE.startsWith("/") ? MASTRA_MCP_MODULE : `${import.meta.dir}/../../../node_modules/@mastra/mcp`}/package.json`,
)
  .json()
  .then((p: any) => p.version)
  .catch(() => "unknown");
t.hop("@mastra/mcp version", version);

function provider(redirectUrl: string, onRedirect: (url: URL) => void) {
  return new MCPOAuthClientProvider({
    redirectUrl,
    clientMetadata: {
      client_name: "cg-spike-65-mastra",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp offline_access",
    },
    onRedirectToAuthorization: onRedirect,
  });
}

// --- a. first contact -------------------------------------------------------

/** Bind port 0, read the port back, release it: never claim a port by guessing. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const { port } = probe;
  probe.stop(true);
  if (!port) throw new Error("Bun.serve bound no port");
  return port;
}

// Mastra binds this port itself, so hand it one that is really free rather than
// a literal 0. It passes the redirect URL straight through to the authorize
// request.
const loopbackRedirect = `http://localhost:${freePort()}/oauth/callback`;
let authorizationUrl: URL | undefined;
const auth = provider(loopbackRedirect, (url) => {
  authorizationUrl = url;
});

const client = new MCPClient({
  id: `cg-spike-65-${Date.now()}`,
  servers: { arcade: { url: new URL(MCP_URL), authProvider: auth } },
});

const beforeTools = await client
  .listTools()
  .then((tools: Record<string, unknown>) => Object.keys(tools))
  .catch((error: Error) => `threw: ${error.message}`);
t.hop("listTools() before any authorization", {
  result: beforeTools,
  serverAuthState: client.getServerAuthState("arcade"),
});

// --- b. an HTTPS redirect URL, the shape a hosted route handler needs --------

const hosted = new MCPClient({
  id: `cg-spike-65-mastra-hosted-${Date.now()}`,
  servers: {
    arcade: {
      url: new URL(MCP_URL),
      authProvider: provider("https://cg-web-sa31.onrender.com/api/oauth/callback", () => {}),
    },
  },
});
await hosted.listTools().catch(() => {});
const hostedResult = await hosted
  .authenticate("arcade", { timeoutMs: 5_000 })
  .then(() => "resolved — authenticate() accepted a non-loopback redirect URL")
  .catch((error: Error) => `threw: ${error.message}`);
t.hop("authenticate() with an https:// redirect URL", hostedResult);
await hosted.disconnect().catch(() => {});

// --- c. the loopback flow, completed with no browser ------------------------

const settled = client
  .authenticate("arcade", { timeoutMs: 120_000 })
  .then(() => "resolved")
  .catch((error: Error) => `threw: ${error.message}`);

// authenticate() delivers the URL through onRedirectToAuthorization; wait for it.
const deadline = Date.now() + 60_000;
while (!authorizationUrl && Date.now() < deadline) await Bun.sleep(100);
if (!authorizationUrl) {
  t.hop("onRedirectToAuthorization never fired within 60s", await settled);
  await client.disconnect().catch(() => {});
  process.exit(1);
}

const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri")!;
t.hop("authenticate() emitted an authorization URL", {
  authorizationUrl: authorizationUrl.toString(),
  redirect_uri: redirectUri,
  note: "Mastra bound this loopback port itself and is waiting for a browser to hit it",
});

const drive = await driveAuthorize(authorizationUrl.toString(), redirectUri, persona, t, {
  expectedPageHost: new URL(IDP_ISSUER).host,
});
t.hop("hosts that rendered a page", {
  pageHosts: drive.pageHosts,
  pagesShown: drive.pagesShown,
  expected: new URL(IDP_ISSUER).host,
  stoppedAt: drive.stoppedAt,
});

const outcome = await Promise.race([
  settled,
  new Promise<string>((resolve) => setTimeout(() => resolve("still pending after 20s"), 20_000)),
]);
t.hop("authenticate() outcome", outcome);

if (outcome === "resolved") {
  const tools = await client.listTools().then((x: Record<string, unknown>) => Object.keys(x));
  t.hop("listTools() after authorization", tools);
}
await client.disconnect().catch(() => {});
