/**
 * **The token seam.** The one function anything calls to get a gateway bearer.
 *
 * Hop 1 ends in a gateway access token, and every tool call the agent makes
 * carries it (`DESIGN.md` → Two hops, two mechanisms). There are two entries to
 * the one agent — the chat route and Mastra Studio — and a page-load tool
 * listing besides, and all three get their bearer from `gatewayToken` and from
 * nowhere else. `app-test/studio-entry.test.ts` fails if any other module
 * imports the functions behind it or reads a stored `access_token` itself.
 *
 * Why one function rather than one per entry: a second token path is where
 * identity quietly splits. A Studio that minted or borrowed its bearer some
 * other way would be a second answer to "who is this tool call made as", and
 * the pre-hook would see whichever one happened to be wired up. #6 re-points
 * this function at the User Source sign-in when it folds the identity module
 * in; it should not have to find a second one.
 *
 * ## What a holder is
 *
 * Whatever keeps a hop-1 grant between turns. The chat route's holder is this
 * browser's sealed session (`lib/identity/session.ts`). Studio's is the Studio
 * process's own grant (`lib/agent/studio.ts`), because Studio has no browser
 * session to read: it is a separate Node process with its own origin. Either
 * way it is the same `GatewayToken` record, refreshed by the same code, and it
 * comes back alongside the bearer so the caller can store what a refresh
 * changed.
 */
import type { IdentitySurface } from "../config.ts";
import { liveGatewayToken, refreshedGatewayToken } from "../identity/handlers.ts";
import type { GatewayToken, Session } from "../identity/session.ts";

/** The part of a holder this function reads and writes. A `Session` is one. */
export interface GatewayHolder {
  gateway?: GatewayToken;
  gateway_rejected_at?: number;
}

export type HeldBearer<H extends GatewayHolder> =
  /** `holder` is the one to keep from here on: a refresh replaces its `gateway`. */
  | { token: string; holder: H }
  /** No usable bearer, and the sentence saying why. Never a stale token in its place. */
  | { token: null; reason: string };

export interface GatewayTokenOptions {
  /**
   * Refresh now, whatever `expires_at` says. For a caller the gateway has just
   * refused (#113): asking again without this would be told the same thing,
   * because the clock still says the token is live.
   */
  refresh?: boolean;
}

/**
 * The live gateway bearer for this holder, refreshed server-side when it is
 * close to expiry or when `refresh` asks for it.
 *
 * Fails loudly or not at all, with the contract `liveGatewayToken` has held
 * since #94: every path that cannot produce a live bearer is `{ token: null,
 * reason }`.
 */
export async function gatewayToken<H extends GatewayHolder>(
  holder: H,
  config: IdentitySurface,
  options: GatewayTokenOptions = {},
): Promise<HeldBearer<H>> {
  // The functions behind this read `gateway` and `gateway_rejected_at` and hand
  // the rest of the record back untouched (`withGatewayToken` spreads it), so a
  // holder that is not a whole `Session` round-trips as itself. They are typed
  // on `Session` because the browser's session was their only caller before #8.
  const asSession = holder as unknown as Session;
  const bearer = options.refresh
    ? await refreshedGatewayToken(asSession, config)
    : await liveGatewayToken(asSession, config);
  if (bearer.token === null) return bearer;
  return { token: bearer.token, holder: bearer.session as unknown as H };
}
