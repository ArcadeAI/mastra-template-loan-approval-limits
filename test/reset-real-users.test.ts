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
 * The app is booted the way a presenter runs it (`test/app.ts`), with nobody
 * in it (#33), and the demo cast is added with `bun run users seed-demo` and a
 * person with `bun run users add` itself (#31), each a subprocess writing the
 * two files the running app has open. Bob is removed with `bun run users remove`
 * and brought back with `bun run users seed-demo`, the same way. The reset command
 * then runs as a subprocess, and what survived is read back over the app's own
 * HTTP surfaces: a sign-in with the password she was given, a `/hooks/pre`
 * decision on her clearance, the roster the pages read. The disk is read only
 * for what no route exposes — whether a session row is still there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Server } from "bun";
import { join } from "node:path";

import { spawnChild } from "../app-test/child.ts";
import { childEnv } from "../app-test/child-env.ts";
import { bootApp, type App } from "./app.ts";

const ROOT = join(import.meta.dir, "..");
const RESET_TOKEN = "real-users-reset-token-for-tests";
const HOOK_SECRET = "real-users-hook-secret-for-tests";
const STORE_TOKEN = "real-users-store-token-for-tests";
/** This file's own throwaway password for the demo cast, handed to `seed-demo`. */
const DEMO_PASSWORD = "real-users-demo-cast-password";

/** The demo cast's addresses on this app: the fixture's, which is what makes them the demo cast's (#33). */
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

/**
 * `bun run users …` (#31), run the way an operator runs it: a subprocess
 * against this app's two database files, with nothing else from this shell.
 */
async function users(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = spawnChild(["bun", "--no-env-file", join(ROOT, "scripts", "users.ts"), ...args], {
    cwd: ROOT,
    env: childEnv({ IDP_DB_PATH: app.databases.idp, GOVERNANCE_DB_PATH: app.databases.governance }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`bun run users ${args.join(" ")} exited ${code}:\n${out}\n${err}`);
  return { code, out, err };
}

/** The app's own readiness page, which carries `fixture_drift` (DESIGN.md → Readiness). */
async function drift(): Promise<{ ids: string[]; changed: string[]; missing: string[] } | null> {
  const body = (await (await fetch(`${app.origin}/health`)).json()) as { fixture_drift: never };
  return body.fixture_drift;
}

/** The same page's `user_drift` (#33): who can sign in with no subject, and the reverse. */
async function userDrift(): Promise<{
  ids: string[];
  identity_without_subject: string[];
  subject_without_identity: string[];
} | null> {
  const body = (await (await fetch(`${app.origin}/health`)).json()) as { user_drift: never };
  return body.user_drift;
}

/** Waits for a condition the policy cache reaches on its next poll. */
async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(100);
  }
  throw new Error("the control plane never served the change that was written");
}

/** Waits a policy poll or two for the cache to see a write made from another connection. */
async function untilDrift(predicate: (value: Awaited<ReturnType<typeof drift>>) => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate(await drift())) return;
    await Bun.sleep(100);
  }
  throw new Error(`fixture_drift never reached the expected state: ${JSON.stringify(await drift())}`);
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

  // A first boot seeds nobody (#33). The demo cast comes in the way an
  // operator brings it in, at the fixture's addresses.
  const seeded = await users([
    "seed-demo", "--alice", ALICE, "--bob", BOB, "--charlie", "charlie@bank.example",
    "--michael", "michael@bank.example", "--password", DEMO_PASSWORD,
  ]);
  expect(seeded.out).toContain(`Alice: added ${ALICE}`);
  expect(seeded.out).not.toContain("real user");

  await users([
    "add", PRIYA.email, "--name", PRIYA.name, "--role", PRIYA.role,
    "--clearance", String(PRIYA.clearance), "--password", PRIYA.password,
  ]);
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

