/**
 * What the act 1 widget actually renders.
 *
 * Assertions are on markup, through the component's own two props, with nothing
 * mocked — the same shape as `panel.test.tsx`. The properties checked here are
 * the ones the beat's credibility rests on:
 *
 * - the tool that was hidden is **absent**, not rendered as struck-through or
 *   greyed out. A crossed-out `ApproveLoan` would be a picture of a control that
 *   does nothing, and it is the single most tempting thing to add to this
 *   screen.
 * - the built-ins that were filtered are **named**, because "eight became six"
 *   is an arithmetic nobody should have to take on trust.
 * - a failure to list is a sentence, never an empty list.
 * - the authority figure is labelled as the policy's at page load, since it is
 *   read from `governance.db` (#32) and a presenter may raise it live.
 * - "not in the cast" and "the roster could not be read" are different
 *   sentences.
 *
 * The person beside the session is the page's lookup, handed in as data. Here
 * it is built by `personIn`, the same function `lookupPerson` applies to the
 * control plane's answer; `roster-from-database.test.tsx` makes that answer
 * come from a real `governance.db`.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PersonaToolList } from "../components/identity/PersonaToolList.tsx";
import type { SessionTools } from "../lib/agent/tool-list.ts";
import type { RosterEntry } from "../lib/approvals-store.ts";
import { personIn, type PersonLookup } from "../lib/identity/roster.ts";
import type { Session } from "../lib/identity/session.ts";

const DANA = "alice@bank.example";
const SAM = "bob@bank.example";

/** What `GET /api/approvals/roster` answers on a freshly seeded `governance.db`, as far as the card reads it. */
const ROSTER: RosterEntry[] = [
  { user_id: DANA, display_name: "Alice", role: "loan_officer", clearance: 50_000 },
  { user_id: SAM, display_name: "Bob", role: "credit_analyst", clearance: 0 },
  { user_id: "charlie@bank.example", display_name: "Charlie", role: "vp_credit", clearance: 250_000 },
  { user_id: "michael@bank.example", display_name: "Michael", role: "chief_credit_officer", clearance: 5_000_000 },
];

function lookup(session: Session | null): PersonLookup {
  if (session === null) return { status: "signed-out" };
  const person = personIn(ROSTER, session.email);
  return person ? { status: "found", person } : { status: "unknown" };
}

function session(email: string): Session {
  return { email, signed_in_at: 0, gateway: { access_token: "tok", expires_at: 0, client_id: "c" } };
}

const SAM_TOOLS: SessionTools = {
  ok: true,
  tools: [
    { name: "Loan_SearchLoans", description: "Find loan applications in the loan book." },
    { name: "Loan_GetLoan", description: "Read one loan application's complete file by ID." },
    { name: "Loan_DenyLoan", description: "Decline a loan application with a stated reason." },
  ],
  filtered: ["System_ManageAuthorization", "Arcade_ListApps"],
};

const DANA_TOOLS: SessionTools = {
  ok: true,
  tools: [
    ...SAM_TOOLS.ok ? SAM_TOOLS.tools : [],
    { name: "Loan_ApproveLoan", description: "Approve a loan application for a given dollar amount." },
  ],
  filtered: ["System_ManageAuthorization", "Arcade_ListApps"],
};

const render = (props: { session: Session | null; tools: SessionTools; person?: PersonLookup }) =>
  renderToStaticMarkup(<PersonaToolList person={lookup(props.session)} {...props} />);

