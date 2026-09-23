/**
 * The generated contract, checked against reality on two axes.
 *
 * 1. The committed file matches what the vendored spec generates. Without this,
 *    someone edits generated output by hand, it works, and the next regeneration
 *    silently reverts it.
 * 2. Payloads Arcade actually sent parse. The shapes below are the ones captured
 *    in `docs/spikes/evidence/02-remote-mcp-hooks-transcript.md`, with the
 *    toolkit and tool names replaced by neutral ones (`packages/` carries no
 *    business-domain vocabulary — see `src/domain.ts`). Everything structural is
 *    verbatim, including the parts that look like mistakes and are not.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { generate } from "../scripts/generate-hook-contract.ts";
import {
  AccessHookRequest,
  AccessHookResult,
  HOOK_CONTRACT_VERSION,
  HOOK_ENDPOINT_PATHS,
  PostHookRequest,
  PostHookResult,
  PreHookRequest,
  PreHookResult,
  ResponseCode,
} from "../src/generated/hook-contract.ts";

const PACKAGE_ROOT = join(import.meta.dir, "..");

describe("the committed file is generated, not edited", () => {
  it("matches what the vendored spec produces", () => {
    const spec = readFileSync(
      join(PACKAGE_ROOT, "vendor", "logic-extensions-http-1.0.schema.yaml"),
      "utf8",
    );
    const committed = readFileSync(
      join(PACKAGE_ROOT, "src", "generated", "hook-contract.ts"),
      "utf8",
    );
    expect(committed).toBe(generate(spec));
  });

  it("reports the upstream spec version it came from", () => {
    expect(HOOK_CONTRACT_VERSION).toBe("1.1.1-beta");
  });

  it("carries the default endpoint paths", () => {
    expect(HOOK_ENDPOINT_PATHS).toEqual({
      preHook: "/pre",
      postHook: "/post",
      accessHook: "/access",
      healthCheck: "/health",
    });
  });
});

describe("payloads captured from Arcade", () => {
  it("parses an /access request", () => {
    const captured = {
      toolkits: { Widgets: { tools: { get_widget: [{ version: "1.0.0" }] } } },
      user_id: "operator@example.com",
    };
    expect(AccessHookRequest.parse(captured)).toEqual(captured);
  });

  it("parses a /pre request", () => {
    // `authorization: [{}]` — a one-element array holding an empty object — is
    // what the engine sends for a tool with no auth requirement. Not a typo.
    const captured = {
      context: { authorization: [{}], user_id: "operator@example.com" },
      execution_id: "tc_3Imptd2CPi796zhzuH9rKQkZODJ",
      inputs: { note: "hello" },
      tool: { name: "get_widget", toolkit: "Widgets", version: "1.0.0" },
    };
    expect(PreHookRequest.parse(captured)).toEqual(captured);
  });

  it("parses a /post request", () => {
    const captured = {
      context: { authorization: [{}], user_id: "operator@example.com" },
      execution_id: "tc_3Imptd2CPi796zhzuH9rKQkZODJ",
      inputs: { note: "hello" },
      output: { echoed: "hello", marker: "REACHED_BACKEND" },
      success: true,
      tool: { name: "get_widget", toolkit: "Widgets", version: "1.0.0" },
    };
    expect(PostHookRequest.parse(captured)).toEqual(captured);
  });

  it("accepts a tool payload with no metadata", () => {
    // Spike 02 measured this: `tool.metadata` is never populated on a hook
    // payload — not for remote MCP tools, and not for hosted toolkits either.
    // A schema that required it would reject every real request.
    const parsed = PreHookRequest.parse({
      execution_id: "tc_1",
      tool: { name: "get_widget", toolkit: "Widgets", version: "1.0.0" },
      inputs: {},
      context: { user_id: "operator@example.com" },
    });
    expect(parsed.tool.metadata).toBeUndefined();
  });
});

describe("tolerance for a beta contract", () => {
  it("keeps a field the spec does not describe", () => {
    // The alternative is Zod 3's default, which strips it — so a field Arcade
    // adds vanishes between parse() and the audit log, invisibly.
    const parsed = PreHookRequest.parse({
      execution_id: "tc_1",
      tool: { name: "get_widget", toolkit: "Widgets", version: "1.0.0" },
      inputs: {},
      context: { user_id: "operator@example.com" },
      something_new: { added: "upstream" },
    });
    expect(parsed).toHaveProperty("something_new", { added: "upstream" });
  });

  it("still rejects a payload missing a required field", () => {
    expect(() =>
      PreHookRequest.parse({
        tool: { name: "get_widget", toolkit: "Widgets", version: "1.0.0" },
        inputs: {},
        context: {},
      }),
    ).toThrow();
  });

  it("rejects a response code outside the enum", () => {
    expect(ResponseCode.options).toEqual(["OK", "CHECK_FAILED", "RATE_LIMIT_EXCEEDED"]);
    expect(() => PreHookResult.parse({ code: "DENY" })).toThrow();
  });
});

describe("hook responses", () => {
  it("accepts a denial carrying the message the model will read", () => {
    const denial = PreHookResult.parse({
      code: "CHECK_FAILED",
      error_message: "Request approval before retrying.",
    });
    expect(denial.error_message).toBe("Request approval before retrying.");
  });

  it("accepts a /pre override of the inputs", () => {
    const result = PreHookResult.parse({
      code: "OK",
      override: { inputs: { quantity: 10 } },
    });
    expect(result.override?.inputs).toEqual({ quantity: 10 });
  });

  it("accepts a /post override of any JSON output type", () => {
    for (const output of [{ a: 1 }, ["a"], "text", 42, null]) {
      expect(PostHookResult.parse({ code: "OK", override: { output } })).toBeDefined();
    }
  });

  it("requires the deny list to nest all the way down to a version array", () => {
    // Spike 02: returning `{}` here failed every tool in the project with
    // `-32603 ... tool access policy service could not be reached`, which is
    // indistinguishable from the hook server being dead.
    const wellFormed = {
      deny: { Widgets: { tools: { update_widget: [{ version: "1.0.0" }] } } },
    };
    expect(AccessHookResult.parse(wellFormed)).toEqual(wellFormed);

    expect(() =>
      AccessHookResult.parse({ deny: { Widgets: { tools: { update_widget: {} } } } }),
    ).toThrow();
  });

  it("accepts an empty /access response, meaning no restriction", () => {
    expect(AccessHookResult.parse({})).toEqual({});
  });
});