describe("drift, with a user `bun run users add` created (#32)", () => {
  test("she is not drift, and a hand-edited demo row beside her still is", async () => {
    await untilDrift((value) => value === null);

    const governance = new Database(app.databases.governance);
    governance.run("UPDATE subjects SET clearance = 250000 WHERE user_id = ?", [ALICE]);
    governance.close();
    await untilDrift((value) => value !== null);
    const found = await drift();
    expect(found?.ids).toEqual([`subjects:${ALICE}`]);
    expect(found?.changed).toEqual([`subjects:${ALICE}`]);

    // Put back by hand, so the next test starts from the fixture.
    const back = new Database(app.databases.governance);
    back.run("UPDATE subjects SET clearance = 50000 WHERE user_id = ?", [ALICE]);
    back.close();
    await untilDrift((value) => value === null);
  }, 60_000);

  // Changed by #33: this was `fixture_drift` missing, and a reset wrote the
  // row back. A demo row that is absent is no longer fixture drift, and a reset
  // no longer adds anybody. What is wrong here is that Charlie can still sign
  // in with no subject, and that is `user_drift`.
  test("a demo row deleted by hand is not fixture drift, and a reset does not add it back; user drift names it", async () => {
    const CHARLIE = "charlie@bank.example";
    const governance = new Database(app.databases.governance);
    governance.run("DELETE FROM subjects WHERE user_id = ?", [CHARLIE]);
    governance.close();
    await until(async () => (await userDrift()) !== null);
    expect(await userDrift()).toEqual({
      ids: [`identity-without-subject:${CHARLIE}`],
      identity_without_subject: [CHARLIE],
      subject_without_identity: [],
    });
    expect(await drift()).toBeNull();
    const health = (await (await fetch(`${app.origin}/health`)).json()) as { status: string; warnings: string[] };
    expect(health.status).toBe("degraded");
    expect(health.warnings.join(" ")).toContain(`${CHARLIE} can sign in but has no subject in governance.db`);

    const { code, out } = await runReset();
    expect(code).toBe(0);
    const hooksLine = out.split("\n").find((line) => line.startsWith("[reset] hooks "));
    expect(hooksLine).toContain(`demo cast's subjects put back to the demo's roles and clearances (${ALICE}, ${BOB}, michael@bank.example)`);
    expect((await roster()).some((entry) => entry.user_id === CHARLIE)).toBe(false);
    expect(await userDrift()).not.toBeNull();

    // Put back the way an operator would, so the next test starts whole.
    const back = new Database(app.databases.governance);
    back.run(
      "INSERT INTO subjects (user_id, display_name, role, clearance, attributes) VALUES (?, 'Charlie', 'vp_credit', 250000, '{}')",
      [CHARLIE],
    );
    back.close();
    await until(async () => (await userDrift()) === null);
    expect(await drift()).toBeNull();

    // And the other direction: a subject with nobody who can sign in as it,
    // which approval routing could still pick.
    const GHOST = "ghost@company.test";
    const ghost = new Database(app.databases.governance);
    ghost.run(
      "INSERT INTO subjects (user_id, display_name, role, clearance, attributes) VALUES (?, 'Ghost', 'vp_credit', 300000, '{}')",
      [GHOST],
    );
    ghost.close();
    await until(async () => (await userDrift()) !== null);
    expect(await userDrift()).toEqual({
      ids: [`subject-without-identity:${GHOST}`],
      identity_without_subject: [],
      subject_without_identity: [GHOST],
    });
    const gone = new Database(app.databases.governance);
    gone.run("DELETE FROM subjects WHERE user_id = ?", [GHOST]);
    gone.close();
    await until(async () => (await userDrift()) === null);
  }, 60_000);
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
    // A demo persona whose name was edited. Until #33 the hard reset put it
    // back from the fixture; now every account is kept exactly as it is.
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
    expect(idpLine).toContain(
      `nobody deleted, 5 accounts kept with the password each already had (${ALICE}, ${BOB}, charlie@bank.example, michael@bank.example, ${PRIYA.email})`,
    );
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

    // Changed by #33: the demo cast is kept as it is, edited name included,
    // with the password `seed-demo` gave it.
    expect(idpRow(ALICE)?.name).toBe("Alice (edited)");
    expect((await signIn(ALICE, DEMO_PASSWORD)).status).toBe(200);
  }, 60_000);

  test("Bob removed with `bun run users remove` has neither half after either reset, and is not drift", async () => {
    await users(["remove", BOB]);
    expect(idpRow(BOB)).toBeNull();
    // Served from the policy cache, which sees the removal on its next poll.
    await until(async () => !(await roster()).some((entry) => entry.user_id === BOB));
    // A removal recorded in subject_changes is intent, not drift.
    await untilDrift((value) => value === null);

    for (const args of [[], ["--hard"]]) {
      const { code, out } = await runReset(args);
      expect(code).toBe(0);
      const hooksLine = out.split("\n").find((line) => line.startsWith("[reset] hooks "));
      // Changed by #33: the line names the demo cast it put back, which is
      // everybody on disk but Bob, instead of naming Bob as removed.
      expect(hooksLine).toContain(`demo cast's subjects put back to the demo's roles and clearances (${ALICE}, charlie@bank.example, michael@bank.example)`);
      expect(hooksLine).not.toContain(BOB);

      expect(idpRow(BOB)).toBeNull();
      expect((await roster()).some((entry) => entry.user_id === BOB)).toBe(false);
      expect((await signIn(BOB, DEMO_PASSWORD)).status).toBe(401);
      expect(await drift()).toBeNull();
    }
    const hard = await runReset(["--hard"]);
    const idpLine = hard.out.split("\n").find((line) => line.startsWith("[reset] idp "));
    expect(idpLine).toContain(`4 accounts kept with the password each already had (${ALICE}, charlie@bank.example, michael@bank.example, ${PRIYA.email})`);
    expect((await signIn(PRIYA.email, PRIYA.password)).status).toBe(200);
    expect(await userDrift()).toBeNull();
  }, 90_000);

  test("Bob removed, then `bun run users seed-demo`, is back as a user with no drift", async () => {
    const { out } = await users([
      "seed-demo", "--alice", ALICE, "--bob", BOB, "--charlie", "charlie@bank.example",
      "--michael", "michael@bank.example", "--password", "bob-is-back-2026",
    ]);
    expect(out).toContain(`Bob: added ${BOB}`);
    await until(async () => (await roster()).some((entry) => entry.user_id === BOB));
    await untilDrift((value) => value === null);
    expect((await roster()).find((entry) => entry.user_id === BOB)?.role).toBe("credit_analyst");
    expect((await signIn(BOB, "bob-is-back-2026")).status).toBe(200);

    // Present again, so both resets treat him as the demo cast once more.
    const { code, out: hardOut } = await runReset(["--hard"]);
    expect(code).toBe(0);
    expect(hardOut).toContain(
      `demo cast's subjects put back to the demo's roles and clearances (${ALICE}, ${BOB}, charlie@bank.example, michael@bank.example)`,
    );
    expect(hardOut).toContain(`5 accounts kept with the password each already had (${ALICE}, ${BOB}, charlie@bank.example`);
    expect((await roster()).some((entry) => entry.user_id === BOB)).toBe(true);
    expect(await drift()).toBeNull();
  }, 90_000);
});
