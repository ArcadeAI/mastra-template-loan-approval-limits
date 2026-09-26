/**
 * #37 — what the chat stream carries of the wire: every text delta as it is
 * produced, each tool result exactly as the model received it, and no secret.
 *
 * Same harness as the tracer bullet: the real control plane compiling the real
 * policy, the real loan module, the real MCP transport through the gateway
 * stand-in (which calls `/pre` and `/post` and forwards `override.output` as
 * Arcade does), and the real `chat` handler behind a `Bun.serve` on `:0`. The
 * model is the scripted stand-in, whose `prompts` are the evidence of what the
 * model was handed. Nothing here needs a key, and nothing reaches Arcade.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DANA, OVER_LIMIT_LOAN, STORE_TOKEN, startAgentHarness, type AgentHarness } from "./agent-harness.ts";
import { chat, CHAT_PATH, turnSecrets } from "../lib/agent/handlers.ts";
import { decodeEvents, type ChatEvent } from "../lib/agent/events.ts";
import { runTurn, type Streamable } from "../lib/agent/run.ts";
import { environmentSecrets, secretValues, WITHHELD, withholdSecrets } from "../lib/agent/withhold.ts";
import { scriptedModel, type ScriptedModel, type Turn } from "./model.ts";
import { writeSession, type Session } from "../lib/identity/session.ts";
import loans from "../lib/loans/fixtures/loans.json" with { type: "json" };

const LOAN = (loans.loans as Array<Record<string, unknown>>).find(
  (loan) => loan.loan_id === OVER_LIMIT_LOAN,
) as Record<string, string>;

let harness: AgentHarness;
let web: ReturnType<typeof Bun.serve>;
let scripted: ScriptedModel;

beforeAll(async () => {
  harness = await startAgentHarness();
  web = Bun.serve({
    port: 0,
    idleTimeout: 60,
    fetch: (request) =>
      new URL(request.url).pathname === CHAT_PATH
        ? chat(request, {
            config: harness.config,
            model: () => scripted.model,
            store: { controlPlaneHost: harness.hooksHost, approvalsStoreToken: STORE_TOKEN },
          })
        : new Response(null, { status: 404 }),
  });
}, 60_000);

afterAll(async () => {
  web?.stop(true);
  await harness?.stop();
});

interface Turned {
  events: ChatEvent[];
  /** The gateway bearer this browser's session carried. */
  bearer: string;
}

