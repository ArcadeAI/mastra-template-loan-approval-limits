/**
 * An identity provider that cannot boot fails closed (#6, criterion 5 and the
 * Q7 condition): in production with `BETTER_AUTH_SECRET` unset, the provider
 * refuses to boot, the app's `/health` names identity as failed, every
 * identity route answers 503, every browser reads as signed out, and the
 * decide action has nobody to decide as.
 *
 * Driven in a process of its own, twice, by `fails-closed.probe.ts`: the
 * provider is one per process and remembers a failed boot, so doing this in
 * the suite's process would read every browser as signed out for every file
 * after it. The second run is the control — the same environment with a
 * secret — so each assertion is shown to turn on the provider and on nothing
 * else.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "cg-fails-closed-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Everything a deployment needs except, in the `failed` run, the one secret. */
function environment(expect: "failed" | "ok"): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.startsWith("PERSONA_") &&
        !key.startsWith("IDP_") &&
        !key.endsWith("_PUBLIC_HOST") &&
        !key.endsWith("_DB_PATH") &&
        !["BETTER_AUTH_SECRET", "RESET_TOKEN", "IDENTITY_HOST", "CONTROL_PLANE_HOST", "GOVERNANCE_STREAM"].includes(key),
    ),
  ) as Record<string, string>;
  return {
    ...inherited,
    CG_PROBE_EXPECT: expect,
    NODE_ENV: "production",
    APP_PUBLIC_HOST: "localhost:3999",
    IDP_DB_PATH: join(scratch, `${expect}-idp.db`),
    GOVERNANCE_DB_PATH: ":memory:",
    LOANS_DB_PATH: ":memory:",
    ARCADE_HOOK_SIGNING_SECRET: "fails-closed-hook-secret",
    APPROVALS_STORE_TOKEN: "fails-closed-store-token",
    SESSION_SECRET: "3f9a1c7e5b2d84069a1fe73c05b8d42e6c917ab3fd50e28c47196baf3d0c5e81",
    IDP_CLIENT_ID: "client-c",
    IDP_CLIENT_SECRET: "client-c-secret",
    ARCADE_API_URL: "http://127.0.0.1:1",
    ARCADE_API_KEY: "fails-closed-arcade-key",
    ARCADE_GATEWAY_ID: "cg-demo-us",
    ANTHROPIC_API_KEY: "fails-closed-anthropic-key",
    GOVERNANCE_STREAM: "fixture",
    ...(expect === "ok" ? { BETTER_AUTH_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex") } : {}),
  };
}

async function probe(expect: "failed" | "ok"): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(["bun", "test", "./app-test/identity/fails-closed.probe.ts"], {
    cwd: REPO,
    env: environment(expect),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${out}\n${err}` };
}

describe("an identity provider that cannot boot fails closed", () => {
  test("with BETTER_AUTH_SECRET unset in production: refused, reported, 503, signed out, no decision", async () => {
    const { code, output } = await probe("failed");
    expect({ code, output }).toMatchObject({ code: 0 });
    expect(output).toContain(" 5 pass");
    expect(output).toContain(" 0 fail");
  }, 120_000);

  test("and the control, with a secret: booted, ok, answering, Charlie, past the session", async () => {
    const { code, output } = await probe("ok");
    expect({ code, output }).toMatchObject({ code: 0 });
    expect(output).toContain(" 5 pass");
    expect(output).toContain(" 0 fail");
  }, 120_000);
});
