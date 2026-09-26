/**
 * The people database: seeding, the one-transaction rule, and the reset that
 * leaves the OAuth client alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { hashPassword } from "better-auth/crypto";

import { createAuth, hashClientSecret } from "../../lib/identity/provider/auth.ts";
import { ensureOAuthClient } from "../../lib/identity/provider/client.ts";
import type { PersonSeed } from "../../lib/identity/provider/db.ts";
import { countPeople, listPeople, openPeople, resetPeople, seed } from "../../lib/identity/provider/db.ts";
import { DEMO_PEOPLE } from "../demo-cast.ts";

const SECRET = "test-secret-".padEnd(48, "x");
const REPO = join(import.meta.dir, "..", "..");

/** The demo cast as a test seeds it (`app-test/demo-cast.ts`): the fixture's addresses, the tests' own password. */
const CAST: PersonSeed[] = DEMO_PEOPLE.map(({ name, email, password }) => ({ name, email, password }));

const ONE_PERSON: PersonSeed = {
  name: "Placeholder Person",
  email: "placeholder@bank.example",
  password: "placeholder-2026",
};

/**
 * The `clientSecret` column, which since #70 holds a hash rather than
 * ciphertext. "the credentials are unchanged" used to be checkable by reading
 * the secret back; hashed storage means the observable form of that property
 * is the stored value itself — if it is the same bytes, the secret Arcade
 * holds still verifies.
 */
function storedSecret(db: Database): string {
  return db.query<{ clientSecret: string }, []>('SELECT "clientSecret" FROM "oauthClient"').get()!
    .clientSecret;
}

function passwordHash(db: Database, email: string): string {
  return db
    .query<{ password: string }, [string]>(
      'SELECT a."password" FROM "account" a JOIN "user" u ON u."id" = a."userId" WHERE u."email" = ?',
    )
    .get(email)!.password;
}

