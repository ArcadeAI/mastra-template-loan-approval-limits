/**
 * #37 — the chat as a conversation, through the real `Chat`, real HTTP and a
 * real DOM.
 *
 * Run by `chat-feel.test.ts` in a Bun worker of its own, for the reason
 * `chat-conversation.test.tsx` gives: happy-dom's globals are shared between
 * files in one runner.
 *
 * Two kinds of server stand behind the page:
 *
 * - **A stepped route.** The test writes each NDJSON event by hand and waits
 *   for the page to show it, so "rendered as it arrives" is a claim about each
 *   event and not about the end state.
 * - **The real chat handler**, against the agent harness (real control plane,
 *   real loan module, the gateway stand-in, the scripted model), for the claim
 *   that the JSON on screen equals what the model saw.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { ChatEvent } from "../lib/agent/events.ts";

const nativeFetch = globalThis.fetch.bind(globalThis);
const NativeRequest = globalThis.Request;
const NativeResponse = globalThis.Response;
const NativeHeaders = globalThis.Headers;
const NativeReadableStream = globalThis.ReadableStream;
const NativeTextEncoder = globalThis.TextEncoder;
const NativeTextDecoder = globalThis.TextDecoder;
const NativeTextDecoderStream = globalThis.TextDecoderStream;
// The real handler runs in this process too, and Mastra pipes web streams
// through each other: happy-dom's look-alikes fail its `instanceof` checks.
const NativeWritableStream = globalThis.WritableStream;
const NativeTransformStream = globalThis.TransformStream;
const NativeTextEncoderStream = globalThis.TextEncoderStream;

GlobalRegistrator.register({ url: "http://chat-feel.test/" });
globalThis.Request = NativeRequest;
globalThis.Response = NativeResponse;
globalThis.Headers = NativeHeaders;
globalThis.ReadableStream = NativeReadableStream;
globalThis.TextEncoder = NativeTextEncoder;
globalThis.TextDecoder = NativeTextDecoder;
globalThis.TextDecoderStream = NativeTextDecoderStream;
globalThis.WritableStream = NativeWritableStream;
globalThis.TransformStream = NativeTransformStream;
globalThis.TextEncoderStream = NativeTextEncoderStream;
globalThis.fetch = nativeFetch;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { Chat } = await import("../components/chat/Chat.tsx");
const { encodeEvent } = await import("../lib/agent/events.ts");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALICE = "alice@bank.example";
const DEFAULT_PROMPT = "Approve the loan for $95K and double-check your work so you don't make any mistakes.";

/** Where the page's relative `/api/chat` goes, and a cookie to send with it. */
let origin = "http://localhost:1";
let cookie: string | null = null;

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new NativeHeaders(init?.headers);
    if (cookie !== null) headers.set("cookie", cookie);
    return nativeFetch(new URL(String(input), origin), { ...init, headers });
  }) as typeof fetch;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = nativeFetch;
});

// ---------------------------------------------------------------------------
// The stepped route.

interface Stepped {
  posts: Array<Record<string, unknown>>;
  /** Write one event to the stream answering POST number `post` (1-based). */
  send(event: ChatEvent, post?: number): Promise<void>;
  /** End the stream answering POST number `post`. */
  close(post?: number): void;
  stop(): void;
}

let stepped: Stepped | null = null;

afterEach(() => {
  stepped?.stop();
  stepped = null;
});

function startStepped(): Stepped {
  const posts: Array<Record<string, unknown>> = [];
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const opened: Array<() => void> = [];
  const waitFor = (post: number) =>
    controllers[post - 1] !== undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          opened[post - 1] = resolve;
        });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/api/chat") return new NativeResponse(null, { status: 404 });
      posts.push((await request.json()) as Record<string, unknown>);
      const index = posts.length - 1;
      const stream = new NativeReadableStream<Uint8Array>({
        start(controller) {
          controllers[index] = controller;
          opened[index]?.();
        },
      });
      return new NativeResponse(stream, { headers: { "content-type": "application/x-ndjson" } });
    },
  });
  origin = `http://localhost:${server.port}`;
  // The stream answering the latest POST, or the first one when the page has
  // not sent it yet: `send` waits for it to open.
  const latest = () => Math.max(posts.length, 1);
  return {
    posts,
    async send(event, post = latest()) {
      await waitFor(post);
      controllers[post - 1]?.enqueue(new NativeTextEncoder().encode(encodeEvent(event)));
    },
    close(post = latest()) {
      try {
        controllers[post - 1]?.close();
      } catch {
        // Already closed.
      }
    },
    stop() {
      for (const controller of controllers) {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
      server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// The page.

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Chat signedInAs={ALICE} />);
  });
  return { container, root };
}