/** One turn as Alice. `script` may be a function of the bearer this browser's session carries. */
async function turn(prompt: string, script: readonly Turn[] | ((bearer: string) => readonly Turn[])): Promise<Turned> {
  const bearer = harness.tokenFor(DANA);
  scripted = scriptedModel(typeof script === "function" ? script(bearer) : script);
  const session: Session = {
    email: DANA,
    signed_in_at: Date.now(),
    gateway: { access_token: bearer, expires_at: Date.now() + 3_600_000, client_id: "chat-wire-tests" },
  };
  const headers = new Headers();
  await writeSession(headers, new Request("http://localhost/"), session, harness.config);
  const cookie = headers
    .getSetCookie()
    .map((value) => value.split(";")[0] as string)
    .join("; ");
  const response = await fetch(`http://localhost:${web.port}${CHAT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt }),
  });
  expect(response.status).toBe(200);
  return { events: decodeEvents(await response.text()), bearer };
}

const of = <K extends ChatEvent["kind"]>(events: readonly ChatEvent[], kind: K) =>
  events.filter((event): event is Extract<ChatEvent, { kind: K }> => event.kind === kind);

/** Every tool-result part the model was handed, in order, as the provider received it. */
function toolResultsTheModelSaw(model: ScriptedModel): Array<{ toolName: string; value: unknown }> {
  const seen: Array<{ toolName: string; value: unknown }> = [];
  const last = model.prompts[model.prompts.length - 1] ?? [];
  for (const message of last as Array<{ role: string; content: unknown }>) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type !== "tool-result") continue;
      const output = part.output as { type: string; value: unknown };
      seen.push({ toolName: String(part.toolName), value: output.value });
    }
  }
  return seen;
}

describe("streaming: a reply of N deltas is N text events", () => {
  const DELTAS = ["Loan ", "LN-2291 ", "is ", "for ", "$95,000 ", "and ", "pending."];

  test("the real handler forwards each delta as its own event, in order", async () => {
    const { events } = await turn("How much is LN-2291 for?", [{ say: DELTAS }]);

    const texts = of(events, "text").map((event) => event.text);
    expect(texts).toEqual(DELTAS);
    // Every text event precedes `done`: the reply streams, then the turn ends.
    const kinds = events.map((event) => event.kind);
    expect(kinds.lastIndexOf("text")).toBeLessThan(kinds.indexOf("done"));
  }, 30_000);
});

describe("the tool result on the stream is what the model received", () => {
  let events: ChatEvent[];

  beforeAll(async () => {
    ({ events } = await turn(`Read loan ${OVER_LIMIT_LOAN}.`, [
      { call: "Loan_GetLoan", input: { loan_id: OVER_LIMIT_LOAN } },
      { say: "Read." },
    ]));
  }, 30_000);

  test("the tool-result event deep-equals the tool result in the model's next prompt", () => {
    const results = of(events, "tool-result");
    expect(results.map((event) => event.tool)).toEqual(["Loan_GetLoan"]);

    const saw = toolResultsTheModelSaw(scripted);
    expect(saw.map((part) => part.toolName)).toEqual(["Loan_GetLoan"]);
    // The claim of AC5, as one assertion.
    expect(results[0]?.result).toEqual(saw[0]?.value);
    expect(results[0]?.withheld).toBeUndefined();
  });

  test("and it is the post-hook output, not what the toolkit returned", () => {
    const result = of(events, "tool-result")[0]?.result as Record<string, unknown>;
    // A present value, so the equality above is not two empty objects agreeing.
    expect(result.loan_id).toBe(OVER_LIMIT_LOAN);
    expect(result.borrower_name).toBe("Northwind Bakery LLC");
    // `/post` masked these. The fixture's real values are nowhere on the stream.
    expect(result.bank_account_number).toBe("[REDACTED]");
    expect(result.tax_id).toBe("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain(LOAN.bank_account_number as string);
    expect(JSON.stringify(events)).not.toContain(LOAN.tax_id as string);
  });

  test("the arguments on the tool-call are the model's own", () => {
    expect(of(events, "tool-call")).toEqual([
      { kind: "tool-call", tool: "Loan_GetLoan", inputs: { loan_id: OVER_LIMIT_LOAN } },
    ]);
  });
});

describe("nothing leaks: secrets never reach a rendered argument or result", () => {
  test("the session's own gateway bearer, echoed into a call, is withheld through the real handler", async () => {
    // The model cannot know the bearer, so this is the adversary's case made
    // concrete: a call whose argument happens to carry it, which the loan
    // module will also echo back in its error. Neither may reach the page.
    const { events: turned, bearer } = await turn("Read it.", (bearer) => [
      { call: "Loan_GetLoan", input: { loan_id: `LN-${bearer}` } },
      { say: "That loan does not exist." },
    ]);

    // The call happened, with the bearer in it, as far as the model knows.
    expect(JSON.stringify(scripted.prompts)).toContain(bearer);
    const call = of(turned, "tool-call")[0];
    expect(call?.inputs).toEqual({ loan_id: `LN-${WITHHELD}` });
    expect(call?.withheld).toBe(1);
    // The loan module's error echoed the id back. Measured, not assumed: the
    // fault is there, and the bearer inside it is withheld.
    const fault = of(turned, "fault")[0];
    expect(fault?.message).toContain(`No loan application found with ID LN-${WITHHELD}`);
    expect(JSON.stringify(turned)).not.toContain(bearer);
  }, 30_000);

  test("a result carrying the store token, an OAuth token and a Bearer header is withheld", async () => {
    const bearer = "gw_7f1d6c2e-5b1a-4c55-9a51-0d1f7c1f2b3a";
    const env = { APPROVALS_STORE_TOKEN: "store-token-from-the-environment-0123" };
    const secrets = turnSecrets(bearer, harness.config, { env, storeToken: STORE_TOKEN });
    // What the handler holds as secret for this turn, named.
    expect(secrets).toContain(bearer);
    expect(secrets).toContain(STORE_TOKEN);
    expect(secrets).toContain(env.APPROVALS_STORE_TOKEN);
    expect(secrets).toContain(harness.config.identity.sessionSecret);

    const jwt =
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZUBiYW5rLmV4YW1wbGUifQ.c2lnbmF0dXJlLW9mLXRoZS10b2tlbg";
    const leaky = {
      loan_id: OVER_LIMIT_LOAN,
      status: "pending",
      debug: `called the store with ${env.APPROVALS_STORE_TOKEN} and ${STORE_TOKEN}`,
      upstream: { access_token: "oauth-access-token-arcade-holds-9f8e7d", token_type: "Bearer" },
      headers: { authorization: `Bearer ${bearer}` },
      note: `forwarded Bearer ${jwt}`,
    };
    const agent: Streamable = {
      stream: async () => ({
        fullStream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "tool-call", payload: { toolName: "Loan_GetLoan", args: { loan_id: bearer } } });
            controller.enqueue({ type: "tool-result", payload: { toolName: "Loan_GetLoan", result: leaky } });
            controller.close();
          },
        }),
      }),
    };
    const events: ChatEvent[] = [];
    await runTurn({ agent, prompt: "read", emit: (event) => void events.push(event), secrets });

    const wire = JSON.stringify(events);
    for (const secret of [bearer, STORE_TOKEN, env.APPROVALS_STORE_TOKEN, "oauth-access-token-arcade-holds-9f8e7d", jwt]) {
      expect(wire).not.toContain(secret);
    }
    const result = of(events, "tool-result")[0];
    expect(result?.result).toEqual({
      loan_id: OVER_LIMIT_LOAN,
      status: "pending",
      debug: `called the store with ${WITHHELD} and ${WITHHELD}`,
      upstream: { access_token: WITHHELD, token_type: "Bearer" },
      headers: { authorization: WITHHELD },
      note: `forwarded Bearer ${WITHHELD}`,
    });
    expect(result?.withheld).toBe(5);
    expect(of(events, "tool-call")[0]).toEqual({
      kind: "tool-call",
      tool: "Loan_GetLoan",
      inputs: { loan_id: WITHHELD },
      withheld: 1,
    });
    // The original is not touched: the escalation reads it after the copy is made.
    expect(leaky.headers.authorization).toBe(`Bearer ${bearer}`);
  });

  test("the service's secrets are read from the environment by name", () => {
    expect(
      environmentSecrets({
        APPROVALS_STORE_TOKEN: "store-token-value-123",
        SESSION_SECRET: "session-secret-value-456",
        RESET_TOKEN: "reset-token-value-789",
        ARCADE_API_KEY: "arc_key_value_0000",
        PORT: "4580",
        SHORT: "abc",
      }).sort(),
    ).toEqual(
      ["arc_key_value_0000", "reset-token-value-789", "session-secret-value-456", "store-token-value-123"].sort(),
    );
  });

  test("a value shorter than eight characters is not treated as a secret", () => {
    // Otherwise a three-character "secret" would mask every loan id with those characters in it.
    expect(secretValues(["2291"])).toEqual([]);
    expect(withholdSecrets({ loan_id: "LN-2291" }, secretValues(["2291"])).withheld).toBe(0);
  });
});
