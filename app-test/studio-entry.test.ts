/**
 * #8: Studio and the chat route run one agent.
 *
 * `src/mastra/index.ts` is what `mastra dev` loads. These tests import that
 * file — not a copy of what it builds — and hold it to four things:
 *
 * 1. **One definition.** One turn through the chat route and one through the
 *    agent Studio registered, against the same gateway as the same persona,
 *    hand the model the same system prompt and the same tools. Read off the
 *    model's own request, which is the only place "the same" means anything.
 * 2. **No behaviour in the prompt.** `DESIGN.md` → No model-side controls. The
 *    tool descriptions that deploy are checked in Python where they are
 *    defined, against the same vocabulary (`behaviour.ts`).
 * 3. **One token seam.** Every gateway bearer comes out of `gatewayToken`, and
 *    no other module reads a stored one. #6 re-points that one function.
 * 4. **Studio can be loaded by Node.** Studio runs under Node while the app runs
 *    on Bun, so the entry's import graph must never reach a `bun:` module.
 *
 * Studio's own hop 1 — the loopback authorization that gives it a bearer — is
 * driven here against the identity suite's Arcade stand-in, which is the one
 * stand-in with an authorization server behind it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { DANA, GATEWAY_ID, startAgentHarness, type AgentHarness } from "./agent-harness.ts";
import { BEHAVIOURAL } from "./behaviour.ts";
import { spawnChild } from "./child.ts";
import { startArcadeStandIn, type ArcadeStandIn } from "./identity-harness.ts";
import { scriptedModel } from "./model.ts";
import { AGENT_ID, INSTRUCTIONS } from "../lib/agent/agent.ts";
import { chat, CHAT_PATH } from "../lib/agent/handlers.ts";
import {
  forgetStudioGrant,
  holdGatewayGrant,
  MASTRA_DEFAULT_PORT,
  STUDIO_AUTHORIZE_PATH,
  STUDIO_CALLBACK_PATH,
  studioAuthorize,
  studioCallback,
  studioPort,
  studioTools,
} from "../lib/agent/studio.ts";
import { readIdentitySurface, type IdentitySurface } from "../lib/config.ts";
import { forgetGatewayClients } from "../lib/identity/gateway.ts";
import { writeSession } from "../lib/identity/session.ts";

const REPO = join(import.meta.dir, "..");
const ENTRY = join(REPO, "src", "mastra", "index.ts");

/** What the model was handed on one call, reduced to what the two entries could differ in. */
interface ModelRequest {
  system: string[];
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
}

/**
 * The scripted model, recording the request each call was made with.
 *
 * `scriptedModel` records the prompt; this adds the tool definitions, which are
 * the other half of what the model is told. Nothing about the answer is
 * examined — the claim is about the request.
 */
