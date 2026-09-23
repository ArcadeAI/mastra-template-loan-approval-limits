import { describe, expect, test } from "bun:test";

import { createSseDecoder, type SseFrame } from "../lib/governance/sse.ts";

/** Feed a whole stream through in one chunk. */
function decode(text: string): SseFrame[] {
  return createSseDecoder().push(text);
}

/** Feed a stream one character at a time — the worst split a network can make. */
function decodeByCharacter(text: string): SseFrame[] {
  const decoder = createSseDecoder();
  return [...text].flatMap((character) => decoder.push(character));
}

describe("frames", () => {
  test("a named event with data", () => {
    expect(decode("event: governance\ndata: {}\n\n")).toEqual([
      { event: "governance", data: "{}", id: null, retry: null },
    ]);
  });

  test("an unnamed event defaults to message", () => {
    expect(decode("data: hello\n\n")[0]?.event).toBe("message");
  });

  test("an id is carried on the frame", () => {
    expect(decode("id: evt_4k7xq2m9hz\ndata: x\n\n")[0]?.id).toBe("evt_4k7xq2m9hz");
  });

  test("retry is read as a number", () => {
    expect(decode("retry: 2500\ndata: x\n\n")[0]?.retry).toBe(2500);
  });

  test("a non-numeric retry is ignored rather than becoming NaN", () => {
    expect(decode("retry: soon\ndata: x\n\n")[0]?.retry).toBeNull();
  });

  test("multiple data lines join with a newline", () => {
    expect(decode("data: one\ndata: two\n\n")[0]?.data).toBe("one\ntwo");
  });

  test("exactly one space after the colon is the delimiter", () => {
    expect(decode("data:  two spaces\n\n")[0]?.data).toBe(" two spaces");
  });

  test("a field with no colon has an empty value", () => {
    expect(decode("data\n\n")[0]?.data).toBe("");
  });

  test("several frames in one chunk arrive in order", () => {
    const frames = decode("data: a\n\ndata: b\n\ndata: c\n\n");

    expect(frames.map((frame) => frame.data)).toEqual(["a", "b", "c"]);
  });
});

describe("what must not dispatch", () => {
  test("a comment keep-alive dispatches nothing", () => {
    expect(decode(": keep-alive\n\n")).toEqual([]);
  });

  test("a keep-alive between frames does not disturb them", () => {
    const frames = decode("data: a\n\n: ping\n\ndata: b\n\n");

    expect(frames.map((frame) => frame.data)).toEqual(["a", "b"]);
  });

  test("a frame still arriving is not dispatched early", () => {
    const decoder = createSseDecoder();

    expect(decoder.push("event: governance\ndata: {}\n")).toEqual([]);
    expect(decoder.push("\n")).toHaveLength(1);
  });

  test("an unknown field is ignored", () => {
    expect(decode("lane: pre\ndata: x\n\n")).toEqual([
      { event: "message", data: "x", id: null, retry: null },
    ]);
  });

  test("state does not leak from one frame into the next", () => {
    const frames = decode("event: governance\nid: evt_1\ndata: a\n\ndata: b\n\n");

    expect(frames[1]).toEqual({ event: "message", data: "b", id: null, retry: null });
  });
});

describe("chunk boundaries, which a loaded network will find", () => {
  const stream =
    "retry: 1000\n\n" +
    ": keep-alive\n\n" +
    "event: governance\nid: evt_2p9wq4nb7c\ndata: {\"decision\":\n" +
    'data: "deny"}\n\n' +
    "event: governance\nid: evt_4k7xq2m9hz\ndata: {}\n\n";

  test("splitting every character gives the same frames as one chunk", () => {
    expect(decodeByCharacter(stream)).toEqual(decode(stream));
  });

  test("and there really were frames to compare", () => {
    expect(decode(stream)).toHaveLength(2);
  });

  test("a split inside a field name survives", () => {
    const decoder = createSseDecoder();
    decoder.push("ev");
    decoder.push("ent: governance\nda");

    expect(decoder.push("ta: x\n\n")[0]).toEqual({
      event: "governance",
      data: "x",
      id: null,
      retry: null,
    });
  });
});

describe("line endings", () => {
  test("CRLF terminates a line", () => {
    expect(decode("event: governance\r\ndata: x\r\n\r\n")[0]?.data).toBe("x");
  });

  test("a bare CR terminates a line", () => {
    expect(decode("event: governance\rdata: x\r\rdata: next\r\r")[0]?.data).toBe("x");
  });

  test("a CR at the very end of a chunk is held, because its LF may be coming", () => {
    const decoder = createSseDecoder();

    expect(decoder.push("data: x\r\r")).toEqual([]);
    expect(decoder.push("\ndata: y\n\n")).toEqual([
      { event: "message", data: "x", id: null, retry: null },
      { event: "message", data: "y", id: null, retry: null },
    ]);
  });

  test("a CRLF split across chunks is one line ending, not two", () => {
    const decoder = createSseDecoder();

    expect(decoder.push("data: x\r")).toEqual([]);
    expect(decoder.push("\n\r\n")).toEqual([
      { event: "message", data: "x", id: null, retry: null },
    ]);
  });

  test("mixed endings in one stream both work", () => {
    const frames = decode("data: a\n\ndata: b\r\n\r\n");

    expect(frames.map((frame) => frame.data)).toEqual(["a", "b"]);
  });
});

describe("payloads the hook server will actually send", () => {
  test("JSON containing newline escapes stays one data line", () => {
    const payload = JSON.stringify({ reason: "Denied.\nRetry once approved." });

    expect(decode(`event: governance\ndata: ${payload}\n\n`)[0]?.data).toBe(payload);
  });

  test("a large payload survives being chunked at 64 bytes", () => {
    const payload = JSON.stringify({ notes: "x".repeat(5000) });
    const stream = `event: governance\ndata: ${payload}\n\n`;
    const decoder = createSseDecoder();

    const frames: SseFrame[] = [];
    for (let at = 0; at < stream.length; at += 64) {
      frames.push(...decoder.push(stream.slice(at, at + 64)));
    }

    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe(payload);
  });
});
