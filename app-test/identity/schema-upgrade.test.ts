/**
 * An `idp.db` this build did not write must be refused at boot, with the file
 * named and the way out stated, rather than opened.
 *
 * **Until #6 this file was about the opposite.** `apps/idp` carried every disk
 * forward: a pre-#70 one gained `jwks` and had its encrypted client secret
 * re-hashed, and a pre-#58 one had `user` rebuilt `COLLATE NOCASE`. The fold
 * took Better Auth 1.7.5 with a fresh schema (DESIGN.md → Services): 1.7.5
 * drops `account.issuer`, which 1.7.2 declared `NOT NULL`, so a 1.7.2 disk
 * holds a column this build never writes and fails at its first seed or
 * reset. There is no upgrade path, so the tests of one went with it, and the
 * pre-#58 fixture they used. What stays is what is still true: the schema
 * replay is idempotent, and a disk stamped with any other version — newer, as
 * before, or now older — is refused before anything else happens.
 *
 * The same refusal protects against #60's failure mode: `cg-hooks` came up
 * green and crash-looped on `no such table`, and a hosted shell will not
 * attach to a service that keeps exiting.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { symmetricEncrypt } from "better-auth/crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OAUTH_CLIENT_ROW_ID } from "../../lib/identity/provider/client.ts";
import {
  countPeople,
  idempotentSchema,
  openPeople,
  readSchemaVersion,
  SCHEMA_VERSION,
  SchemaTooNewError,
  SchemaTooOldError,
} from "../../lib/identity/provider/db.ts";

const ROOT = join(import.meta.dir, "..", "..");

const SECRET = "test-secret-".padEnd(48, "x");
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const REDIRECT_URIS = [REDIRECT_URI];

const REGISTERED_CLIENT_ID = "aaaaBBBBccccDDDDeeeeFFFFgggg1234";
const REGISTERED_CLIENT_SECRET = "sssTTTuuuVVVwwwXXXyyyZZZ000111222333444555666777";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = join(tmpdir(), `cg-idp-upgrade-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function legacyDb(dir: string, storageSecret = SECRET): Promise<string> {
  const path = join(dir, "idp.db");
  const db = await openPeople(path);

  db.exec('DROP TABLE "jwks"');
  db.exec("PRAGMA user_version = 0");

  // The client row as the pre-#70 `ensureOAuthClient` wrote it: the secret
  // encrypted under BETTER_AUTH_SECRET, via Better Auth's own `symmetricEncrypt`.
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO "oauthClient"
       ("id", "clientId", "clientSecret", "name", "redirectUris", "scopes",
        "tokenEndpointAuthMethod", "grantTypes", "responseTypes", "applicationType",
        "requirePKCE", "skipConsent", "disabled", "createdAt", "updatedAt")
     VALUES ($id, $clientId, $clientSecret, 'Arcade', $redirectUris,
             '["openid","profile","email","offline_access"]',
             'client_secret_post', '["authorization_code","refresh_token"]', '["code"]', 'web',
             1, 0, 0, $now, $now)`,
  ).run({
    $id: OAUTH_CLIENT_ROW_ID,
    $clientId: REGISTERED_CLIENT_ID,
    $clientSecret: await symmetricEncrypt({ key: storageSecret, data: REGISTERED_CLIENT_SECRET }),
    $redirectUris: JSON.stringify(REDIRECT_URIS),
    $now: now,
  });

  db.close();
  return path;
}

function tables(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

describe("idempotentSchema", () => {
  test("rewrites the three forms Better Auth's compiler emits", () => {
    const rewritten = idempotentSchema(
      `-- a comment\n-- and another\ncreate table "a" ("x" text);\n\n` +
        `create index "a_x_idx" on "a" ("x");\n\ncreate unique index "a_x_uidx" on "a" ("x");`,
    );

    expect(rewritten).toContain('create table if not exists "a"');
    expect(rewritten).toContain('create index if not exists "a_x_idx"');
    expect(rewritten).toContain('create unique index if not exists "a_x_uidx"');
    // The comment header is not carried into a statement.
    expect(rewritten).not.toContain("-- a comment");
  });

  test("refuses a statement it cannot make idempotent, rather than dropping it", () => {
    // The failure this guards against is the one #69 is about: a statement
    // that silently does not run looks exactly like a schema already current.
    expect(() => idempotentSchema('alter table "a" add column "y" text;')).toThrow(
      /cannot make this statement idempotent/,
    );
  });

  test("replaying it against a database that already has everything is a no-op", async () => {
    const db = await openPeople(":memory:");
    const before = tables(db);

    db.exec(idempotentSchema(await Bun.file(join(ROOT, "lib", "identity", "provider", "schema.sql")).text()));

    expect(tables(db)).toEqual(before);
    expect(countPeople(db)).toBe(4);
    db.close();
  });
});

describe("a disk stamped with another schema version", () => {
  test("refuses a database stamped newer than this build, before anything else happens", async () => {
    const path = await legacyDb(tempDir());
    const stamped = new Database(path);
    stamped.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 41}`);
    stamped.close();

    await expect(openPeople(path)).rejects.toThrow(SchemaTooNewError);
    // Named the file and the way out, rather than surfacing later as a
    // SQLiteError from whatever first touched the missing piece (#60).
    await expect(openPeople(path)).rejects.toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await expect(openPeople(path)).rejects.toThrow(new RegExp(`user_version ${SCHEMA_VERSION + 41}\\b`));
  });

  /**
   * New with #6. Versions 0 (before #70) and 1 (#70 to #6) are the demo's
   * `apps/idp` on Better Auth 1.7.2. Opened, either would come up green and
   * fail at its first reset, on a `NOT NULL` column this build never writes.
   */
  test.each([0, 1])("refuses a disk stamped %i, older than this build, naming the file and the way out", async (version) => {
    const path = await legacyDb(tempDir());
    const stamped = new Database(path);
    stamped.exec(`PRAGMA user_version = ${version}`);
    stamped.close();

    await expect(openPeople(path)).rejects.toThrow(SchemaTooOldError);
    await expect(openPeople(path)).rejects.toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await expect(openPeople(path)).rejects.toThrow(new RegExp(`user_version ${version};`));
    await expect(openPeople(path)).rejects.toThrow(/delete .* and restart/);
  });

  test("the refusal writes nothing: the disk reads back exactly as it was", async () => {
    const path = await legacyDb(tempDir());
    const before = new Database(path);
    const tablesBefore = tables(before);
    const peopleBefore = countPeople(before);
    before.close();

    await expect(openPeople(path)).rejects.toThrow(SchemaTooOldError);

    const after = new Database(path);
    expect(tables(after)).toEqual(tablesBefore);
    expect(countPeople(after)).toBe(peopleBefore);
    expect(readSchemaVersion(after)).toBe(0);
    after.close();
  });
});
