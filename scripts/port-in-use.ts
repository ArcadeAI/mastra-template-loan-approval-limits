/**
 * Is anything already listening on the port `bun run dev` is about to give Next (#30)?
 *
 * Next's own check is a bind, and a bind is not enough. On the third live run
 * (#7) another project's `astro dev` held `[::1]:3000`. Next bound `*:3000`
 * without an error, because a wildcard bind succeeds beside a listener on one
 * specific address, and ngrok's `localhost:3000` reached Astro. The User Source
 * discovery then failed against a page that was not this app's.
 *
 * So this asks the question the tunnel will ask: does a connection to the port
 * on each loopback address get answered? A listener on `0.0.0.0` or `::`
 * answers on loopback too, so the two addresses cover the wildcards. An address
 * the machine does not have (no IPv6) refuses the connection and counts as
 * free, which is what it is.
 */
import { connect } from "node:net";

/** Where `localhost` can land: ngrok and browsers try either. */
export const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1"] as const;

/** How long an unanswered connection attempt waits. A local listener answers in well under this. */
const CONNECT_TIMEOUT_MS = 1_000;

/** The loopback addresses on which something accepts a connection to `port`, as `host:port`. */
export async function listenersOn(port: number): Promise<string[]> {
  const held = await Promise.all(LOOPBACK_ADDRESSES.map((host) => accepts(host, port)));
  return LOOPBACK_ADDRESSES.filter((_, index) => held[index]).map((host) =>
    host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`,
  );
}

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const settle = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/** The refusal `scripts/next.ts` prints: the port, where it is held, and the two ways out. */
export function portTakenMessage(port: number, held: readonly string[]): string {
  return [
    `Port ${port} is already in use: something is listening on ${held.join(" and ")}.`,
    "Next would start anyway, and the tunnel would reach that other process instead of this app.",
    `  See what holds it:  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
    `  Then stop it, or set PORT in .env to a free port and point ngrok at that port instead of ${port}.`,
  ].join("\n");
}
