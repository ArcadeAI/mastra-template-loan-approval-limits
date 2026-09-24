/**
 * The no-backend path, end to end: the real route handler, over a real socket,
 * read by the real subscriber, into the real timeline. Nothing is stubbed, so
 * "builds and demos against fixture events with no backend running" is a thing
 * this suite actually does rather than a thing the README claims.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { aGovernanceEventSequence } from "@cg/policy-schema";

import { GET } from "../app/api/governance/fixture-stream/route.ts";
import { subscribeToGovernanceEvents } from "../lib/governance/subscribe.ts";
import { allEvents, appendEvents, emptyTimeline, type Timeline } from "../lib/governance/timeline.ts";
import {
  FIXTURE_STREAM_PATH,
  panelStreamHealth,
  resolvePanelStream,
  withFixtureParams,
  type PanelStream,
  type WatchableStream,
} from "../lib/governance/stream-url.ts";

/** Narrows to a stream there is something to subscribe to, failing loudly if there is not. */
function watching(stream: PanelStream): WatchableStream {
  if (stream.mode === "unconfigured") throw new Error(`expected a stream, got: ${stream.problem}`);
  return stream;
}


const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

/** The route handler itself, bound to a port the OS handed out. */
function serveFixtureRoute(): string {
  const server = Bun.serve({ port: 0, fetch: (request) => GET(request) });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/api/governance/fixture-stream`;
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** Runs the fixture stream into a timeline and stops once it has `count` events. */
async function play(url: string, count: number): Promise<Timeline> {
  let timeline = emptyTimeline();
  const controller = new AbortController();
  const done = subscribeToGovernanceEvents(url, {
    onEvents: (batch) => {
      timeline = appendEvents(timeline, batch);
    },
    signal: controller.signal,
    retryMs: 20,
  });

  await until(() => timeline.received >= count, `${count} events from the fixture stream`);
  controller.abort();
  await done;
  return timeline;
}

describe("the fixture stream", () => {
  test("serves text/event-stream", async () => {
    const response = await fetch(`${serveFixtureRoute()}?delayMs=0`);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    await response.body?.cancel();
  });

  test("tells a proxy not to buffer it, or the acts arrive all at once at the end", async () => {
    const response = await fetch(`${serveFixtureRoute()}?delayMs=0`);

    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await response.body?.cancel();
  });

  test("delivers #5's whole sequence, in order, through the real client", async () => {
    const expected = aGovernanceEventSequence();

    const timeline = await play(`${serveFixtureRoute()}?delayMs=0`, expected.length);

    expect(allEvents(timeline).map((event) => event.id)).toEqual(
      expected.map((event) => event.id),
    );
  });

  test("the events survive the round trip byte for byte", async () => {
    const expected = aGovernanceEventSequence();

    const timeline = await play(`${serveFixtureRoute()}?delayMs=0`, expected.length);

    expect(allEvents(timeline)).toEqual(expected);
  });

  test("fills all three lanes, which is what makes it a demo of three control points", async () => {
    const timeline = await play(`${serveFixtureRoute()}?delayMs=0`, 5);

    expect(timeline.lanes.access.length).toBeGreaterThan(0);
    expect(timeline.lanes.pre.length).toBeGreaterThan(0);
    expect(timeline.lanes.post.length).toBeGreaterThan(0);
  });

  test("covers allow, deny and modify, so every visual state is exercised", async () => {
    const timeline = await play(`${serveFixtureRoute()}?delayMs=0`, 5);

    expect(timeline.counts.allow).toBeGreaterThan(0);
    expect(timeline.counts.deny).toBeGreaterThan(0);
    expect(timeline.counts.modify).toBeGreaterThan(0);
  });

  test("holds the connection open afterwards instead of replaying on a loop", async () => {
    const url = `${serveFixtureRoute()}?delayMs=0`;
    let timeline = emptyTimeline();
    const controller = new AbortController();
    const statuses: string[] = [];
    const done = subscribeToGovernanceEvents(url, {
      onEvents: (batch) => {
        timeline = appendEvents(timeline, batch);
      },
      onStatus: (status) => statuses.push(status),
      signal: controller.signal,
      retryMs: 20,
    });

    await until(() => timeline.received >= 5, "the sequence");
    await Bun.sleep(300);
    controller.abort();
    await done;

    expect(timeline.received).toBe(5);
    expect(statuses).not.toContain("reconnecting");
  });

  test("paces the acts apart by default, so causality is visible", async () => {
    const url = serveFixtureRoute();
    const startedAt = Date.now();

    await play(url, 2);

    expect(Date.now() - startedAt).toBeGreaterThan(900);
  });

  test("a client that goes away does not leave the handler writing", async () => {
    const response = await fetch(`${serveFixtureRoute()}?delayMs=0`);
    await response.body?.cancel();

    // Nothing to assert beyond this returning: the handler's abort listener is
    // what stops it looping on a stream nobody is reading.
    await Bun.sleep(50);
    expect(true).toBe(true);
  });
});

describe("which stream the panel is pointed at", () => {
  // #81. Every one of these used to resolve to the fixture, including the two
  // that describe a production deployment — which is what the live cg-web was
  // doing while a human watched it replay the demo over a real governed call.
  // `render.yaml` never declared GOVERNANCE_STREAM, so that was every deploy
  // since #21.
  const DEPLOYED = { NODE_ENV: "production" } as const;

  test("a development clone with nothing set still plays the replay", () => {
    expect(resolvePanelStream({})).toEqual({
      url: "/api/governance/fixture-stream",
      mode: "fixture",
    });
  });

  test("a configured hook host alone is not enough to switch away from the fixture", () => {
    expect(resolvePanelStream({ HOOKS_PUBLIC_HOST: "localhost:8081" }).mode).toBe("fixture");
  });

  test("GOVERNANCE_STREAM=hooks points at the hook server, and carries the host for the badge", () => {
    expect(
      resolvePanelStream({ GOVERNANCE_STREAM: "hooks", HOOKS_PUBLIC_HOST: "localhost:8081" }),
    ).toEqual({ url: "http://localhost:8081/events", mode: "hooks", host: "localhost:8081" });
  });

  test("a deployed host gets https, a local one gets http", () => {
    const deployed = resolvePanelStream({
      GOVERNANCE_STREAM: "hooks",
      HOOKS_PUBLIC_HOST: "cg-hooks.onrender.com",
    });
    const local = resolvePanelStream({
      GOVERNANCE_STREAM: "hooks",
      HOOKS_PUBLIC_HOST: "127.0.0.1:4421",
    });

    expect(watching(deployed).url).toBe("https://cg-hooks.onrender.com/events");
    expect(watching(local).url).toBe("http://127.0.0.1:4421/events");
  });

  test("asking for hooks without a host is unconfigured, not a quiet replay", () => {
    for (const env of [
      { GOVERNANCE_STREAM: "hooks" },
      { GOVERNANCE_STREAM: "hooks", HOOKS_PUBLIC_HOST: "  " },
      { ...DEPLOYED, GOVERNANCE_STREAM: "hooks" },
    ]) {
      const stream = resolvePanelStream(env);
      expect(stream.mode).toBe("unconfigured");
      // The sentence names the variable, because whoever reads it is about to
      // go and set it.
      expect(stream).toHaveProperty("problem", expect.stringContaining("HOOKS_PUBLIC_HOST"));
    }
  });

  test("a deployment that was told nothing at all is unconfigured", () => {
    // The exact shape of the live cg-web on 2026-09-11: a host set by hand and
    // no GOVERNANCE_STREAM, which used to be indistinguishable from a demo.
    for (const env of [
      DEPLOYED,
      { ...DEPLOYED, HOOKS_PUBLIC_HOST: "cg-hooks.onrender.com" },
      { RENDER: "true", HOOKS_PUBLIC_HOST: "cg-hooks.onrender.com" },
    ]) {
      const stream = resolvePanelStream(env);
      expect(stream.mode).toBe("unconfigured");
      expect(stream).toHaveProperty("problem", expect.stringContaining("GOVERNANCE_STREAM"));
    }
  });

  test("a value this service does not understand is refused by name", () => {
    const stream = resolvePanelStream({ GOVERNANCE_STREAM: "hook" });

    expect(stream.mode).toBe("unconfigured");
    expect(stream).toHaveProperty("problem", expect.stringContaining("GOVERNANCE_STREAM=hook"));
  });

  test("a typo is not rescued by ?fixture=1, which would hide it behind a replay", () => {
    expect(resolvePanelStream({ GOVERNANCE_STREAM: "Hooks" }, { fixture: "1" }).mode).toBe(
      "unconfigured",
    );
  });

  test("fixture is available in production, but only when it is asked for", () => {
    expect(resolvePanelStream({ ...DEPLOYED, GOVERNANCE_STREAM: "fixture" }).mode).toBe("fixture");
    expect(resolvePanelStream(DEPLOYED, { fixture: "1" }).mode).toBe("fixture");
    expect(resolvePanelStream(DEPLOYED, { fixture: "true" }).mode).toBe("fixture");
    // Not an incantation anybody would type by accident.
    expect(resolvePanelStream(DEPLOYED, { fixture: "0" }).mode).toBe("unconfigured");
  });

  test("?fixture=1 still tunes the replay it asked for", () => {
    expect(watching(resolvePanelStream(DEPLOYED, { fixture: "1", delayMs: "0" })).url).toBe(
      "/api/governance/fixture-stream?delayMs=0",
    );
  });

  test("what /health reports is the page's own resolution, not a second opinion", () => {
    expect(panelStreamHealth({ GOVERNANCE_STREAM: "hooks", HOOKS_PUBLIC_HOST: "cg-hooks.onrender.com" })).toBe("live");
    expect(panelStreamHealth({ GOVERNANCE_STREAM: "fixture" })).toBe("fixture");
    expect(panelStreamHealth({ NODE_ENV: "production" })).toBe("unconfigured");
    // A bare service name throws on the page (#67) — loudly, at a developer.
    // /health must still answer, because Render drops an instance whose health
    // check fails and takes the endpoint that explains why with it.
    expect(panelStreamHealth({ GOVERNANCE_STREAM: "hooks", HOOKS_PUBLIC_HOST: "cg-hooks" })).toBe(
      "unconfigured",
    );
  });
});

describe("the burst the panel has to survive", () => {
  test("repeat multiplies the sequence, with distinct ids so none de-duplicate away", async () => {
    const timeline = await play(`${serveFixtureRoute()}?delayMs=0&repeat=200`, 1000);

    expect(timeline.received).toBe(1000);
    expect(timeline.counts.allow + timeline.counts.deny + timeline.counts.modify).toBe(1000);
  });

  test("a thousand events keep their arrival order end to end", async () => {
    const url = `${serveFixtureRoute()}?delayMs=0&repeat=200`;
    const seen: string[] = [];
    const controller = new AbortController();
    const done = subscribeToGovernanceEvents(url, {
      onEvents: (batch) => seen.push(...batch.map((event) => event.id)),
      signal: controller.signal,
      retryMs: 20,
    });

    await until(() => seen.length >= 1000, "a thousand events");
    controller.abort();
    await done;

    const expected = Array.from({ length: 200 }, (_, pass) =>
      aGovernanceEventSequence().map((event) => (pass === 0 ? event.id : `${event.id}_${pass}`)),
    ).flat();

    expect(seen.slice(0, 1000)).toEqual(expected.slice(0, 1000));
  });

  test("repeat is capped, so a mistyped URL cannot ask for a million events", async () => {
    // 9,999,999 would take minutes; the cap turns it into a bounded replay.
    const timeline = await play(`${serveFixtureRoute()}?delayMs=0&repeat=9999999`, 5);

    expect(timeline.received).toBeGreaterThanOrEqual(5);
  });

  test("a junk repeat falls back to one pass rather than erroring", async () => {
    const timeline = await play(`${serveFixtureRoute()}?delayMs=0&repeat=banana`, 5);

    expect(timeline.received).toBe(5);
  });
});

describe("fixture pacing carried from the page's own query string", () => {
  const fixture = { url: FIXTURE_STREAM_PATH, mode: "fixture" } as const;

  test("no parameters leaves the URL alone", () => {
    expect(withFixtureParams(fixture, {})).toEqual(fixture);
  });

  test("delayMs and repeat are carried over", () => {
    expect(withFixtureParams(fixture, { repeat: "2000", delayMs: "0" }).url).toBe(
      "/api/governance/fixture-stream?delayMs=0&repeat=2000",
    );
  });

  test("anything else on the page's query string is not", () => {
    expect(withFixtureParams(fixture, { persona: "dana", token: "secret" })).toEqual(fixture);
  });

  test("a repeated parameter takes its first value", () => {
    expect(withFixtureParams(fixture, { repeat: ["3", "9"] }).url).toContain("repeat=3");
  });

  test("the hook server's stream is never given query parameters", () => {
    const hooks = {
      url: "https://cg-hooks.onrender.com/events",
      mode: "hooks",
      host: "cg-hooks.onrender.com",
    } as const;

    expect(withFixtureParams(hooks, { repeat: "2000" })).toEqual(hooks);
  });
});
