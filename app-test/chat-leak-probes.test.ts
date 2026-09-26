/**
 * #37 review round 1: the reviewer's two leak probes, kept as tests.
 *
 * Both put an app-held secret into a tool result where none of the old nets
 * looked, then read the stream the browser gets:
 *
 * 1. Under innocuous keys (`diagnostic_note`, `trace_id`), so the key-name net
 *    misses, and with no `Bearer ` or JWT shape, so the shape net misses. What
 *    is left is the known-value net, which only works if the withheld set holds
 *    every secret the app holds: the identity provider's signing secret, and
 *    every token in the sealed session, not only the bearer.
 * 2. Nested deeper than the old walk's cutoff of 32, at 33 and at 1000 levels.
 *
 * The turn is driven through the real `runTurn`, with the withheld set built
 * the way the chat route builds it (`turnSecrets`).
 */
import { describe, expect, test } from "bun:test";

import { turnSecrets } from "../lib/agent/handlers.ts";
import { sessionSecrets } from "../lib/identity/handlers.ts";
import { registerSecretFingerprint, secretFingerprints, sha256 } from "../lib/secret-fingerprints.ts";
import type { ChatEvent } from "../lib/agent/events.ts";
import { runTurn, type Streamable } from "../lib/agent/run.ts";
import { WITHHELD, withholdSecrets } from "../lib/agent/withhold.ts";
import { readIdentitySurface, readWebConfig } from "../lib/config.ts";
import { readConfig as readProviderConfig } from "../lib/identity/provider/config.ts";
import type { GatewayToken, IdpToken, Session } from "../lib/identity/session.ts";

const BEARER = "gw_5b0f4a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const REFRESH = "gw_refresh_9a8b7c6d5e4f3a2b1c0d";
const IDP_ACCESS = "idp_access_1f2e3d4c5b6a7980";
const IDP_REFRESH = "idp_refresh_0a1b2c3d4e5f6a7b";
const PROVIDER_SECRET = "provider-signing-secret-for-the-probe-7c1d9e";

const SESSION: Session = {
  email: "alice@bank.example",
  signed_in_at: Date.now(),
  gateway: { access_token: BEARER, refresh_token: REFRESH, expires_at: Date.now() + 3_600_000, client_id: "probe" },
  idp: { access_token: IDP_ACCESS, refresh_token: IDP_REFRESH, expires_at: Date.now() + 3_600_000 },
};

/** What the chat route would withhold on this turn. */
function withheldSet() {
  const env = { BETTER_AUTH_SECRET: PROVIDER_SECRET, APP_PUBLIC_HOST: "localhost:4580" };
  // The provider reads its own configuration at boot, which is where it
  // registers what the chat must withhold. Read here the way boot reads it.
  readProviderConfig(env);
  return turnSecrets(BEARER, readIdentitySurface({}), { env, session: SESSION });
}

async function resultOnTheWire(result: unknown): Promise<{ wire: string; events: ChatEvent[] }> {
  const agent: Streamable = {
    stream: async () => ({
      fullStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "tool-call", payload: { toolName: "Loan_GetLoan", args: { loan_id: "LN-2291" } } });
          controller.enqueue({ type: "tool-result", payload: { toolName: "Loan_GetLoan", result } });
          controller.close();
        },
      }),
    }),
  };
  const events: ChatEvent[] = [];
  await runTurn({ agent, prompt: "read", emit: (event) => void events.push(event), secrets: withheldSet() });
  return { wire: JSON.stringify(events), events };
}

function nested(depth: number, leaf: unknown): unknown {
  let node: unknown = leaf;
  for (let level = 0; level < depth; level += 1) node = { next: node };
  return node;
}

describe("probe 1: app-held secrets under innocuous keys", () => {
  test("the provider's signing secret, as a diagnostic note, is withheld", async () => {
    const { wire } = await resultOnTheWire({ loan_id: "LN-2291", diagnostic_note: `configured with ${PROVIDER_SECRET}` });
    expect(wire).not.toContain(PROVIDER_SECRET);
    expect(wire).toContain(`configured with ${WITHHELD}`);
  });

  test("every token in the sealed session, as trace ids, is withheld", async () => {
    const { wire } = await resultOnTheWire({
      loan_id: "LN-2291",
      trace_id: REFRESH,
      span_id: IDP_ACCESS,
      parent_id: IDP_REFRESH,
      request_id: BEARER,
    });
    for (const token of [REFRESH, IDP_ACCESS, IDP_REFRESH, BEARER]) expect(wire).not.toContain(token);
  });
});

describe("probe 2: a secret nested past any depth", () => {
  for (const depth of [33, 1000]) {
    test(`a known secret ${depth} levels deep is withheld, and the structure is kept`, async () => {
      // The bearer, which the old set did hold, so this isolates the depth.
      const { wire, events } = await resultOnTheWire(nested(depth, { trace_id: BEARER }));
      expect(wire).not.toContain(BEARER);
      let node = (events.find((event) => event.kind === "tool-result") as { result: unknown }).result;
      for (let level = 0; level < depth; level += 1) node = (node as { next: unknown }).next;
      expect(node).toEqual({ trace_id: WITHHELD });
    });
  }
});

// ---------------------------------------------------------------------------
// The withheld set is every secret the app holds, and a new one cannot be
// added without a test noticing.

/** Every field required, so a field added to the type fails the typecheck until it is filled here. */
type Every<T> = { [K in keyof T]-?: NonNullable<T[K]> };

