/**
 * An identity provider that cannot boot fails closed (#6, criterion 5 and the
 * Q7 condition): in production with `BETTER_AUTH_SECRET` unset, the provider
 * refuses to boot, the app's `/health` names identity as failed, every
 * identity route answers 503, every browser reads as signed out, and the
 * decide action has nobody to decide as.
 *
 * Since #9, two more refusals take the same path. On a public host the
 * published development secret is refused whatever `NODE_ENV` says, and an
 * `idp.db` whose signing key the configured secret cannot open is refused at
 * boot, never re-keyed. Plain localhost with no secret still boots, which is
 * what keeps a fresh clone zero-config.
 *
 * Driven in a process of its own per world by `fails-closed.probe.ts`: the
 * provider is one per process and remembers a failed boot, so doing this in
 * the suite's process would read every browser as signed out for every file
 * after it. The controls are the same environments with the one thing fixed,
 * so each assertion is shown to turn on the provider and on nothing else.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openIdentityProvider } from "../../lib/identity/provider/server.ts";
import { readConfig } from "../../lib/identity/provider/config.ts";
import { spawnChild } from "../child.ts";
import { childEnv } from "../child-env.ts";

const REPO = join(import.meta.dir, "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "cg-fails-closed-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PUBLIC = "fails-closed.ngrok.app";
const randomSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

interface World {
  expect: "failed" | "ok";
  /** A phrase the refusal must contain, for a `failed` world. */
  reason?: string;
  NODE_ENV: string;
  APP_PUBLIC_HOST: string;
  /** Absent means unset. */
  BETTER_AUTH_SECRET?: string;
  IDP_DB_PATH?: string;
}

/** Everything a deployment needs; each world varies only the identity secret, the host and NODE_ENV. */
function environment(world: World, name: string): Record<string, string> {
  // An allowlist (`child-env.ts`): the variables this is about must not
  // arrive from the shell that runs the suite.
  return childEnv({
    CG_PROBE_EXPECT: world.expect,
    ...(world.reason ? { CG_PROBE_ERROR: world.reason } : {}),
    NODE_ENV: world.NODE_ENV,
    APP_PUBLIC_HOST: world.APP_PUBLIC_HOST,
    IDP_DB_PATH: world.IDP_DB_PATH ?? join(scratch, `${name}-idp.db`),
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
    ...(world.BETTER_AUTH_SECRET === undefined ? {} : { BETTER_AUTH_SECRET: world.BETTER_AUTH_SECRET }),
  });
}

async function probe(world: World, name: string): Promise<{ code: number; output: string }> {
  const child = spawnChild(["bun", "test", "./app-test/identity/fails-closed.probe.ts"], {
    cwd: REPO,
    env: environment(world, name),
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

async function passes(world: World, name: string): Promise<void> {
  const { code, output } = await probe(world, name);
  expect({ code, output }).toMatchObject({ code: 0 });
  expect(output).toContain(" 5 pass");
  expect(output).toContain(" 0 fail");
}

describe("an identity provider that cannot boot fails closed", () => {
  test("with BETTER_AUTH_SECRET unset in production: refused, reported, 503, signed out, no decision", async () => {
    await passes(
      { expect: "failed", reason: "BETTER_AUTH_SECRET is required in production", NODE_ENV: "production", APP_PUBLIC_HOST: "localhost:3999" },
      "production",
    );
  }, 120_000);

  test("with BETTER_AUTH_SECRET unset on a public host, in development: refused the published secret (#9)", async () => {
    await passes(
      {
        expect: "failed",
        reason: "the development secret is published in this repository",
        NODE_ENV: "development",
        APP_PUBLIC_HOST: PUBLIC,
      },
      "public-host",
    );
  }, 120_000);

  test("with an idp.db whose signing key the secret cannot open: refused at boot, and never re-keyed (#9)", async () => {
    // A signing key minted under one secret, the way a localhost run mints it
    // on its first `/jwks` or sign-in, then the app started under another.
    const dbPath = join(scratch, "stale-idp.db");
    const before = await openIdentityProvider(readConfig({ IDP_DB_PATH: dbPath, BETTER_AUTH_SECRET: randomSecret() }));
    expect((await before.fetch(new Request("http://localhost:3999/jwks"))).status).toBe(200);
    before.close();
    const keys = () => new Database(dbPath, { readonly: true }).query(`select id, privateKey from jwks`).all();
    const minted = keys();
    expect(minted).toHaveLength(1);

    await passes(
      {
        expect: "failed",
        reason: "holds an ID-token signing key encrypted under a different BETTER_AUTH_SECRET",
        NODE_ENV: "development",
        APP_PUBLIC_HOST: PUBLIC,
        BETTER_AUTH_SECRET: randomSecret(),
        IDP_DB_PATH: dbPath,
      },
      "stale",
    );
    // No replacement key was minted over the one it could not open.
    expect(keys()).toEqual(minted);
  }, 120_000);

  test("and the control, with a secret: booted, ok, answering, Charlie, past the session", async () => {
    await passes({ expect: "ok", NODE_ENV: "production", APP_PUBLIC_HOST: "localhost:3999", BETTER_AUTH_SECRET: randomSecret() }, "ok");
  }, 120_000);

  test("the control on a public host: with a secret it boots (#9)", async () => {
    await passes({ expect: "ok", NODE_ENV: "development", APP_PUBLIC_HOST: PUBLIC, BETTER_AUTH_SECRET: randomSecret() }, "public-ok");
  }, 120_000);

  test("plain localhost with no secret still boots on the development secret: a fresh clone stays zero-config (#9)", async () => {
    await passes({ expect: "ok", NODE_ENV: "development", APP_PUBLIC_HOST: "localhost:3999" }, "localhost-dev");
  }, 120_000);
});
