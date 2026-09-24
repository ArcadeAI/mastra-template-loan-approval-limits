/**
 * Hop 1 is a User Source gateway whose User Source is the app's own identity
 * provider (#6, criterion 8, as clarified on the issue).
 *
 * `gatewayToken()` is unchanged: its bearer is still the gateway token hop 1
 * ends in, and Arcade issues that token itself after brokering the login to
 * the User Source (spike 04's addendum; Arcade's User Sources guide). What #6
 * moved is the broker's target — from `cg-idp` to the app — and this is the
 * check that it lands there, on both of hop 1's paths:
 *
 *   - **Studio's loopback hop 1** (#8): no browser session, so the brokered
 *     login is the app's own `/login`, on the app's own port, and Studio then
 *     lists tools with the bearer the gateway bound to that person.
 *   - **the web UI's hop 1**: a browser already signed in at the app is not
 *     asked for a password again — Better Auth's session and the app's sealed
 *     one are on the same origin since #6 — and `gatewayToken()` hands back the
 *     grant the User Source login produced.
 *
 * The gateway is the stand-in (`startArcadeStandIn`, User Source mode), which
 * redeems the User Source's code at the app's real token endpoint and reads
 * the ID token's `email`, having compared its `iss` with the configured issuer
 * byte for byte. The identity provider is the real one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { gatewayToken } from "../../lib/agent/gateway-token.ts";
import {
  forgetStudioGrant,
  STUDIO_AUTHORIZE_PATH,
  STUDIO_CALLBACK_PATH,
  studioAuthorize,
  studioCallback,
  studioTools,
} from "../../lib/agent/studio.ts";
import { readIdentitySurface, type IdentitySurface } from "../../lib/config.ts";
import { forgetGatewayClients } from "../../lib/identity/gateway.ts";
import { joinChunks, openSealed } from "../../lib/identity/seal.ts";
import { SESSION_COOKIE, type Session } from "../../lib/identity/session.ts";
import {
  Browser,
  GATEWAY_ID,
  PEOPLE,
  SESSION_SECRET,
  signInAs,
  startIdentityHarness,
  type IdentityHarness,
  type PersonaKey,
} from "../identity-harness.ts";

let harness: IdentityHarness;
let studio: ReturnType<typeof Bun.serve>;
let studioConfig: IdentitySurface;

/** Fill whatever form appears: the app's login as this persona, and allow on any consent. */
const as = (persona: PersonaKey) => (fields: Record<string, string>) => {
  const filled = { ...fields };
  if ("email" in fields) {
    filled.email = PEOPLE[persona].email;
    filled.password = PEOPLE[persona].password;
  }
  if ("decision" in fields) filled.decision = "allow";
  return filled;
};

beforeAll(async () => {
  harness = await startIdentityHarness({ userSource: true });
  studioConfig = readIdentitySurface({
    ARCADE_API_URL: harness.arcade.url,
    ARCADE_GATEWAY_ID: GATEWAY_ID,
    ARCADE_LOAN_TOOLKIT: "Loan",
    ARCADE_APPROVALS_TOOLKIT: "Approvals",
    ANTHROPIC_API_KEY: "anthropic-key-for-hop1-tests",
  });
  // Studio's two routes, on a loopback server of their own, as `mastra dev`
  // mounts them (`app-test/studio-entry.test.ts` does the same).
  studio = Bun.serve({
    port: 0,
    hostname: "localhost",
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === STUDIO_AUTHORIZE_PATH) return studioAuthorize(request, studioConfig);
      if (pathname === STUDIO_CALLBACK_PATH) return studioCallback(request, studioConfig);
      return new Response(null, { status: 404 });
    },
  });
}, 90_000);

afterAll(async () => {
  await forgetStudioGrant();
  forgetGatewayClients();
  studio?.stop(true);
  await harness?.stop();
});

describe("hop 1 through a User Source gateway whose User Source is the app", () => {
  test("Studio's loopback hop 1 lands on the app's own /login, and Studio lists tools as that person", async () => {
    forgetGatewayClients();
    await forgetStudioGrant();
    const browser = new Browser();

    const landed = await browser.follow(`http://localhost:${studio.port}${STUDIO_AUTHORIZE_PATH}`, as("riley"), {
      stopAt: STUDIO_CALLBACK_PATH,
    });

    // The gateway sent the browser to the app — its own authorize endpoint, on
    // the app's own port — and the password was typed into the app's /login.
    const app = new URL(harness.webUrl);
    expect(browser.visited).toContain(`302 GET ${harness.webUrl}/oauth2/authorize`);
    expect(browser.visited.some((line) => line.startsWith(`200 GET ${harness.webUrl}/login`))).toBe(true);
    expect(browser.pageHosts).toContain(app.host);
    // And nowhere else asked for one: the only other form was Arcade's own
    // consent screen, which has no password field.
    expect(browser.pageHosts.filter((host) => host !== app.host)).toEqual([new URL(harness.arcade.url).host]);

    // The gateway read the person off the app's ID token, issued by the app.
    const login = harness.arcade.userSourceLogins.at(-1)!;
    expect(login).toMatchObject({ iss: harness.webUrl, email: PEOPLE.riley.email });

    // Studio redeems its code and holds the grant...
    const done = await fetch(landed.url, { redirect: "manual" });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Studio is authorized");

    // ...and lists tools through `gatewayToken()` with the bearer the gateway
    // bound to Charlie at the User Source.
    const tools = await studioTools(studioConfig, `http://localhost:${studio.port}`);
    expect(Object.keys(tools)).toEqual(["Loan_GetLoan"]);
    expect(login.access_token).not.toBeNull();
    expect(harness.arcade.bearers.at(-1)).toBe(login.access_token!);
  });

  test("the web UI's hop 1 asks nobody for a password twice, and gatewayToken() hands back the User Source grant", async () => {
    forgetGatewayClients();
    const browser = new Browser();

    // Signed in at the app, as the web UI does it (client C).
    await signInAs(browser, harness, "dana", { stopAt: "/api/arcade/start" });
    const passwordsBefore = browser.visited.filter((line) => line.startsWith("303 POST") && line.endsWith("/login")).length;
    expect(passwordsBefore).toBe(1);

    const landed = await browser.follow(`${harness.webUrl}/api/arcade/start`, as("dana"), {
      stopAt: "/api/arcade/callback",
    });

    // Brokered to the app again, under the User Source's client this time —
    // and no second password: the app's Better Auth session was already here.
    const brokered = browser.visited.filter((line) => line === `302 GET ${harness.webUrl}/oauth2/authorize`);
    expect(brokered.length).toBeGreaterThanOrEqual(2);
    const passwordsAfter = browser.visited.filter((line) => line.startsWith("303 POST") && line.endsWith("/login")).length;
    expect(passwordsAfter).toBe(passwordsBefore);

    const callback = await browser.fetch(landed.url);
    expect(callback.status).toBe(303);

    const login = harness.arcade.userSourceLogins.at(-1)!;
    expect(login).toMatchObject({ iss: harness.webUrl, email: PEOPLE.dana.email });

    // The one token seam, unchanged, hands back exactly that grant.
    const session = await openSealed<Session>(joinChunks(SESSION_COOKIE, browser.cookies), SESSION_SECRET);
    expect(session?.email).toBe(PEOPLE.dana.email);
    const bearer = await gatewayToken(session!, harness.config);
    expect(bearer.token).toBe(login.access_token);
  });
});
