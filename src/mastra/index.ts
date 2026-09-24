/**
 * The Mastra entry: what `mastra dev` loads and Studio shows.
 *
 * It registers the agent the chat route runs, not a copy of it: `studioAgent`
 * is `buildAgent` from `lib/agent/agent.ts` with the same instructions and the
 * same governed toolset, resolved from Studio's own gateway grant. See
 * `lib/agent/studio.ts` for where that grant comes from, and
 * `app-test/studio-entry.test.ts` for the test that fails if the two diverge.
 *
 * Studio runs under Node, in its own process, while the app runs on Bun. So
 * nothing this file reaches may open `bun:sqlite` or import any other `bun:`
 * module: not the control plane, not the loan module, not the identity store.
 * The same test imports this file under Node and fails if it cannot.
 */
import { Mastra } from "@mastra/core";
import { registerApiRoute } from "@mastra/core/server";

import { AGENT_ID } from "../../lib/agent/agent.ts";
import {
  STUDIO_AUTHORIZE_PATH,
  STUDIO_CALLBACK_PATH,
  studioAgent,
  studioAuthorize,
  studioCallback,
  studioPort,
} from "../../lib/agent/studio.ts";

const port = studioPort();

export const mastra = new Mastra({
  agents: { [AGENT_ID]: studioAgent({ port }) },
  server: {
    port,
    apiRoutes: [
      // Hop 1 for Studio. Unauthenticated by Mastra because the browser arriving
      // here is on its way to sign in; PKCE and a one-use `state` guard the leg.
      registerApiRoute(STUDIO_AUTHORIZE_PATH, {
        method: "GET",
        requiresAuth: false,
        handler: (c) => studioAuthorize(c.req.raw),
      }),
      registerApiRoute(STUDIO_CALLBACK_PATH, {
        method: "GET",
        requiresAuth: false,
        handler: (c) => studioCallback(c.req.raw),
      }),
    ],
  },
});