describe("the persona, with role and authority", () => {
  test("all three are on screen, and the email is the identity", () => {
    const markup = render({ session: session(DANA), tools: DANA_TOOLS });

    expect(markup).toContain("Alice");
    expect(markup).toContain("Loan Officer");
    expect(markup).toContain("$50,000");
    // The address, always: it is the string Arcade sees as `user_id` and the
    // loan book records as the actor, and a screen about who the agent acts as
    // that shows only a friendly name is showing the label and hiding the fact.
    expect(markup).toContain(DANA);
  });

  test("Bob's authority is zero, and zero is written out rather than left blank", () => {
    const markup = render({ session: session(SAM), tools: SAM_TOOLS });

    expect(markup).toContain("Bob");
    expect(markup).toContain("Credit Analyst");
    expect(markup).toContain("$0");
  });

  test("the figure says when it was read", () => {
    // `DESIGN.md` lets a presenter raise a clearance live on stage. The figure
    // is the subject row at page load, and says so, rather than presenting
    // itself as what the next call will be decided with.
    expect(render({ session: session(DANA), tools: DANA_TOOLS })).toContain("in the policy when this page loaded");
  });

  test("an address the control plane has no subject for is said out loud, not guessed at", () => {
    const markup = render({ session: session("stranger@elsewhere.example"), tools: SAM_TOOLS });

    expect(markup).toContain("stranger@elsewhere.example");
    expect(markup).toContain("Not in this deployment’s cast");
    expect(markup).toContain("has no subject at that address");
    // No borrowed role and no borrowed figure.
    expect(markup).not.toContain("Loan Officer");
    expect(markup).not.toContain("$50,000");
  });

  test("a roster that could not be read is not 'not in the cast'", () => {
    const markup = render({
      session: session(DANA),
      tools: DANA_TOOLS,
      person: { status: "unavailable", reason: "the control plane answered 503" },
    });

    expect(markup).toContain("the control plane answered 503");
    expect(markup).toContain("says nothing about whether the address above is in the cast");
    expect(markup).not.toContain("cast</strong>");
    expect(markup).not.toContain("$50,000");
  });

  test("a role outside the demo cast's reads as words", () => {
    const person = personIn(
      [{ user_id: "priya@company.test", display_name: "Priya", role: "regional_credit_head", clearance: 400_000 }],
      "Priya@Company.Test",
    );
    const markup = render({
      session: session("priya@company.test"),
      tools: DANA_TOOLS,
      person: person ? { status: "found", person } : { status: "unknown" },
    });

    expect(markup).toContain("Priya");
    expect(markup).toContain("Regional Credit Head");
    expect(markup).toContain("$400,000");
  });

  test("nobody signed in says so", () => {
    const markup = render({ session: null, tools: { ok: false, reason: "Nobody is signed in." } });
    expect(markup).toContain("Nobody is signed in");
  });
});

describe("the tool list", () => {
  test("as Bob the approval tool is absent — not struck through, not greyed out, absent", () => {
    const markup = render({ session: session(SAM), tools: SAM_TOOLS });

    expect(markup).toContain("Loan_SearchLoans");
    expect(markup).toContain("Loan_GetLoan");
    expect(markup).toContain("Loan_DenyLoan");
    // The assertion the whole act rests on. There is nothing on this screen for
    // anyone to point at and ask "why is it still there?"
    expect(markup).not.toContain("ApproveLoan");
    expect(markup).not.toContain("approve_loan");
  });

  test("as Alice it is there", () => {
    expect(render({ session: session(DANA), tools: DANA_TOOLS })).toContain("Loan_ApproveLoan");
  });

  test("the page says where the list came from, and that it was not filtered here", () => {
    const markup = render({ session: session(SAM), tools: SAM_TOOLS });

    // The claim is on the screen, not only in a comment: a UI that filtered a
    // full catalogue client-side would render the same three rows while proving
    // the opposite thing, so it says which of the two it did.
    expect(markup).toContain("tools/list");
    expect(markup).toContain("Not filtered in the browser");
  });

  test("the roster is a native keyboard-collapsible disclosure with its count in the label", () => {
    const markup = render({ session: session(DANA), tools: DANA_TOOLS });

    expect(markup).toContain("<details");
    expect(markup).toContain("<summary");
    expect(markup).toContain("4 tools available");
    expect(markup).not.toContain("<details open");
  });

  test("the filtered built-ins are named, not quietly dropped", () => {
    const markup = render({ session: session(DANA), tools: DANA_TOOLS });

    expect(markup).toContain("System_ManageAuthorization");
    expect(markup).toContain("Arcade_ListApps");
    expect(markup).toContain("2 further");
  });

  test("a list that could not be fetched is a sentence, never an empty list", () => {
    const markup = render({
      session: session(DANA),
      tools: { ok: false, reason: "The gateway listed no tools at all." },
    });

    expect(markup).toContain("No tool list.");
    expect(markup).toContain("The gateway listed no tools at all.");
    // And nothing that reads as "this persona may use nothing".
    expect(markup).not.toContain("advertised nothing this persona may use");
  });

  test("an empty-but-successful list says the gateway advertised nothing usable", () => {
    const markup = render({ session: session(SAM), tools: { ok: true, tools: [], filtered: [] } });
    expect(markup).toContain("advertised nothing this persona may use");
  });
});
