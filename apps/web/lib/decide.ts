/**
 * Pressing the button, as a function rather than as a route.
 *
 * The server action in `app/approvals/[id]/actions.ts` reads the cookie and
 * calls this; everything that decides what the screen says lives here, where a
 * test can drive it against a stand-in Arcade without a Next.js runtime.
 *
 * The three outcomes stay three. A refusal is the control plane working and
 * reads as such; a failure is the control plane unreachable and reads as such.
 * Collapsing them would make an outage look like a denial — which is the
 * comfortable direction to get wrong, and still wrong: the audience would be
 * told a control fired when none did.
 */
import type { DecideCall, DecideOutcome } from "./arcade.ts";
import { decideThroughArcade } from "./arcade.ts";
import type { WebConfig } from "./config.ts";

export type DecideResult =
  | { state: "idle" }
  | { state: "recorded"; decision: "approved" | "denied"; message: string }
  /** The pre-hook said no. `message` is what the model would have read. */
  | { state: "refused"; message: string }
  | { state: "failed"; message: string };

export const IDLE: DecideResult = { state: "idle" };

export async function submitDecision(
  call: DecideCall,
  config: WebConfig,
  execute: (call: DecideCall, config: WebConfig) => Promise<DecideOutcome> = decideThroughArcade,
): Promise<DecideResult> {
  const outcome = await execute(call, config);

  switch (outcome.outcome) {
    case "recorded":
      return {
        state: "recorded",
        decision: call.decision,
        message:
          outcome.request === null
            ? `Recorded as ${call.decision}.`
            : `Recorded as ${outcome.request.status} by ${outcome.request.decided_by ?? call.userId}.`,
      };
    case "refused":
      return { state: "refused", message: outcome.message };
    case "failed":
      return { state: "failed", message: outcome.message };
  }
}
