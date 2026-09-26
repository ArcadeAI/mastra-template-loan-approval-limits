/**
 * A real user survives `bun run reset` and `bun run reset --hard` (#32).
 *
 * Before #32 the hard reset deleted every person in `idp.db` and seeded the
 * four personas again, and both scopes replaced every `subjects` row in
 * `governance.db` from the fixture. That was right while the cast was only
 * ever the fixture's. Since #31 an operator adds people with `bun run users`,
 * and a reset meant to put the *demo* back would have deleted every one of
 * them: their account gone, their role gone, and every governed call they made
 * afterwards refused as an identity nobody registered.
 *
 * The app is booted the way a presenter runs it (`test/app.ts`), and a person
 * is added the way `bun run users add` adds one: a `user` row with a
 * `credential` account in `idp.db`, and a `subjects` row in `governance.db`,
 * written straight into the files the running app has open. The reset command
 * then runs as a subprocess, and what survived is read back over the app's own
 * HTTP surfaces: a sign-in with the password she was given, a `/hooks/pre`
 * decision on her clearance, the roster the pages read. The disk is read only
 * for what no route exposes — whether a session row is still there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Server } from "bun";
import { hashPassword } from "better-auth/crypto";
import { join } from "node:path";

import { spawnChild } from "../app-test/child.ts";
import { bootApp, type App } from "./app.ts";

const ROOT = join(import.meta.dir, "..");
const RESET_TOKEN = "real-users-reset-token-for-tests";
const HOOK_SECRET = "real-users-hook-secret-for-tests";
const STORE_TOKEN = "real-users-store-token-for-tests";
const DEMO_PASSWORD = "megaforce-demo-2026";

/** The demo cast's addresses on this app: the fixture's, since no PERSONA_* is set. */
const ALICE = "alice@bank.example";
const BOB = "bob@bank.example";

/** Somebody `bun run users add` put in: over Alice's limit, with authority for the $95K. */
const PRIYA = {
  email: "priya@company.test",
  name: "Priya",
  password: "priya-chose-this-one",
  role: "vp_credit",
  clearance: 400_000,
};

let app: App;
let userinfo: Server<unknown>;

