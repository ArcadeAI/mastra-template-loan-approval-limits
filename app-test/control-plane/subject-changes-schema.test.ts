/**
 * `subject_changes` (#31, schema version 5) reaches a `governance.db` that
 * predates it. The disk persists (#29), so a table only a fresh seed creates
 * is a table every existing install never gets, and `bun run users` would fail
 * on its first write against a database that opened green.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SCHEMA_VERSION,
  counts,
  openGovernance,
  readSchemaVersion,
  type MigrationReport,
  type SeedOptions,
} from "../../lib/control-plane/policy-store.ts";
import { addSubject, subjectChanges } from "../../lib/control-plane/subjects.ts";

const OPTIONS: SeedOptions = { loanToolkit: "Loan", approvalsToolkit: "Approvals", personaEmails: {} };

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cg-subject-changes-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tableExists = (db: Database, name: string) =>
  db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)!.n === 1;

/** A disk exactly as version 4 left it: this build's seed with the new table taken back out. */
function writeDiskAtVersion4(path: string): void {
  openGovernance(path, OPTIONS).close();
  const db = new Database(path);
  db.exec("DROP TRIGGER subject_changes_is_append_only_update");
  db.exec("DROP TRIGGER subject_changes_is_append_only_delete");
  db.exec("DROP TABLE subject_changes");
  db.exec("UPDATE subjects SET clearance = 75000 WHERE role = 'loan_officer'");
  db.exec("PRAGMA user_version = 4");
  db.close();
}

describe("subject_changes on an existing disk", () => {
  test("this build writes version 5", () => {
    expect(SCHEMA_VERSION).toBe(5);
  });

  test("a version 4 disk gains the table, keeps its rows, and says it migrated", () => {
    withDir((dir) => {
      const path = join(dir, "governance.db");
      writeDiskAtVersion4(path);

      let report: MigrationReport | null = null;
      const db = openGovernance(path, OPTIONS, (r) => {
        report = r;
      });
      try {
        expect(readSchemaVersion(db)).toBe(5);
        expect(tableExists(db, "subject_changes")).toBe(true);
        expect((report as MigrationReport | null)).toMatchObject({ from: 4, to: 5, vacuumMs: null });
        // The live state is the live state: the edited clearance survived.
        expect(counts(db).subjects).toBe(4);
        expect(db.query<{ c: number }, []>("SELECT clearance AS c FROM subjects WHERE role = 'loan_officer'").get()!.c).toBe(75000);

        const change = addSubject(db, { user_id: "new@example.com", display_name: "New", role: "vp_credit", clearance: 1 }, "test");
        expect(subjectChanges(db)).toEqual([change]);
        expect(() => db.exec("DELETE FROM subject_changes")).toThrow(/append-only/);
      } finally {
        db.close();
      }
    });
  });

  test("a disk that still owes #103's VACUUM ends at version 5, not 4", () => {
    withDir((dir) => {
      const path = join(dir, "governance.db");
      writeDiskAtVersion4(path);
      const old = new Database(path);
      old.exec("PRAGMA user_version = 3");
      old.close();

      let report: MigrationReport | null = null;
      const db = openGovernance(path, OPTIONS, (r) => {
        report = r;
      });
      try {
        expect((report as MigrationReport | null)?.from).toBe(3);
        expect((report as MigrationReport | null)?.vacuumMs).not.toBeNull();
        expect(readSchemaVersion(db)).toBe(5);
        expect(tableExists(db, "subject_changes")).toBe(true);
      } finally {
        db.close();
      }

      // And the next boot has nothing left to do.
      let again: MigrationReport | null = null;
      openGovernance(path, OPTIONS, (r) => {
        again = r;
      }).close();
      expect(again).toBeNull();
    });
  });
});
