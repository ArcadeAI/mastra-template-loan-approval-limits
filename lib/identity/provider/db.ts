/**
 * `idp.db` — the people. Better Auth's own tables (`user`, `session`,
 * `account`, `verification`) plus the OAuth provider plugin's (`oauthClient`,
 * tokens, consents).
 *
 * The identity module knows who someone is and nothing else: no titles, no
 * limits, no loans. Authority lives in the control plane; the loan book lives
 * in the loan module. Everything here is identity.
 */
import { Database } from "bun:sqlite";
import { hashPassword } from "better-auth/crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { readPersonaEmailOverrides } from "../../../packages/policy-schema/contract/persona-email-contract.ts";
import fixture from "./fixtures/people.json" with { type: "json" };
// Generated from the installed Better Auth by `scripts/generate-schema.ts`;
// `test/schema.test.ts` fails when it is stale. Checked in rather than built
// at boot because the seed has to create the schema itself, inside the seed
// transaction — see `seed`. Kept byte-identical to what the library compiles,
// so `generate:check` stays a real comparison; `idempotentSchema` below is
// what actually runs.
import GENERATED_SCHEMA from "./schema.sql" with { type: "text" };

const personSchema = z.object({
  persona: z.enum(["dana", "sam", "riley", "morgan"]),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

// Hand-edited, so parsed rather than trusted: a typo fails at boot with a
// field path instead of surfacing as a persona who quietly cannot log in.
const fixtureSchema = z.object({ people: z.array(personSchema).min(1) });

/** One person as they appear in the fixture. */
export type PersonSeed = z.infer<typeof personSchema>;

/** What the service tells about a person. Name and email — that is the whole record. */
export interface Person {
  id: string;
  name: string;
  email: string;
}

/**
 * The fixture, with each persona's email replaced by the role variable from
 * the shared persona email contract when that variable is set.
 *
 * The email is the join key across the whole system — Arcade `user_id`, OAuth
 * subject, loan-book actor — and the Arcade accounts are created by hand on
 * #13 under whatever addresses are available. `.env.example` already carries
 * these four variables for the persona switcher; reading them here is what
 * keeps `idp.db` and the Arcade accounts on the same string without a second
 * place to edit. The fixture's own addresses are the fallback for a local run.
 *
 * **Every address is lowercased on the way in** (#58). Better Auth lowercases
 * the address before it looks a user up, and SQLite compares text
 * case-sensitively, so a row stored as `Alice@…` can never be signed in
 * as — and the login page reports the same "did not match" it gives a wrong
 * password, so nothing on screen says why. Normalising here means
 * `insertPeople` can only ever write a lowercase row; `schema.sql`'s
 * `collate nocase` on the column is the second line of defence, for a row
 * this function did not write.
 */
export function loadPeople(env: Record<string, string | undefined> = process.env): PersonSeed[] {
  const overrides = readPersonaEmailOverrides(env);
  return fixtureSchema.parse(fixture).people.map((person) => {
    const override = overrides[person.persona];
    return { ...person, email: (override || person.email).toLowerCase() };
  });
}

/**
 * Tables that hold *people and their state*, in an order that respects the
 * foreign keys. `resetPeople` clears exactly these. Two tables are off the
 * list on purpose:
 *
 *   - `oauthClient` — the credentials Arcade holds. Rotating them breaks OAuth
 *     right after a reset, at the authorize step, where no hook fires and
 *     nothing on screen says why.
 *   - `jwks` — the ID-token signing keys (#70). Clearing them mints a new key
 *     pair on the next signature, and an Arcade User Source that had cached
 *     the old key set would reject the ID token. Same failure, one layer down.
 */
const PEOPLE_TABLES = [
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthConsent",
  "verification",
  "session",
  "account",
  "user",
] as const;

/**
 * The three statement forms Better Auth's SQLite migration compiler emits,
 * and the idempotent spelling of each.
 *
 * Ordered so the longer prefix is tried first: `create unique index "` also
 * begins with `create `, and matching the wrong rule would produce SQL that
 * does not parse.
 */
const IDEMPOTENT_FORMS = [
  ["create table \"", "create table if not exists \""],
  ["create unique index \"", "create unique index if not exists \""],
  ["create index \"", "create index if not exists \""],
] as const;

/**
 * Rewrites the generated DDL so replaying it against a database that already
 * holds some of it is a no-op rather than an error.
 *
 * `schema.sql` is the library's own output and stays byte-identical to it, so
 * `generate:check` keeps comparing like with like; `CREATE ... IF NOT EXISTS`
 * is not something Better Auth's compiler emits, so the idempotent form is
 * derived here instead of being checked in.
 *
 * **Throws on a statement it does not recognise**, at import time. The whole
 * point of the upgrade path is that a missing table appears; a statement this
 * function quietly dropped would be a table that never does — a thing that
 * looks exactly like a schema that is already current. Better a service that
 * refuses to start and names the statement.
 *
 * Exported for the test that feeds it an unrecognised statement.
 */
export function idempotentSchema(generated: string): string {
  const statements = generated
    // The generated file opens with a `--` comment block, which would
    // otherwise ride along on the front of the first statement.
    .replace(/^(?:--[^\n]*\n)+/, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  return statements
    .map((statement) => {
      const form = IDEMPOTENT_FORMS.find(([prefix]) => statement.startsWith(prefix));
      if (!form) {
        throw new Error(
          `idp.db schema: cannot make this statement idempotent, so the upgrade path ` +
            `would skip it silently — teach idempotentSchema about it: ${statement.slice(0, 120)}`,
        );
      }
      return `${form[1]}${statement.slice(form[0].length)};`;
    })
    .join("\n\n");
}

/**
 * The DDL that actually runs, inside `seed()`'s transaction on a fresh
 * database. Still passed through `idempotentSchema`, although since #6 nothing
 * replays it against an older disk (see `SCHEMA_VERSION`): the pass costs
 * nothing, and its refusal of a statement form it does not recognise is how a
 * Better Auth upgrade that emits a new one is caught at import rather than at
 * the first seed.
 */
const SCHEMA = idempotentSchema(GENERATED_SCHEMA);

/**
 * The schema revision this build writes, recorded in `PRAGMA user_version`.
 * Bump it in the same commit as any change to `schema.sql`.
 *
 * **Version 2 is a fresh schema (#6): Better Auth 1.7.5.** 1.7.5 drops
 * `account.issuer`, which 1.7.2 declared `NOT NULL` with a unique index on
 * `(issuer, accountId)`. A disk written by the 1.7.2 build therefore holds a
 * column this build never writes, and the first seed or reset against it fails
 * on that constraint. DESIGN.md → Services records the choice: the demo held
 * Better Auth at 1.7.2 because moving would have needed a migration on a live
 * disk, and the template's `idp.db` starts fresh instead. So there is no
 * upgrade path, and a disk stamped older than this is refused with the way out,
 * the same as one stamped newer.
 *
 * Versions 0 and 1 were the demo's `apps/idp`: 0 before the JWT plugin (#70),
 * 1 from #70 on. Both are refused.
 */
export const SCHEMA_VERSION = 2;

/** The schema revision recorded on disk. 0 on anything written before #70. */
export function readSchemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

/** How to get from a disk this build cannot read to one it can, said the same way for both directions. */
function resetAdvice(path: string): string {
  return (
    `Reset it: stop the app, delete ${path} (and its -wal and -shm siblings), ` +
    `and restart — the fixture reseeds on an empty disk. Note that deleting the file ` +
    `also rotates the OAuth client, so Arcade has to be re-registered afterwards.`
  );
}

/**
 * Thrown at boot, before the port opens, when `idp.db` is not one this build
 * can bring forward. Names the file and the way out, because the alternative
 * is a `SQLiteError: no such table` from the first request that needs the
 * missing piece, a crash loop, and a remote shell that will not attach to a
 * service that keeps exiting (#60, measured on `cg-hooks`).
 */
export class SchemaTooNewError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
  ) {
    super(
      `idp.db at ${path} was written by a newer build (PRAGMA user_version ${found}; ` +
        `this build understands ${SCHEMA_VERSION}) and cannot be migrated backwards. ` +
        resetAdvice(path),
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * Thrown at boot when `idp.db` was written by an older schema than this build's
 * fresh one — see {@link SCHEMA_VERSION} for why there is no upgrade path.
 * Refused rather than opened, because opening it comes up green and fails at
 * the first reset, on a `NOT NULL` column nothing here writes.
 */
export class SchemaTooOldError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
  ) {
    super(
      `idp.db at ${path} was written by an older schema (PRAGMA user_version ${found}; ` +
        `this build writes ${SCHEMA_VERSION}, Better Auth 1.7.5's, and does not upgrade older disks). ` +
        resetAdvice(path),
    );
    this.name = "SchemaTooOldError";
  }
}

/**
 * Opens the people database, bootstrapping it from the fixture only when it
 * has no schema, and refusing one written by any other schema version.
 *
 * Seed-if-empty rather than seed-on-boot: `idp.db` lives on a disk, so a
 * consent granted on stage is still there after a restart. Getting back to a
 * clean state is the reset, never a side effect of deploying — and that reset
 * leaves the OAuth client alone, see `resetPeople`.
 */
export async function openPeople(path: string, people: PersonSeed[] = loadPeople()): Promise<Database> {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  try {
    if (hasSchema(db)) checkSchemaVersion(db, path);
    else await seed(db, people);
  } catch (cause) {
    // Leave no half-open handle behind: the caller is about to exit, and a
    // lingering WAL lock is one more thing between a crash-looping service
    // and somebody deleting the file.
    db.close();
    throw cause;
  }

  return db;
}

/**
 * A disk that already has a schema is opened only when it is this build's.
 *
 * **No inserts and no DDL.** The rows on this disk are the state the demo is
 * in, and `resetPeople` is what re-seeds people — deliberately, never at boot.
 */
function checkSchemaVersion(db: Database, path: string): void {
  const found = readSchemaVersion(db);
  if (found > SCHEMA_VERSION) throw new SchemaTooNewError(path, found);
  if (found < SCHEMA_VERSION) throw new SchemaTooOldError(path, found);
}

function hasSchema(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'",
    )
    .get();

  return row !== null;
}

/** A person with the password already hashed — the only form that goes into a transaction. */
interface HashedPerson {
  name: string;
  email: string;
  passwordHash: string;
}

/**
 * Hashing is async (scrypt), and `bun:sqlite` transactions are synchronous, so
 * every password is hashed before the transaction opens rather than inside it.
 */
async function hashAll(people: PersonSeed[]): Promise<HashedPerson[]> {
  return Promise.all(
    people.map(async ({ name, email, password }) => ({
      name,
      email,
      passwordHash: await hashPassword(password),
    })),
  );
}

/**
 * Creates the schema and inserts the seed rows in **one** transaction.
 *
 * The schema has to be inside the transaction, not just the inserts. SQLite
 * DDL is transactional, so a seed that throws halfway leaves no tables at all
 * and the next boot tries again with a clear error. Creating the tables first
 * and wrapping only the inserts produces the one failure that cannot recover
 * on its own: a database holding a schema and no rows, which `hasSchema` reads
 * as already seeded. The service then comes up green and nobody can log in —
 * and on a disk that persists, it stays that way. A forker who gives two
 * personas the same email is one boot away from that.
 *
 * Same shape as the loan book's seed (#29), copied rather than reinvented.
 * Exported for the test that holds this line.
 */
export async function seed(db: Database, people: PersonSeed[]): Promise<void> {
  const hashed = await hashAll(people);

  db.transaction(() => {
    db.exec(SCHEMA);
    // Inside the same transaction as the DDL and the rows, so the version is
    // recorded if and only if both landed.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    insertPeople(db, hashed);
  })();
}

/**
 * Clears everything about people — users, credentials, sessions, tokens,
 * consents — and seeds the personas again, in one transaction. **The OAuth
 * client is untouched**, so the `client_id` and `client_secret` registered in
 * the Arcade dashboard keep working across a reset.
 *
 * Deleting the people also deletes their consents, so the first authorize
 * after a reset shows the login page and the consent page again. That is what
 * a rehearsal from clean should look like.
 *
 * Exported for `scripts/reset.ts` and the test that asserts the client survives.
 */
export async function resetPeople(db: Database, people: PersonSeed[] = loadPeople()): Promise<void> {
  const hashed = await hashAll(people);

  db.transaction(() => {
    for (const table of PEOPLE_TABLES) db.exec(`DELETE FROM "${table}"`);
    insertPeople(db, hashed);
  })();
}

/**
 * Better Auth's Kysely adapter stores every `date` column as an ISO-8601
 * string on SQLite, and every row id as a random string, so rows written here
 * are indistinguishable from rows Better Auth writes itself. The credential
 * account is what `emailAndPassword` sign-in looks up: `providerId` is the
 * literal `"credential"` and `accountId` is the user's own id, both read off a
 * row Better Auth's own sign-up wrote. 1.7.2 also required `issuer`
 * (`"local:credential"`); 1.7.5 dropped the column (#6).
 */
function insertPeople(db: Database, people: HashedPerson[]): void {
  // Prepared after the DDL (the tables have to exist to compile against) and
  // finalized before the transaction commits, so a rollback is not fighting
  // open statements over tables it is about to drop.
  const insertUser = db.prepare<unknown, Record<string, string | number>>(`
    INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    VALUES ($id, $name, $email, 1, $now, $now)
  `);
  const insertAccount = db.prepare<unknown, Record<string, string | number>>(`
    INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
    VALUES ($id, $userId, 'credential', $userId, $password, $now, $now)
  `);

  try {
    const now = new Date().toISOString();
    for (const person of people) {
      const userId = crypto.randomUUID();
      insertUser.run({ $id: userId, $name: person.name, $email: person.email, $now: now });
      insertAccount.run({
        $id: crypto.randomUUID(),
        $userId: userId,
        $password: person.passwordHash,
        $now: now,
      });
    }
  } finally {
    insertUser.finalize();
    insertAccount.finalize();
  }
}

export function listPeople(db: Database): Person[] {
  return db
    .query<Person, []>('SELECT "id", "name", "email" FROM "user" ORDER BY "email" ASC')
    .all();
}

export function countPeople(db: Database): number {
  const row = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM "user"').get();
  return row?.n ?? 0;
}
