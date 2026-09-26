/**
 * `bun run users` against the real app on a local port (#31, criterion 7):
 * the app under `next dev`, with its own databases, and the command writing
 * those same files while it runs.
 *
 *   1. a user `users add` created signs in with the password it printed;
 *   2. `/hooks/pre` holds them to the clearance they were given;
 *   3. `set-clearance` takes effect with no restart, within a policy poll;
 *   4. `remove` revokes their session and their sign-in, and `/hooks/pre`
 *      then denies them as an identity nobody registered;
 *   5. an address never added is denied the same way;
 *   6. there is still no open sign-up.
 *
 * No Arcade: every request is the one Arcade or a browser would make.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootApp, type App } from "../test/app.ts";
import { childEnv } from "./child-env.ts";
import { spawnChild } from "./child.ts";

const ROOT = join(import.meta.dir, "..");
const HOOK_SECRET = `users-live-${crypto.randomUUID()}`;
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const POLICY_POLL_MS = 250;
const EMAIL = "Rowan.Test@Example.com";
const LOWER = EMAIL.toLowerCase();
const NOT_REGISTERED = "an administrator must register the identity";

let app: App;
let data: string;
let env: Record<string, string>;
let password = "";
let clientId = "";

async function users(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawnChild(["bun", "--no-env-file", "scripts/users.ts", ...args], {
    cwd: ROOT,
    env: childEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`users ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
  return { code, stdout, stderr };
}

const approve = (userId: string, amount: number) =>
  fetch(`${app.origin}/hooks/pre`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${HOOK_SECRET}` },
    body: JSON.stringify({
      execution_id: `tc_users_${crypto.randomUUID()}`,
      tool: { name: "ApproveLoan", toolkit: "Loan", version: "1.0.0" },
      inputs: { loan_id: "LN-2299", amount },
      context: { authorization: [{}], user_id: userId },
    }),
  }).then((response) => response.json() as Promise<{ code: string; error_message?: string }>);

const signIn = (email: string, secret: string) =>
  fetch(`${app.origin}/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.origin },
    body: JSON.stringify({ email, password: secret }),
  });

/** Where the provider sends a browser holding `cookie` that asks to authorize: consent if signed in, login if not. */
async function authorizeAs(cookie: string): Promise<string> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const response = await fetch(
    `${app.origin}/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "openid email",
      state: "users-live",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })}`,
    { headers: { cookie }, redirect: "manual" },
  );
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!, app.origin).pathname;
}

beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), "cg-users-live-"));
  env = {
    GOVERNANCE_DB_PATH: join(data, "governance.db"),
    IDP_DB_PATH: join(data, "idp.db"),
    IDP_OAUTH_REDIRECT_URIS: REDIRECT_URI,
    ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET,
    POLICY_POLL_MS: String(POLICY_POLL_MS),
  };
  app = await bootApp(env);
  env = { ...env, APP_PUBLIC_HOST: app.host };

  const client = spawnChild(["bun", "--no-env-file", "scripts/identity/oauth-client.ts", "--json"], {
    cwd: ROOT,
    env: childEnv({ ...env, NODE_ENV: "test" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(client.stdout).text(), client.exited]);
  if (code !== 0) throw new Error(`oauth-client exited ${code}`);
  clientId = (JSON.parse(out) as { client_id: string }).client_id;
}, 240_000);

afterAll(async () => {
  await app?.stop();
  if (data) rmSync(data, { recursive: true, force: true });
});

describe("bun run users, against the running app", () => {
  let cookie = "";

  test("a user added with users add signs in with the password it printed", async () => {
    const added = await users(["add", EMAIL, "--name", "Rowan", "--role", "loan_officer", "--clearance", "50000"]);
    password = added.stdout.match(/^ {2}password {3}(\S+)$/m)![1]!;

    const wrong = await signIn(LOWER, `${password}x`);
    expect(wrong.status).toBe(401);

    const response = await signIn(EMAIL, password);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { user: { email: string } }).user.email).toBe(LOWER);
    cookie = response.headers
      .getSetCookie()
      .map((raw) => raw.split(";")[0]!)
      .join("; ");
    expect(cookie).toContain("session_token=");
    // The session is live: authorize goes on to consent rather than back to the login page.
    expect(await authorizeAs(cookie)).toBe("/consent");
  });

  test("/hooks/pre holds them to their clearance", async () => {
    const over = await approve(LOWER, 60_000);
    expect(over.code).toBe("CHECK_FAILED");
    expect(over.error_message).toContain("exceeds your approval authority of 50000");
    expect(await approve(LOWER, 50_000)).toEqual({ code: "OK" });
  });

  test("set-clearance takes effect without a restart, within one policy poll", async () => {
    await users(["set-clearance", LOWER, "75000"]);
    const changed = performance.now();
    let answer = await approve(LOWER, 60_000);
    while (answer.code !== "OK" && performance.now() - changed < 10 * POLICY_POLL_MS) {
      await Bun.sleep(25);
      answer = await approve(LOWER, 60_000);
    }
    const elapsed = performance.now() - changed;
    console.log(`[users-live] set-clearance 50000 -> 75000 visible to /hooks/pre after ${Math.round(elapsed)}ms`);
    expect(answer).toEqual({ code: "OK" });
    // One poll, plus the request that noticed it.
    expect(elapsed).toBeLessThan(2 * POLICY_POLL_MS + 250);
    const over = await approve(LOWER, 80_000);
    expect(over.error_message).toContain("exceeds your approval authority of 75000");
  });

  test("a removed user loses their session and their sign-in, and /hooks/pre denies them", async () => {
    const removed = await users(["remove", LOWER]);
    expect(removed.stdout).toMatch(/[1-9]\d* session\(s\)/);

    expect(await authorizeAs(cookie)).toBe("/login");
    expect((await signIn(LOWER, password)).status).toBe(401);

    let answer = await approve(LOWER, 1);
    const started = performance.now();
    while (answer.code === "OK" && performance.now() - started < 10 * POLICY_POLL_MS) {
      await Bun.sleep(25);
      answer = await approve(LOWER, 1);
    }
    expect(answer.code).toBe("CHECK_FAILED");
    expect(answer.error_message).toContain(NOT_REGISTERED);
  });

  test("an email that was never added is denied as unregistered", async () => {
    const answer = await approve("never.added@example.com", 1);
    expect(answer.code).toBe("CHECK_FAILED");
    expect(answer.error_message).toContain(NOT_REGISTERED);
  });

  test("there is still no open sign-up", async () => {
    const response = await fetch(`${app.origin}/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.origin },
      body: JSON.stringify({ email: "walk.in@example.com", password: "walk-in-password", name: "Walk In" }),
    });
    expect(response.status).toBe(404);
    expect((await signIn("walk.in@example.com", "walk-in-password")).status).toBe(401);
  });
});
