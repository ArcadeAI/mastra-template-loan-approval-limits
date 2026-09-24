import { describe, expect, test } from "bun:test";
import type { Effect, GovernanceEvent, HookPoint } from "@cg/policy-schema";
import { aGovernanceEvent, aGovernanceEventSequence } from "@cg/policy-schema";

import {
  allEvents,
  appendEvents,
  emptyTimeline,
  HOOK_POINTS,
  LANE_CAPACITY,
} from "../lib/governance/timeline.ts";

function anEvent(index: number, hook: HookPoint = "pre", decision: Effect = "allow") {
  return aGovernanceEvent({ id: `evt_${index}`, hook, decision });
}

/** Feed a whole list in one go, as the subscriber does per frame. */
function timelineOf(events: readonly GovernanceEvent[], capacity?: number) {
  return appendEvents(emptyTimeline(), events, capacity);
}

describe("lanes", () => {
  test("an empty timeline has three empty lanes", () => {
    const timeline = emptyTimeline();

    expect(timeline.lanes).toEqual({ access: [], pre: [], post: [] });
    expect(timeline.received).toBe(0);
    expect(timeline.latestId).toBeNull();
  });

  test("each event lands in the lane of its hook", () => {
    const timeline = timelineOf([
      anEvent(1, "access"),
      anEvent(2, "pre"),
      anEvent(3, "post"),
      anEvent(4, "access"),
    ]);

    expect(timeline.lanes.access.map((event) => event.id)).toEqual(["evt_4", "evt_1"]);
    expect(timeline.lanes.pre.map((event) => event.id)).toEqual(["evt_2"]);
    expect(timeline.lanes.post.map((event) => event.id)).toEqual(["evt_3"]);
  });

  test("a lane is newest-first, so the freshest card never moves", () => {
    const timeline = timelineOf([anEvent(1), anEvent(2), anEvent(3)]);

    expect(timeline.lanes.pre.map((event) => event.id)).toEqual(["evt_3", "evt_2", "evt_1"]);
    expect(timeline.latestId).toBe("evt_3");
  });

  test("appending across calls continues the same order", () => {
    let timeline = timelineOf([anEvent(1), anEvent(2)]);
    timeline = appendEvents(timeline, [anEvent(3)]);

    expect(timeline.lanes.pre.map((event) => event.id)).toEqual(["evt_3", "evt_2", "evt_1"]);
  });
});

describe("counts", () => {
  test("tally every decision the panel has seen", () => {
    const timeline = timelineOf([
      anEvent(1, "access", "deny"),
      anEvent(2, "pre", "deny"),
      anEvent(3, "pre", "allow"),
      anEvent(4, "post", "modify"),
      anEvent(5, "post", "allow"),
    ]);

    expect(timeline.counts).toEqual({ allow: 2, deny: 2, modify: 1 });
    expect(timeline.received).toBe(5);
  });

  test("counts keep counting past a lane's capacity", () => {
    const events = Array.from({ length: 40 }, (_, index) => anEvent(index, "pre", "deny"));

    const timeline = timelineOf(events, 5);

    expect(timeline.counts.deny).toBe(40);
    expect(timeline.received).toBe(40);
  });
});

describe("no event is dropped silently", () => {
  test("a lane past capacity says how many are behind it", () => {
    const events = Array.from({ length: 12 }, (_, index) => anEvent(index, "pre"));

    const timeline = timelineOf(events, 5);

    expect(timeline.lanes.pre).toHaveLength(5);
    expect(timeline.behind.pre).toBe(7);
  });

  test("what a lane holds plus what is behind it is everything it received", () => {
    const events = Array.from({ length: 137 }, (_, index) => anEvent(index, "post"));

    const timeline = timelineOf(events, LANE_CAPACITY);

    expect(timeline.lanes.post.length + timeline.behind.post).toBe(137);
  });

  test("a lane under capacity has nothing behind it", () => {
    const timeline = timelineOf([anEvent(1), anEvent(2)], 5);

    expect(timeline.behind).toEqual({ access: 0, pre: 0, post: 0 });
  });

  test("a flood of /access cannot evict the /pre denial that act 2 turns on", () => {
    // The measured case: a whole-project /access decides 10,844 tools. One
    // shared window would push everything else off the panel.
    const denial = aGovernanceEvent({ id: "evt_the_denial", hook: "pre", decision: "deny" });
    const flood = Array.from({ length: 10_844 }, (_, index) => anEvent(index, "access"));

    const timeline = timelineOf([denial, ...flood]);

    expect(timeline.lanes.pre.map((event) => event.id)).toEqual(["evt_the_denial"]);
    expect(timeline.behind.access).toBe(10_844 - LANE_CAPACITY);
    expect(timeline.behind.pre).toBe(0);
  });
});

