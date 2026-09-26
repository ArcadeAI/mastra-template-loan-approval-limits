/**
 * The environment this service reads, and the one literal it duplicates.
 *
 * `apps/web` does not depend on `apps/hooks` in the package graph — one is the
 * governed UI, the other is the thing governing it, and an import edge between
 * them would be the wrong shape whatever it carried. So the development
 * fallback for `APPROVALS_STORE_TOKEN` is written out in both places, and this
 * test is what keeps the copies honest: it reads the control plane's source and
 * fails if the two ever disagree.
 *
 * Without the fallback a clean checkout renders the approval page as "nothing
 * to decide" — the store answers `401`, and nothing on screen says the cause is
 * an unset variable. With it and a drift that nobody noticed, the same thing
 * happens and the test that should have caught it does not exist.
 *
 * The drift that actually happened, on round 3 of #52, was not in the literal
 * but in the *guard around it*: `apps/hooks` refused to boot in production
 * without a real token and `apps/web` quietly used the published fallback. So
 * this file now pins both — the value and the check — on both sides.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { baseUrl, readIdentitySurface, readWebConfig } from "../lib/config.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const GUARD = 'if (!storeToken && env.NODE_ENV === "production") {\n' +
  '    throw new Error("APPROVALS_STORE_TOKEN is required in production");';

const sourceOf = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

describe("the approvals store token", () => {
  test("falls back to the same development value apps/hooks falls back to", () => {
    const token = readWebConfig({}).approvalsStoreToken;

    expect(token).not.toBe("");
    expect(sourceOf("lib", "control-plane", "config.ts")).toContain(
      `const DEV_STORE_TOKEN = "${token}"`,
    );
  });

  test("a value in the environment wins, and is trimmed", () => {
    expect(readWebConfig({ APPROVALS_STORE_TOKEN: "  real-token " }).approvalsStoreToken).toBe(
      "real-token",
    );
  });

  test("outside production, an unset variable takes the development fallback", () => {
    // The whole point of the fallback: a clean checkout runs the approval page
    // with no configuration at all.
    for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }]) {
      expect(readWebConfig(env).approvalsStoreToken).toBe(
        "cg-approvals-store-dev-token-not-for-production",
      );
    }
  });

  test("in production, an unset variable is refused rather than defaulted", () => {
    // Round 3 of #52. The fallback is published in the source, so a production
    // service using it would be authenticating to the approvals store with a
    // token anyone can read — quietly, because the fallback works locally.
    expect(() => readWebConfig({ NODE_ENV: "production" })).toThrow(
      "APPROVALS_STORE_TOKEN is required in production",
    );
    // Whitespace is not a token either.
    expect(() => readWebConfig({ NODE_ENV: "production", APPROVALS_STORE_TOKEN: "   " })).toThrow(
      "APPROVALS_STORE_TOKEN is required in production",
    );
  });

  test("in production with a real one, it is read and nothing throws", () => {
    const config = readWebConfig({
      NODE_ENV: "production",
      APPROVALS_STORE_TOKEN: "a-real-production-token",
    });
    expect(config.approvalsStoreToken).toBe("a-real-production-token");
    expect(config.approvalsStoreToken).not.toBe(
      "cg-approvals-store-dev-token-not-for-production",
    );
  });
});

describe("both services guard production the same way", () => {
  test("the guard is byte-for-byte the same in apps/web and apps/hooks", () => {
    // Two copies of one rule, so the drift this test exists to prevent is not
    // just the literal token but the check around it. Round 3 of #52 was
    // exactly this drift: the literal matched and the guard did not exist on
    // one side, so the credential-presenting service silently used a published
    // value in production while the control plane refused to boot on it.
    for (const source of [
      sourceOf("lib", "config.ts"),
      sourceOf("lib", "control-plane", "config.ts"),
    ]) {
      expect(source).toContain(GUARD);
    }
  });

  test("the stand-in's copies of both development bearers match the control plane's", () => {
    // `scripts/arcade-stand-in.ts` calls /pre and the approvals store, so it
    // carries both development literals for the zero-configuration local run.
    // Three copies of two strings is drift waiting to happen, and a stand-in
    // whose hook bearer had drifted would fail with a 401 that looks like a
    // governance decision and is not one.
    const hooks = sourceOf("lib", "control-plane", "config.ts");
    const standIn = sourceOf("scripts", "arcade-stand-in.ts");

    for (const literal of ["DEV_SECRET", "DEV_STORE_TOKEN"] as const) {
      const value = new RegExp(`const ${literal} = "([^"]+)"`).exec(hooks)?.[1];
      expect(value, `apps/hooks defines ${literal}`).toBeString();
      expect(standIn).toContain(`"${value as string}"`);
    }
  });

  test("apps/hooks refuses to boot in production without a real one", () => {
    expect(sourceOf("lib", "control-plane", "config.ts")).toContain(
      "APPROVALS_STORE_TOKEN is required in production",
    );
  });

  test("every image CI boots under NODE_ENV=production is handed a token", () => {
    // Which means the image smokes have to supply one, or the container exits
    // before /health and the job fails. That is what happened to `build hooks
    // image` on round 2, and it is why `build web image` is given one too.
    //
    // Since #4 there is no hooks image: the control plane ships in the web
    // one, so that one smoke is handed both bearers. It was `hooks` and `web`,
    // one store token each, until then.
    const workflow = sourceOf(".github", "workflows", "ci.yml");
    const web = workflow.slice(workflow.indexOf("- service: web"));
    expect(workflow).toContain("- service: web");
    expect(workflow).not.toContain("- service: hooks");
    expect(web).toMatch(/smoke_env:[\s\S]*?-e ARCADE_HOOK_SIGNING_SECRET=[\s\S]*?-e APPROVALS_STORE_TOKEN=/);
  });
});

describe("addresses", () => {
  test("are host-form, and the consumer adds the scheme", () => {
    // Every address in this repo is host-form, set by hand on the deployment
    // with no scheme, and this function is the one place that picks http or
    // https.
    expect(baseUrl("localhost:4400")).toBe("http://localhost:4400");
    expect(baseUrl("127.0.0.1:4400")).toBe("http://127.0.0.1:4400");
    expect(baseUrl("cg-hooks-sa31.example.com")).toBe("https://cg-hooks-sa31.example.com");
  });

  test("a trailing slash on the Arcade URL does not become a double slash", () => {
    expect(readWebConfig({ ARCADE_API_URL: "https://api.arcade.dev/" }).arcadeApiUrl).toBe(
      "https://api.arcade.dev",
    );
  });
});

// #33: the `PERSONA_*_EMAIL` contract is gone. The web surface reads no persona
// variable, so a leftover one in somebody's `.env` changes nothing and refuses
// nothing — people are added with `bun run users`.
describe("no persona email configuration (#33)", () => {
  test("a persona variable, current or deprecated or misspelt, is neither read nor refused", () => {
    const plain = readWebConfig({});
    for (const extra of [
      { PERSONA_LOAN_OFFICER_EMAIL: "alice@example.com" },
      { PERSONA_DANA_EMAIL: "dana@example.com" },
      { PERSONA_VP_CREDIT_EMAL: "charlie@example.com" },
    ]) {
      expect(readWebConfig(extra)).toEqual(plain);
      expect(() => readIdentitySurface(extra)).not.toThrow();
    }
  });
});