const tempDirs: string[] = [];
function tempDb(): string {
  const path = join(tmpdir(), `cg-idp-${crypto.randomUUID()}`, "idp.db");
  tempDirs.push(dirname(path));
  return path;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * #33: there is no shipped cast and no shipped password. Until then this
 * module seeded four personas from `fixtures/people.json` under one checked-in
 * password, at addresses the `PERSONA_*` variables could override.
 */
describe("nobody is shipped (#33)", () => {
  test("there is no people fixture, and the module reads no persona variable and no password", () => {
    expect(existsSync(join(REPO, "lib/identity/provider/fixtures/people.json"))).toBe(false);
    const source = readFileSync(join(REPO, "lib/identity/provider/db.ts"), "utf8");
    expect(source).not.toMatch(/people\.json|PERSONA_|process\.env|megaforce/);
  });

  test("a person to seed is parsed: a real address and a password of at least eight characters", async () => {
    await expect(openPeople(":memory:", [{ ...ONE_PERSON, email: "not-an-address" }])).rejects.toThrow(/email/i);
    await expect(openPeople(":memory:", [{ ...ONE_PERSON, password: "short" }])).rejects.toThrow(/password/);
  });
});

describe("seeding", () => {
  test("bootstraps the schema and nobody into an empty database", async () => {
    const db = await openPeople(":memory:");

    expect(countPeople(db)).toBe(0);
    expect(listPeople(db)).toEqual([]);
  });

  test("seeds exactly the people it is handed", async () => {
    const db = await openPeople(":memory:", CAST);

    expect(listPeople(db).map((p) => p.email).sort()).toEqual(CAST.map((p) => p.email).sort());
  });

  // #58. Better Auth lowercases the address before it looks a user up, so a
  // row stored with a capital is somebody nobody can sign in as — and the
  // login page calls that a wrong password.
  test("writes lowercase rows even when the people are handed over capitalised", async () => {
    const db = await openPeople(":memory:", [{ ...ONE_PERSON, email: "  Alice@Bank.Example " }]);

    expect(listPeople(db).map((p) => p.email)).toEqual(["alice@bank.example"]);
  });

  test("a seed that fails leaves no schema, so the next boot retries", async () => {
    // Two people with the same email pass the zod schema and violate the
    // unique index. If the schema were created outside the seed transaction,
    // the tables would survive the failed inserts, `hasSchema` would report
    // the database as seeded, and every later boot would come up green with
    // nobody able to log in — permanently, on a disk that persists.
    const db = new Database(":memory:");

    await expect(seed(db, [ONE_PERSON, ONE_PERSON])).rejects.toThrow(/UNIQUE/);
    expect(() => countPeople(db)).toThrow(/no such table/);

    await seed(db, [ONE_PERSON]);
    expect(countPeople(db)).toBe(1);
  });

  test("leaves an existing database alone — later boots are not a reset", async () => {
    const path = tempDb();

    const first = await openPeople(path, CAST);
    const ids = listPeople(first).map((p) => p.id);
    first.close();

    // Different people on the second open change nothing: the database
    // already has a schema, so it is left as it is.
    const second = await openPeople(path, [ONE_PERSON]);
    const again = listPeople(second).map((p) => p.id);
    second.close();

    expect(again).toEqual(ids);
  });
});

describe("resetPeople", () => {
  // Changed by #33: the people were deleted and seeded again from the
  // fixture. There is no fixture password to seed them with, so they are kept.
  test("keeps the people and the OAuth client, credentials included", async () => {
    const path = tempDb();
    const db = await openPeople(path, CAST);
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    const redirectUris = ["http://127.0.0.1:9/callback"];

    const before = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });
    const storedBefore = storedSecret(db);
    const peopleBefore = listPeople(db).map((p) => p.id);

    const result = resetPeople(db);

    const after = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });

    expect(before.created).toBe(true);
    expect(after.created).toBe(false);
    expect(after.clientId).toBe(before.clientId);
    // The secret is readable exactly once, at creation; what survives the
    // reset is the stored hash, which is what the token endpoint checks.
    expect(before.clientSecret).toBeTruthy();
    expect(after.clientSecret).toBeNull();
    expect(storedSecret(db)).toBe(storedBefore);
    expect(storedBefore).toBe(await hashClientSecret(before.clientSecret!));

    // The people are the same rows, not replacements.
    expect(listPeople(db).map((p) => p.id)).toEqual(peopleBefore);
    expect(result.kept).toEqual(CAST.map((p) => p.email).sort());
    db.close();
  });

  test("clears sessions, tokens and consents, and keeps the people", async () => {
    const db = await openPeople(":memory:", CAST);
    const person = listPeople(db)[0]!;
    const now = new Date().toISOString();

    db.query(
      `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
       VALUES ('s1', $now, 't1', $now, $now, $user)`,
    ).run({ $now: now, $user: person.id });

    resetPeople(db);

    expect(db.query('SELECT COUNT(*) AS n FROM "session"').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthConsent"').get()).toEqual({ n: 0 });
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthAccessToken"').get()).toEqual({ n: 0 });
    expect(countPeople(db)).toBe(CAST.length);
  });

  /**
   * #32: somebody `bun run users add` put in is not the demo's to reset. Their
   * user row, their credential and its password hash are exactly what they
   * were; only their sessions go, with everybody else's. Since #33 the same is
   * true of the demo cast.
   */
  test("leaves every user in place, the demo cast included, and signs them all out", async () => {
    const db = await openPeople(":memory:", CAST);
    const now = new Date().toISOString();
    const hash = await hashPassword("priya-chose-this-one");
    db.query(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES ('u-priya', 'Priya', 'priya@company.test', 1, $now, $now)`,
    ).run({ $now: now });
    db.query(
      `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
       VALUES ('a-priya', 'u-priya', 'credential', 'u-priya', $hash, $now, $now)`,
    ).run({ $hash: hash, $now: now });
    const alice = listPeople(db).find((p) => p.email === "alice@bank.example")!;
    for (const [id, user] of [["s-priya", "u-priya"], ["s-alice", alice.id]] as const) {
      db.query(
        `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
         VALUES ($id, $now, $id, $now, $now, $user)`,
      ).run({ $id: id, $now: now, $user: user });
    }

    const result = resetPeople(db);

    expect(result.kept).toEqual([...CAST.map((p) => p.email), "priya@company.test"].sort());
    expect(db.query('SELECT "id", "name" FROM "user" WHERE "email" = \'priya@company.test\'').get()).toEqual({
      id: "u-priya",
      name: "Priya",
    });
    expect(db.query('SELECT "id", "password" FROM "account" WHERE "userId" = \'u-priya\'').get()).toEqual({
      id: "a-priya",
      password: hash,
    });
    expect(db.query('SELECT COUNT(*) AS n FROM "session"').get()).toEqual({ n: 0 });
    // Changed by #33: the demo person was replaced; now she is the same row.
    expect(listPeople(db).find((p) => p.email === "alice@bank.example")!.id).toBe(alice.id);
    expect(countPeople(db)).toBe(5);
  });

  test("a demo person who is not on disk is not added back", async () => {
    const db = await openPeople(":memory:", CAST);
    db.exec('DELETE FROM "user" WHERE "email" = \'bob@bank.example\'');

    const result = resetPeople(db);

    expect(result.kept).toEqual(["alice@bank.example", "charlie@bank.example", "michael@bank.example"]);
    expect(listPeople(db).map((p) => p.email)).toEqual([
      "alice@bank.example",
      "charlie@bank.example",
      "michael@bank.example",
    ]);
  });

  test("a reset of an empty database adds nobody", async () => {
    const db = await openPeople(":memory:");
    expect(resetPeople(db)).toEqual({ kept: [] });
    expect(countPeople(db)).toBe(0);
  });

  // Changed by #33: a demo person's edited name and password went back to the
  // fixture's. With no fixture password there is nothing to go back to, and
  // resetting a password somebody chose would lock them out.
  test("an edited name and a changed password are kept", async () => {
    const db = await openPeople(":memory:", CAST);
    db.exec(`UPDATE "user" SET "name" = 'Alice (edited)' WHERE "email" = 'alice@bank.example'`);
    const hash = passwordHash(db, "alice@bank.example");

    resetPeople(db);

    expect(listPeople(db).find((p) => p.email === "alice@bank.example")?.name).toBe("Alice (edited)");
    expect(passwordHash(db, "alice@bank.example")).toBe(hash);
  });

  test("the client is unowned, so deleting every user cannot cascade into it", async () => {
    const db = await openPeople(":memory:", CAST);
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    await ensureOAuthClient(auth, { redirectUris: ["http://127.0.0.1:9/callback"], secret: SECRET });

    const row = db.query<{ userId: string | null }, []>('SELECT "userId" FROM "oauthClient"').get();
    expect(row?.userId).toBeNull();

    db.exec('DELETE FROM "user"');
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 1 });
  });
});

describe("ensureOAuthClient never rotates", () => {
  const redirectUris = ["http://127.0.0.1:9/callback"];

  /** A client row as an earlier build wrote it: generated id, found by name. */
  function insertLegacyRow(db: Database, name: string, clientId: string): void {
    db.query(
      `INSERT INTO "oauthClient" ("id", "clientId", "clientSecret", "name", "redirectUris", "createdAt", "updatedAt")
       VALUES ($id, $clientId, 'ciphertext', $name, '["http://127.0.0.1:9/callback"]', $now, $now)`,
    ).run({ $id: crypto.randomUUID(), $clientId: clientId, $name: name, $now: new Date().toISOString() });
  }

  test("adopts a row written under a generated id instead of minting a second client", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    // Written by a real bootstrap, then re-keyed to look like the earlier build's row.
    const original = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });
    const storedBefore = storedSecret(db);
    db.exec(`UPDATE "oauthClient" SET "id" = '${crypto.randomUUID()}'`);

    const adopted = await ensureOAuthClient(auth, { redirectUris, secret: SECRET });

    expect(adopted.created).toBe(false);
    expect(adopted.clientId).toBe(original.clientId);
    expect(storedSecret(db)).toBe(storedBefore);
    expect(db.query('SELECT "id" FROM "oauthClient"').all()).toEqual([{ id: "arcade" }]);
  });

  test("refuses to boot when client rows exist that it cannot recognise", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    insertLegacyRow(db, "Something Else", "client-arcade-may-hold");

    await expect(ensureOAuthClient(auth, { redirectUris, secret: SECRET })).rejects.toThrow(
      /Refusing to create another/,
    );
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 1 });
  });

  test("refuses when two legacy rows share the name, rather than guess", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    insertLegacyRow(db, "Arcade", "first");
    insertLegacyRow(db, "Arcade", "second");

    await expect(ensureOAuthClient(auth, { redirectUris, secret: SECRET })).rejects.toThrow(
      /2 named "Arcade"/,
    );
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 2 });
  });
});

describe("ensureOAuthClient", () => {
  test("two bootstraps at once still leave exactly one client", async () => {
    // The service booting on a fresh disk while someone runs `oauth-client`
    // in a shell: both look, both find nothing, both insert. The row has a
    // fixed primary key, so one insert loses and takes the winner's client.
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });
    const redirectUris = ["http://127.0.0.1:9/callback"];

    const [a, b] = await Promise.all([
      ensureOAuthClient(auth, { redirectUris, secret: SECRET }),
      ensureOAuthClient(auth, { redirectUris, secret: SECRET }),
    ]);

    expect(a.clientId).toBe(b.clientId);
    expect(db.query('SELECT COUNT(*) AS n FROM "oauthClient"').get()).toEqual({ n: 1 });

    // Exactly one of the two inserted the row, and only that one may hold the
    // secret: the loser adopted the winner's client and has nothing to print.
    const winners = [a, b].filter((result) => result.created);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.clientSecret).toBeTruthy();
    expect([a, b].find((result) => !result.created)!.clientSecret).toBeNull();
    expect(storedSecret(db)).toBe(await hashClientSecret(winners[0]!.clientSecret!));
  });

  test("brings the redirect URIs in line without touching the credentials", async () => {
    const db = await openPeople(":memory:");
    const auth = createAuth({ db, baseURL: "http://localhost:1", secret: SECRET });

    const first = await ensureOAuthClient(auth, { redirectUris: ["http://a/cb"], secret: SECRET });
    const storedBefore = storedSecret(db);
    const second = await ensureOAuthClient(auth, {
      redirectUris: ["http://a/cb", "http://b/cb"],
      secret: SECRET,
    });

    expect(second.clientId).toBe(first.clientId);
    expect(second.secretState).toBe("unchanged");
    expect(storedSecret(db)).toBe(storedBefore);
    expect(second.redirectUris).toEqual(["http://a/cb", "http://b/cb"]);

    const stored = db
      .query<{ redirectUris: string }, []>('SELECT "redirectUris" FROM "oauthClient"')
      .get();
    expect(JSON.parse(stored!.redirectUris)).toEqual(["http://a/cb", "http://b/cb"]);
  });
});