async function settle(description: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function submit(container: HTMLElement): Promise<void> {
  await act(async () => {
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function typePrompt(container: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea === null) throw new Error("chat composer is missing");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function cleanup(container: HTMLElement, root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

const statusText = (container: HTMLElement) => container.querySelector(".chat-status")?.textContent ?? null;
const statusKind = (container: HTMLElement) => container.querySelector(".chat-status")?.getAttribute("data-status") ?? null;
const idle = (container: HTMLElement) => container.querySelector("button")?.textContent === "Send";
const prose = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-role="assistant"] [data-kind="text"]')].map((node) => node.textContent ?? "").join("");

/**
 * The value a `JsonView` tree shows, read back off the DOM.
 *
 * Built from what is rendered — keys, brackets and leaves as the reader sees
 * them — rather than from the copy button's text, so an equality against it
 * is a claim about the screen.
 */
function renderedJson(view: Element): unknown {
  const tree = view.querySelector(":scope > .json-view-tree");
  const root = tree?.firstElementChild;
  if (!root) throw new Error("JsonView has no tree");
  return readNode(root).value;
}

function readNode(node: Element): { key: string | undefined; value: unknown } {
  const line = node.matches("details.json-node") ? node.querySelector(":scope > summary") : node;
  const keyText = line?.querySelector(":scope > .json-key")?.textContent;
  const key = keyText === undefined || keyText === null ? undefined : (JSON.parse(keyText) as string);
  if (node.matches("details.json-node")) {
    // The last bracket in the line: with a key, the first is the `: `.
    const open = [...(line?.querySelectorAll(":scope > .json-punct") ?? [])].at(-1)?.textContent;
    const children = [...node.querySelectorAll(":scope > .json-children > *")].map(readNode);
    if (open === "[") return { key, value: children.map((child) => child.value) };
    return { key, value: Object.fromEntries(children.map((child) => [child.key, child.value])) };
  }
  const leaf = line?.lastElementChild;
  if (leaf?.classList.contains("json-punct")) return { key, value: leaf.textContent === "[]" ? [] : {} };
  return { key, value: JSON.parse(leaf?.textContent ?? "null") };
}

// ---------------------------------------------------------------------------

describe("AC2: the reply streams, one render per delta", () => {
  test("N deltas give N renders, and the first text is on screen before the reply finishes", async () => {
    stepped = startStepped();
    const { container, root } = await mount();
    try {
      await submit(container);
      const deltas = ["Reading ", "LN-2291", " now; ", "it is ", "for ", "$95,000."];
      const seen: string[] = [];
      let sofar = "";
      for (const delta of deltas) {
        await stepped.send({ kind: "text", text: delta });
        sofar += delta;
        // Trimmed, as a paragraph is (`markdown.ts`).
        await settle(`the reply to read ${JSON.stringify(sofar.trim())}`, () => prose(container) === sofar.trim());
        seen.push(prose(container));
        // Not finished: no `done` yet, and the chat says it is still running.
        expect(container.textContent).toContain("Running…");
      }
      expect(seen).toHaveLength(deltas.length);
      expect(new Set(seen).size).toBe(deltas.length);
      expect(seen[0]).toBe("Reading");

      await stepped.send({ kind: "done", calls: 0 });
      stepped.close();
      await settle("the turn to end", () => idle(container));
      expect(prose(container)).toBe(deltas.join(""));
    } finally {
      await cleanup(container, root);
    }
  });
});

describe("AC3: the status line names the current wait", () => {
  test("thinking, calling, thinking, and gone on done", async () => {
    stepped = startStepped();
    const { container, root } = await mount();
    try {
      await submit(container);
      await settle("Thinking…", () => statusText(container) === "Thinking…");
      expect(statusKind(container)).toBe("running");

      await stepped.send({ kind: "tool-call", tool: "Loan_SearchLoans", inputs: { min_amount: 90000 } });
      await settle("Calling Loan_SearchLoans…", () => statusText(container) === "Calling Loan_SearchLoans…");

      await stepped.send({ kind: "tool-result", tool: "Loan_SearchLoans", result: [{ loan_id: "LN-2291" }] });
      await settle("Thinking… again", () => statusText(container) === "Thinking…");

      await stepped.send({ kind: "text", text: "One loan matches." });
      await stepped.send({ kind: "done", calls: 1 });
      await settle("the line to clear on done", () => statusText(container) === null);
      stepped.close();
      await settle("the turn to end", () => idle(container));
      expect(statusText(container)).toBeNull();
    } finally {
      await cleanup(container, root);
    }
  });

  test("the approval wait is held after done, still, and a new message clears it", async () => {
    stepped = startStepped();
    const { container, root } = await mount();
    try {
      await submit(container);
      await stepped.send({ kind: "tool-call", tool: "Approvals_RequestApproval", inputs: { resource_id: "LN-2291" } });
      await stepped.send({
        kind: "tool-result",
        tool: "Approvals_RequestApproval",
        result: { request_id: "apr_0m4xq7bd91kz", approver: "Charlie" },
      });
      await stepped.send({
        kind: "waiting",
        tool: "Approvals_RequestApproval",
        request_id: "apr_0m4xq7bd91kz",
        approver: "Charlie",
        approver_id: "charlie@bank.example",
      });
      await settle("the approval wait", () => statusText(container) === "Waiting for Charlie's approval…");
      await stepped.send({ kind: "text", text: "Approval requested from Charlie. Waiting." });
      await stepped.send({ kind: "done", calls: 1 });
      stepped.close();
      await settle("the turn to end", () => idle(container));

      expect(statusText(container)).toBe("Waiting for Charlie's approval…");
      expect(statusKind(container)).toBe("held");

      await typePrompt(container, "What else is pending?");
      await submit(container);
      await settle("the new message's own status", () => statusText(container) === "Thinking…");
      await stepped.send({ kind: "text", text: "Nothing else." }, 2);
      await stepped.send({ kind: "done", calls: 0 }, 2);
      stepped.close(2);
      await settle("the follow-up to end", () => idle(container));
      expect(statusText(container)).toBeNull();
    } finally {
      await cleanup(container, root);
    }
  });

  test("the authorization wait names the tool and stays until Continue", async () => {
    stepped = startStepped();
    const { container, root } = await mount();
    try {
      await submit(container);
      await stepped.send({ kind: "tool-call", tool: "Approvals_RequestApproval", inputs: { resource_id: "LN-2291" } });
      await stepped.send({
        kind: "authorization",
        tool: "Approvals_RequestApproval",
        url: "https://slack.com/oauth/v2/authorize?client_id=x",
      });
      await stepped.send({ kind: "done", calls: 1 });
      stepped.close();
      await settle("the turn to end", () => idle(container));
      expect(statusText(container)).toBe("Waiting for you to authorize Approvals_RequestApproval…");
      expect(statusKind(container)).toBe("held");

      await act(async () => {
        container
          .querySelector('[data-action="continue-authorization"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await settle("Continue's attempt to be thinking", () => statusText(container) === "Thinking…");
      await stepped.send({ kind: "fault", tool: "Approvals_RequestApproval", message: "Slack answered 503" }, 2);
      await settle("the line to clear on fault", () => statusText(container) === null);
      await stepped.send({ kind: "done", calls: 1 }, 2);
      stepped.close(2);
      await settle("the retry to end", () => idle(container));
      expect(statusText(container)).toBeNull();
    } finally {
      await cleanup(container, root);
    }
  });

  test("an error clears it", async () => {
    stepped = startStepped();
    const { container, root } = await mount();
    try {
      await submit(container);
      await stepped.send({ kind: "tool-call", tool: "Loan_GetLoan", inputs: { loan_id: "LN-2291" } });
      await settle("Calling Loan_GetLoan…", () => statusText(container) === "Calling Loan_GetLoan…");
      await stepped.send({ kind: "error", message: "the provider returned 500" });
      await settle("the line to clear on error", () => statusText(container) === null);
      await stepped.send({ kind: "done", calls: 1 });
      stepped.close();
      await settle("the turn to end", () => idle(container));
      expect(statusText(container)).toBeNull();
    } finally {
      await cleanup(container, root);
    }
  });
});

describe("AC1, AC4, AC5: one transcript, and tool rows that open onto the wire", () => {
  const RESULT = {
    loan_id: "LN-2291",
    borrower_name: "Northwind Bakery LLC",
    amount: 95000,
    approved: false,
    bank_account_number: "[REDACTED]",
    decisions: [],
    tags: ["pending", "over-limit"],
    underwriter: { name: null, score: 1.4 },
  };

  test("a tool call is a collapsed row that expands to its arguments and its post-hook result", async () => {
    stepped = startStepped();
    const { container, root } = await mount();
    try {
      await submit(container);
      await stepped.send({ kind: "text", text: "Reading it now." });
      await stepped.send({ kind: "tool-call", tool: "Loan_GetLoan", inputs: { loan_id: "LN-2291" } });
      await settle("the tool row", () => container.querySelector('[data-kind="tool"]') !== null);
      const row = container.querySelector<HTMLDetailsElement>('details[data-kind="tool"]');
      expect(row?.getAttribute("data-state")).toBe("running…");
      await stepped.send({ kind: "tool-result", tool: "Loan_GetLoan", result: RESULT });
      await stepped.send({ kind: "text", text: "It is for $95,000." });
      await stepped.send({ kind: "done", calls: 1 });
      stepped.close();
      await settle("the turn to end", () => idle(container));

      const rows = container.querySelectorAll<HTMLDetailsElement>('details[data-kind="tool"]');
      expect(rows).toHaveLength(1);
      const tool = rows[0] as HTMLDetailsElement;
      // Collapsed, and named by the tool.
      expect(tool.open).toBe(false);
      expect(tool.querySelector("summary .chat-tool-name")?.textContent).toBe("Loan_GetLoan");
      expect(tool.getAttribute("data-state")).toBe("returned");

      // Opens onto both views.
      tool.open = true;
      const args = tool.querySelector('[data-json="Arguments"]');
      const result = tool.querySelector('[data-json="Result"]');
      expect(args).not.toBeNull();
      expect(result).not.toBeNull();
      expect(renderedJson(args as Element)).toEqual({ loan_id: "LN-2291" });
      expect(renderedJson(result as Element)).toEqual(RESULT);
      // Collapsible nodes, and typed leaves for the colouring.
      expect(result?.querySelectorAll("details.json-node").length).toBeGreaterThanOrEqual(3);
      expect(result?.querySelector(".json-string")?.textContent).toBe('"LN-2291"');
      expect(result?.querySelector(".json-number")?.textContent).toBe("95000");
      expect(result?.querySelector(".json-boolean")?.textContent).toBe("false");
      expect(result?.querySelector(".json-null")?.textContent).toBe("null");
      // Stated in the UI.
      expect(tool.querySelector('[data-note="post-hook"]')?.textContent).toContain("post-hook output");

      // Copy puts the exact value on the clipboard.
      let copied = "";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => void (copied = text) },
      });
      await act(async () => {
        result?.querySelector<HTMLButtonElement>('[data-action="copy-json"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(JSON.parse(copied)).toEqual(RESULT);
      expect(result?.querySelector('[data-action="copy-json"]')?.textContent).toBe("Copied");

      // The prose either side of the call stays either side of it.
      const markup = container.innerHTML;
      expect(markup.indexOf("Reading it now.")).toBeLessThan(markup.indexOf("Loan_GetLoan"));
      expect(markup.indexOf("Loan_GetLoan")).toBeLessThan(markup.indexOf("It is for $95,000."));
    } finally {
      await cleanup(container, root);
    }
  });

  test("a denied call's row says so, and the decision card stays its own card", async () => {
    stepped = startStepped();
    const { container, root } = await mount();
    try {
      await submit(container);
      await stepped.send({ kind: "tool-call", tool: "Loan_ApproveLoan", inputs: { loan_id: "LN-2291", amount: 95000 } });
      await stepped.send({
        kind: "denied",
        tool: "Loan_ApproveLoan",
        reason: "DENIED: approving LN-2291 for 95000 exceeds your approval authority of 50000. [ref evt_4k7xq2m9hz]",
        ref: "evt_4k7xq2m9hz",
      });
      await stepped.send({ kind: "done", calls: 1 });
      stepped.close();
      await settle("the turn to end", () => idle(container));

      const row = container.querySelector('details[data-kind="tool"]');
      expect(row?.getAttribute("data-state")).toBe("denied");
      expect(row?.querySelector('[data-json="Result"]')).toBeNull();
      const card = container.querySelector<HTMLElement>('[data-kind="denied"]');
      expect(card).not.toBeNull();
      // The card is bordered; the turn and the messages around it are not.
      expect(card?.style.borderLeft).toContain("solid");
      expect(card?.closest('[data-role="assistant"]')?.getAttribute("style")).toBeNull();
    } finally {
      await cleanup(container, root);
    }
  });

  test("the stylesheet draws no box around a turn or a message", async () => {
    // happy-dom does not apply `chat.css`, so the rule is read where it lives.
    // The Chrome run on the PR measures the computed borders of the same
    // elements on the real page.
    const css = await Bun.file(new URL("../components/chat/chat.css", import.meta.url)).text();
    for (const selector of [".chat-turn", ".chat-message", ".chat-message-user", ".chat-message-assistant"]) {
      const rule = new RegExp(`(^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css);
      expect({ selector, found: rule !== null }).toEqual({ selector, found: true });
      expect({ selector, border: /\bborder(?!-radius)[\w-]*\s*:/.test(rule?.[2] ?? "") }).toEqual({
        selector,
        border: false,
      });
    }
  });
});

describe("AC6: chat, don't click", () => {
  const challenge: ChatEvent = {
    kind: "authorization",
    tool: "Loan_GetLoan",
    url: "https://provider.example/authorize/request-1",
  };

  async function challenged(container: HTMLElement): Promise<void> {
    await submit(container);
    await stepped?.send(challenge, 1);
    await stepped?.send({ kind: "done", calls: 1 }, 1);
    stepped?.close(1);
    await settle("the authorization card", () => container.querySelector('[data-action="continue-authorization"]') !== null);
    await settle("the turn to end", () => idle(container));
  }

  test("a typed message resumes the paused turn with the request Continue sends, and is not sent to the model", async () => {
    // What Continue sends, measured on its own first.
    stepped = startStepped();
    let clicked: Record<string, unknown> | undefined;
    {
      const { container, root } = await mount();
      try {
        await challenged(container);
        await act(async () => {
          container
            .querySelector('[data-action="continue-authorization"]')
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await settle("Continue's request", () => stepped?.posts.length === 2);
        clicked = stepped.posts[1];
        await stepped.send({ kind: "done", calls: 0 }, 2);
        stepped.close(2);
        await settle("Continue's attempt to end", () => idle(container));
      } finally {
        await cleanup(container, root);
      }
    }
    stepped.stop();

    stepped = startStepped();
    const { container, root } = await mount();
    try {
      await challenged(container);
      await typePrompt(container, "done");
      await submit(container);
      await settle("the typed resume's request", () => stepped?.posts.length === 2);
      expect(stepped.posts[1]).toEqual(clicked as Record<string, unknown>);
      expect(stepped.posts[1]).toEqual({ prompt: DEFAULT_PROMPT });
      expect(JSON.stringify(stepped.posts[1])).not.toContain('"done"');

      await stepped.send({ kind: "tool-call", tool: "Loan_GetLoan", inputs: { loan_id: "LN-2291" } }, 2);
      await stepped.send({ kind: "tool-result", tool: "Loan_GetLoan", result: { loan_id: "LN-2291" } }, 2);
      await stepped.send({ kind: "text", text: "Read it." }, 2);
      await stepped.send({ kind: "done", calls: 1 }, 2);
      stepped.close(2);
      await settle("the resumed attempt to end", () => idle(container));

      // The typed line is on screen, saying what it did.
      const users = [...container.querySelectorAll('[data-role="user"]')];
      expect(users.map((node) => node.querySelector("p")?.textContent)).toEqual([DEFAULT_PROMPT, "done"]);
      expect(users[1]?.querySelector('[data-note="continues"]')?.textContent).toContain("not sent to the agent");
      // And the button stays: it is still how a click continues.
      expect(container.querySelectorAll('[data-kind="authorization"]')).toHaveLength(1);
      expect(container.textContent).toContain("Read it.");
    } finally {
      await cleanup(container, root);
    }
  });

  test("a typed message and a click together start one attempt, not two", async () => {
    for (const order of ["type-then-click", "click-then-type"] as const) {
      stepped = startStepped();
      const { container, root } = await mount();
      try {
        await challenged(container);
        await typePrompt(container, "continue");
        const button = container.querySelector<HTMLButtonElement>('[data-action="continue-authorization"]');
        expect(button).not.toBeNull();
        await act(async () => {
          const form = container.querySelector("form");
          const typed = () => form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          const click = () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          if (order === "type-then-click") {
            typed();
            click();
          } else {
            click();
            typed();
          }
        });
        await settle("the one attempt's request", () => stepped?.posts.length === 2);
        await stepped.send({ kind: "done", calls: 0 }, 2);
        stepped.close(2);
        await settle("the attempt to end", () => idle(container));
        // Give a second request every chance to arrive.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect({ order, posts: stepped.posts.length }).toEqual({ order, posts: 2 });
        expect(stepped.posts[1]).toEqual({ prompt: DEFAULT_PROMPT });
      } finally {
        await cleanup(container, root);
        stepped.stop();
        stepped = null;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The real handler.

describe("AC5 end to end: the JSON on screen equals what the model saw", () => {
  test("Alice reads LN-2291: the rendered result is the tool result in the model's prompt", async () => {
    const { DANA, OVER_LIMIT_LOAN, startAgentHarness } = await import("./agent-harness.ts");
    const { chat, CHAT_PATH } = await import("../lib/agent/handlers.ts");
    const { scriptedModel } = await import("./model.ts");
    const { writeSession } = await import("../lib/identity/session.ts");
    const loans = (await import("../lib/loans/fixtures/loans.json", { with: { type: "json" } })).default as unknown as {
      loans: Array<Record<string, string>>;
    };
    const account = loans.loans.find((loan) => loan.loan_id === OVER_LIMIT_LOAN)?.bank_account_number as string;

    const harness = await startAgentHarness();
    const scripted = scriptedModel([
      { call: "Loan_GetLoan", input: { loan_id: OVER_LIMIT_LOAN } },
      { say: ["Northwind ", "Bakery, ", "$95,000."] },
    ]);
    const web = Bun.serve({
      port: 0,
      idleTimeout: 60,
      fetch: (request) =>
        new URL(request.url).pathname === CHAT_PATH
          ? chat(request, { config: harness.config, model: () => scripted.model })
          : new NativeResponse(null, { status: 404 }),
    });
    origin = `http://localhost:${web.port}`;
    const bearer = harness.tokenFor(DANA);
    const headers = new NativeHeaders();
    await writeSession(
      headers,
      new NativeRequest("http://localhost/"),
      {
        email: DANA,
        signed_in_at: Date.now(),
        gateway: { access_token: bearer, expires_at: Date.now() + 3_600_000, client_id: "chat-feel" },
      },
      harness.config,
    );
    cookie = headers
      .getSetCookie()
      .map((value) => value.split(";")[0] as string)
      .join("; ");

    const { container, root } = await mount();
    try {
      await submit(container);
      await settle("the real turn to end", () => idle(container) && container.textContent?.includes("this turn.") === true);

      const tool = container.querySelector('details[data-kind="tool"][data-tool="Loan_GetLoan"]');
      expect(tool?.getAttribute("data-state")).toBe("returned");
      const shown = renderedJson(tool?.querySelector('[data-json="Result"]') as Element);

      const last = scripted.prompts[scripted.prompts.length - 1] as Array<{ role: string; content: unknown }>;
      const part = last
        .filter((message) => message.role === "tool")
        .flatMap((message) => message.content as Array<Record<string, unknown>>)
        .find((candidate) => candidate.type === "tool-result" && candidate.toolName === "Loan_GetLoan");
      const saw = (part?.output as { value: unknown }).value;

      expect(shown).toEqual(saw);
      expect((shown as Record<string, unknown>).bank_account_number).toBe("[REDACTED]");
      expect(renderedJson(tool?.querySelector('[data-json="Arguments"]') as Element)).toEqual({
        loan_id: OVER_LIMIT_LOAN,
      });
      expect(container.innerHTML).not.toContain(account);
      expect(container.innerHTML).not.toContain(bearer);
      expect(prose(container)).toBe("Northwind Bakery, $95,000.");
    } finally {
      await cleanup(container, root);
      cookie = null;
      web.stop(true);
      await harness.stop();
    }
  }, 60_000);
});
