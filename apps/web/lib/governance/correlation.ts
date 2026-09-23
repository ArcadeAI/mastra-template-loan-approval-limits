/**
 * Correlation — the one function the panel joins on.
 *
 * The panel shows what the control plane decided. The chat shows what the agent
 * was told. Tying one to the other is the whole reason a presenter can point at
 * a red card and say "that is the refusal you just read". #6 settled how:
 *
 * - **Denials** reach the agent over MCP as `isError: true` plus text, with no
 *   `execution_id` — it does not cross the gateway. The one thing that crosses
 *   verbatim is the `error_message` `apps/hooks` writes, so the audit row's id
 *   rides at the end of it in brackets, and this module reads it back out.
 *   Written by `withCorrelation()` in `apps/hooks/src/correlation.ts`; the
 *   regex below is that contract's other half and
 *   `test/correlation.test.ts` proves the two agree.
 * - **Allows** carry `execution_id` on the hook's own payload, which reaches
 *   this panel on the event itself. No token needed.
 *
 * Two paths, one join. `correlate()` is the swappable seam the issue asks for:
 * every caller goes through it, and replacing the strategy is replacing this
 * file.
 *
 * **It fails soft, always.** The prefix Arcade puts ahead of our text
 * (`Tool execution was denied by an extension policy: `) is theirs and
 * undocumented. A message with no parseable token is an *uncorrelated* event —
 * rendered in its lane with no join — never a dropped one. A panel that goes
 * blank because Arcade edited a string is a bad thing to discover on stage.
 */
import type { GovernanceEvent } from "@cg/policy-schema";

/**
 * Matches the token at the very end of an `error_message`; group 1 is the
 * event id. Kept byte-identical to `CORRELATION_TOKEN` in `apps/hooks` — the
 * id is `evt_` plus ten Crockford base32 characters (no `i`, `l`, `o`, `u`).
 */
export const CORRELATION_TOKEN = /\[ref (evt_[0-9a-hj-km-np-tv-z]{10})\]\s*$/;

/** What the caller knows about a turn, and wants the matching events for. */
export type CorrelationKey =
  | {
      /** Text the agent received — a denial. Parsed for the embedded token. */
      readonly kind: "message";
      readonly message: string;
    }
  | {
      /** Arcade's execution id, off a hook payload. Correlates `/pre` to `/post`. */
      readonly kind: "execution";
      readonly executionId: string;
    };

/**
 * The events belonging to `key`, in the order they arrived.
 *
 * Empty when nothing matches, which is a normal answer and not an error: an
 * untokenised message, an execution the panel has not seen an event for yet, a
 * `/access` event (which has no execution to identify — `execution_id` is `""`
 * there, and an empty key never matches it).
 */
export function correlate(
  events: readonly GovernanceEvent[],
  key: CorrelationKey,
): GovernanceEvent[] {
  if (key.kind === "execution") {
    if (key.executionId === "") return [];
    return events.filter((event) => event.execution_id === key.executionId);
  }

  const id = CORRELATION_TOKEN.exec(key.message)?.[1] ?? null;
  if (id === null) return [];

  // The token names one audit row. Its execution, if it has one, names the rest
  // of the call — so a denial correlates to its own `/access` and `/post`
  // siblings too, which is what makes the lanes light up together.
  const anchor = events.find((event) => event.id === id);
  if (anchor === undefined) return [];
  if (anchor.execution_id === "") return [anchor];
  return correlate(events, { kind: "execution", executionId: anchor.execution_id });
}

/**
 * Whether `event` is one of `correlate()`'s answers — the predicate the panel
 * highlights with, so highlighting and joining cannot disagree.
 */
export function isCorrelated(
  correlated: readonly GovernanceEvent[],
  event: GovernanceEvent,
): boolean {
  return correlated.some((candidate) => candidate.id === event.id);
}
