#!/usr/bin/env bun
/**
 * Spike 04 — drive Arcade's MCP gateway login end to end with no browser, as one
 * persona, and print every hop.
 *
 *   MCP initialize (no token) -> 401 + WWW-Authenticate
 *     -> protected-resource metadata -> authorization server metadata
 *     -> dynamic client registration on a loopback port we actually hold
 *     -> /oauth2/authorize with PKCE
 *        -> whichever IdP Arcade brokers to: login page, consent page
 *        -> back through Arcade's intermediate callback
 *     -> code -> /oauth2/token -> access token
 *   -> MCP initialize -> tools/list -> tools/call
 *   -> read the frames back off the hook server's /events and print the /pre user_id
 *
 * The interesting measurement is which host renders the login page. With a User
 * Source attached that is the configured OIDC issuer; anything else means the
 * gateway is still authenticating against Arcade's own accounts.
 *
 * Usage:
 *   PERSONA_EMAIL=… PERSONA_PASSWORD=… bun docs/spikes/evidence/04-user-source-flow.ts
 *
 * Optional: ARCADE_MCP_URL, IDP_ISSUER, HOOKS_URL, SPIKE_TOOL, SPIKE_TOOL_ARGS.
 * No credential the repo owns appears here: the persona password is a demo
 * fixture and the OAuth client is registered fresh on every run.
 */
import {
  Transcript,
  driveAuthorize,
  framesSince,
  McpProbe,
  pkce,
  b64url,
  required,
  startCallbackServer,
} from "./04-oauth-drive.ts";

const MCP_URL = process.env.ARCADE_MCP_URL ?? "https://api.arcade.dev/mcp/cg-demo-us";
const IDP_ISSUER = process.env.IDP_ISSUER ?? "https://cg-idp-or5b.onrender.com";
const HOOKS_URL = process.env.HOOKS_URL ?? "https://cg-hooks.onrender.com";
const TOOL = process.env.SPIKE_TOOL ?? "Loan_GetLoan";
const TOOL_ARGS = JSON.parse(process.env.SPIKE_TOOL_ARGS ?? '{"loan_id":"LN-2291"}');

const persona = { email: required("PERSONA_EMAIL"), password: required("PERSONA_PASSWORD") };
const t = new Transcript();

async function main() {
  console.log(`spike 04 — ${MCP_URL} as ${persona.email}`);
  console.log(`  expected user source issuer: ${IDP_ISSUER}`);
  const startedAt = Date.now();
  const mcp = new McpProbe(MCP_URL);

  const unauth = await mcp.send(undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cg-spike-65", version: "0.1.0" },
    },
  });
  t.hop(`MCP initialize with no token -> ${unauth.status}`, {
    body: unauth.text,
    "www-authenticate": unauth.wwwAuthenticate,
  });
  if (unauth.status !== 401) throw new Error(`expected 401, got ${unauth.status}`);

  const resourceMetadata = /resource_metadata="([^"]+)"/.exec(unauth.wwwAuthenticate ?? "")?.[1];
  if (!resourceMetadata) throw new Error("no resource_metadata in WWW-Authenticate");
  const prm = await (await fetch(resourceMetadata)).json();
  t.hop("protected-resource metadata", prm);

  const asUrl = new URL(prm.authorization_servers[0]);
  const asMeta = await (
    await fetch(`${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname}`)
  ).json();
  t.hop("authorization server metadata", asMeta);

  const { server, captured, redirectUri } = startCallbackServer();
  try {
    const reg = await (
      await fetch(asMeta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "cg-spike-65",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: "mcp offline_access",
        }),
      })
    ).json();
    t.hop("dynamic client registration", reg);

    const { verifier, challenge } = await pkce();
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const authorizeUrl = `${asMeta.authorization_endpoint}?${new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      scope: "mcp offline_access",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: MCP_URL,
    })}`;
    t.hop("authorize URL", authorizeUrl);

    const drive = await driveAuthorize(authorizeUrl, redirectUri, persona, t, {
      expectedPageHost: new URL(IDP_ISSUER).host,
    });
    t.hop("hosts that rendered a page", {
      pageHosts: drive.pageHosts,
      pagesShown: drive.pagesShown,
      expected: new URL(IDP_ISSUER).host,
      authenticatedAgainstTheUserSource: drive.pageHosts.every((h) => h === new URL(IDP_ISSUER).host),
    });
    t.hop("redirect chain", drive.visited);
    if (drive.stoppedAt) {
      throw new Error(
        `the chain stopped at ${drive.stoppedAt} instead of reaching the redirect URI — ` +
          `the pages were served by ${drive.pageHosts.join(", ") || "no host"}, not ${new URL(IDP_ISSUER).host}`,
      );
    }

    const params = await Promise.race([
      captured,
      new Promise<URLSearchParams>((_, reject) =>
        setTimeout(() => reject(new Error("no callback within 90s")), 90_000),
      ),
    ]);
    t.hop("callback query", {
      keys: [...params.keys()],
      stateMatches: params.get("state") === state,
      error: params.get("error"),
      error_description: params.get("error_description"),
    });

    const code = params.get("code");
    if (!code) throw new Error(`authorize failed: ${params.get("error")} — ${params.get("error_description")}`);

    const tokenRes = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: reg.client_id,
        code_verifier: verifier,
        resource: MCP_URL,
      }).toString(),
    });
    const tokenText = await tokenRes.text();
    t.hop(`token exchange -> ${tokenRes.status}`, tokenText);
    const token = JSON.parse(tokenText).access_token as string;
    if (!token) throw new Error("no access_token on the token response");

    const init = await mcp.send(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cg-spike-65", version: "0.1.0" },
      },
    });
    t.hop(`MCP initialize with the token -> ${init.status} (session ${mcp.sessionId ?? "none"})`, init.json ?? init.text);
    await mcp.send(token, { jsonrpc: "2.0", method: "notifications/initialized" });

    const list = await mcp.send(token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    t.hop(`tools/list -> ${list.status}`, (list.json?.result?.tools ?? []).map((tool: any) => tool.name));

    const call = await mcp.send(token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: TOOL, arguments: TOOL_ARGS },
    });
    t.hop(`tools/call ${TOOL} -> ${call.status}`, call.json ?? call.text);
  } finally {
    server.stop(true);
  }

  const frames = await framesSince(HOOKS_URL, startedAt);
  t.hop("hook frames this run produced", frames);
  const pre = frames.find((f) => f.hook === "pre");
  console.log(`\n══ user_id on the /pre frame: ${pre ? JSON.stringify(pre.user_id) : "NO /pre FRAME OBSERVED"}`);
  if (pre) console.log(`══ decision ${pre.decision}, rule ${pre.rule_id ?? "none"}`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
});