describe("the withheld set covers every secret the app holds", () => {
  test("every token field of the sealed session is in it", () => {
    const gateway: Every<GatewayToken> = {
      access_token: "every-gateway-access-0001",
      refresh_token: "every-gateway-refresh-0002",
      expires_at: 1,
      client_id: "every-client-id",
    };
    const idp: Every<IdpToken> = {
      access_token: "every-idp-access-0003",
      refresh_token: "every-idp-refresh-0004",
      expires_at: 1,
    };
    const session: Every<Session> = {
      email: "alice@bank.example",
      signed_in_at: 1,
      gateway_rejected_at: 1,
      gateway,
      idp,
    };
    const tokens: string[] = [];
    const walk = (node: unknown) => {
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (/token/i.test(key) && typeof value === "string") tokens.push(value);
        walk(value);
      }
    };
    walk(session);
    // The premise: four tokens were found, so the check below is about something.
    expect(tokens.sort()).toEqual(
      ["every-gateway-access-0001", "every-gateway-refresh-0002", "every-idp-access-0003", "every-idp-refresh-0004"].sort(),
    );
    const held = turnSecrets("unrelated-bearer-0000", readIdentitySurface({}), { env: {}, session }).values;
    for (const token of tokens) expect({ token, held: held.includes(token) }).toEqual({ token, held: true });
    expect(sessionSecrets(session).sort()).toEqual(tokens.sort());
  });

  test("every secret-named field of the configuration is in it", () => {
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: "cfg-anthropic-key-0001",
      ARCADE_API_KEY: "cfg-arcade-key-0002",
      SESSION_SECRET: "cfg-session-secret-0003-0123456789abcdef",
      IDP_CLIENT_SECRET: "cfg-idp-client-secret-0004",
      APPROVALS_STORE_TOKEN: "cfg-store-token-0005",
      ARCADE_GATEWAY_ID: "cfg-gateway-id-not-a-secret",
    };
    const config = readWebConfig(env);
    const fields: Array<{ path: string; value: string }> = [];
    const walk = (node: unknown, path: string) => {
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (/(secret|token|key|password)$/i.test(key) && typeof value === "string" && value !== "") {
          fields.push({ path: `${path}.${key}`, value });
        }
        walk(value, `${path}.${key}`);
      }
    };
    walk(config, "config");
    expect(fields.map((field) => field.path).sort()).toEqual(
      [
        "config.agent.anthropicApiKey",
        "config.approvalsStoreToken",
        "config.arcadeApiKey",
        "config.identity.idpClientSecret",
        "config.identity.sessionSecret",
      ].sort(),
    );
    // The config the turn runs with, and an empty environment, so every value
    // held here came through `configSecrets` and not through `SECRET_ENV`.
    const held = turnSecrets("unrelated-bearer-0000", config, { env: {} }).values;
    for (const field of fields) expect({ ...field, held: held.includes(field.value) }).toEqual({ ...field, held: true });
    expect(held).not.toContain(env.ARCADE_GATEWAY_ID);
  });

  test("every secret-named variable in .env.example is withheld, the provider's by fingerprint", async () => {
    const example = await Bun.file(new URL("../.env.example", import.meta.url)).text();
    const names = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)]
      .map((match) => match[1] as string)
      .filter((name) => /(SECRET|TOKEN|KEY|PASSWORD)$/.test(name));
    // The premise, named: a sweep that found nothing would pass for nothing.
    expect(names).toContain("BETTER_AUTH_SECRET");
    expect(names).toContain("APPROVALS_STORE_TOKEN");
    expect(names).toContain("RESET_TOKEN");
    const env: Record<string, string> = { APP_PUBLIC_HOST: "localhost:4580" };
    for (const name of names) env[name] = `env-${name.toLowerCase()}-value-0123456789abcdef`;
    readProviderConfig(env);
    const set = turnSecrets("unrelated-bearer-0000", readIdentitySurface({}), { env });
    const probe = Object.fromEntries(names.map((name) => [`note_${name.toLowerCase()}`, `saw ${env[name]} here`]));
    const { value } = withholdSecrets(probe, set);
    for (const name of names) {
      expect({ name, shown: (value as Record<string, string>)[`note_${name.toLowerCase()}`] }).toEqual({
        name,
        shown: `saw ${WITHHELD} here`,
      });
    }
  });

  test("the fingerprint registry holds no raw secret", () => {
    const raw = "a-secret-that-must-not-be-stored-anywhere-9f2c";
    registerSecretFingerprint(raw);
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("cg.secret-fingerprints")];
    expect(registry).toBeInstanceOf(Map);
    const stored = JSON.stringify([...(registry as Map<string, unknown>).entries()]);
    expect(stored).toContain(sha256(raw));
    expect(stored).not.toContain(raw);
    expect(Bun.inspect(registry)).not.toContain(raw);
    expect(JSON.stringify(secretFingerprints())).not.toContain(raw);
    // And it still finds the secret it cannot see.
    expect(withholdSecrets({ note: `x${raw}y` }, { values: [], fingerprints: secretFingerprints() }).value).toEqual({
      note: `x${WITHHELD}y`,
    });
  });
});

describe("the walk has no cutoff and survives a cycle", () => {
  test("a value that refers to itself is copied with its shape and scanned once", () => {
    const cyclic: Record<string, unknown> = { trace_id: BEARER };
    cyclic.self = cyclic;
    const { value, withheld } = withholdSecrets(cyclic, { values: [BEARER], fingerprints: [] });
    const copy = value as Record<string, unknown>;
    expect(copy.trace_id).toBe(WITHHELD);
    expect(copy.self).toBe(copy);
    expect(withheld).toBe(1);
  });

  test("100,000 levels deep does not overflow the stack", () => {
    const { value } = withholdSecrets(nested(100_000, { trace_id: BEARER }), { values: [BEARER], fingerprints: [] });
    let node = value;
    for (let level = 0; level < 100_000; level += 1) node = (node as { next: unknown }).next;
    expect(node).toEqual({ trace_id: WITHHELD });
  });
});
