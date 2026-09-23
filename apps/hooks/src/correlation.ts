/**
 * The correlation token (#6).
 *
 * Over MCP a denial reaches the agent as `isError: true` plus text, with no
 * `execution_id` and no typed error kind — the hook saw an execution id on its
 * own payload, but the client never does. The one thing that does cross
 * verbatim is the `error_message` this service writes. So the audit row's id
 * rides inside it, and the panel (#21) reads it back out to join the event it
 * shows to the denial the agent received. Exact under concurrency, which the
 * persona switcher will produce on stage; heuristic matching on user, tool and
 * time was rejected for exactly that reason.
 *
 * The token sits at the very end, in brackets, after the remediation
 * instruction: `… retry once approved. [ref evt_4k7xq2m9hz]`. It reads as a
 * reference number, not as something to do — the model has no `ref` tool to
 * call and nothing tells it the value means anything. The message the rule
 * author wrote is untouched ahead of it.
 *
 * The panel must fail soft: a message without a token is an uncorrelated event,
 * never a dropped one. The prefix Arcade puts ahead of our text is theirs and
 * undocumented.
 */

/** Matches the token at the end of an `error_message`; group 1 is the event id. */
export const CORRELATION_TOKEN = /\[ref (evt_[0-9a-hj-km-np-tv-z]{10})\]\s*$/;

export function withCorrelation(message: string, eventId: string): string {
  return `${message.trimEnd()} [ref ${eventId}]`;
}

/** The event id embedded in `message`, or `null` when there is none. */
export function correlationId(message: string): string | null {
  return CORRELATION_TOKEN.exec(message)?.[1] ?? null;
}
