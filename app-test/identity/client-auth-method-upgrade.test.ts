/**
 * The #61 upgrade on a disk that already exists.
 *
 * `idp.db` lives on a persistent disk, so the live `cg-idp` OAuth client row was
 * written by an earlier build with `tokenEndpointAuthMethod:
 * "client_secret_post"`. Changing the constant in `src/client.ts` moves what a
 * *new* client would be created with and nothing else — the live row would keep
 * the old value forever, the token exchange would keep failing server to
 * server, no hook would fire, and the panel would stay dark. Exactly the shape
 * of silent nothing this project keeps out of its controls.
 *
 * So `ensureOAuthClient` reconciles the method on an existing row the way it
 * already reconciles the redirect URIs, and this file is the measurement: an
 * `idp.db` holding a `client_secret_post` row, a boot, and the **same client id
 * and the same secret** answering to HTTP Basic afterwards. No rotation: the
 * credentials in the Arcade dashboard must survive this.
 *
 * The service is booted the way a deployment boots it, twice, over real HTTP.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { serveOnFreePort } from "../cdp.ts";
import { spawnChild } from "../child.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dbPath = join(tmpdir(), `cg-idp-auth-method-${crypto.randomUUID()}`, "idp.db");
const REDIRECT_URI = "http://127.0.0.1:9/callback";
const SECRET = "test-secret-".padEnd(48, "x");

/** What `/health` says about the client. The two fields this file is about. */
interface Health {
  oauth: {
    client_id: string;
    token_endpoint_auth_method: string;
    client_secret_state: string;
  };
}

/** The stored row, read straight out of SQLite — the thing the boot has to change. */
interface Row {
  clientId: string;
  clientSecret: string;
  tokenEndpointAuthMethod: string | null;
  redirectUris: string;
}

let env: Record<string, string>;
let running: Subprocess | null = null;

function baseEnv(port: number): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("IDP_"),
    ),
  ) as Record<string, string>;

  return {
    ...inherited,
    PORT: String(port),
    IDP_DB_PATH: dbPath,
    APP_PUBLIC_HOST: new URL(`http://127.0.0.1:${port}`).host,
    IDP_OAUTH_REDIRECT_URIS: REDIRECT_URI,
    BETTER_AUTH_SECRET: SECRET,
  };
}

/**
 * Boots the service on its own free port and returns its base URL plus
 * everything it wrote to stderr once it is up. Stderr, because the line that
 * announces a reconciled auth method goes there on purpose: it costs a human a
 * field in the Arcade dashboard, and the deploy log should surface it without
 * anyone knowing to look.
 */
async function boot(): Promise<{ baseUrl: string; stderr: () => Promise<string> }> {
  // On a port chosen inside `serveOnFreePort`, which starts the service again
  // on a new one if another process took it first (#9). stdout is not piped,
  // so what `serveOnFreePort` captures is stderr alone.
  const booted = await serveOnFreePort(
    (port) => {
      env = baseEnv(port);
      return spawnChild(["bun", join(ROOT, "scripts", "identity.ts")], {
        env,
        stdout: "ignore",
        stderr: "pipe",
      });
    },
    { ready: async (port) => (await fetch(`http://127.0.0.1:${port}/identity/health`)).ok, timeoutMs: 20_000 },
  ).catch((error: unknown) => {
    throw new Error(`idp did not come up:\n${(error as Error).message}`);
  });
  const { child } = booted;
  const baseUrl = `http://127.0.0.1:${booted.port}`;
  running = child;

  let captured: string | null = null;
  return {
    baseUrl,
    stderr: async () => {
      // Read once, after the child is killed: that is what ends the stream.
      if (captured === null) {
        child.kill();
        await child.exited;
        // Give the pipe a moment to deliver the child's last words.
        await Bun.sleep(50);
        captured = booted.output();
        if (running === child) running = null;
      }
      return captured;
    },
  };
}

function stop() {
  running?.kill();
  running = null;
}

/** The one client row, as SQLite holds it. */
function readRow(): Row {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query('select * from "oauthClient" where "id" = ?').get("arcade") as Row;
  } finally {
    db.close();
  }
}

function writeAuthMethod(method: string) {
  const db = new Database(dbPath);
  try {
    db.run('update "oauthClient" set "tokenEndpointAuthMethod" = ? where "id" = ?', [method, "arcade"]);
  } finally {
    db.close();
  }
}

async function health(baseUrl: string): Promise<Health> {
  return (await (await fetch(`${baseUrl}/identity/health`)).json()) as Health;
}

