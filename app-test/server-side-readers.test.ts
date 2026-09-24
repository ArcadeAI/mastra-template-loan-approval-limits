/**
 * The app's own server-side readers never go out through `APP_PUBLIC_HOST`
 * (#6, criterion 7; the finding from #4).
 *
 * `APP_PUBLIC_HOST` is the ngrok host: the address Arcade Cloud reaches the
 * app at. Since #6 it is also the identity provider's issuer. A server-side
 * read of one of the app's own modules addressed to it would leave the
 * machine, cross the tunnel and come back in — slower, rate-limited by
 * ngrok, and broken the moment the tunnel is down, which is when a presenter
 * most needs the panel to say so. So every such read is in-process or goes to
 * a local address, and this file is the check.
 *
 * Every reader is driven for real, with `APP_PUBLIC_HOST` set to a host that
 * exists nowhere and `fetch` replaced by a recorder that answers 503 without
 * touching the network. A reader that addressed the public host would show up
 * in the record; the last test plants one to show that it does.
 *
 * The readers, from the list on #4 and the ones #6 adds:
 *
 *   - the panel's status strip and its Reset button (`lib/governance/control-plane.ts`)
 *   - the approval page, and the chat's approval-status poll (`lib/approvals-store.ts`)
 *   - the loan module's bearer validation (`lib/loans/actor.ts`, `IDENTITY_HOST`)
 *   - the web sign-in's token exchange, userinfo and auth-method lookup,
 *     and the bank screens' token refresh (`lib/identity/oidc.ts`)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { appOrigin, readIdentitySurface, readWebConfig } from "../lib/config.ts";
import { fetchApproval, fetchRoster } from "../lib/approvals-store.ts";
import { readControlPlane, resetToken, runReset } from "../lib/governance/control-plane.ts";
import { signinCallback } from "../lib/identity/handlers.ts";
import { identityLink, linkIdentity, type IdentityLink } from "../lib/identity/link.ts";
import { refreshIdpToken } from "../lib/identity/oidc.ts";
import { SIGNIN_COOKIE, writeLeg, type SigninLeg } from "../lib/identity/session.ts";
import { actorFromRequest } from "../lib/loans/actor.ts";
import { loanModuleConfig } from "../lib/loans/instance.ts";

/** A host that resolves nowhere, so a request to it could only be a mistake. */
const PUBLIC_HOST = "app-public-host.invalid";
const PORT = "4999";
const SESSION_SECRET = "server-side-readers-suite-secret-0123456789";

const ENV = {
  APP_PUBLIC_HOST: PUBLIC_HOST,
  PORT,
  SESSION_SECRET,
  IDP_CLIENT_ID: "client-c",
  IDP_CLIENT_SECRET: "client-c-secret",
  RESET_TOKEN: "reset-token-for-the-reader-suite",
  APPROVALS_STORE_TOKEN: "store-token-for-the-reader-suite",
};

/** Every URL anything in this process asked the network for. */
let requested: string[] = [];
/** Every URL the identity provider was asked for, in-process. */
let answeredInProcess: string[] = [];

