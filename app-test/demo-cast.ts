/**
 * The demo cast, seeded by the tests themselves (#33).
 *
 * Until #33 the app seeded Alice, Bob, Charlie and Michael on its first boot,
 * into both `idp.db` and `governance.db`, all four under one shipped password.
 * Now a fresh start seeds nobody, and an operator adds the cast with
 * `bun run users seed-demo`, which generates their passwords. Most suites are
 * about something else — a hook, a page, the approval flow — and act as the
 * cast, so they seed it here: the same two writes `seed-demo` makes (a Better
 * Auth account through `addPerson`, a `subjects` row through `addSubject`),
 * at the fixture's own `@bank.example` addresses, with a password that exists
 * only in this file.
 *
 * `app-test/users-cli.test.ts` and `test/reset-real-users.test.ts` run the
 * real `seed-demo` end to end; this helper is for the suites that are not
 * about it.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

import fixture from "../lib/control-plane/fixtures/governance.json" with { type: "json" };
import { openGovernance, type SeedOptions } from "../lib/control-plane/policy-store.ts";
import { addSubject, readSubject } from "../lib/control-plane/subjects.ts";
import { addPerson, findPerson, openPeople } from "../lib/identity/provider/db.ts";
import { childEnv } from "./child-env.ts";
import { spawnChild } from "./child.ts";

const REPO = join(import.meta.dir, "..");

/**
 * The tests' own throwaway password for every demo person. Not a credential:
 * it signs in only to databases a test created, and nothing outside `app-test/`
 * and `test/` knows it. Deliberately nothing like the shipped password the app
 * had before #33, so a test still leaning on that one fails.
 */
export const DEMO_PASSWORD = "demo-cast-test-only-throwaway-33";

export type DemoKey = "dana" | "sam" | "riley" | "morgan";

export interface DemoPerson {
  /** The fixture's internal key (DESIGN.md → Cast). Never shown to anybody. */
  key: DemoKey;
  name: string;
  email: string;
  role: string;
  clearance: number;
  password: string;
}

/** The fixture's four, keyed the way the tests have always keyed them. */
export const DEMO_CAST: Readonly<Record<DemoKey, DemoPerson>> = Object.fromEntries(
  fixture.subjects.map((subject) => [
    subject.persona,
    {
      key: subject.persona as DemoKey,
      name: subject.display_name,
      email: subject.user_id.toLowerCase(),
      role: subject.role,
      clearance: subject.clearance,
      password: DEMO_PASSWORD,
    },
  ]),
) as Record<DemoKey, DemoPerson>;

export const DEMO_PEOPLE: readonly DemoPerson[] = Object.values(DEMO_CAST);

/**
 * The cast's identities in `idp.db`: an open database, or a path, which is
 * opened (and its schema created, as the app would) and closed again. Anybody
 * already there is left as they are, as `seed-demo` leaves them.
 */
export async function seedDemoIdentity(target: Database | string): Promise<void> {
  const db = typeof target === "string" ? await openPeople(target) : target;
  try {
    if (typeof target === "string") db.exec("PRAGMA busy_timeout = 5000");
    for (const person of DEMO_PEOPLE) {
      if (findPerson(db, person.email) === null) {
        await addPerson(db, { name: person.name, email: person.email, password: person.password });
      }
    }
  } finally {
    if (typeof target === "string") db.close();
  }
}

/**
 * The cast's `subjects` rows in `governance.db`: an open database, or the path
 * of one that already has its schema (a running app's, say). Rows already
 * there are left as they are. Written through `addSubject`, so each lands with
 * the `subject_changes` row `seed-demo` would write.
 */
export function seedDemoSubjects(target: Database | string): void {
  const db = typeof target === "string" ? new Database(target) : target;
  try {
    if (typeof target === "string") db.exec("PRAGMA busy_timeout = 5000");
    for (const person of DEMO_PEOPLE) {
      if (readSubject(db, person.email) !== null) continue;
      addSubject(
        db,
        { user_id: person.email, display_name: person.name, role: person.role, clearance: person.clearance },
        "test:demo-cast",
      );
    }
  } finally {
    if (typeof target === "string") db.close();
  }
}

/**
 * A `governance.db` at `path` as a first boot writes it and `seed-demo` then
 * fills it: the policy, and the demo cast's subjects. For a harness that hands
 * the file to a control plane it spawns, before it spawns it, so the first
 * hook call already meets the cast. `toolkits` are the names that control
 * plane will be configured with, because a fresh file's rules are keyed on
 * them. A file that already has a schema keeps its policy, and gains only the
 * subjects it lacks.
 */
export function seedDemoGovernance(path: string, toolkits: SeedOptions = { loanToolkit: "Loan", approvalsToolkit: "Approvals" }): void {
  const db = openGovernance(path, toolkits);
  try {
    seedDemoSubjects(db);
  } finally {
    db.close();
  }
}

/**
 * `bun run users …` itself, as an operator runs it: a subprocess against two
 * database files, with nothing else from the test's environment. For the tests
 * whose point is that a person got in the way a real one does.
 */
export async function runUsers(
  args: string[],
  databases: { idp: string; governance: string },
): Promise<{ code: number; out: string; err: string }> {
  const proc = spawnChild(["bun", "--no-env-file", join(REPO, "scripts", "users.ts"), ...args], {
    cwd: REPO,
    env: childEnv({ IDP_DB_PATH: databases.idp, GOVERNANCE_DB_PATH: databases.governance }),
    stdin: "ignore",
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
