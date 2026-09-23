/**
 * The timeline the panel renders: three lanes, a running tally, and the rules
 * for what happens when events arrive faster than anyone can read them.
 *
 * Three properties, each of which the demo would be worse without:
 *
 * - **Nothing is reordered.** Events are held in the order they arrived, never
 *   sorted by `ts`. A burst shares timestamps to the millisecond, and sorting
 *   equal keys is not stable across engines — a panel that shuffles the order
 *   of a deny and the allow that followed it tells the audience the opposite of
 *   what happened.
 * - **Nothing is dropped silently.** Lanes are bounded, because a whole-project
 *   `/access` call decides ten thousand tools and the browser cannot draw that.
 *   But every event past the bound is *counted*, and the lane says how many are
 *   behind it. A control plane that quietly discards records is the failure
 *   this project exists to argue against.
 * - **The lanes are bounded separately.** One shared window would let a chatty
 *   `/access` sweep evict the `/pre` denial that is the point of act 2. Each
 *   lane keeps its own history, so a flood in one cannot erase another.
 *
 * Replays are expected rather than exceptional — a reconnect resends whatever
 * the server was not sure landed — so an event whose `id` has been seen before
 * is ignored outright.
 */
import type { Effect, GovernanceEvent, HookPoint } from "@cg/policy-schema";

export const HOOK_POINTS = ["access", "pre", "post"] as const;

/** How many events a single lane keeps. Beyond this the oldest fall behind. */
export const LANE_CAPACITY = 50;

export interface Timeline {
  /** Each lane newest-first, so the freshest card is always in the same place. */
  readonly lanes: Readonly<Record<HookPoint, readonly GovernanceEvent[]>>;
  /** Events this lane received and no longer holds. Displayed, never hidden. */
  readonly behind: Readonly<Record<HookPoint, number>>;
  /** Decisions over everything ever received, not just what is on screen. */
  readonly counts: Readonly<Record<Effect, number>>;
  /**
   * The same tally, per lane. A lane's header carries its own counts as well
   * as the panel's global ones, because "the pre-hook denied one call" is a
   * different and more useful fact than "something denied one call" — and the
   * three lanes are the structure the panel is read through.
   */
  readonly laneCounts: Readonly<Record<HookPoint, Readonly<Record<Effect, number>>>>;
  /** Total events accepted, after de-duplication. */
  readonly received: number;
  /** The most recent event's id — what the lane flashes for. `null` when empty. */
  readonly latestId: string | null;
  /**
   * Arrival index per accepted event id. Lanes are bounded separately, so this
   * is the only thing that can put the three of them back into one order —
   * which is what `correlate()` reads, and what a presenter means by "then".
   */
  readonly arrival: ReadonlyMap<string, number>;
}

export function emptyTimeline(): Timeline {
  return {
    lanes: { access: [], pre: [], post: [] },
    behind: { access: 0, pre: 0, post: 0 },
    counts: { allow: 0, deny: 0, modify: 0 },
    laneCounts: {
      access: { allow: 0, deny: 0, modify: 0 },
      pre: { allow: 0, deny: 0, modify: 0 },
      post: { allow: 0, deny: 0, modify: 0 },
    },
    received: 0,
    latestId: null,
    arrival: new Map(),
  };
}

/**
 * `timeline` with `incoming` appended, in the order given.
 *
 * Takes a batch rather than one event because that is how a burst actually
 * arrives: the subscriber coalesces everything that landed since the last
 * frame and hands it over together, so a thousand events cost one pass and one
 * render instead of a thousand of each.
 */
export function appendEvents(
  timeline: Timeline,
  incoming: readonly GovernanceEvent[],
  capacity: number = LANE_CAPACITY,
): Timeline {
  const fresh = incoming.filter((event) => !timeline.arrival.has(event.id));
  if (fresh.length === 0) return timeline;

  const lanes: Record<HookPoint, GovernanceEvent[]> = {
    access: [...timeline.lanes.access],
    pre: [...timeline.lanes.pre],
    post: [...timeline.lanes.post],
  };
  const behind = { ...timeline.behind };
  const counts = { ...timeline.counts };
  const laneCounts: Record<HookPoint, Record<Effect, number>> = {
    access: { ...timeline.laneCounts.access },
    pre: { ...timeline.laneCounts.pre },
    post: { ...timeline.laneCounts.post },
  };
  const arrival = new Map(timeline.arrival);

  for (const event of fresh) {
    // `unshift` keeps the lane newest-first, which is the reverse of arrival
    // order and the only reordering this module performs.
    lanes[event.hook].unshift(event);
    arrival.set(event.id, arrival.size);
    counts[event.decision] += 1;
    laneCounts[event.hook][event.decision] += 1;
  }

  for (const hook of HOOK_POINTS) {
    const overflow = lanes[hook].length - capacity;
    if (overflow > 0) {
      lanes[hook].length = capacity;
      behind[hook] += overflow;
    }
  }

  return {
    lanes,
    behind,
    counts,
    laneCounts,
    received: timeline.received + fresh.length,
    latestId: fresh[fresh.length - 1]?.id ?? timeline.latestId,
    arrival,
  };
}

/**
 * Everything the panel still holds, back in arrival order. What `correlate()`
 * reads, so a join returns events in the order they happened rather than
 * grouped by the lane they landed in.
 */
export function allEvents(timeline: Timeline): GovernanceEvent[] {
  const index = (event: GovernanceEvent): number => timeline.arrival.get(event.id) ?? 0;
  return HOOK_POINTS.flatMap((hook) => timeline.lanes[hook]).sort(
    (left, right) => index(left) - index(right),
  );
}
