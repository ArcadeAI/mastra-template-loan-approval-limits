/**
 * `bun run users` (#31), driven the way a person drives it: the command, in a
 * child process, against a fresh pair of databases, read back afterwards.
 *
 * What the app does with the rows (sign-in, `/hooks/pre`, the policy poll) is
 * `users-live.test.ts`, against the real app. This file is the command's own
 * contract: both halves or neither, the role read from the policy, every
 * change recorded, and the password never kept.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyPassword } from "better-auth/crypto";

import { childEnv } from "./child-env.ts";
import { spawnChild } from "./child.ts";

const ROOT = join(import.meta.dir, "..");
const INVITE = "Arcade dashboard (https://api.arcade.dev/dashboard), your project, Members: invite";

const scratch = mkdtempSync(join(tmpdir(), "cg-users-cli-"));
let dir = "";

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => {
  dir = mkdtempSync(join(scratch, "case-"));
});

const idpPath = () => join(dir, "idp.db");
const governancePath = () => join(dir, "governance.db");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The command, with nothing from this checkout's `.env` files: `--no-env-file`,
 * and an allowlisted environment naming this case's two databases.
 */
async function users(args: string[], stdin?: string): Promise<Run> {
  const child = spawnChild(["bun", "--no-env-file", "scripts/users.ts", ...args], {
    cwd: ROOT,
    env: childEnv({ IDP_DB_PATH: idpPath(), GOVERNANCE_DB_PATH: governancePath() }),
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function ok(args: string[], stdin?: string): Promise<Run> {
  const run = await users(args, stdin);
  if (run.code !== 0) throw new Error(`users ${args.join(" ")} exited ${run.code}\n${run.stdout}\n${run.stderr}`);
  return run;
}

function query<T>(path: string, sql: string, ...params: string[]): T[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<T, string[]>(sql).all(...params);
  } finally {
    db.close();
  }
}

const person = (email: string) =>
  query<{ id: string; name: string; email: string }>(idpPath(), 'SELECT id, name, email FROM "user" WHERE email = ?', email)[0];
const credential = (userId: string) =>
  query<{ providerId: string; password: string }>(
    idpPath(),
    'SELECT providerId, password FROM "account" WHERE userId = ?',
    userId,
  );
const subject = (email: string) =>
  query<{ user_id: string; display_name: string; role: string; clearance: number }>(
    governancePath(),
    "SELECT user_id, display_name, role, clearance FROM subjects WHERE user_id = ?",
    email,
  )[0];
const changes = (email?: string) =>
  query<Record<string, string | number | null>>(
    governancePath(),
    email === undefined
      ? "SELECT * FROM subject_changes ORDER BY seq"
      : "SELECT * FROM subject_changes WHERE user_id = ? ORDER BY seq",
    ...(email === undefined ? [] : [email]),
  );
const counts = () => ({
  people: query<{ n: number }>(idpPath(), 'SELECT COUNT(*) AS n FROM "user"')[0]!.n,
  subjects: query<{ n: number }>(governancePath(), "SELECT COUNT(*) AS n FROM subjects")[0]!.n,
  changes: query<{ n: number }>(governancePath(), "SELECT COUNT(*) AS n FROM subject_changes")[0]!.n,
});

/** Opens both databases once, the way the app's first boot would, so a refusal test has something to compare. */
async function bootstrap(): Promise<void> {
  await ok(["list"]);
}

/** The generated password `add` printed, and how many times it appears. */
function printedPassword(stdout: string): string {
  const match = stdout.match(/^ {2}password {3}(\S+)$/m);
  if (!match) throw new Error(`no password line in:\n${stdout}`);
  return match[1]!;
}

/** Raw bytes of a database and its WAL, so "not on disk" covers pages not yet checkpointed. */
function onDisk(path: string): string {
  return ["", "-wal", "-shm"]
    .map((suffix) => (existsSync(path + suffix) ? readFileSync(path + suffix).toString("latin1") : ""))
    .join("");
}

function plant(path: string, sql: string): void {
  const db = new Database(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe("users add", () => {
  test("creates the identity and the subject, lowercased, and prints the change row", async () => {
    const run = await ok(["add", "Dana.Lee@Example.COM", "--name", "Dana Lee", "--role", "loan_officer", "--clearance", "75000"]);

    const who = person("dana.lee@example.com");
    expect(who).toMatchObject({ name: "Dana Lee", email: "dana.lee@example.com" });
    const accounts = credential(who!.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.providerId).toBe("credential");

    expect(subject("dana.lee@example.com")).toEqual({
      user_id: "dana.lee@example.com",
      display_name: "Dana Lee",
      role: "loan_officer",
      clearance: 75000,
    });

    const [row] = changes("dana.lee@example.com");
    expect(row).toMatchObject({
      action: "add",
      role_before: null,
      role_after: "loan_officer",
      clearance_before: null,
      clearance_after: 75000,
    });
    expect(String(row!.id)).toMatch(/^chg_[0-9a-z]{10}$/);
    expect(String(row!.actor)).toStartWith("cli:");
    // The row it wrote is the row it printed.
    expect(run.stdout).toContain(
      `subject_changes #${row!.seq} ${row!.id} at ${row!.ts} by ${row!.actor}: add dana.lee@example.com, ` +
        `role (none) -> loan_officer, clearance (none) -> 75000`,
    );
  });

  test("a generated password is printed once, verifies against the stored hash, and is nowhere on disk", async () => {
    const run = await ok(["add", "erin@example.com", "--name", "Erin", "--role", "vp_credit", "--clearance", "250000"]);
    const password = printedPassword(run.stdout);
    expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(run.stdout.split(password)).toHaveLength(2);
    expect(run.stderr).not.toContain(password);

    const [account] = credential(person("erin@example.com")!.id);
    // Hashed the way the seed hashes (`hashPassword` in `db.ts`), so Better Auth's own verifier accepts it.
    expect(await verifyPassword({ hash: account!.password, password })).toBe(true);
    expect(account!.password).not.toContain(password);

    for (const path of [idpPath(), governancePath()]) expect(onDisk(path)).not.toContain(password);
  });

  test("--password is used as given and not echoed", async () => {
    const run = await ok([
      "add", "finn@example.com", "--name", "Finn", "--role", "loan_officer", "--clearance", "1000", "--password", "correct-horse-battery",
    ]);
    expect(run.stdout).not.toContain("correct-horse-battery");
    expect(run.stdout).not.toMatch(/^ {2}password /m);
    const [account] = credential(person("finn@example.com")!.id);
    expect(await verifyPassword({ hash: account!.password, password: "correct-horse-battery" })).toBe(true);
  });

  test("without --role it refuses before writing anything", async () => {
    await bootstrap();
    const before = counts();
    const run = await users(["add", "gil@example.com", "--name", "Gil", "--clearance", "5"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--role is required");
    expect(counts()).toEqual(before);
    expect(person("gil@example.com")).toBeUndefined();
  });

  test("a role the policy does not know is refused, naming the ones it does, and nothing is written", async () => {
    await bootstrap();
    const before = counts();
    const run = await users(["add", "gil@example.com", "--name", "Gil", "--role", "janitor", "--clearance", "5"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      'role "janitor" is not one the policy knows: chief_credit_officer, credit_analyst, loan_officer, vp_credit',
    );
    expect(counts()).toEqual(before);
  });

  test("the roles come from the policy: a role a rule names is accepted, and a role outlives its last holder", async () => {
    await bootstrap();
    plant(
      governancePath(),
      `INSERT INTO policy_rules (id, description, hook, toolkit, tool, subjects, conditions, effect, reason, priority)
       VALUES ('access.auditors-cannot-see-deny', '', 'access', 'Loan', 'DenyLoan',
               '{"user_ids":null,"roles":["auditor"],"clearance_below":null,"clearance_at_least":null}',
               '[]', 'deny', 'Auditors do not deny loans.', 20)`,
    );
    await ok(["add", "hana@example.com", "--name", "Hana", "--role", "auditor", "--clearance", "0"]);
    expect(subject("hana@example.com")?.role).toBe("auditor");

    // Every loan officer gone from governance.db: the role is still the fixture's.
    plant(governancePath(), "DELETE FROM subjects WHERE role = 'loan_officer'");
    await ok(["add", "ivan@example.com", "--name", "Ivan", "--role", "loan_officer", "--clearance", "10"]);
  });

  test("--clearance defaults to 0 for credit_analyst only, and must be a non-negative whole number", async () => {
    const analyst = await ok(["add", "jo@example.com", "--name", "Jo", "--role", "credit_analyst"]);
    expect(analyst.stdout).toContain("clearance 0");
    expect(subject("jo@example.com")?.clearance).toBe(0);

    for (const role of ["loan_officer", "vp_credit", "chief_credit_officer"]) {
      const run = await users(["add", `k.${role}@example.com`, "--name", "K", "--role", role]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(`--clearance is required for role ${role}`);
      expect(person(`k.${role}@example.com`)).toBeUndefined();
    }

    for (const clearance of ["-1", "1.5", "50k", ""]) {
      const run = await users(["add", "lee@example.com", "--name", "Lee", "--role", "loan_officer", `--clearance=${clearance}`]);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("is not a non-negative whole number");
    }
    expect(person("lee@example.com")).toBeUndefined();
  });

  test("the implied 0 is the policy's: without the access rule, credit_analyst needs --clearance too", async () => {
    await bootstrap();
    plant(governancePath(), "UPDATE policy_rules SET enabled = 0 WHERE id = 'access.analysts-cannot-see-approve'");
    const run = await users(["add", "mo@example.com", "--name", "Mo", "--role", "credit_analyst"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--clearance is required for role credit_analyst");
  });

  test("an address either half already holds is refused, and nothing changes", async () => {
    await ok(["add", "nia@example.com", "--name", "Nia", "--role", "loan_officer", "--clearance", "1"]);
    const before = counts();
    const again = await users(["add", "NIA@example.com", "--name", "Nia", "--role", "vp_credit", "--clearance", "2"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("nia@example.com already exists");

    plant(governancePath(), "DELETE FROM subjects WHERE user_id = 'nia@example.com'");
    const half = await users(["add", "nia@example.com", "--name", "Nia", "--role", "vp_credit", "--clearance", "2"]);
    expect(half.code).toBe(1);
    expect(half.stderr).toContain("half there: an identity in idp.db but no subject");
    expect(counts()).toEqual({ ...before, subjects: before.subjects - 1 });
  });

  test("both halves or neither: a subject that cannot be written takes the identity back out", async () => {
    await bootstrap();
    plant(
      governancePath(),
      "CREATE TRIGGER planted_refusal BEFORE INSERT ON subjects BEGIN SELECT RAISE(ABORT, 'planted refusal'); END;",
    );
    const before = counts();
    const run = await users(["add", "omar@example.com", "--name", "Omar", "--role", "loan_officer", "--clearance", "1"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("planted refusal");
    expect(run.stderr).toContain("the identity was removed again and nothing was added");
    expect(person("omar@example.com")).toBeUndefined();
    expect(counts()).toEqual(before);
    // And no password was handed out for an account that does not exist.
    expect(run.stdout).not.toMatch(/password/);
  });
});

describe("the Arcade invite reminder", () => {
  test("names the email for every role that can request an approval", async () => {
    const roles = { loan_officer: "5", credit_analyst: "0", vp_credit: "5", chief_credit_officer: "5" };
    for (const [role, clearance] of Object.entries(roles)) {
      const email = `req.${role}@example.com`;
      const run = await ok(["add", email, "--name", "R", "--role", role, "--clearance", clearance]);
      expect(run.stdout).toContain(`${INVITE} ${email}`);
      expect(run.stdout).toContain(`${email} can request approvals`);
    }
  });

  test("is not printed for a role the policy hides the request tool from", async () => {
    await bootstrap();
    plant(
      governancePath(),
      `INSERT INTO policy_rules (id, description, hook, toolkit, tool, subjects, conditions, effect, reason, priority)
       VALUES ('access.analysts-cannot-request', '', 'access', 'Approvals', 'RequestApproval',
               '{"user_ids":null,"roles":["credit_analyst"],"clearance_below":null,"clearance_at_least":null}',
               '[]', 'deny', 'Analysts do not request approvals.', 11)`,
    );
    const analyst = await ok(["add", "pat@example.com", "--name", "Pat", "--role", "credit_analyst"]);
    expect(analyst.stdout).not.toContain(INVITE);
    const officer = await ok(["add", "quinn@example.com", "--name", "Quinn", "--role", "loan_officer", "--clearance", "5"]);
    expect(officer.stdout).toContain(`${INVITE} quinn@example.com`);
  });
});

describe("set-role and set-clearance", () => {
  test("each change writes a row, with before and after", async () => {
    await ok(["add", "rae@example.com", "--name", "Rae", "--role", "loan_officer", "--clearance", "50000"]);

    const clearance = await ok(["set-clearance", "Rae@Example.com", "75000"]);
    expect(subject("rae@example.com")?.clearance).toBe(75000);
    const role = await ok(["set-role", "rae@example.com", "vp_credit"]);
    expect(subject("rae@example.com")?.role).toBe("vp_credit");

    const rows = changes("rae@example.com");
    expect(rows.map((row) => row.action)).toEqual(["add", "set-clearance", "set-role"]);
    expect(rows[1]).toMatchObject({ role_before: "loan_officer", role_after: "loan_officer", clearance_before: 50000, clearance_after: 75000 });
    expect(rows[2]).toMatchObject({ role_before: "loan_officer", role_after: "vp_credit", clearance_before: 75000, clearance_after: 75000 });
    expect(clearance.stdout).toContain(`subject_changes #${rows[1]!.seq} ${rows[1]!.id}`);
    expect(role.stdout).toContain(`subject_changes #${rows[2]!.seq} ${rows[2]!.id}`);
  });

  test("no change, no row", async () => {
    await ok(["add", "sol@example.com", "--name", "Sol", "--role", "loan_officer", "--clearance", "10"]);
    const before = counts();
    expect((await ok(["set-clearance", "sol@example.com", "10"])).stdout).toContain("nothing recorded");
    expect((await ok(["set-role", "sol@example.com", "loan_officer"])).stdout).toContain("nothing recorded");
    expect(counts()).toEqual(before);
  });

  test("refuses an unknown role, a bad clearance and an unknown user, writing nothing", async () => {
    await ok(["add", "tao@example.com", "--name", "Tao", "--role", "loan_officer", "--clearance", "10"]);
    const before = counts();
    expect((await users(["set-role", "tao@example.com", "janitor"])).code).toBe(1);
    expect((await users(["set-clearance", "tao@example.com", "-3"])).code).toBe(2);
    const nobody = await users(["set-clearance", "nobody@example.com", "3"]);
    expect(nobody.code).toBe(1);
    expect(nobody.stderr).toContain("nobody@example.com has no subject");
    expect(counts()).toEqual(before);
    expect(subject("tao@example.com")).toMatchObject({ role: "loan_officer", clearance: 10 });
  });

  test("subject_changes is append-only", async () => {
    await ok(["add", "uma@example.com", "--name", "Uma", "--role", "loan_officer", "--clearance", "10"]);
    expect(() => plant(governancePath(), "UPDATE subject_changes SET clearance_after = 999")).toThrow(/append-only/);
    expect(() => plant(governancePath(), "DELETE FROM subject_changes")).toThrow(/append-only/);
    expect(changes("uma@example.com")).toHaveLength(1);
  });
});

describe("users remove", () => {
  test("deletes both halves and revokes every session and token", async () => {
    await ok(["add", "vic@example.com", "--name", "Vic", "--role", "loan_officer", "--clearance", "10"]);
    const { id } = person("vic@example.com")!;
    const clientId = query<{ clientId: string }>(idpPath(), 'SELECT clientId FROM "oauthClient" LIMIT 1')[0]?.clientId;
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    // A signed-in browser and an OAuth grant, as Better Auth writes them.
    plant(
      idpPath(),
      `INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('s1', '${later}', 'tok-s1', '${now}', '${now}', '${id}');
       INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('s2', '${later}', 'tok-s2', '${now}', '${now}', '${id}');
       INSERT INTO "oauthClient" (id, clientId, redirectUris) SELECT 'c-test', 'client-test', '[]' WHERE ${clientId === undefined ? 1 : 0};
       INSERT INTO "oauthRefreshToken" (id, token, clientId, sessionId, userId, expiresAt, createdAt, scopes)
         VALUES ('r1', 'tok-r1', '${clientId ?? "client-test"}', 's1', '${id}', '${later}', '${now}', 'openid');
       INSERT INTO "oauthAccessToken" (id, token, clientId, sessionId, userId, refreshId, expiresAt, createdAt, scopes)
         VALUES ('a1', 'tok-a1', '${clientId ?? "client-test"}', 's1', '${id}', 'r1', '${later}', '${now}', 'openid');
       INSERT INTO "oauthConsent" (id, clientId, userId, scopes, createdAt, updatedAt)
         VALUES ('k1', '${clientId ?? "client-test"}', '${id}', 'openid', '${now}', '${now}');`,
    );
    const clientsBefore = query<{ n: number }>(idpPath(), 'SELECT COUNT(*) AS n FROM "oauthClient"')[0]!.n;

    const run = await ok(["remove", "VIC@example.com"]);
    expect(run.stdout).toContain("2 session(s), 1 access token(s), 1 refresh token(s) and 1 consent(s) revoked");
    expect(person("vic@example.com")).toBeUndefined();
    expect(subject("vic@example.com")).toBeUndefined();
    for (const table of ["session", "account", "oauthAccessToken", "oauthRefreshToken", "oauthConsent"]) {
      expect(query<{ n: number }>(idpPath(), `SELECT COUNT(*) AS n FROM "${table}" WHERE userId = ?`, id)[0]!.n).toBe(0);
    }
    // The OAuth clients Arcade is registered against are not people.
    expect(query<{ n: number }>(idpPath(), 'SELECT COUNT(*) AS n FROM "oauthClient"')[0]!.n).toBe(clientsBefore);

    const last = changes("vic@example.com").at(-1);
    expect(last).toMatchObject({ action: "remove", role_before: "loan_officer", role_after: null, clearance_before: 10, clearance_after: null });
    expect(run.stdout).toContain(`subject_changes #${last!.seq} ${last!.id}`);
  });

  test("removes whichever half is there, and refuses an address with neither", async () => {
    await ok(["add", "wen@example.com", "--name", "Wen", "--role", "loan_officer", "--clearance", "10"]);
    plant(governancePath(), "DELETE FROM subjects WHERE user_id = 'wen@example.com'");
    const half = await ok(["remove", "wen@example.com"]);
    expect(half.stdout).toContain("subject    none in governance.db");
    expect(person("wen@example.com")).toBeUndefined();

    const none = await users(["remove", "wen@example.com"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("there is no user wen@example.com");
  });
});

describe("users list", () => {
  test("shows both halves side by side, and says what a half-present user cannot do", async () => {
    await ok(["add", "xan@example.com", "--name", "Xan", "--role", "vp_credit", "--clearance", "250000"]);
    await ok(["add", "yui@example.com", "--name", "Yui", "--role", "loan_officer", "--clearance", "5"]);
    plant(governancePath(), "DELETE FROM subjects WHERE user_id = 'yui@example.com'");
    const { stdout } = await ok(["list"]);
    expect(stdout).toMatch(/^xan@example\.com\s+Xan\s+vp_credit\s+250000\s+yes\s+yes$/m);
    expect(stdout).toMatch(/^yui@example\.com\s+Yui\s+-\s+-\s+yes\s+no\s+can sign in, but has no subject: denied at every hook$/m);
  });
});

describe("users seed-demo", () => {
  const FLAGS = ["--alice", "al@demo.test", "--bob", "bo@demo.test", "--charlie", "ch@demo.test", "--michael", "mi@demo.test"];
  const CAST = [
    ["al@demo.test", "Alice", "loan_officer", 50_000],
    ["bo@demo.test", "Bob", "credit_analyst", 0],
    ["ch@demo.test", "Charlie", "vp_credit", 250_000],
    ["mi@demo.test", "Michael", "chief_credit_officer", 5_000_000],
  ] as const;

  test("adds the four with today's roles and limits, each with a password and the invite reminder", async () => {
    const run = await ok(["seed-demo", ...FLAGS]);
    for (const [email, name, role, clearance] of CAST) {
      expect(person(email)?.name).toBe(name);
      expect(subject(email)).toEqual({ user_id: email, display_name: name, role, clearance });
      expect(changes(email).map((row) => row.action)).toEqual(["add"]);
      expect(run.stdout).toContain(`${INVITE} ${email}`);
    }
    expect(run.stdout.match(/^ {2}password {3}\S+$/gm)).toHaveLength(4);
  });

  test("is idempotent: a second run writes nothing and prints no password, and still reminds", async () => {
    await ok(["seed-demo", ...FLAGS]);
    const before = counts();
    const again = await ok(["seed-demo", ...FLAGS]);
    expect(counts()).toEqual(before);
    expect(again.stdout).not.toMatch(/password/);
    for (const [email] of CAST) {
      expect(again.stdout).toContain(`${email} already present`);
      expect(again.stdout).toContain(`${INVITE} ${email}`);
    }
  });

  test("asks for the emails it was not given", async () => {
    const run = await ok(["seed-demo", "--bob", "bo@demo.test"], "al@demo.test\nch@demo.test\nmi@demo.test\n");
    expect(run.stderr).toContain("Alice's email (loan_officer, clearance 50000): ");
    expect(run.stderr).not.toContain("Bob's email");
    for (const [email, , role] of CAST) expect(subject(email)?.role).toBe(role);
  });

  test("with no answers and no flags it refuses before writing anything", async () => {
    await bootstrap();
    const before = counts();
    const run = await users(["seed-demo", "--alice", "al@demo.test"], "");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("pass --alice, --bob, --charlie, --michael, or answer the prompts");
    expect(counts()).toEqual(before);
  });

  test("refuses the same email twice", async () => {
    const run = await users(["seed-demo", "--alice", "x@demo.test", "--bob", "x@demo.test", "--charlie", "c@demo.test", "--michael", "m@demo.test"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("a different email for each person");
  });
});