describe("a burst is neither dropped nor reordered", () => {
  test("a thousand events arrive complete and in reverse arrival order", () => {
    const events = Array.from({ length: 1000 }, (_, index) => anEvent(index, "pre"));

    const timeline = timelineOf(events, 1000);

    expect(timeline.received).toBe(1000);
    expect(timeline.behind.pre).toBe(0);
    expect(timeline.lanes.pre.map((event) => event.id)).toEqual(
      events.map((event) => event.id).reverse(),
    );
  });

  test("arriving one at a time gives the same result as arriving in one batch", () => {
    const events = Array.from({ length: 300 }, (_, index) =>
      anEvent(index, index % 3 === 0 ? "access" : index % 3 === 1 ? "pre" : "post"),
    );

    const oneAtATime = events.reduce(
      (timeline, event) => appendEvents(timeline, [event]),
      emptyTimeline(),
    );
    const allAtOnce = timelineOf(events);

    expect(oneAtATime.lanes).toEqual(allAtOnce.lanes);
    expect(oneAtATime.counts).toEqual(allAtOnce.counts);
    expect(oneAtATime.behind).toEqual(allAtOnce.behind);
  });

  test("out-of-order timestamps are not re-sorted — arrival order is the truth", () => {
    const later = aGovernanceEvent({ id: "evt_a", ts: "2026-01-01T00:00:09.000Z" });
    const earlier = aGovernanceEvent({ id: "evt_b", ts: "2026-01-01T00:00:01.000Z" });

    const timeline = timelineOf([later, earlier]);

    expect(timeline.lanes.pre.map((event) => event.id)).toEqual(["evt_b", "evt_a"]);
  });

  test("events sharing a timestamp to the millisecond keep their arrival order", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const events = Array.from({ length: 50 }, (_, index) =>
      aGovernanceEvent({ id: `evt_${index}`, ts }),
    );

    const timeline = timelineOf(events);

    expect(timeline.lanes.pre.map((event) => event.id)).toEqual(
      events.map((event) => event.id).reverse(),
    );
  });
});

describe("a reconnect's replay", () => {
  test("an id already accepted is ignored", () => {
    let timeline = timelineOf([anEvent(1), anEvent(2)]);
    timeline = appendEvents(timeline, [anEvent(2), anEvent(3)]);

    expect(timeline.lanes.pre.map((event) => event.id)).toEqual(["evt_3", "evt_2", "evt_1"]);
    expect(timeline.received).toBe(3);
  });

  test("a replay of nothing new returns the very same timeline", () => {
    const timeline = timelineOf([anEvent(1)]);

    expect(appendEvents(timeline, [anEvent(1)])).toBe(timeline);
  });

  test("a duplicate does not double-count a decision", () => {
    let timeline = timelineOf([anEvent(1, "pre", "deny")]);
    timeline = appendEvents(timeline, [anEvent(1, "pre", "deny")]);

    expect(timeline.counts.deny).toBe(1);
  });
});

describe("allEvents", () => {
  test("returns the three lanes interleaved back into arrival order", () => {
    const timeline = timelineOf([
      anEvent(1, "access"),
      anEvent(2, "post"),
      anEvent(3, "pre"),
      anEvent(4, "access"),
    ]);

    expect(allEvents(timeline).map((event) => event.id)).toEqual([
      "evt_1",
      "evt_2",
      "evt_3",
      "evt_4",
    ]);
  });

  test("#5's fixture sequence round-trips in the order it was written", () => {
    const sequence = aGovernanceEventSequence();

    expect(allEvents(timelineOf(sequence)).map((event) => event.id)).toEqual(
      sequence.map((event) => event.id),
    );
  });
});

describe("appendEvents does not mutate what it was given", () => {
  test("the previous timeline is unchanged", () => {
    const before = timelineOf([anEvent(1)]);
    const laneBefore = before.lanes.pre;

    appendEvents(before, [anEvent(2)]);

    expect(before.lanes.pre).toBe(laneBefore);
    expect(before.lanes.pre).toHaveLength(1);
    expect(before.received).toBe(1);
  });
});

describe("per-lane counts", () => {
  test("each lane tallies only its own hook", () => {
    const timeline = timelineOf([
      anEvent(1, "access", "deny"),
      anEvent(2, "pre", "deny"),
      anEvent(3, "pre", "allow"),
      anEvent(4, "post", "modify"),
      anEvent(5, "post", "modify"),
    ]);

    expect(timeline.laneCounts.access).toEqual({ allow: 0, deny: 1, modify: 0 });
    expect(timeline.laneCounts.pre).toEqual({ allow: 1, deny: 1, modify: 0 });
    expect(timeline.laneCounts.post).toEqual({ allow: 0, deny: 0, modify: 2 });
  });

  test("the three lanes sum to the global tally", () => {
    const events = Array.from({ length: 90 }, (_, index) =>
      anEvent(
        index,
        index % 3 === 0 ? "access" : index % 3 === 1 ? "pre" : "post",
        index % 2 === 0 ? "allow" : "deny",
      ),
    );

    const timeline = timelineOf(events);

    for (const decision of ["allow", "deny", "modify"] as const) {
      const summed = HOOK_POINTS.reduce(
        (total, hook) => total + timeline.laneCounts[hook][decision],
        0,
      );
      expect(summed).toBe(timeline.counts[decision]);
    }
  });

  test("a lane keeps counting past its capacity", () => {
    const events = Array.from({ length: 400 }, (_, index) =>
      anEvent(index, "access", "deny"),
    );

    const timeline = timelineOf(events, 5);

    expect(timeline.lanes.access).toHaveLength(5);
    expect(timeline.laneCounts.access.deny).toBe(400);
  });

  test("an empty timeline has three zeroed lanes", () => {
    expect(emptyTimeline().laneCounts).toEqual({
      access: { allow: 0, deny: 0, modify: 0 },
      pre: { allow: 0, deny: 0, modify: 0 },
      post: { allow: 0, deny: 0, modify: 0 },
    });
  });

  test("a replayed duplicate does not double-count its lane", () => {
    let timeline = timelineOf([anEvent(1, "pre", "deny")]);
    timeline = appendEvents(timeline, [anEvent(1, "pre", "deny")]);

    expect(timeline.laneCounts.pre.deny).toBe(1);
  });
});
