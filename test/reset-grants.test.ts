/**
 * #123 — what a reset does to a grant a persona is already holding.
 *
 * The decision recorded on #123 is two resets, and this file is the test of
 * that decision rather than of whatever the code happens to do:
 *
 *   - **between takes** (`bun run reset`) a grant a persona already holds
 *     **still works afterwards**, so nobody is signed out and nobody has to
 *     authorize again — and the loan book and the control plane are still put
 *     back, so it is a real reset and not a no-op;
 *   - **`--hard`** invalidates it, **on purpose**, because signing in and
 *     authorizing from clean is the thing that reset exists to make
 *     demonstrable (#174) — and it says so in its own output rather than
 *     leaving it to be discovered at a login page on stage.
 *
 * ## What this file does not claim
 *
 * Only the app's identity provider and its loan module are in the loop here
 * (`apps/idp` and `apps/loan-app` until #6 and #5). Whether **Arcade**
 * presents a stale token or raises an authorization card instead is Arcade's
 * decision, it is not measurable without the project credential, and it is not
 * what is being tested: measured live on 2026-09-19, Arcade raises the card
 * and Continue clears it. What these tests pin is our own half — which tokens
 * survive which reset — because that is what `scripts/reset.ts` controls.
 *
 * ## Why it joins the real IdP to the real loan book
 *
 * `test/reset.test.ts` deliberately does not: it points the loan module at a
 * `/oauth2/userinfo` stand-in, because walking a whole authorize flow to read
 * one loan is `app-test/identity/flow.test.ts`'s job. But a token minted by a
 * stand-in cannot be invalidated when the real IdP is reset, which is the
 * entire subject here. So this file spends the authorize flow once and gets a
 * **real** access token.
 *
 * Every assertion goes through a **write** (`POST /loans/…/approve`). Reads
 * may be answered from `actorFromRequest`'s 60-second memory (#167) and a read
 * that passed after a reset would prove nothing; a write re-introspects at the
 * provider every time, by design, which is exactly the measurement this file
 * needs.
 *
 * ## One app since #6
 *
 * Until #6 these were three services on three ports. The identity provider
 * was the last to fold in, so this boots the real app once (`test/app.ts`):
 * the authorize flow runs at its own `/oauth2/…`, `/login` and `/consent`, the
 * loan module validates the grant at its own `/oauth2/userinfo` over its local
 * listener (`IDENTITY_HOST` unset, the default), and the reset command is
 * handed the one address.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The fixture itself, not the provider's `loadPeople`: the persona-email
// overrides it applies are deliberately not wanted here — `bootApp` drops
// every `PERSONA_*` from the environment, so the fixture's own address is the
// one that gets seeded.
import people from "../lib/identity/provider/fixtures/people.json" with { type: "json" };
import { bootApp, type App } from "./app.ts";

const ROOT = join(import.meta.dir, "..");
const RESET_TOKEN = "reset-grants-token-for-tests";
const HOOK_SECRET = "reset-grants-hook-secret-for-tests";
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const BETTER_AUTH_SECRET = "reset-grants-test-secret-".padEnd(48, "x");
const OVER_LIMIT_LOAN = "LN-2291";

const alice = people.people.find((person) => person.persona === "dana")!;

let app: App;
/** The access token Arcade would be holding: minted once, never re-minted. */
let arcadeToken = "";
/** The environment the app was booted with, for the credentials script. */
let appEnv: Record<string, string> = {};
/** Where the app's `idp.db` is, so the credentials script opens the same one. */
const data = join(tmpdir(), `cg-grants-${crypto.randomUUID()}`);

/** The three modules, each at its own paths on the one app. */
const idp = { get baseUrl() { return app.origin; } };
const hooks = { get baseUrl() { return app.origin; } };
const loanApp = { get baseUrl() { return `${app.origin}/bank`; } };

/** The command, run the way a presenter runs it. */
async function runResetCommand(args: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", join(ROOT, "scripts", "reset.ts"), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      RESET_TOKEN,
      APP_PUBLIC_HOST: app.host,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/** A cookie jar and manual redirects — `apps/idp/test/flow.test.ts`'s `Browser`. */
class Browser {
  private cookies = new Map<string, string>();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  submit(url: string, fields: Record<string, string>): Promise<Response> {
    return this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams(fields).toString(),
    });
  }
}

/**
 * Alice's hop-2 access token, through the whole flow: authorize → login →
 * consent → code → token. The one thing a stand-in cannot produce.
 */
