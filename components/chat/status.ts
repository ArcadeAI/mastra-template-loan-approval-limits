/**
 * The line under the transcript that says what the agent is waiting on (#37).
 *
 * Read off the stream's own events and nothing else, so it cannot say anything
 * the stream did not. Two kinds, decided by the human on #37:
 *
 * - **Running.** "Thinking…" and "Calling Loan_SearchLoans…". Only while a
 *   turn is streaming, and cleared by `done`, `error` or `fault`.
 * - **Held.** "Waiting for Charlie's approval…" and "Waiting for you to
 *   authorize Loan_GetLoan…". The turn has ended (`DESIGN.md` → The wait:
 *   nothing polls), so these are static text, with no animation. They stay
 *   until the resume, Continue, or a new message, which is when the latest
 *   turn stops being the one that ended on them. A fault or an error clears
 *   them too.
 *
 * The authorization wait names the tool the event names, and does not guess
 * a provider from the URL (the human, on #37).
 */
import type { ChatEvent } from "../../lib/agent/events.ts";

export type Status = { kind: "running" | "held"; text: string } | null;

export interface StatusInput {
  /** A turn is streaming into the latest transcript entry. */
  running: boolean;
  /** The latest turn's events, in arrival order. */
  events: readonly ChatEvent[];
  /** The approval request this transcript still holds, if any. */
  waitingRequestId: string | null;
  /** An authorization challenge on the latest turn is still unanswered. */
  challengeHeld: boolean;
}

export function statusLine(input: StatusInput): Status {
  // `done` is always the last event of a turn, so it is read separately:
  // what came before it is what the turn ended on.
  const finished = input.events.some((event) => event.kind === "done");
  const last = input.events.filter((event) => event.kind !== "done").at(-1);

  if (last?.kind === "fault" || last?.kind === "error") return null;

  if (input.running && !finished) {
    // Both waits end the turn, so once either has arrived the rest of the
    // stream is closing words, and the wait is what is true.
    const ended = input.events.find(
      (event): event is Extract<ChatEvent, { kind: "waiting" | "authorization" }> =>
        event.kind === "waiting" || event.kind === "authorization",
    );
    if (ended?.kind === "waiting") return { kind: "held", text: approvalWait(ended.approver) };
    if (ended?.kind === "authorization") return { kind: "held", text: authorizationWait(ended.tool) };
    if (last?.kind === "tool-call") return { kind: "running", text: `Calling ${last.tool}…` };
    return { kind: "running", text: "Thinking…" };
  }

  if (input.challengeHeld) {
    const challenge = [...input.events]
      .reverse()
      .find((event): event is Extract<ChatEvent, { kind: "authorization" }> => event.kind === "authorization");
    if (challenge) return { kind: "held", text: authorizationWait(challenge.tool) };
  }

  if (input.waitingRequestId !== null) {
    const waiting = input.events.find(
      (event): event is Extract<ChatEvent, { kind: "waiting" }> =>
        event.kind === "waiting" && event.request_id === input.waitingRequestId,
    );
    if (waiting) return { kind: "held", text: approvalWait(waiting.approver) };
  }

  return null;
}

function approvalWait(approver: string): string {
  return `Waiting for ${approver}'s approval…`;
}

function authorizationWait(tool: string): string {
  return `Waiting for you to authorize ${tool}…`;
}
