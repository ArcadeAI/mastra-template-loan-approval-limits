#!/usr/bin/env bun
/**
 * Spike 05 — walk a gateway's MCP authorization chain with a custom verifier
 * configured, and print which host rendered every page a human would have seen.
 *
 * Spike 04 asked the same question with no verifier set and got
 * `account.arcade.dev` for both gateways. #75's hypothesis is that the Arcade
 * account wall is the *default verifier*, and that setting a custom one moves the
 * login onto `apps/idp`. This script is the measurement.
 *
 *   MCP initialize (no token) -> 401 + WWW-Authenticate
 *     -> protected-resource metadata (does it name a user source?)
 *     -> authorization server metadata
 *     -> dynamic client registration on a loopback port we actually hold
 *     -> /oauth2/authorize with PKCE, following every redirect by hand
 *        -> whichever host renders the login: the verifier? the IdP? Arcade?
 *     -> code -> token -> initialize -> tools/list -> tools/call
 *        -> if the tool needs its own OAuth, walk that chain too (hop 2)
 *   -> replay /events and print the user_id on the /pre frame
 *
 * Usage:
 *   PERSONA_EMAIL=… PERSONA_PASSWORD=… VERIFIER_HOST=xxxx.ngrok-free.app \
 *     bun docs/spikes/evidence/05-verifier-flow.ts
 *
 * Optional: ARCADE_MCP_URL (defaults to the User Source gateway), IDP_ISSUER,
 * HOOKS_URL, SPIKE_TOOL, SPIKE_TOOL_ARGS.
 *
 * `PROBE_ONLY=1` answers one question — which host renders hop 1's first page —
 * and stops there without typing a password anywhere. **It exits 0 when it stops,**
 * because stopping is the measurement. Only a chain that renders no page at all is
 * a probe failure.
 *
 * The guard from spike 04 is kept: **this will not type a persona's password
 * into a host it was not told to trust.** The trusted set is the IdP and, if
 * `VERIFIER_HOST` is given, the verifier's tunnel.
 */
import {
  Transcript,
  driveAuthorize,
  framesSince,
  Jar,
  McpProbe,
  pkce,
  b64url,
  required,
  startCallbackServer,
  stripQuery,
} from "./05-drive.ts";

const MCP_URL = process.env.ARCADE_MCP_URL ?? "https://api.arcade.dev/mcp/cg-demo-us";
const IDP_ISSUER = process.env.IDP_ISSUER ?? "https://cg-idp-or5b.onrender.com";
const HOOKS_URL = process.env.HOOKS_URL ?? "https://cg-hooks.onrender.com";
const TOOL = process.env.SPIKE_TOOL ?? "Loan_GetLoan";
const TOOL_ARGS = JSON.parse(process.env.SPIKE_TOOL_ARGS ?? '{"loan_id":"LN-2291"}');
const PROBE_ONLY = process.env.PROBE_ONLY === "1";

const idpHost = new URL(IDP_ISSUER).host;
const verifierHost = process.env.VERIFIER_HOST?.trim();
const trustedPageHosts = [idpHost, ...(verifierHost ? [verifierHost] : [])];


/**
 * Pull the `authorization_url` out of a `tools/call` result.
 *
 * Arcade signals an unmet auth requirement as `isError: true` with a text block
 * whose body is JSON: `{authorization_url, llm_instructions, message}`. Parse the
 * block; do not pattern-match the enclosing serialisation, or the URL arrives with
 * its ampersands still escaped.
 */
function authorizationUrlFrom(result: any): string | undefined {
  for (const block of result?.result?.content ?? []) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try {
      const payload = JSON.parse(block.text);
      if (typeof payload?.authorization_url === "string") return payload.authorization_url;
    } catch {
      /* not the JSON block */
    }
  }
  return undefined;
}

const persona = { email: required("PERSONA_EMAIL"), password: required("PERSONA_PASSWORD") };
const t = new Transcript();

