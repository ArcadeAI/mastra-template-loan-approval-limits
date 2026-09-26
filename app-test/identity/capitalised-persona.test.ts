/**
 * The test #58 says would have caught it: put a person in under a capitalised
 * address and assert `/sign-in/email` answers 200.
 *
 * Until #33 the address arrived through a per-persona email variable read at
 * first seed; that contract is gone. Since #33 nobody is seeded and the only way in is
 * `bun run users add`, so that is what this runs, as a subprocess against the
 * provider's own file before it boots.
 *
 * Every other fixture in this directory is lowercase, which is why a persona
 * configured as `Alice@Example.Test` reached a live sitting before
 * anyone noticed they could not log in. Better Auth lowercases the address
 * before it looks the row up and SQLite compares text case-sensitively, so
 * the row was unreachable — and `handleLogin` reports that as "That email and
 * password did not match", the same sentence it gives a wrong password.
 *
 * Booted as a subprocess, env only, the way a deployment boots it, so what is under
 * test is the seed that really ran and the schema that really applied.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { serveOnFreePort } from "../cdp.ts";
import { spawnChild } from "../child.ts";
import { childEnv } from "../child-env.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dbPath = join(tmpdir(), `cg-idp-${crypto.randomUUID()}`, "idp.db");
const SECRET = "test-secret-".padEnd(48, "x");

/** As a human types it into `bun run users add`, copying the Arcade invite. */
const CONFIGURED = "Alice@Bank.Example";
const STORED = CONFIGURED.toLowerCase();
/** This test's own throwaway password, given to `users add`. */
const PASSWORD = "capitalised-address-test-password";

let child: Subprocess;
let baseUrl: string;

/** Better Auth's own endpoint, called the way its client calls it. */
async function signIn(email: string, password = PASSWORD): Promise<Response> {
  return fetch(`${baseUrl}/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email, password }),
  });
}

beforeAll(async () => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const add = spawnChild(
    [
      "bun",
      "--no-env-file",
      join(ROOT, "scripts", "users.ts"),
      "add",
      CONFIGURED,
      "--name",
      "Alice",
      "--role",
      "loan_officer",
      "--clearance",
      "50000",
      "--password",
      PASSWORD,
    ],
    {
      cwd: ROOT,
      env: childEnv({ IDP_DB_PATH: dbPath, GOVERNANCE_DB_PATH: join(dirname(dbPath), "governance.db") }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [addOut, addErr, addCode] = await Promise.all([
    new Response(add.stdout).text(),
    new Response(add.stderr).text(),
    add.exited,
  ]);
  if (addCode !== 0) throw new Error(`users add exited ${addCode}:\n${addOut}\n${addErr}`);

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("IDP_"),
    ),
  ) as Record<string, string>;

  // On a port chosen inside `serveOnFreePort`, which starts the provider again
  // on a new one if another process took it first (#9).
  const booted = await serveOnFreePort(
    (port) =>
      spawnChild(["bun", join(ROOT, "scripts", "identity.ts")], {
        env: {
          ...inherited,
          PORT: String(port),
          IDP_DB_PATH: dbPath,
          APP_PUBLIC_HOST: `127.0.0.1:${port}`,
          IDP_OAUTH_REDIRECT_URIS: "http://127.0.0.1:9/callback",
          BETTER_AUTH_SECRET: SECRET,
        },
        stdout: "pipe",
        stderr: "pipe",
      }),
    { ready: async (port) => (await fetch(`http://127.0.0.1:${port}/identity/health`)).ok, timeoutMs: 20_000 },
  ).catch((error: unknown) => {
    throw new Error(`idp did not come up:\n${(error as Error).message}`);
  });
  child = booted.child;
  baseUrl = `http://127.0.0.1:${booted.port}`;
});

afterAll(() => {
  child?.kill();
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

describe("a person added with a capitalised address", () => {
  test("can sign in with the address exactly as it was typed", async () => {
    const response = await signIn(CONFIGURED);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { user?: { email?: string } };
    expect(body.user?.email).toBe(STORED);
  });

  test("can sign in with the lowercase form too — the same person, either way", async () => {
    expect((await signIn(STORED)).status).toBe(200);
  });

  test("a wrong password is still refused, so the 200 above is not a blanket pass", async () => {
    expect((await signIn(CONFIGURED, "not-it")).status).toBe(401);
  });

  test("the row that was written is lowercase, so the join key is byte-equal downstream", async () => {
    // A second connection to the same file: the service is still holding it,
    // and this is only a read.
    const db = new Database(dbPath, { readonly: true });
    try {
      const emails = db.query<{ email: string }, []>('SELECT "email" FROM "user"').all();
      expect(emails.map((row) => row.email)).toContain(STORED);
      expect(emails.some((row) => /[A-Z]/.test(row.email))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("the login page a browser posts to accepts it as well", async () => {
    const response = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ email: CONFIGURED, password: PASSWORD }).toString(),
      redirect: "manual",
    });

    // 303 back to `/` — signed in, with no OAuth flow to continue. A 401 here
    // is the bug: the page cannot tell an unreachable row from a bad password.
    expect(response.status).toBe(303);
  });
});