const realFetch = globalThis.fetch;
const previous: Record<string, string | undefined> = {};
let previousLink: IdentityLink | undefined;

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  for (const key of ["CONTROL_PLANE_HOST", "IDENTITY_HOST"]) {
    previous[key] = process.env[key];
    delete process.env[key];
  }

  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      requested.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("the recorder answers everything with 503", { status: 503 });
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;

  // The identity provider, as this process has it: in-process. A stand-in
  // that answers the three calls sign-in makes, so the reader runs to the end.
  previousLink = identityLink();
  linkIdentity({
    failure: () => null,
    async fetch(request) {
      answeredInProcess.push(request.url);
      const { pathname } = new URL(request.url);
      if (pathname === "/identity/health") return Response.json({ oauth: { token_endpoint_auth_method: "client_secret_basic" } });
      if (pathname === "/oauth2/token") return Response.json({ access_token: "at-alice", expires_in: 3600, refresh_token: "rt" });
      if (pathname === "/oauth2/userinfo") return Response.json({ sub: "alice", email: "alice@bank.example" });
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  linkIdentity(previousLink);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** The hosts in the record, one each. */
function hosts(urls: string[]): string[] {
  return [...new Set(urls.map((url) => new URL(url).host))];
}

function reset() {
  requested = [];
  answeredInProcess = [];
}

describe("with APP_PUBLIC_HOST set to the tunnel", () => {
  test("the configuration names it as the public host, so the premise holds", () => {
    const config = readWebConfig();
    expect(config.hooksHost).toBe(PUBLIC_HOST);
    expect(config.identity.idpIssuer).toBe(`https://${PUBLIC_HOST}`);
    expect(appOrigin()).toBe(`https://${PUBLIC_HOST}`);
  });

  test("the panel's status strip reads the control plane locally", async () => {
    reset();
    await readControlPlane(readWebConfig());
    expect(requested.length).toBeGreaterThan(0);
    expect(hosts(requested)).toEqual([`localhost:${PORT}`]);
  });

  test("the panel's Reset button resets it locally", async () => {
    reset();
    await runReset(readWebConfig(), "demo", resetToken());
    expect(requested.length).toBeGreaterThan(0);
    expect(hosts(requested)).toEqual([`localhost:${PORT}`]);
  });

  test("the approval page and the approval-status poll read the store locally", async () => {
    reset();
    await fetchApproval("apr_000000000001", readWebConfig()).catch(() => undefined);
    await fetchRoster(readWebConfig()).catch(() => undefined);
    expect(requested.length).toBeGreaterThan(0);
    expect(hosts(requested)).toEqual([`localhost:${PORT}`]);
  });

  test("the loan module validates a bearer at the app's own listener", async () => {
    reset();
    const { idpHost } = loanModuleConfig();
    expect(idpHost).toBe(`localhost:${PORT}`);
    await actorFromRequest(
      new Request("http://localhost/loans", { headers: { authorization: "Bearer a-token-nobody-issued" } }),
      idpHost,
    ).catch(() => undefined);
    expect(requested.length).toBeGreaterThan(0);
    expect(hosts(requested)).toEqual([`localhost:${PORT}`]);
  });

  test("the web sign-in exchanges its code and reads userinfo in-process, and fetches nothing", async () => {
    reset();
    const config = readIdentitySurface();
    const leg: SigninLeg = { state: "state", verifier: "v".repeat(43), next: "/" };
    const sealed = new Headers();
    await writeLeg(sealed, SIGNIN_COOKIE, leg, config);
    const cookie = sealed.getSetCookie()[0]!.split(";")[0]!;

    const answer = await signinCallback(
      new Request(`https://${PUBLIC_HOST}/api/auth/callback?code=c&state=state`, { headers: { cookie } }),
      config,
    );

    // It signed the person in, so every call it needed was answered...
    expect(answer.status).toBe(303);
    expect(answer.headers.getSetCookie().some((each) => each.startsWith("cg_session"))).toBe(true);
    // ...by the provider in this process, and not one of them by the network.
    expect(answeredInProcess.map((url) => new URL(url).pathname).sort()).toEqual([
      "/identity/health",
      "/oauth2/token",
      "/oauth2/userinfo",
    ]);
    expect(requested).toEqual([]);
  });

  test("the bank screens renew their token in-process too", async () => {
    reset();
    const renewed = await refreshIdpToken({
      issuer: appOrigin(),
      clientId: "client-c",
      clientSecret: "client-c-secret",
      refreshToken: "rt",
    });
    expect(renewed.ok).toBe(true);
    expect(answeredInProcess.map((url) => new URL(url).pathname)).toContain("/oauth2/token");
    expect(requested).toEqual([]);
  });
});

describe("the check bites", () => {
  test("a reader that addressed the public host would be in the record", async () => {
    reset();
    // What the panel's strip was until #4 moved it to CONTROL_PLANE_HOST: a
    // read of the app's own control plane at its public address.
    await fetch(`${appOrigin()}/hooks/health`);
    expect(hosts(requested)).toEqual([PUBLIC_HOST]);
    expect(hosts(requested)).not.toEqual([`localhost:${PORT}`]);
  });
});