function recordingModel(say: string) {
  const scripted = scriptedModel([{ say }]);
  const inner = scripted.model as { doStream(options: unknown): unknown };
  const requests: ModelRequest[] = [];
  const model = {
    ...(scripted.model as object),
    doStream(options: { prompt: Array<{ role: string; content: unknown }>; tools?: unknown[] }) {
      requests.push({
        system: options.prompt
          .filter((message) => message.role === "system")
          .map((message) => String(message.content)),
        tools: ((options.tools ?? []) as Array<{ name: string; description?: string; inputSchema?: unknown }>)
          .map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
      return inner.doStream(options);
    },
  };
  return { model, requests };
}

const PROMPT = "Which loan applications are waiting for a decision?";

describe("one agent, two entries", () => {
  let harness: AgentHarness;
  let web: ReturnType<typeof Bun.serve>;
  let chatModel: () => unknown = () => null;
  const saved: Record<string, string | undefined> = {};
  let mastra: typeof import("../src/mastra/index.ts")["mastra"];

  beforeAll(async () => {
    harness = await startAgentHarness();
    web = Bun.serve({
      port: 0,
      idleTimeout: 60,
      fetch: (request) =>
        new URL(request.url).pathname === CHAT_PATH
          ? chat(request, { config: harness.config, model: () => chatModel() })
          : new Response(null, { status: 404 }),
    });

    // Studio reads its configuration from the environment when it is asked
    // for the agent's tools, exactly as it does under `mastra dev`. Pointed at
    // the same gateway stand-in, the same toolkits and the same model id as the
    // chat route's config.
    const env: Record<string, string> = {
      ARCADE_API_URL: harness.config.arcadeApiUrl,
      ARCADE_GATEWAY_ID: harness.config.identity.gatewayId,
      ARCADE_LOAN_TOOLKIT: harness.config.agent.toolkits[0]!,
      ARCADE_APPROVALS_TOOLKIT: harness.config.agent.approvalsToolkit,
      ANTHROPIC_API_KEY: harness.config.agent.anthropicApiKey,
      MODEL_ID: harness.config.agent.modelId,
    };
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    ({ mastra } = await import("../src/mastra/index.ts"));
  }, 60_000);

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await forgetStudioGrant();
    web?.stop(true);
    await harness?.stop();
  });

  test("src/mastra/index.ts registers the agent the chat route builds", async () => {
    const agent = mastra.getAgent(AGENT_ID);
    expect(agent.id).toBe(AGENT_ID);
    expect(await agent.getInstructions()).toBe(INSTRUCTIONS);
  });

  test("the model is handed the same system prompt and the same six tools from both", async () => {
    // The chat route, as Alice signed in on a browser holding a gateway token.
    const viaChat = recordingModel("Checked.");
    chatModel = () => viaChat.model;
    const headers = new Headers();
    await writeSession(
      headers,
      new Request("http://localhost/"),
      {
        email: DANA,
        signed_in_at: Date.now(),
        gateway: {
          access_token: harness.tokenFor(DANA),
          expires_at: Date.now() + 3_600_000,
          client_id: "mcp-client-for-studio-entry-tests",
        },
      },
      harness.config,
    );
    const cookie = headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const response = await fetch(`http://localhost:${web.port}${CHAT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ prompt: PROMPT }),
    });
    expect(response.status).toBe(200);
    await response.text();

    // Studio, as the same person: a grant for Alice held by this process, the
    // way Studio's callback holds one. The registered agent's model is swapped
    // for the recorder with Mastra's own hook for that — Studio's model
    // picker uses the same one — and nothing else about the agent is touched.
    holdGatewayGrant({
      access_token: harness.tokenFor(DANA),
      expires_at: Date.now() + 3_600_000,
      client_id: "mcp-client-for-studio-entry-tests",
    });
    const viaStudio = recordingModel("Checked.");
    const agent = mastra.getAgent(AGENT_ID);
    agent.__updateModel({ model: viaStudio.model as never });
    const streamed = await agent.stream(PROMPT);
    await streamed.text;

    expect(viaChat.requests).toHaveLength(1);
    expect(viaStudio.requests).toHaveLength(1);
    const [fromChat] = viaChat.requests;
    const [fromStudio] = viaStudio.requests;

    // Named before compared, so an equality between two empty lists cannot
    // pass for agreement.
    expect(fromChat!.system).toEqual([INSTRUCTIONS]);
    expect(fromChat!.tools.map((tool) => tool.name)).toEqual([
      "Approvals_Decide",
      "Approvals_RequestApproval",
      "Loan_ApproveLoan",
      "Loan_DenyLoan",
      "Loan_GetLoan",
      "Loan_SearchLoans",
    ]);
    expect(fromStudio).toEqual(fromChat!);

    // And both were made as Alice: the gateway lists as the bearer's person.
    const listedAs = harness.lists.map((list) => list.user_id);
    expect(listedAs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(listedAs)).toEqual(new Set([DANA]));
  }, 60_000);

  test("Studio with no grant says so, and says where to get one", async () => {
    await forgetStudioGrant();
    const config = readIdentitySurface();
    await expect(studioTools(config, "http://localhost:4999")).rejects.toThrow(
      /Studio has no gateway token: nobody has authorized this Studio process yet\. To authorize, open http:\/\/localhost:4999\/arcade\/authorize and sign in\./,
    );
  });
});

describe("the system prompt", () => {
  test("carries no behavioural instruction", () => {
    expect(INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(INSTRUCTIONS).not.toMatch(BEHAVIOURAL);
  });

  test("the vocabulary check bites on the sentences it exists for", () => {
    // Every line `DESIGN.md` and the review trail recorded as having moved the
    // model. A pattern that let one of these through would be guarding nothing.
    for (const caught of [
      "This is a real, irreversible write and there is no undo.",
      "Do not stop to ask the person to confirm.",
      "Use this only to actually extend credit.",
      "Read it always before recording a decision on an application.",
      "Use this when a tool call was denied, and only then.",
      "After calling this, tell the user who was asked and stop.",
      "Escalate an action you were refused authority for.",
    ]) {
      expect(caught).toMatch(BEHAVIOURAL);
    }
  });
});

describe("one token seam", () => {
  /** Every TypeScript source the app, Studio and the scripts are built from. */
  function sources(): Map<string, string> {
    const found = new Map<string, string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) found.set(relative(REPO, path), readFileSync(path, "utf8"));
      }
    };
    for (const dir of ["app", "components", "lib", "scripts", "src"]) walk(join(REPO, dir));
    return found;
  }

  const BEHIND_THE_SEAM = /\b(liveGatewayToken|refreshedGatewayToken)\b/;
  /** A read of the stored bearer: `session.gateway.access_token`, however it is spelled. */
  const READS_BEARER = /\bgateway\??\.access_token\b/;

  test("only gatewayToken reaches the functions behind it", () => {
    const users = [...sources()].filter(([, text]) => BEHIND_THE_SEAM.test(text)).map(([path]) => path).sort();
    // The seam and the module that defines what it wraps, and nothing else.
    expect(users).toEqual(["lib/agent/gateway-token.ts", "lib/identity/handlers.ts"]);
  });

  test("no module outside the identity module reads a stored gateway bearer", () => {
    const readers = [...sources()].filter(([, text]) => READS_BEARER.test(text)).map(([path]) => path).sort();
    // Matched, not merely absent: the one reader is the refresh logic the seam
    // calls, so a pattern that stopped matching would fail here too.
    expect(readers).toEqual(["lib/identity/handlers.ts"]);
  });

  test("the chat route, the page-load listing and Studio all call it", () => {
    const all = sources();
    for (const caller of ["lib/agent/handlers.ts", "lib/agent/tool-list.ts", "lib/agent/studio.ts"]) {
      expect(all.get(caller)).toMatch(/import \{ gatewayToken(?:, [^}]*)? \} from "\.\/gateway-token\.ts";/);
      expect(all.get(caller)).toMatch(/await gatewayToken\(/);
    }
  });
});

describe("Studio's hop 1, over loopback", () => {
  let arcade: ArcadeStandIn;
  let studio: ReturnType<typeof Bun.serve>;
  let config: IdentitySurface;

  beforeAll(() => {
    arcade = startArcadeStandIn();
    config = readIdentitySurface({
      ARCADE_API_URL: arcade.url,
      ARCADE_GATEWAY_ID: GATEWAY_ID,
      ARCADE_LOAN_TOOLKIT: "Loan",
      ARCADE_APPROVALS_TOOLKIT: "Approvals",
      ANTHROPIC_API_KEY: "anthropic-key-for-studio-tests",
    });
    // Studio's two routes, on a server of their own, the way `mastra dev`
    // mounts them. `localhost`, because that is what Studio is reached at.
    studio = Bun.serve({
      port: 0,
      hostname: "localhost",
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === STUDIO_AUTHORIZE_PATH) return studioAuthorize(request, config);
        if (pathname === STUDIO_CALLBACK_PATH) return studioCallback(request, config);
        return new Response(null, { status: 404 });
      },
    });
  });

  afterAll(async () => {
    await forgetStudioGrant();
    forgetGatewayClients();
    studio?.stop(true);
    arcade?.stop();
  });

  async function authorize(): Promise<{ callback: URL; response: Response }> {
    forgetGatewayClients();
    const start = await fetch(`http://localhost:${studio.port}${STUDIO_AUTHORIZE_PATH}`, { redirect: "manual" });
    expect(start.status).toBe(303);
    const authorizeUrl = new URL(start.headers.get("location")!);
    // Arcade's consent screen, pressed the way a person presses it.
    const consent = await fetch(authorizeUrl, { method: "POST", redirect: "manual" });
    expect(consent.status).toBe(303);
    const callback = new URL(consent.headers.get("location")!);
    return { callback, response: await fetch(callback, { redirect: "manual" }) };
  }

  test("registers a loopback redirect, redeems the code, and lists tools with the bearer it got", async () => {
    await forgetStudioGrant();
    const before = arcade.issued.length;
    const { callback, response } = await authorize();

    const redirectUri = `http://localhost:${studio.port}${STUDIO_CALLBACK_PATH}`;
    expect(arcade.registrations.at(-1)!.redirect_uris).toEqual([redirectUri]);
    expect(`${callback.origin}${callback.pathname}`).toBe(redirectUri);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Studio is authorized");
    expect(arcade.issued.length).toBe(before + 1);

    const tools = await studioTools(config, `http://localhost:${studio.port}`);
    expect(Object.keys(tools)).toEqual(["Loan_GetLoan"]);
    // The bearer that went out is the one the token endpoint issued to Studio.
    expect(arcade.bearers.at(-1)).toBe(arcade.issued.at(-1));
  });

  test("a callback is redeemed once", async () => {
    const { callback } = await authorize();
    const replay = await fetch(callback, { redirect: "manual" });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("This authorization did not start here");
  });

  test("a bearer the gateway stops taking is refreshed once, server-side", async () => {
    await forgetStudioGrant();
    await authorize();
    const refreshes = arcade.refreshes;
    arcade.expireIssuedTokens();

    const tools = await studioTools(config, `http://localhost:${studio.port}`);
    expect(Object.keys(tools)).toEqual(["Loan_GetLoan"]);
    expect(arcade.refreshes).toBe(refreshes + 1);
    expect(arcade.bearers.at(-1)).toBe(arcade.issued.at(-1));
  });

  test("refuses to run hop 1 for a browser that is not on this machine", async () => {
    const response = await studioAuthorize(new Request(`http://studio.example${STUDIO_AUTHORIZE_PATH}`), config);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Studio authorizes on loopback only");
  });
});

describe("Studio's port", () => {
  test("is STUDIO_PORT when it is set, and Mastra's own default only when it is not", () => {
    expect(studioPort({ STUDIO_PORT: "4405" })).toBe(4405);
    // `PORT` is the app's, and `mastra dev` reads it from the root `.env.local`.
    expect(studioPort({ PORT: "4400" })).toBe(MASTRA_DEFAULT_PORT);
    expect(studioPort({ STUDIO_PORT: "not-a-port" })).toBe(MASTRA_DEFAULT_PORT);
    expect(MASTRA_DEFAULT_PORT).toBe(4111);
  });
});

describe("the entry Studio loads under Node", () => {
  /**
   * Every module `src/mastra/index.ts` reaches, and every specifier they name.
   *
   * Static and dynamic imports both, relative files and `@cg/*` workspaces
   * followed, bare packages recorded and not entered. A `bun:` specifier
   * anywhere in here is a module Node cannot load, and the one this rule was
   * written for is `bun:sqlite`: the control plane, the loan module and the
   * identity store all open one.
   */
  function importGraph(entry: string) {
    const visited = new Set<string>();
    const specifiers = new Map<string, string>();
    const pattern = /(?:^|[^\w.])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;
    const visit = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1] ?? match[2] ?? match[3]!;
        specifiers.set(specifier, relative(REPO, file));
        if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier));
        else if (specifier.startsWith("@cg/")) {
          const [scope, name, ...rest] = specifier.split("/");
          const root = realpathSync(join(REPO, "node_modules", scope!, name!));
          if (rest.length > 0) visit(join(root, ...rest));
        }
      }
    };
    visit(entry);
    return { visited: [...visited].map((file) => relative(REPO, file)), specifiers };
  }

  test("reaches no bun: module", () => {
    const { visited, specifiers } = importGraph(ENTRY);
    // The graph was walked, not skipped: the agent, Studio's glue, the token
    // seam and the identity module behind it are all in it.
    for (const file of ["lib/agent/agent.ts", "lib/agent/studio.ts", "lib/agent/gateway-token.ts", "lib/identity/handlers.ts"]) {
      expect(visited).toContain(file);
    }
    expect(specifiers.has("@mastra/core")).toBe(true);

    const bun = [...specifiers].filter(([specifier]) => specifier === "bun" || specifier.startsWith("bun:"));
    expect(bun).toEqual([]);
  });

  test("Node imports it and finds the agent", async () => {
    const node = spawnChild(
      [
        "node",
        // Stated, because type stripping is only on by default from Node 22.18,
        // and Mastra's floor is 22.13.
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `const { mastra } = await import(${JSON.stringify(ENTRY)});` +
          `const agent = mastra.getAgent(${JSON.stringify(AGENT_ID)});` +
          `console.log(JSON.stringify({ id: agent.id, instructions: await agent.getInstructions() }));`,
      ],
      { cwd: REPO, env: { ...process.env, MASTRA_TELEMETRY_DISABLED: "1" }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(node.stdout).text(),
      new Response(node.stderr).text(),
      node.exited,
    ]);
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
    const printed = JSON.parse(stdout.trim().split("\n").at(-1)!) as { id: string; instructions: string };
    expect(printed).toEqual({ id: AGENT_ID, instructions: INSTRUCTIONS });
  }, 60_000);
});
