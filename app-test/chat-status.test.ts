/**
 * #37 — the status line, as a function of the stream's events.
 *
 * `statusLine` is the whole of what decides the words; `chat-feel-worker.tsx`
 * drives the same thing through the real `Chat` over real HTTP. These pin each
 * rule the human settled on #37: the running statuses clear on `done`,
 * `error` or `fault`; the two waits are held as static text after `done`; a
 * fault or error clears everything; the authorization wait names the tool.
 */
import { describe, expect, test } from "bun:test";

import { statusLine, type StatusInput } from "../components/chat/status.ts";
import type { ChatEvent } from "../lib/agent/events.ts";

const REQUEST_ID = "apr_0m4xq7bd91kz";
const call: ChatEvent = { kind: "tool-call", tool: "Loan_SearchLoans", inputs: { min_amount: 90000 } };
const result: ChatEvent = { kind: "tool-result", tool: "Loan_SearchLoans", result: [] };
const waiting: ChatEvent = {
  kind: "waiting",
  tool: "Approvals_RequestApproval",
  request_id: REQUEST_ID,
  approver: "Charlie",
  approver_id: "charlie@bank.example",
};
const authorization: ChatEvent = {
  kind: "authorization",
  tool: "Approvals_RequestApproval",
  url: "https://slack.com/oauth/v2/authorize?client_id=x",
};

const input = (events: ChatEvent[], overrides: Partial<StatusInput> = {}): StatusInput => ({
  running: true,
  events,
  waitingRequestId: null,
  challengeHeld: false,
  ...overrides,
});

describe("while a turn is running", () => {
  test("before any event, and between steps, it is thinking", () => {
    expect(statusLine(input([]))).toEqual({ kind: "running", text: "Thinking…" });
    expect(statusLine(input([call, result]))).toEqual({ kind: "running", text: "Thinking…" });
    expect(statusLine(input([{ kind: "text", text: "Looking" }]))).toEqual({ kind: "running", text: "Thinking…" });
  });

  test("a tool call in flight is named by its wire name", () => {
    expect(statusLine(input([call]))).toEqual({ kind: "running", text: "Calling Loan_SearchLoans…" });
  });

  test("done, error and fault each clear it", () => {
    expect(statusLine(input([call, result, { kind: "done", calls: 1 }]))).toBeNull();
    expect(statusLine(input([call, { kind: "error", message: "provider 500" }]))).toBeNull();
    expect(statusLine(input([call, { kind: "fault", tool: "Loan_SearchLoans", message: "ECONNREFUSED" }]))).toBeNull();
  });

  test("once the approval is requested, the closing words stream under the wait", () => {
    expect(statusLine(input([call, result, waiting, { kind: "text", text: "Waiting." }]))).toEqual({
      kind: "held",
      text: "Waiting for Charlie's approval…",
    });
  });
});

describe("after the turn has ended", () => {
  test("an approval the transcript still holds stays on the line, as static text", () => {
    const events = [waiting, { kind: "done", calls: 1 } as ChatEvent];
    expect(statusLine(input(events, { running: false, waitingRequestId: REQUEST_ID }))).toEqual({
      kind: "held",
      text: "Waiting for Charlie's approval…",
    });
    // Resumed: the page no longer holds it, and the line clears.
    expect(statusLine(input(events, { running: false, waitingRequestId: null }))).toBeNull();
  });

  test("an unanswered authorization names the tool, not a provider guessed from the URL", () => {
    const events = [authorization, { kind: "done", calls: 1 } as ChatEvent];
    const status = statusLine(input(events, { running: false, challengeHeld: true }));
    expect(status).toEqual({ kind: "held", text: "Waiting for you to authorize Approvals_RequestApproval…" });
    expect(status?.text).not.toContain("Slack");
    // Continued, or a new message: no longer held.
    expect(statusLine(input(events, { running: false, challengeHeld: false }))).toBeNull();
  });

  test("a new attempt's events do not carry an old attempt's wait", () => {
    // The follow-up turn is its own attempt; the approval is still held by
    // the page, but the line is about the latest attempt, which did not end on it.
    const followUp: ChatEvent[] = [{ kind: "text", text: "Sure." }, { kind: "done", calls: 0 }];
    expect(statusLine(input(followUp, { running: false, waitingRequestId: REQUEST_ID }))).toBeNull();
  });

  test("a fault or an error clears a held wait too, with the done that follows it", () => {
    expect(
      statusLine(
        input([waiting, { kind: "fault", tool: "resume", message: "store unreachable" }, { kind: "done", calls: 1 }], {
          running: false,
          waitingRequestId: REQUEST_ID,
        }),
      ),
    ).toBeNull();
    expect(
      statusLine(
        input([authorization, { kind: "error", message: "stopped" }, { kind: "done", calls: 1 }], {
          running: false,
          challengeHeld: true,
        }),
      ),
    ).toBeNull();
  });

  test("nothing to wait on is no line at all", () => {
    expect(statusLine(input([{ kind: "done", calls: 0 }], { running: false }))).toBeNull();
  });
});
