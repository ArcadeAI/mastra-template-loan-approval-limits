/**
 * The name, role and clearance beside a person come from `governance.db` (#32).
 *
 * Until #32 the sign-in card and the loan cards' "decided by" read a static
 * list of four personas joined on the `PERSONA_*` variables, so a user added to
 * the database had a role the hooks enforced and a card that said nobody was
 * there. Here the control plane is real — its own server on a port the OS
 * handed out, over a `governance.db` seeded from the shipped fixture — and a
 * user is added the way `bun run users add` adds one, as a `subjects` row. The
 * card and the loan book then read it through `GET /api/approvals/roster`, the
 * route the app's pages read at `CONTROL_PLANE_HOST`.
 *
 * The one stand-in is the loan book `readLoanBook` is handed: the claim is
 * about whose name goes on a decision, not about the bank, whose own reads are
 * `api-loans.test.ts`'s.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { PersonaToolList } from "../components/identity/PersonaToolList.tsx";
import type { SessionTools } from "../lib/agent/tool-list.ts";
import type { HooksConfig } from "../lib/control-plane/config.ts";
import { fixtureDigest } from "../lib/control-plane/fixture-drift.ts";
import { createPolicyCache } from "../lib/control-plane/policy-cache.ts";
import { loadSeed, openGovernance, seed as seedInto } from "../lib/control-plane/policy-store.ts";
import { createServer } from "../lib/control-plane/server.ts";
import { lookupPerson, type PersonLookup } from "../lib/identity/roster.ts";
import type { Session } from "../lib/identity/session.ts";
import { readLoanBook } from "../lib/loan-context/read.ts";

const STORE_TOKEN = "roster-test-store-token";
const POLL_MS = 10;
const PRIYA = { user_id: "priya@company.test", display_name: "Priya", role: "vp_credit", clearance: 400_000 };

const config: HooksConfig = {
  port: 0,
  dbPath: ":memory:",
  signingSecret: "roster-test-hook-secret",
  approvalsStoreToken: STORE_TOKEN,
  loanToolkit: "Loan",
  approvalsToolkit: "Approvals",
  personaEmails: {},
  deadlineMs: 2500,
  policyPollMs: POLL_MS,
  grantTtlSeconds: 900,
  injectionDetection: "armed",
  resetToken: "",
};

interface Plane {
  db: Database;
  roster: { controlPlaneHost: string; approvalsStoreToken: string };
  stop(): void;
}

const planes: Plane[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const plane of planes.splice(0)) plane.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The control plane, booted the way `lib/control-plane/index.ts` boots it, over a fresh disk. */
function bootPlane(options: { start?: boolean } = {}): Plane {
  const dir = mkdtempSync(join(tmpdir(), "cg-32-roster-"));
  dirs.push(dir);
  const dbPath = join(dir, "governance.db");
  const image = loadSeed(config);
  const seeded = new Database(dbPath, { create: true });
  seedInto(seeded, image);
  seeded.close();

  const db = openGovernance(dbPath, config);
  const cache = createPolicyCache(db, {
    log: () => {},
    pollMs: POLL_MS,
    scanners: config.injectionDetection,
    fixture: fixtureDigest(config, image),
  });
  if (options.start !== false) cache.start();
  const server = createServer({ config: { ...config, dbPath }, db, cache, log: () => {}, seed: image });
  const plane: Plane = {
    db,
    roster: { controlPlaneHost: `localhost:${server.port}`, approvalsStoreToken: STORE_TOKEN },
    stop() {
      cache.stop();
      server.stop(true);
      db.close();
    },
  };
  planes.push(plane);
  return plane;
}

/** Where a control plane was a moment ago: a real address nothing answers on any more. */
function stoppedPlane(): Plane["roster"] {
  const plane = bootPlane();
  plane.stop();
  planes.splice(planes.indexOf(plane), 1);
  return plane.roster;
}

/** What `bun run users add` writes (#31): one `subjects` row. */
function addUser(db: Database, user: typeof PRIYA): void {
  db.run(
    "INSERT INTO subjects (user_id, display_name, role, clearance, attributes) VALUES (?, ?, ?, ?, '{}')",
    [user.user_id, user.display_name, user.role, user.clearance],
  );
}

const TOOLS: SessionTools = { ok: true, tools: [], filtered: [] };

function card(email: string, person: PersonLookup): string {
  const session: Session = { email, signed_in_at: 0 };
  return renderToStaticMarkup(<PersonaToolList session={session} tools={TOOLS} person={person} />);
}