async function main() {
  console.log(`spike 05 — ${MCP_URL} as ${persona.email}`);
  console.log(`  hosts this run will type a password into: ${trustedPageHosts.join(", ")}`);
  if (PROBE_ONLY) console.log("  PROBE_ONLY: stopping at the first rendered page");
  const startedAt = Date.now();
  const mcp = new McpProbe(MCP_URL);

  const unauth = await mcp.send(undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cg-spike-75", version: "0.1.0" },
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
  t.hop(
    "user source attached to this gateway?",
    prm["urn:arcade:oauth:user_source_id"] ?? "no urn:arcade:oauth:user_source_id — members mode",
  );

  const asUrl = new URL(prm.authorization_servers[0]);
  const asMeta = await (
    await fetch(`${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname}`)
  ).json();
  t.hop("authorization server metadata", asMeta);

  const { server, captured, redirectUri } = startCallbackServer();
  const jar = new Jar();
  try {
    const reg = await (
      await fetch(asMeta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "cg-spike-75",
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
      // PROBE_ONLY trusts nothing, which is how it stops at the first page without
      // submitting anything. That stop is the probe's whole result, not a failure.
      trustedPageHosts: PROBE_ONLY ? [] : trustedPageHosts,
      jar,
    });
    t.hop("hop 1 — hosts that rendered a page", {
      pageHosts: drive.pageHosts,
      pagesShown: drive.pagesShown,
      reachedTheVerifier: verifierHost ? drive.pageHosts.includes(verifierHost) : "VERIFIER_HOST not set",
      reachedTheIdP: drive.pageHosts.includes(idpHost),
      stoppedBecause: drive.stoppedBecause ?? null,
    });
    t.hop("hop 1 — redirect chain", drive.visited);

    // A probe asks one question — which host authenticates the persona on hop 1 —
    // and answers it by looking at the first page rendered. Round 1's reviewer ran
    // this, got the right answer on screen, and got a "FAILED" line and exit 1
    // underneath it, because the code below could not tell "stopped on purpose"
    // from "stopped because something broke". It can now: a probe that reached a
    // page succeeded, whichever host served it, and the host is the finding.
    if (PROBE_ONLY) {
      const host = drive.pageHosts[0];
      if (!host) {
        console.error(
          `\nPROBE FAILED: the chain rendered no page at all. It ended at ` +
            `${drive.stoppedAt ? stripQuery(drive.stoppedAt) : "the redirect URI"} — ${drive.stoppedBecause ?? "no reason recorded"}.`,
        );
        process.exitCode = 1;
        return;
      }
      const whose =
        host === idpHost
          ? `our own IdP — hop 1 is brokered to the User Source`
          : host === verifierHost
            ? `the custom verifier's tunnel`
            : `${host}, which is neither our IdP nor the verifier`;
      console.log(
        `\n══ PROBE OK — hop 1 on ${MCP_URL}` +
          `\n══ ${drive.visited.length} hops, first page rendered by ${host}: ${whose}.` +
          `\n══ No password was typed: the probe stops at the first page by design.`,
      );
      return;
    }

    if (drive.stoppedAt) {
      throw new Error(
        `the chain stopped at ${stripQuery(drive.stoppedAt)} instead of reaching the redirect URI — ` +
          `${drive.stoppedBecause}. Pages were served by ${drive.pageHosts.join(", ") || "no host"}.`,
      );
    }

    // The chain is walked by hand, so it lands *on* the redirect URI rather than
    // being fetched through it: read the query off `landedOn` and fall back to the
    // loopback listener only if something else drove the last hop.
    const params = drive.landedOn
      ? new URL(drive.landedOn).searchParams
      : await Promise.race([
          captured,
          new Promise<URLSearchParams>((_, reject) =>
            setTimeout(() => reject(new Error("no callback within 120s")), 120_000),
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
        clientInfo: { name: "cg-spike-75", version: "0.1.0" },
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

    // Hop 2: the tool's own OAuth requirement. Arcade hands the URL back inside a
    // JSON document inside an MCP text block, so it has to be parsed rather than
    // pattern-matched out. A regex over the serialised form finds the URL with its
    // `&` still written `\u0026`, and walking that gets `response_type is required`
    // from our own IdP — a plausible-looking failure that is entirely the client's
    // fault. Measured the hard way.
    const toolAuthUrl = authorizationUrlFrom(call.json);
    if (toolAuthUrl && !toolAuthUrl.startsWith(MCP_URL)) {
      t.hop("hop 2 — the tool call handed back a URL; walking it with the same cookie jar", toolAuthUrl);
      const cookiesBefore = jar.hosts();
      const hop2 = await driveAuthorize(toolAuthUrl, "http://never.invalid/", persona, t, {
        trustedPageHosts,
        jar,
      });
      t.hop("hop 2 — hosts that rendered a page", {
        pageHosts: hop2.pageHosts,
        pagesShown: hop2.pagesShown,
        cookieJarHostsBefore: cookiesBefore,
        cookieJarHostsAfter: jar.hosts(),
        stoppedBecause: hop2.stoppedBecause ?? null,
      });
      t.hop("hop 2 — redirect chain", hop2.visited);

      // The authorization is Arcade's to record, not this script's, so the only
      // honest way to ask whether hop 2 worked is to call the tool again.
      const retry = await mcp.send(token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: TOOL, arguments: TOOL_ARGS },
      });
      const stillNeedsAuth = Boolean(authorizationUrlFrom(retry.json));
      t.hop(
        `hop 2 — ${TOOL} retried after the authorization walk -> ${retry.status}` +
          (stillNeedsAuth ? " — STILL UNAUTHORIZED" : " — authorized"),
        retry.json ?? retry.text,
      );
    } else {
      t.hop("hop 2 — no authorization URL came back from the tool call", toolAuthUrl ?? null);
    }
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
