/**
 * The people in `idp.db`, for `bun run users` (#31): find, add, remove and
 * list one person, and nothing else.
 *
 * A provider tool, like `oauth-client.ts` and `reset.ts` beside it
 * (`app-test/identity/only-identity-mints.test.ts` → `PROVIDER_TOOLS`), so it
 * is the one place outside the provider that opens its database. What it hands
 * back is people-shaped: no database handle, no Better Auth instance, no
 * signing key and no client. `scripts/users.ts`, which also writes the control
 * plane, reaches identity only through here, so it has nothing it could mint
 * a token with.
 */
import { idpDbPath } from "../../lib/identity/provider/config.ts";
import {
  addPerson,
  findPerson,
  listPeople,
  openPeople,
  PersonExistsError,
  removePerson,
  type Person,
  type Removal,
} from "../../lib/identity/provider/db.ts";

export { PersonExistsError, type Person, type Removal };

export interface People {
  find(email: string): Person | null;
  /** Hashes the password the way the seed does and stores only the hash. */
  add(person: { name: string; email: string; password: string }): Promise<Person>;
  /** The person, their credential, sessions, tokens and consents; `null` when nobody is there. */
  remove(email: string): Removal | null;
  list(): Person[];
  close(): void;
}

/** Opens `IDP_DB_PATH` (`./idp.db` when unset), seeding it from the fixture if it has no schema, as the app would. */
export async function openPeopleStore(env: Record<string, string | undefined> = process.env): Promise<People> {
  const db = await openPeople(idpDbPath(env));
  // The app holds the same file open; wait out its write lock rather than fail.
  db.exec("PRAGMA busy_timeout = 1000");
  return {
    find: (email) => findPerson(db, email),
    add: (person) => addPerson(db, person),
    remove: (email) => removePerson(db, email),
    list: () => listPeople(db),
    close: () => db.close(),
  };
}
