/**
 * Studio shows a layer-2 challenge as readable text carrying the authorization link (#30).
 *
 * On the third live run (#7) the Loan toolkit's hop-2 challenge reached Studio
 * as the tool error "authorization challenge requires URL elicitation", with
 * the result drawn as `[object Object]`, so the person had no link to follow.
 *
 * Each test drives one turn through the agent Studio registers
 * (`studioAgent`), against the gateway stand-in answering `Loan_GetLoan` with
 * one of the challenge shapes the chat route already reads. The chunk for that
 * call is sent through JSON, as Studio's server streams it, and drawn with the
 * function Studio's own page draws a tool error with, read out of the Studio
 * bundle that ships in `node_modules/mastra`. A result is drawn as itself.
 *
 * Measured before #30: every shape but the native request came back a tool
 * error drawn as `[object Object]`, and the native one as the empty result
 * `{}`. The output is on #30's PR.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { DANA, OVER_LIMIT_LOAN, startAgentHarness, type AgentHarness } from "./agent-harness.ts";
import { scriptedModel } from "./model.ts";
import { forgetStudioGrant, holdGatewayGrant, studioAgent } from "../lib/agent/studio.ts";

const ROOT = join(import.meta.dir, "..");
const TOOL = "Loan_GetLoan";

/**
 * Studio's own "error text" function, out of the bundle `mastra dev` serves.
 * It returns `error.message` when that is a string, and `String(error)`
 * otherwise, which is where `[object Object]` comes from. Found by its body
 * rather than its minified name, and a bundle that no longer has it fails here
 * rather than letting the test pass on a guess.
 */
function studioErrorText(): (error: unknown) => string {
  const assets = join(realpathSync(join(ROOT, "node_modules", "mastra")), "dist", "studio", "assets");
  const pattern =
    /function (\w+)\(e\)\{if\(e&&typeof e=="object"\)\{if\("message"in e&&typeof e\.message=="string"\)return e\.message;[^]*?\}return String\(e\)\}/;
  for (const file of readdirSync(assets).filter((name) => name.endsWith(".js"))) {
    const match = pattern.exec(readFileSync(join(assets, file), "utf8"));
    if (match) return new Function(`${match[0]}; return ${match[1]};`)() as (error: unknown) => string;
  }
  throw new Error(`Studio's tool-error text function is not in ${assets} any more; read how Studio draws a tool error now`);
}

/** What Studio's page shows for one tool call's outcome chunk. */
function drawn(chunk: { type: string; payload: Record<string, unknown> }, errorText: (error: unknown) => string): string {
  const sent = JSON.parse(JSON.stringify(chunk)) as { type: string; payload: Record<string, unknown> };
  if (sent.type === "tool-error") return errorText(sent.payload.error);
  const result = sent.payload.result;
  return typeof result === "string" ? result : JSON.stringify(result);
}

let harness: AgentHarness;
let errorText: (error: unknown) => string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  errorText = studioErrorText();
  harness = await startAgentHarness();
  // What `mastra dev` reads from the environment, pointed at the stand-in.
  const env: Record<string, string> = {
    ARCADE_API_URL: harness.config.arcadeApiUrl,
    ARCADE_GATEWAY_ID: harness.config.identity.gatewayId,
    ARCADE_LOAN_TOOLKIT: harness.config.agent.toolkits[0]!,
    ARCADE_APPROVALS_TOOLKIT: harness.config.agent.approvalsToolkit,
    ANTHROPIC_API_KEY: harness.config.agent.anthropicApiKey,
    MODEL_ID: harness.config.agent.modelId,
    APP_PUBLIC_HOST: "lal-tunnel.example",
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
}, 60_000);

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await forgetStudioGrant();
  await harness?.stop();
});

