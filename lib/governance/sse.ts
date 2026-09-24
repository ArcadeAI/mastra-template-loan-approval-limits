/**
 * An incremental decoder for `text/event-stream`, per the WHATWG spec's
 * event-stream interpretation rules.
 *
 * The browser ships `EventSource`, which does this already. The panel does not
 * use it, for two reasons that matter here: `EventSource` cannot set a request
 * header, so it cannot resume with `Last-Event-ID` after the connection this
 * panel holds open drops; and its reconnect timing is the browser's, not ours,
 * which on stage means an outage of unpredictable length in the middle of an
 * act. A `fetch` over a `ReadableStream` gives both back, and has the useful
 * side effect that the whole path is exercisable in a test against a real
 * server rather than a stub.
 *
 * The decoder is a pure state machine over chunk boundaries: a chunk may split
 * a field, a line, or a frame, and a network under load will do all three.
 */

/** One dispatched event. Absent fields take the spec's defaults. */
export interface SseFrame {
  /** `event:`, or `"message"` when the stream did not name one. */
  readonly event: string;
  /** `data:` lines joined with newlines, with no trailing newline. */
  readonly data: string;
  /** `id:`, or `null` when the frame carried none. */
  readonly id: string | null;
  /** `retry:` in milliseconds, or `null`. The server's reconnect advice. */
  readonly retry: number | null;
}

export interface SseDecoder {
  /** Frames completed by this chunk. Empty while a frame is still arriving. */
  push(chunk: string): SseFrame[];
}

const LF = "\n";
const CR = "\r";

export function createSseDecoder(): SseDecoder {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | null = null;
  let retry: number | null = null;

  function reset(): void {
    event = "";
    data = [];
    id = null;
    retry = null;
  }

  function dispatch(): SseFrame | null {
    // A frame with no data lines is not dispatched — the spec says so, and it
    // is how a server sends a keep-alive without waking the UI.
    if (data.length === 0) {
      reset();
      return null;
    }
    const frame: SseFrame = {
      event: event === "" ? "message" : event,
      data: data.join(LF),
      id,
      retry,
    };
    reset();
    return frame;
  }

  function readLine(text: string): SseFrame | null {
    if (text === "") return dispatch();
    // A line starting with a colon is a comment. Servers send them as
    // keep-alives; they must not disturb the frame being assembled.
    if (text.startsWith(":")) return null;

    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    // Exactly one leading space after the colon is part of the delimiter.
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        id = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) retry = Number(value);
        break;
      default:
        // An unknown field is ignored, which is what lets the wire format grow.
        break;
    }
    return null;
  }

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      const frames: SseFrame[] = [];

      // Lines end with CRLF, LF, or CR. A lone trailing CR is held back: the
      // LF that would pair with it may be at the head of the next chunk.
      let start = 0;
      let index = 0;
      while (index < buffer.length) {
        const character = buffer[index];
        if (character !== LF && character !== CR) {
          index += 1;
          continue;
        }
        if (character === CR && index === buffer.length - 1) break;

        const frame = readLine(buffer.slice(start, index));
        if (frame !== null) frames.push(frame);

        index += character === CR && buffer[index + 1] === LF ? 2 : 1;
        start = index;
      }

      buffer = buffer.slice(start);
      return frames;
    },
  };
}
