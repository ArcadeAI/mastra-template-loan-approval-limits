/**
 * The app's `/health` carries the loan book (#5), under the one-response shape
 * `DESIGN.md` → Readiness describes: one field per capability, `status:
 * ok|degraded`, HTTP 200 either way.
 *
 * `loans` is never a bare count. `cg-loan-app` answered `loans: <n>`, and `0`
 * read the same whether the book was empty or the database never opened — the
 * zero that means "broken" rather than "absent". So a loan book that did not
 * open says `failed`, names why, has no count at all, and makes the whole
 * answer `degraded`.
 *
 * Through the route itself, in-process, against the app's one loan book: first
 * in memory, then deliberately unopenable.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET } from "../../app/health/route.ts";
import fixture from "../../lib/loans/fixtures/loans.json" with { type: "json" };
import { closeLoanModule } from "../../lib/loans/instance.ts";
import { bootTestControlPlane } from "../control-plane-instance.ts";

bootTestControlPlane();

const scratch = mkdtempSync(join(tmpdir(), "cg-loans-health-"));
const previous = process.env.LOANS_DB_PATH;

afterAll(() => {
  closeLoanModule();
  if (previous === undefined) delete process.env.LOANS_DB_PATH;
  else process.env.LOANS_DB_PATH = previous;
  rmSync(scratch, { recursive: true, force: true });
});

async function health(): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = GET();
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("/health reports the loan book", () => {
  test("an open book is ok, with the number of loans it holds", async () => {
    closeLoanModule();
    process.env.LOANS_DB_PATH = ":memory:";

    const { status, body } = await health();

    expect(status).toBe(200);
    expect(body.loans).toEqual({ status: "ok", count: fixture.loans.length });
    expect(fixture.loans.length).toBeGreaterThan(1);
  });

  test("a book that did not open is failed, says why, and makes the answer degraded", async () => {
    closeLoanModule();
    // A regular file where the database's directory should be: `openLoanBook`
    // cannot create `loans.db` under it, whatever the permissions.
    const blocker = join(scratch, "not-a-directory");
    writeFileSync(blocker, "");
    process.env.LOANS_DB_PATH = join(blocker, "loans.db");

    const { status, body } = await health();

    // 200 still, so a human can read it.
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    const loans = body.loans as { status: string; count: unknown; error: string };
    expect(loans.status).toBe("failed");
    expect(loans.count).toBeNull();
    expect(loans.error.length).toBeGreaterThan(0);
  });
});