/** `Authorization: Basic base64(client_id:client_secret)`, RFC 6749 §2.3.1. */
function basicAuth(clientId: string, clientSecret: string): string {
  const half = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
  return `Basic ${Buffer.from(`${half(clientId)}:${half(clientSecret)}`).toString("base64")}`;
}

/**
 * Does the token endpoint accept these credentials, sent this way?
 *
 * Asked at `/oauth2/introspect` rather than `/oauth2/token`, deliberately.
 * Introspection authenticates the client **before** it looks at the token
 * (`introspect-njKASm3q.mjs:2505..2515`), whereas the authorization_code grant
 * consumes the code first — so a token request with a placeholder code answers
 * `invalid_grant` without ever reaching the client checks, and would pass this
 * assertion whatever the secret was. Same `validateClientCredentials`, same
 * registered-method rule, no authorization flow to walk.
 */
async function clientAuthAccepted(
  baseUrl: string,
  init: { headers?: Record<string, string>; form: Record<string, string> },
): Promise<{ status: number; error?: string; error_description?: string }> {
  const response = await fetch(`${baseUrl}/oauth2/introspect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...init.headers },
    body: new URLSearchParams({ token: "not-a-real-token", ...init.form }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    error_description?: string;
  };
  return { status: response.status, ...body };
}

/** The secret the "existing Arcade registration" holds, minted on the first boot. */
let registeredSecret: string;
let firstBootRow: Row;

beforeAll(async () => {
  mkdirSync(dirname(dbPath), { recursive: true });

  // Boot once to create the disk and the client, then rotate for a readable
  // secret — the operational path a human takes on a fresh deploy (#70).
  const first = await boot();
  const rotate = spawnChild(["bun", join(ROOT, "scripts", "identity", "oauth-client.ts"), "--json", "--rotate"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(rotate.stdout).text(), rotate.exited]);
  expect(code).toBe(0);
  registeredSecret = (JSON.parse(out) as { client_secret: string }).client_secret;
  expect(registeredSecret).toBeTruthy();

  await first.stderr();
  stop();

  // Now make it a pre-#61 disk: the row the live cg-idp service has been
  // running with since #13.
  writeAuthMethod("client_secret_post");
  firstBootRow = readRow();
  expect(firstBootRow.tokenEndpointAuthMethod).toBe("client_secret_post");
});

afterAll(() => {
  stop();
  rmSync(dirname(dbPath), { recursive: true, force: true });
});

describe("booting on a disk whose client is registered client_secret_post", () => {
  test("the row is reconciled in place, and the credentials are untouched", async () => {
    const second = await boot();
    const after = readRow();

    expect(after.tokenEndpointAuthMethod).toBe("client_secret_basic");
    // The two halves of the Arcade registration. A rotation here is the
    // failure this reconcile exists to avoid.
    expect(after.clientId).toBe(firstBootRow.clientId);
    expect(after.clientSecret).toBe(firstBootRow.clientSecret);
    // And the other thing `ensureOAuthClient` reconciles still survives the
    // shared update.
    expect(after.redirectUris).toBe(firstBootRow.redirectUris);

    const reported = await health(second.baseUrl);
    expect(reported.oauth.client_id).toBe(firstBootRow.clientId);
    expect(reported.oauth.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(reported.oauth.client_secret_state).toBe("unchanged");

    // The secret Arcade already holds now authenticates over HTTP Basic.
    const accepted = await clientAuthAccepted(second.baseUrl, {
      headers: { authorization: basicAuth(firstBootRow.clientId, registeredSecret) },
      form: {},
    });
    expect(accepted.status).toBe(200);
    expect(accepted.error).toBeUndefined();

    // And the form it used to be registered for no longer does — which is what
    // makes the reconcile a change rather than a no-op.
    const refused = await clientAuthAccepted(second.baseUrl, {
      form: { client_id: firstBootRow.clientId, client_secret: registeredSecret },
    });
    expect(refused.error).toBe("invalid_client");
    expect(refused.error_description).toBe(
      "client registered for client_secret_basic cannot use client_secret_post",
    );

    // Said out loud, on stderr, because it is the moment the Arcade dashboard
    // field stops matching what this service accepts.
    const stderr = await second.stderr();
    expect(stderr).toContain("token auth method reconciled to client_secret_basic");
    expect(stderr).toContain("app-identity");
    expect(stderr).not.toContain(registeredSecret);
  });

  test("a second boot on the reconciled disk says nothing, because nothing changed", async () => {
    const third = await boot();

    expect((await health(third.baseUrl)).oauth.token_endpoint_auth_method).toBe("client_secret_basic");

    // The line is about a change. Printing it on every boot would make it
    // noise, and the next real one would be read as noise too.
    const stderr = await third.stderr();
    expect(stderr).not.toContain("token auth method reconciled");
  });
});
