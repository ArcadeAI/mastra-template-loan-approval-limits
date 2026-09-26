/**
 * The role and authority beside a persona's name, and where they come from.
 *
 * Two properties, and the first one is the one that would rot quietly.
 *
 * **The table does not drift from the policy.** `apps/web` carries its own copy
 * of each persona's `role` and `clearance` because it does not depend on
 * `apps/hooks` in the package graph and should not start to — the same trade
 * `lib/config.ts` makes for `DEV_STORE_TOKEN`, with the same remedy: this file
 * reads the other service's seed fixture and fails when the two disagree. A UI
 * that said "$50,000" while the policy seeded something else would be a control
 * surface misreporting the control.
 *
 * **The person comes from the database** (#32). The card's name, role and
 * clearance are the `subjects` row the hooks decide on, looked up by the
 * address the IdP asserted, so the string on screen is the string the hooks
 * decide on (`DESIGN.md` rule 3) and a user added with `bun run users` is named.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PERSONAS } from "../lib/identity/personas.ts";
import { formatAuthority, personIn, roleLabel } from "../lib/identity/roster.ts";

const REPO_ROOT = join(import.meta.dir, "..");

interface SeedSubject {
  persona: string;
  display_name: string;
  role: string;
  clearance: number;
}

function seededSubjects(): SeedSubject[] {
  const path = join(REPO_ROOT, "lib", "control-plane", "fixtures", "governance.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { subjects: SeedSubject[] }).subjects;
}

describe("the role/limit table matches what apps/hooks seeds", () => {
  test("same four people, same roles, same clearances", () => {
    const seeded = seededSubjects();

    expect(PERSONAS.map((persona) => persona.key)).toEqual(seeded.map((subject) => subject.persona));
    for (const subject of seeded) {
      const persona = PERSONAS.find((each) => each.key === subject.persona);
      expect(persona).toBeDefined();
      expect(persona?.name).toBe(subject.display_name);
      // `roleKey` is what `access.analysts-cannot-see-approve` matches on;
      // `role` is what a person reads. Only the first can be wrong silently.
      expect(persona?.roleKey).toBe(subject.role);
      expect(persona?.clearance).toBe(subject.clearance);
    }
  });

  test("the cast is DESIGN.md's, figures included", () => {
    // Written out rather than derived, so an edit to both the fixture and the
    // table still has to be a deliberate edit to `DESIGN.md` → Cast as well.
    expect(PERSONAS.map((persona) => [persona.name, persona.role, persona.clearance])).toEqual([
      ["Alice", "Loan Officer", 50_000],
      ["Bob", "Credit Analyst", 0],
      ["Charlie", "VP Credit", 250_000],
      ["Michael", "Chief Credit Officer", 5_000_000],
    ]);
  });

  test("no email is written down here", () => {
    // The buttons name a persona; the identity is whatever the IdP asserts.
    // A hardcoded address would be one refactor away from being trusted.
    const source = readFileSync(join(import.meta.dir, "..", "lib", "identity", "personas.ts"), "utf8");
    expect(source).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
  });
});

describe("looking a person up from the address the IdP asserted", () => {
  // What `GET /api/approvals/roster` answers, as far as the lookup reads it.
  // `roster-from-database.test.tsx` makes it come from a real governance.db.
  const subjects = [
    { user_id: "alice@example.test", display_name: "Alice", role: "loan_officer", clearance: 50_000 },
    { user_id: "priya@company.test", display_name: "Priya", role: "regional_credit_head", clearance: 400_000 },
  ];

  test("the address is matched case-insensitively, as the join key is everywhere else", () => {
    // #58: the session's email is lowercase and a row may not be; a roster
    // keyed on the raw value is a roster the lookup can never hit.
    expect(personIn(subjects, "alice@example.test")?.name).toBe("Alice");
    expect(personIn(subjects, "  ALICE@EXAMPLE.TEST  ")?.name).toBe("Alice");
    expect(personIn([{ ...subjects[0]!, user_id: "Alice@Example.Test" }], "alice@example.test")?.email).toBe(
      "alice@example.test",
    );
  });

  test("name, role and clearance are the row's, whoever added it", () => {
    expect(personIn(subjects, "priya@company.test")).toEqual({
      email: "priya@company.test",
      name: "Priya",
      role: "Regional Credit Head",
      roleKey: "regional_credit_head",
      clearance: 400_000,
    });
  });

  test("an address the roster does not hold is null, never a guess", () => {
    expect(personIn(subjects, "someone.else@example.test")).toBeNull();
    expect(personIn(subjects, "")).toBeNull();
    expect(personIn(subjects, null)).toBeNull();
    expect(personIn([], "alice@example.test")).toBeNull();
  });

  test("the demo roles read as DESIGN.md writes them, any other as title-cased words", () => {
    expect(PERSONAS.map((persona) => roleLabel(persona.roleKey))).toEqual([
      "Loan Officer",
      "Credit Analyst",
      "VP Credit",
      "Chief Credit Officer",
    ]);
    expect(roleLabel("regional_credit_head")).toBe("Regional Credit Head");
  });

  test("no environment variable decides who the card names", () => {
    // Before #32 the card was keyed on per-persona email variables, which #33
    // removed altogether, so a user added to the database
    // was "not in the cast". The lookup takes no environment at all now.
    const source = readFileSync(join(REPO_ROOT, "lib", "identity", "roster.ts"), "utf8");
    expect(source).not.toMatch(/persona-email-contract|readPersonaEmailOverrides|process\.env|\bPERSONAS\b/);
  });
});

describe("the authority as a person reads it", () => {
  test("dollars with separators, and zero says zero", () => {
    expect(formatAuthority(50_000)).toBe("$50,000");
    expect(formatAuthority(0)).toBe("$0");
    expect(formatAuthority(5_000_000)).toBe("$5,000,000");
  });
});
