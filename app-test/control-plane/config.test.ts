import { describe, expect, test } from "bun:test";

import { readConfig } from "../../lib/control-plane/config.ts";
import { counts, loadSeed, openGovernance } from "../../lib/control-plane/policy-store.ts";

/**
 * The `PERSONA_*_EMAIL` contract is gone (#33). Until then these four role
 * variables named the four personas' addresses and were read at first seed;
 * now nobody is seeded, people are added with `bun run users`, and nothing
 * reads a persona variable. A leftover one in somebody's `.env` changes
 * nothing, and refusing it would stop an upgraded checkout from booting over a
 * line that no longer means anything.
 */
describe("no persona email configuration (#33)", () => {
  const PERSONAS = {
    PERSONA_LOAN_OFFICER_EMAIL: "  Alice@Example.com ",
    PERSONA_CREDIT_ANALYST_EMAIL: "bob@example.com",
    PERSONA_VP_CREDIT_EMAIL: "charlie@example.com",
    PERSONA_CHIEF_CREDIT_OFFICER_EMAIL: "michael@example.com",
    PERSONA_DANA_EMAIL: "dana@example.com",
  };

  test("the config carries no persona addresses, and the persona variables do not change it", () => {
    const without = readConfig({ APP_PUBLIC_HOST: "localhost:1" });
    const withThem = readConfig({ APP_PUBLIC_HOST: "localhost:1", ...PERSONAS });
    expect(Object.keys(without)).not.toContain("personaEmails");
    expect(withThem).toEqual(without);
  });

  test("a first boot with them set still seeds nobody, and the demo cast stays at the fixture's addresses", () => {
    const config = readConfig({ APP_PUBLIC_HOST: "localhost:1", ...PERSONAS });
    const db = openGovernance(":memory:", config);
    try {
      expect(counts(db).subjects).toBe(0);
    } finally {
      db.close();
    }
    expect(loadSeed(config).subjects.map((subject) => subject.user_id).sort()).toEqual([
      "alice@bank.example",
      "bob@bank.example",
      "charlie@bank.example",
      "michael@bank.example",
    ]);
  });
});