async function runReset(args: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const proc = spawnChild(["bun", join(ROOT, "scripts", "reset.ts"), ...args], {
    cwd: ROOT,
    env: { ...process.env, RESET_TOKEN, APP_PUBLIC_HOST: app.host },
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

/** What `bun run users add` writes (#31), with the password hashed the way the seed hashes it. */
async function addRealUser(): Promise<void> {
  const passwordHash = await hashPassword(PRIYA.password);
  const idp = new Database(app.databases.idp);
  try {
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    idp.transaction(() => {
      idp.run(
        `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)`,
        [userId, PRIYA.name, PRIYA.email, now, now],
      );
      idp.run(
        `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
        [crypto.randomUUID(), userId, userId, passwordHash, now, now],
      );
    })();
  } finally {
    idp.close();
  }
  const governance = new Database(app.databases.governance);
  try {
    governance.run(
      "INSERT INTO subjects (user_id, display_name, role, clearance, attributes) VALUES (?, ?, ?, ?, '{}')",
      [PRIYA.email, PRIYA.name, PRIYA.role, PRIYA.clearance],
    );
  } finally {
    governance.close();
  }
}

/** Better Auth's own sign-in, as the login form calls it. */
const signIn = (email: string, password: string) =>
  fetch(`${app.origin}/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.origin },
    body: JSON.stringify({ email, password }),
  });

/** A `/hooks/pre` decision for this person approving the $95K. */
async function approve95k(userId: string): Promise<unknown> {
  const response = await fetch(`${app.origin}/hooks/pre`, {
    method: "POST",
    headers: { authorization: `Bearer ${HOOK_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({
      execution_id: `tc_${crypto.randomUUID()}`,
      tool: { name: "ApproveLoan", toolkit: "Loan", version: "1.0.0" },
      inputs: { loan_id: "LN-2291", amount: 95_000 },
      context: { authorization: [{}], user_id: userId },
    }),
  });
  return response.json();
}

interface RosterEntry {
  user_id: string;
  display_name: string;
  role: string;
  clearance: number;
  attributes: Record<string, unknown>;
}

/** The roster the pages read (`lib/identity/roster.ts`). */
async function roster(): Promise<RosterEntry[]> {
  const response = await fetch(`${app.origin}/api/approvals/roster`, {
    headers: { authorization: `Bearer ${STORE_TOKEN}` },
  });
  return ((await response.json()) as { subjects: RosterEntry[] }).subjects;
}

async function priyaInRoster(): Promise<RosterEntry | undefined> {
  return (await roster()).find((entry) => entry.user_id === PRIYA.email);
}

/** The policy cache picks a new row up on its poll; wait for it rather than for a fixed time. */
async function untilServed(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await priyaInRoster()) !== undefined) return;
    await Bun.sleep(100);
  }
  throw new Error("the control plane never served the subjects row that was added");
}

/** Session rows on disk for one address. No route answers this, on purpose (`/get-session` is not mounted). */
function sessionsFor(email: string): number {
  const idp = new Database(app.databases.idp, { readonly: true });
  try {
    return (
      idp
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM "session" s JOIN "user" u ON u."id" = s."userId" WHERE u."email" = ?`,
        )
        .get(email)?.n ?? 0
    );
  } finally {
    idp.close();
  }
}

function idpRow(email: string): { name: string } | null {
  const idp = new Database(app.databases.idp, { readonly: true });
  try {
    return idp.query<{ name: string }, [string]>(`SELECT "name" FROM "user" WHERE "email" = ?`).get(email);
  } finally {
    idp.close();
  }
}

const EXPECTED_PRIYA_ROW: RosterEntry = {
  user_id: PRIYA.email,
  display_name: PRIYA.name,
  role: PRIYA.role,
  clearance: PRIYA.clearance,
  attributes: {},
};

beforeAll(async () => {
  // The token endpoint the loan module reads the actor off, and nothing else:
  // the loan book is reset here, never read as anybody.
  userinfo = Bun.serve({ port: 0, fetch: () => new Response("invalid_token", { status: 401 }) });

  app = await bootApp({
    RESET_TOKEN,
    ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET,
    APPROVALS_STORE_TOKEN: STORE_TOKEN,
    BETTER_AUTH_SECRET: "real-users-test-secret-".padEnd(48, "x"),
    IDP_OAUTH_REDIRECT_URIS: `http://127.0.0.1:${userinfo.port}/callback`,
    IDENTITY_HOST: `127.0.0.1:${userinfo.port}`,
  });

  await addRealUser();
  await untilServed();
}, 240_000);

afterAll(async () => {
  await app?.stop();
  userinfo?.stop(true);
});

describe("before any reset, the added user is a user", () => {
  test("she signs in, and the control plane decides on her clearance", async () => {
    expect((await signIn(PRIYA.email, PRIYA.password)).status).toBe(200);
    expect(await approve95k(PRIYA.email)).toEqual({ code: "OK" });
    // And the $95K is still over Alice's limit, so the allow above is Priya's
    // clearance and not a policy that permits everybody.
    expect(await approve95k(ALICE)).toMatchObject({ code: "CHECK_FAILED" });
  });
});

describe("`bun run reset` keeps her", () => {
  test("her subjects row is untouched, she is still served, and the output names her", async () => {
    // A stage edit to a demo row, which this reset is meant to undo.
    const governance = new Database(app.databases.governance);
    governance.run("UPDATE subjects SET clearance = 250000 WHERE user_id = ?", [ALICE]);
    governance.close();

    const sessionsBefore = sessionsFor(PRIYA.email);
    expect(sessionsBefore).toBeGreaterThan(0);

    const { code, out, err } = await runReset();
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain(`1 added by \`bun run users\` kept (${PRIYA.email})`);

    expect(await priyaInRoster()).toEqual(EXPECTED_PRIYA_ROW);
    expect((await roster()).find((entry) => entry.user_id === ALICE)?.clearance).toBe(50_000);
    expect(await approve95k(PRIYA.email)).toEqual({ code: "OK" });
    // The default scope leaves identity alone entirely: still signed in.
    expect(sessionsFor(PRIYA.email)).toBe(sessionsBefore);
    expect((await signIn(PRIYA.email, PRIYA.password)).status).toBe(200);

    // And her row is not drift, so /health is not degraded by her existing.
    const health = (await (await fetch(`${app.origin}/hooks/health`)).json()) as { fixture_drift: unknown };
    expect(health.fixture_drift).toBeNull();
  }, 60_000);
});

describe("`bun run reset --hard` keeps her too, and signs everybody out", () => {
  test("her account and password survive, her session does not, and the output says both", async () => {
    // A demo persona whose name was edited, which the hard reset puts back.
    const idp = new Database(app.databases.idp);
    idp.run(`UPDATE "user" SET "name" = 'Alice (edited)' WHERE "email" = ?`, [ALICE]);
    idp.close();
    expect((await signIn(ALICE, DEMO_PASSWORD)).status).toBe(200);
    expect(sessionsFor(PRIYA.email)).toBeGreaterThan(0);
    expect(sessionsFor(ALICE)).toBeGreaterThan(0);

    const { code, out, err } = await runReset(["--hard"]);
    expect(err).toBe("");
    expect(code).toBe(0);

    const idpLine = out.split("\n").find((line) => line.startsWith("[reset] idp "));
    expect(idpLine).toContain("OK  everyone signed out");
    expect(idpLine).toContain(`demo cast re-seeded (${ALICE}, ${BOB}, charlie@bank.example, michael@bank.example)`);
    expect(idpLine).toContain(`1 user added by \`bun run users\` kept (${PRIYA.email})`);
    expect(idpLine).toContain("people 5→5");
    expect(out).toContain("Everyone is signed out");

    // Everybody signed out: no session row for anybody.
    expect(sessionsFor(PRIYA.email)).toBe(0);
    expect(sessionsFor(ALICE)).toBe(0);

    // She is still a user, with the password she was given, not the demo's.
    expect((await signIn(PRIYA.email, PRIYA.password)).status).toBe(200);
    expect((await signIn(PRIYA.email, DEMO_PASSWORD)).status).toBe(401);
    expect(idpRow(PRIYA.email)?.name).toBe(PRIYA.name);
    // And still a subject, served on her own clearance.
    expect(await priyaInRoster()).toEqual(EXPECTED_PRIYA_ROW);
    expect(await approve95k(PRIYA.email)).toEqual({ code: "OK" });

    // The demo cast is back the way the fixture seeds it.
    expect(idpRow(ALICE)?.name).toBe("Alice");
    expect((await signIn(ALICE, DEMO_PASSWORD)).status).toBe(200);
  }, 60_000);

  test("a demo persona that was removed stays removed: the cast is re-seeded only if it was seeded", async () => {
    // What `bun run users remove bob@…` leaves behind: no user, no account.
    const idp = new Database(app.databases.idp);
    idp.run("PRAGMA foreign_keys = ON");
    idp.run(`DELETE FROM "user" WHERE "email" = ?`, [BOB]);
    idp.close();
    expect(idpRow(BOB)).toBeNull();

    const { code, out } = await runReset(["--hard"]);
    expect(code).toBe(0);
    const idpLine = out.split("\n").find((line) => line.startsWith("[reset] idp "));
    expect(idpLine).toContain(`demo cast re-seeded (${ALICE}, charlie@bank.example, michael@bank.example)`);
    expect(idpLine).toContain("people 4→4");

    expect(idpRow(BOB)).toBeNull();
    expect((await signIn(BOB, DEMO_PASSWORD)).status).toBe(401);
    expect((await signIn(PRIYA.email, PRIYA.password)).status).toBe(200);
  }, 60_000);
});