async function authorizeAlice(): Promise<string> {
  // The client the service made at boot has a hashed secret (#70), so rotate
  // once to hold one the exchange can use. Arcade's registered client *id* is
  // unchanged by this, which is the property every reset here asserts.
  const rotate = Bun.spawnSync(
    ["bun", join(ROOT, "scripts", "identity", "oauth-client.ts"), "--json", "--rotate"],
    { env: { ...process.env, ...appEnv, APP_PUBLIC_HOST: app.host, NODE_ENV: "test" } },
  );
  expect(rotate.exitCode).toBe(0);
  const creds = JSON.parse(rotate.stdout.toString()) as { client_id: string; client_secret: string };

  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(
    new Bun.CryptoHasher("sha256").update(verifier).digest(),
  ).toString("base64url");

  const browser = new Browser();
  const queryOf = (location: string) => new URL(location, idp.baseUrl).search.slice(1);

  let location =
    (
      await browser.fetch(
        `${idp.baseUrl}/oauth2/authorize?` +
          new URLSearchParams({
            response_type: "code",
            client_id: creds.client_id,
            redirect_uri: REDIRECT_URI,
            scope: "openid email",
            state: `state-${crypto.randomUUID()}`,
            code_challenge: challenge,
            code_challenge_method: "S256",
          }),
      )
    ).headers.get("location") ?? "";

  if (/\/login(\?|$)/.test(location)) {
    const login = await browser.submit(`${idp.baseUrl}/login`, {
      email: alice.email,
      password: alice.password,
      oauth_query: queryOf(location),
    });
    expect(login.status).toBe(303);
    location = login.headers.get("location") ?? "";
  }
  if (/\/consent\?/.test(location)) {
    const consent = await browser.submit(`${idp.baseUrl}/consent`, {
      decision: "allow",
      oauth_query: queryOf(location),
    });
    expect(consent.status).toBe(303);
    location = consent.headers.get("location") ?? "";
  }

  const code = new URL(location).searchParams.get("code");
  expect(code).toBeTruthy();

  // HTTP Basic, form-encoded — the shape Arcade sends (#61).
  const half = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  const basic = `Basic ${Buffer.from(`${half(creds.client_id)}:${half(creds.client_secret)}`).toString("base64")}`;
  const token = await fetch(`${idp.baseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as { access_token: string };
  expect(body.access_token).toBeTruthy();
  return body.access_token;
}

/**
 * A governed write, made the way the `Loan` toolkit makes it: the persona's
 * bearer and nothing else. A write rather than a read on purpose — see the
 * note at the top of this file.
 */
function approveAsArcade(): Promise<Response> {
  return fetch(`${loanApp.baseUrl}/loans/${OVER_LIMIT_LOAN}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${arcadeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ amount: 95_000 }),
  });
}

const loanStatus = async (): Promise<string> =>
  (
    (await (
      await fetch(`${loanApp.baseUrl}/loans/${OVER_LIMIT_LOAN}`, {
        headers: { authorization: `Bearer ${arcadeToken}` },
      })
    ).json()) as { status: string }
  ).status;

beforeAll(async () => {
  appEnv = {
    RESET_TOKEN,
    ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET,
    PERSONA_LOAN_OFFICER_EMAIL: alice.email,
    BETTER_AUTH_SECRET,
    IDP_OAUTH_REDIRECT_URIS: REDIRECT_URI,
    // The credentials script below opens the same `idp.db` the app does.
    IDP_DB_PATH: join(data, "idp.db"),
  };
  app = await bootApp(appEnv);

  arcadeToken = await authorizeAlice();
}, 120_000);

afterAll(async () => {
  await app?.stop();
  rmSync(data, { recursive: true, force: true });
});

describe("a reset between takes leaves every persona's grant alive", () => {
  test("the grant Arcade holds still works after `bun run reset`", async () => {
    // The premise: it works before the reset. Asserted rather than assumed, so
    // a failure below means the reset broke it and not that it never worked.
    expect((await approveAsArcade()).status).toBe(200);

    const { code, out, err } = await runResetCommand();
    expect(err).toBe("");
    expect(code).toBe(0);

    // The same token, unchanged, on a write — which always re-resolves at the
    // provider, so no remembered answer can make this pass.
    const after = await approveAsArcade();
    expect(after.status).toBe(200);
  });

  test("and it is still a real reset: the loan book and the control plane went back", async () => {
    // Dirty the book through the grant, then put it back with the soft reset.
    expect((await approveAsArcade()).status).toBe(200);
    expect(await loanStatus()).toBe("approved");

    expect((await runResetCommand()).code).toBe(0);

    expect(await loanStatus()).toBe("pending");
    const health = (await (await fetch(`${hooks.baseUrl}/hooks/health`)).json()) as {
      audit_rows: number;
      counts: Record<string, number>;
    };
    expect(health.audit_rows).toBe(0);
    expect(health.counts.grants).toBe(0);
    expect(health.counts.policy_rules).toBeGreaterThan(0);
  });

  test("it says out loud that it left the IdP alone", async () => {
    const { out } = await runResetCommand();
    expect(out).toMatch(/idp\s+SKIPPED/);
    expect(out).toContain("nobody has to log in or authorize again");
    expect(out).toContain("--hard");
    // And no idp line pretending it ran.
    expect(out).not.toMatch(/\[reset\] idp\s+OK/);
  });

  test("the people were never touched, so nobody was signed out", async () => {
    const before = (await (await fetch(`${idp.baseUrl}/identity/health`)).json()) as { people: number };
    expect((await runResetCommand()).code).toBe(0);
    const after = (await (await fetch(`${idp.baseUrl}/identity/health`)).json()) as { people: number };
    expect(after.people).toBe(before.people);

    // The consent is what a re-seed would have deleted, and the grant riding
    // on it is what would have died. Still there.
    expect((await approveAsArcade()).status).toBe(200);
    expect((await runResetCommand()).code).toBe(0);
  });
});

