import { describe, expect, test } from "bun:test";
import { aGovernanceEvent, aGovernanceEventSequence } from "@cg/policy-schema";
import type { GovernanceEvent } from "@cg/policy-schema";

// The hook server writes the token this module reads. Importing its writer here
// — in a test, never at runtime — is what stops the two halves of the contract
// drifting apart silently, which for a correlation token looks exactly like a
// panel that simply never joins anything.
import { withCorrelation } from "../../hooks/src/correlation.ts";
import { CORRELATION_TOKEN, correlate, isCorrelated } from "../lib/governance/correlation.ts";

/** The prefix Arcade wraps our message in. Theirs, undocumented, may change. */
const ARCADE_PREFIX = "Tool execution was denied by an extension policy: ";

describe("the token contract with apps/hooks", () => {
  test("reads back an id the hook server wrote", () => {
    const message = withCorrelation("Exceeds your approval authority.", "evt_4k7xq2m9hz");

    expect(CORRELATION_TOKEN.exec(message)?.[1]).toBe("evt_4k7xq2m9hz");
  });

  test("reads it back through Arcade's prefix", () => {
    const message = ARCADE_PREFIX + withCorrelation("Exceeds your authority.", "evt_4k7xq2m9hz");

    expect(CORRELATION_TOKEN.exec(message)?.[1]).toBe("evt_4k7xq2m9hz");
  });
});

/**
 * A call as the panel sees it: `/access`, `/pre`, `/post`, sharing one Arcade
 * execution id, with ids in the format `apps/hooks` actually mints — `evt_`
 * plus ten Crockford base32 characters. #5's `aGovernanceEventSequence()` uses
 * short readable ids (`evt_0001`) that the token deliberately will not match,
 * so correlation is exercised against realistic ones here.
 */
function aCorrelatedCall(): GovernanceEvent[] {
  const execution_id = "exec_7f3c1a";
  return [
    aGovernanceEvent({ id: "evt_2p9wq4nb7c", hook: "access", execution_id: "", decision: "allow" }),
    aGovernanceEvent({ id: "evt_4k7xq2m9hz", hook: "pre", execution_id, decision: "deny" }),
    aGovernanceEvent({ id: "evt_8t3zh6vd2m", hook: "post", execution_id, decision: "modify" }),
    aGovernanceEvent({ id: "evt_5r1nc8jk4q", hook: "pre", execution_id: "exec_other", decision: "allow" }),
  ];
}

describe("correlate, by message", () => {
  test("joins a denial to every event of the same execution", () => {
    const events = aCorrelatedCall();
    const message = withCorrelation("Exceeds your approval authority.", "evt_4k7xq2m9hz");

    const joined = correlate(events, { kind: "message", message });

    expect(joined.map((event) => event.id)).toEqual(["evt_4k7xq2m9hz", "evt_8t3zh6vd2m"]);
  });

  test("returns the anchor alone when it has no execution id", () => {
    const events = aCorrelatedCall();

    const joined = correlate(events, {
      kind: "message",
      message: withCorrelation("Role has no access to this tool.", "evt_2p9wq4nb7c"),
    });

    expect(joined.map((event) => event.id)).toEqual(["evt_2p9wq4nb7c"]);
  });

  test("does not reach into a different execution", () => {
    const events = aCorrelatedCall();
    const message = withCorrelation("Denied.", "evt_4k7xq2m9hz");

    expect(correlate(events, { kind: "message", message })).not.toContainEqual(
      expect.objectContaining({ id: "evt_5r1nc8jk4q" }),
    );
  });
});

describe("correlate, by execution id", () => {
  test("joins every event Arcade gave the same execution", () => {
    const joined = correlate(aCorrelatedCall(), {
      kind: "execution",
      executionId: "exec_7f3c1a",
    });

    expect(joined.map((event) => event.id)).toEqual(["evt_4k7xq2m9hz", "evt_8t3zh6vd2m"]);
  });

  test("an empty execution id joins nothing, rather than every /access event", () => {
    expect(correlate(aCorrelatedCall(), { kind: "execution", executionId: "" })).toEqual([]);
  });
});

describe("failing soft", () => {
  // Each of these is a message the panel could plausibly be handed on stage.
  // Every one of them must produce an empty join and no throw — the events are
  // still rendered in their lanes, just without the highlight.
  const unparseable: ReadonlyArray<readonly [string, string]> = [
    ["no token at all", "Tool execution was denied by an extension policy: you may not do that."],
    ["Arcade changed the prefix", "Blocked by policy. [ref evt_4k7xq2m9hz] and then some trailing prose."],
    ["a truncated id", "Denied. [ref evt_4k7xq2m9]"],
    ["an id using an excluded letter", "Denied. [ref evt_4k7xq2m9hi]"],
    ["a different bracket form", "Denied. (ref evt_4k7xq2m9hz)"],
    ["the empty string", ""],
  ];

  for (const [what, message] of unparseable) {
    test(`${what} joins nothing and does not throw`, () => {
      expect(correlate(aCorrelatedCall(), { kind: "message", message })).toEqual([]);
    });
  }

  test("a well-formed token for an event the panel never received joins nothing", () => {
    const message = withCorrelation("Denied.", "evt_zzzzzzzzzz");

    expect(correlate(aCorrelatedCall(), { kind: "message", message })).toEqual([]);
  });

  test("an empty event list joins nothing", () => {
    const message = withCorrelation("Denied.", "evt_4k7xq2m9hz");

    expect(correlate([], { kind: "message", message })).toEqual([]);
  });
});

describe("isCorrelated", () => {
  test("agrees with correlate about which events are joined", () => {
    const events = aGovernanceEventSequence();
    const joined = correlate(events, { kind: "execution", executionId: events[1]!.execution_id });

    expect(events.filter((event) => isCorrelated(joined, event)).map((event) => event.id)).toEqual(
      joined.map((event) => event.id),
    );
  });

  test("nothing is correlated against an empty join", () => {
    expect(isCorrelated([], aGovernanceEvent())).toBe(false);
  });
});
