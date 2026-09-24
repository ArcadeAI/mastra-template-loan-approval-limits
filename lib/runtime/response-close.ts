/**
 * Makes a Node `ServerResponse` say `close` when its client goes away, on Bun.
 *
 * The app runs on Bun since #4. Next learns that a client left from the
 * *response's* `close` event: `request.signal` in a route handler is built on
 * it, and so is the pipe that cancels a streamed body. Node emits it on a
 * client disconnect. Bun's `node:http` (1.3.14) does not: measured on #4, an
 * aborted fetch against a bare `http.createServer` gets
 * `["socket close","req close"]` on Bun and `["res close","socket close","req
 * close"]` on Node. So behind Next on Bun no stream was ever told its reader
 * left. `GET /events` kept every closed panel tab subscribed (three `curl -N`
 * that exited left `stream_clients: 3`), and a chat stream abandoned mid-turn
 * would have kept running.
 *
 * The shim closes that gap and nothing else. When a response's socket closes
 * before the response finished, the response emits `close`, which is what Node
 * would have done. Installed once, from `instrumentation.ts`, before the first
 * request, and only on Bun. On Node, or on a Bun that emits `close` itself,
 * the guard below means it never fires twice.
 */
import http from "node:http";

const INSTALLED = Symbol.for("cg.response-close");

export function installResponseClose(): void {
  if (typeof Bun === "undefined") return;
  const proto = http.Server.prototype as http.Server & { [INSTALLED]?: true };
  if (proto[INSTALLED]) return;
  proto[INSTALLED] = true;

  const emit = proto.emit;
  proto.emit = function patchedEmit(this: http.Server, event: string | symbol, ...args: unknown[]) {
    if (event === "request") {
      const [request, response] = args as [http.IncomingMessage, http.ServerResponse];
      let closed = false;
      response.once("close", () => {
        closed = true;
      });
      request.socket?.once("close", () => {
        if (!closed && !response.writableFinished) response.emit("close");
      });
    }
    return emit.call(this, event, ...args);
  } as typeof proto.emit;
}