describe("the panel's Reset button leaves the IdP alone too", () => {
  test("`demo` mode does not disturb a grant", async () => {
    expect((await approveAsArcade()).status).toBe(200);
    const before = (await (await fetch(`${idp.baseUrl}/identity/health`)).json()) as { people: number };

    // Exactly the request `lib/governance/control-plane.ts`'s
    // `runReset` sends for the `demo` mode — one address, one body. Posted
    // here rather than imported because that module is Next-side code, and
    // until #3 the root tsconfig had no DOM lib for it; `app-test/control-plane-route.test.ts`
    // holds the other half, that neither mode has any address but cg-hooks.
    const pressed = await fetch(`${hooks.baseUrl}/hooks/admin/reset`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${RESET_TOKEN}` },
      body: JSON.stringify({ mode: "demo" }),
    });
    expect(pressed.status).toBe(200);

    // It really did reset the control plane...
    const health = (await (await fetch(`${hooks.baseUrl}/hooks/health`)).json()) as { audit_rows: number };
    expect(health.audit_rows).toBe(0);
    // ...and left identity entirely alone: same people, same live grant.
    expect(((await (await fetch(`${idp.baseUrl}/identity/health`)).json()) as { people: number }).people).toBe(
      before.people,
    );
    expect((await approveAsArcade()).status).toBe(200);

    expect((await runResetCommand()).code).toBe(0);
  });
});

describe("--hard invalidates it, deliberately, and says so", () => {
  test("the same token is refused afterwards", async () => {
    // Alive going in.
    expect((await approveAsArcade()).status).toBe(200);

    const { code, out, err } = await runResetCommand(["--hard"]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toMatch(/\[reset\] idp\s+OK\s+people \d+→\d+, OAuth client \S+ unchanged/);

    const refused = await approveAsArcade();
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "The identity provider rejected the token." });
  });

  test("the IdP's own answer is an OAuth invalid_token, and the loan book drops it", async () => {
    expect((await runResetCommand(["--hard"])).code).toBe(0);

    // The machine-readable signal exists exactly once, here. Recorded because
    // #123 turns on where it stops existing.
    const userinfo = await fetch(`${idp.baseUrl}/oauth2/userinfo`, {
      headers: { authorization: `Bearer ${arcadeToken}` },
    });
    expect(userinfo.status).toBe(401);
    expect(userinfo.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await userinfo.json()).toMatchObject({ error: "invalid_token" });

    // And it does not survive the next hop: `apps/loan-app` answers a sentence
    // with no code, no `WWW-Authenticate` and no status detail, which is why
    // no re-authorization can be driven from it.
    const refused = await approveAsArcade();
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBeNull();
    expect(await refused.text()).not.toContain("invalid_token");
  });

  test("the presenter is told everyone is signed out, and what that costs", async () => {
    const { out } = await runResetCommand(["--hard"]);
    expect(out).toContain("All four personas are signed out");
    expect(out).toContain("authorize, then Continue");
    // Named as the point of this reset rather than as a malfunction: `--hard`
    // exists so the auth flow can be shown again (#174).
    expect(out).toContain("this reset exists to make demonstrable");

    // And it must not send anybody to a dashboard. Live evidence on
    // 2026-09-19 is that Arcade raises the card by itself and Continue clears
    // it, so an instruction to go and revoke by hand would describe a failure
    // that does not happen — the class of lying surface this project has
    // three of already (#151, #167, #170).
    expect(out).not.toMatch(/dashboard/i);
    expect(out).not.toMatch(/revoke/i);
  });

  test("the OAuth client Arcade is registered against still does not move", async () => {
    const before = (await (await fetch(`${idp.baseUrl}/identity/health`)).json()) as {
      oauth: { client_id: string };
    };
    expect((await runResetCommand(["--hard"])).code).toBe(0);
    const after = (await (await fetch(`${idp.baseUrl}/identity/health`)).json()) as {
      oauth: { client_id: string };
    };
    expect(after.oauth.client_id).toBe(before.oauth.client_id);
  });
});