/** One Studio turn in which the model reads LN-2291; what Studio draws for the call, and what the model read next. */
async function studioTurn(): Promise<{ shown: string; type: string; modelRead: string }> {
  holdGatewayGrant({ access_token: harness.tokenFor(DANA), expires_at: Date.now() + 3_600_000, client_id: "studio-authorization-tests" });
  const script = scriptedModel([{ call: TOOL, input: { loan_id: OVER_LIMIT_LOAN } }, { say: "Noted." }]);
  const agent = studioAgent({ port: 4999 });
  agent.__updateModel({ model: script.model as never });
  const streamed = await agent.stream(`Read ${OVER_LIMIT_LOAN}.`);
  let outcome: { type: string; payload: Record<string, unknown> } | undefined;
  for await (const chunk of streamed.fullStream as AsyncIterable<{ type: string; payload: Record<string, unknown> }>) {
    if ((chunk.type === "tool-error" || chunk.type === "tool-result") && chunk.payload.toolName === TOOL) outcome = chunk;
  }
  expect(outcome, `no outcome for ${TOOL} in the stream`).toBeDefined();
  const shown = drawn(outcome!, errorText);
  console.log(`[studio-authorization] ${outcome!.type}: ${shown}`);
  return { shown, type: outcome!.type, modelRead: JSON.stringify(script.prompts.at(-1)) };
}

describe("a Loan tool that needs authorizing, in Studio", () => {
  test("the legacy authorization_url challenge is drawn as text with its link", async () => {
    const url = "https://cloud.arcade.dev/oauth/authorize?flow=legacy-studio";
    harness.gateway.requireAuthorizationFor(TOOL, url);
    const { shown, type, modelRead } = await studioTurn();
    expect(shown).not.toContain("[object Object]");
    expect(type).toBe("tool-result");
    expect(shown).toContain(`${TOOL} did not run: Arcade needs you to authorize the Loan toolkit first.`);
    expect(shown).toContain(url);
    expect(modelRead).toContain(url);
  }, 60_000);

  test("the URL-elicitation error -32042 is drawn as text with the link it carries", async () => {
    const url = "https://cloud.arcade.dev/oauth/authorize?flow=protocol-studio";
    harness.gateway.requireProtocolAuthorizationFor(TOOL, url);
    const { shown, type } = await studioTurn();
    expect(shown).not.toContain("[object Object]");
    expect(type).toBe("tool-result");
    expect(shown).toContain(url);
  }, 60_000);

  test("a native elicitation/create, cancelled by Studio, is drawn as text with its link", async () => {
    const url = "https://cloud.arcade.dev/oauth/authorize?flow=native-studio";
    harness.gateway.requireNativeElicitationFor(TOOL, url);
    const { shown, type } = await studioTurn();
    expect(shown).not.toBe("{}");
    expect(type).toBe("tool-result");
    expect(shown).toContain(url);
  }, 60_000);

  test("with no link anywhere, the text says to authorize Loan in the web UI first", async () => {
    harness.gateway.requireProtocolAuthorizationFor(TOOL);
    const { shown, type } = await studioTurn();
    expect(shown).not.toContain("[object Object]");
    expect(type).toBe("tool-result");
    expect(shown).toContain("sent Studio no link to show");
    expect(shown).toContain("Authorize it in the web UI: open https://lal-tunnel.example, sign in as the same person");
  }, 60_000);

  test("a hook denial is still a tool error, so the model reads it as a failed call", async () => {
    holdGatewayGrant({ access_token: harness.tokenFor(DANA), expires_at: Date.now() + 3_600_000, client_id: "studio-authorization-tests" });
    const script = scriptedModel([{ call: "Loan_ApproveLoan", input: { loan_id: OVER_LIMIT_LOAN, amount: 95_000 } }, { say: "Noted." }]);
    const agent = studioAgent({ port: 4999 });
    agent.__updateModel({ model: script.model as never });
    const streamed = await agent.stream("Approve the loan for $95K.");
    const types: string[] = [];
    for await (const chunk of streamed.fullStream as AsyncIterable<{ type: string; payload: Record<string, unknown> }>) {
      if (chunk.payload?.toolName === "Loan_ApproveLoan" && /^tool-(error|result)$/.test(chunk.type)) {
        types.push(chunk.type);
        // Recorded, not asserted: Studio draws every tool error this way, and a denial must stay one.
        console.log(`[studio-authorization] the denial, as Studio draws it: ${drawn(chunk, errorText)}`);
      }
    }
    expect(types).toEqual(["tool-error"]);
    expect(JSON.stringify(script.prompts.at(-1))).toContain("exceeds your approval authority");
  }, 60_000);
});