describe("the signed-in card reads the subjects table", () => {
  test("a user added through the database is named, with their role and clearance", async () => {
    const plane = bootPlane();
    addUser(plane.db, PRIYA);
    await Bun.sleep(POLL_MS * 8);

    // Capitalised, as a session could never be but a hand-typed address can.
    const person = await lookupPerson("Priya@Company.Test", plane.roster);
    expect(person).toEqual({
      status: "found",
      person: { email: PRIYA.user_id, name: "Priya", role: "VP Credit", roleKey: "vp_credit", clearance: 400_000 },
    });

    const markup = card(PRIYA.user_id, person);
    expect(markup).toContain("<strong>Priya</strong>");
    expect(markup).toContain("VP Credit");
    expect(markup).toContain("$400,000");
    expect(markup).not.toContain("Not in this deployment");
  });

  test("the demo cast is read from the same table, not from a list in the app", async () => {
    const plane = bootPlane();
    const alice = await lookupPerson("alice@bank.example", plane.roster);
    expect(alice.status === "found" && [alice.person.name, alice.person.role, alice.person.clearance]).toEqual([
      "Alice",
      "Loan Officer",
      50_000,
    ]);

    // A clearance raised live is what the next page load shows.
    plane.db.run("UPDATE subjects SET clearance = 75000, display_name = 'Alice B.' WHERE user_id = 'alice@bank.example'");
    await Bun.sleep(POLL_MS * 8);
    const raised = await lookupPerson("alice@bank.example", plane.roster);
    expect(raised.status === "found" && [raised.person.name, raised.person.clearance]).toEqual(["Alice B.", 75_000]);
    expect(card("alice@bank.example", raised)).toContain("$75,000");
  });

  test("an address with no subject row is 'not in the cast'", async () => {
    const plane = bootPlane();
    const person = await lookupPerson("stranger@elsewhere.example", plane.roster);
    expect(person).toEqual({ status: "unknown" });
    expect(card("stranger@elsewhere.example", person)).toContain("has no subject at that address");
  });

  test("a control plane that cannot answer is 'unavailable', never 'not in the cast'", async () => {
    const person = await lookupPerson("alice@bank.example", stoppedPlane());
    expect(person.status).toBe("unavailable");
    expect(card("alice@bank.example", person)).toContain("could not be read");
  });

  test("so is a policy that has not loaded, whose roster is empty for a different reason", async () => {
    const plane = bootPlane({ start: false });
    const person = await lookupPerson("alice@bank.example", plane.roster);
    expect(person).toEqual({ status: "unavailable", reason: "the control plane's policy is cold, so it has no roster to give" });
  });

  test("the wrong store bearer is unavailable too, and says what the control plane answered", async () => {
    const plane = bootPlane();
    const person = await lookupPerson("alice@bank.example", { ...plane.roster, approvalsStoreToken: "wrong" });
    expect(person).toEqual({ status: "unavailable", reason: "the control plane answered 401" });
  });

  test("nobody signed in asks nobody", async () => {
    expect(await lookupPerson(null, stoppedPlane())).toEqual({
      status: "signed-out",
    });
  });
});

describe("decided_by_name reads the subjects table", () => {
  /** Two loans: one decided by a user added through the database, one by an address nobody holds. */
  const loanBook = {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/loans") return Response.json({ count: 2, loans: [{ loan_id: "LN-1" }, { loan_id: "LN-2" }] });
      const id = path.split("/").pop();
      const decided_by = id === "LN-1" ? PRIYA.user_id : "gone@company.test";
      return Response.json({
        loan_id: id,
        borrower_name: "Northwind Bakery LLC",
        amount: 95_000,
        status: "approved",
        decisions: [{ decided_by, decided_at: "2026-09-26T10:00:00Z" }],
      });
    },
  };

  const session: Session = {
    email: "alice@bank.example",
    signed_in_at: Date.now(),
    idp: { access_token: "a-bearer", expires_at: Date.now() + 3_600_000 },
  };

  test("a decision by a user added through the database carries their name", async () => {
    const plane = bootPlane();
    addUser(plane.db, PRIYA);
    await Bun.sleep(POLL_MS * 8);

    const book = await readLoanBook(session, { loans: loanBook, roster: plane.roster });
    expect(book.status).toBe("loaded");
    const cards = book.status === "loaded" ? book.loans : [];
    expect(cards.map((each) => [each.loan_id, each.decided_by, each.decided_by_name])).toEqual([
      ["LN-1", PRIYA.user_id, "Priya"],
      // Nobody at that address: no name, and the card shows the address.
      ["LN-2", "gone@company.test", null],
    ]);
  });

  test("with the roster unreachable the decision keeps its address and names nobody", async () => {
    const book = await readLoanBook(session, { loans: loanBook, roster: stoppedPlane() });
    expect(book.status === "loaded" && book.loans.map((each) => each.decided_by_name)).toEqual([null, null]);
  });
});
