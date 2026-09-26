/**
 * `POST /admin/reset` (#23), over the wire against the service booted the way
 * a deployment boots it — `bun src/index.ts`, env only.
 *
 * `test/flow.test.ts` already proves the hard claim for the *script*: after
 * `scripts/reset.ts` the credentials Arcade holds still complete a whole
 * authorize → login → consent → token → userinfo pass. This file is about the
 * endpoint that `bun run reset` at the repo root actually calls, because a
 * presenter between takes has no shell on the service.
 *
 * What it has to hold, in the order it would go wrong:
 *
 *   1. the client id does not move — everything else is recoverable, and this
 *      one costs a re-registration in a dashboard and fails invisibly;
 *   2. the people are still there, and each signs in with their own password
 *      (#33: nobody is re-seeded, because there is no shipped password);
 *   3. running it twice leaves the same state;
 *   4. no bearer, no reset; no `RESET_TOKEN`, no route.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { serveOnFreePort } from "../cdp.ts";
import { spawnChild } from "../child.ts";
import { DEMO_PEOPLE, seedDemoIdentity } from "../demo-cast.ts";

const ROOT = join(import.meta.dir, "..", "..");
const RESET_TOKEN = "idp-reset-token-for-tests";
const SECRET = "test-secret-".padEnd(48, "x");
const REDIRECT_URI = "http://127.0.0.1:9/callback";

const people = DEMO_PEOPLE;
const dana = people.find((person) => person.key === "dana")!;

interface HealthBody {
  status: string;
  people: number;
  reset: string;
  oauth: { client_id: string; clients: { key: string; client_id: string }[] };
}

interface ResetBody {
  service: string;
  reset: string;
  people: { before: number; after: number };
  clients: { key: string; client_id: string }[];
  not_reset: Record<string, string>;
}

interface Instance {
  child: Subprocess;
  baseUrl: string;
  dbPath: string;
}

const started: Instance[] = [];

async function boot(overrides: Record<string, string>): Promise<Instance> {
  const dbPath = join(tmpdir(), `cg-idp-reset-${crypto.randomUUID()}`, "idp.db");
  const logPath = join(dirname(dbPath), "stdout.log");
  mkdirSync(dirname(dbPath), { recursive: true });
  // Nobody is seeded at first boot (#33): the demo cast is added the way
  // `bun run users seed-demo` adds it, before the provider opens the file.
  await seedDemoIdentity(dbPath);

  // Any PERSONA_* or IDP_* in the developer's shell is deliberately not passed
  // on, so this is about the fixture rather than about their environment.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !key.startsWith("PERSONA_") && !key.startsWith("IDP_"),
    ),
  ) as Record<string, string>;

  // On a port chosen inside `serveOnFreePort`, which starts the provider again
  // on a new one if another process took it first (#9).
  const booted = await serveOnFreePort(
    (port) =>
      spawnChild(["bun", join(ROOT, "scripts", "identity.ts")], {
        env: {
          ...inherited,
          PORT: String(port),
          IDP_DB_PATH: dbPath,
          APP_PUBLIC_HOST: `127.0.0.1:${port}`,
          IDP_OAUTH_REDIRECT_URIS: REDIRECT_URI,
          BETTER_AUTH_SECRET: SECRET,
          ...overrides,
        },
        stdout: Bun.file(logPath),
        stderr: "pipe",
      }),
    { ready: async (port) => (await fetch(`http://127.0.0.1:${port}/identity/health`)).ok, timeoutMs: 20_000 },
  ).catch((error: unknown) => {
    throw new Error(`idp did not come up:\n${(error as Error).message}`);
  });
  const child = booted.child;
  const baseUrl = `http://127.0.0.1:${booted.port}`;

  const instance = { child, baseUrl, dbPath };
  started.push(instance);
  return instance;
}

let live: Instance;

const health = async (base: string): Promise<HealthBody> =>
  (await (await fetch(`${base}/identity/health`)).json()) as HealthBody;

const reset = (base: string, token: string | null = RESET_TOKEN, method = "POST") =>
  fetch(`${base}/identity/admin/reset`, {
    method,
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

beforeAll(async () => {
  live = await boot({ RESET_TOKEN });
});

afterAll(() => {
  for (const instance of started) {
    instance.child.kill();
    rmSync(dirname(instance.dbPath), { recursive: true, force: true });
  }
});

describe("the reset the root command calls", () => {
  test("the OAuth client Arcade is registered against does not move", async () => {
    const before = await health(live.baseUrl);
    expect(before.oauth.client_id).toBeTruthy();

    const response = await reset(live.baseUrl);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ResetBody;

    // Three readings of the same id, and each catches a different way of being
    // wrong: the response's own claim, the service's `/health` after the fact,
    // and the value that was there before any of this ran.
    expect(body.clients.map((each) => each.client_id)).toEqual(
      before.oauth.clients.map((each) => each.client_id),
    );
    expect((await health(live.baseUrl)).oauth.client_id).toBe(before.oauth.client_id);
  });

  test("the people are all still there, and one of them can still sign in", async () => {
    const before = await health(live.baseUrl);
    expect(before.people).toBeGreaterThan(0);

    const body = (await (await reset(live.baseUrl)).json()) as ResetBody;
    expect(body.people.after).toBe(before.people);
    expect((await health(live.baseUrl)).people).toBe(before.people);

    // The rows are not just present, they are usable: a kept person's
    // password still authenticates. A reset that wrote unusable credential
    // rows would satisfy every count above and strand the demo at the login
    // page.
    const signIn = await fetch(`${live.baseUrl}/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: live.baseUrl },
      body: JSON.stringify({ email: dana.email, password: dana.password }),
    });
    expect(signIn.status).toBe(200);
  });

  // Changed by #33: this held all four personas to one shipped password after
  // a reset. There is none any more; each person keeps the password they were
  // given, and a reset does not replace it with anything.
  test("after a reset every person signs in with the password they already had, and no other", async () => {
    const response = await reset(live.baseUrl);
    expect(response.status).toBe(200);

    for (const person of people) {
      const signIn = await fetch(`${live.baseUrl}/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: live.baseUrl },
        body: JSON.stringify({ email: person.email, password: person.password }),
      });
      expect(signIn.status).toBe(200);

      const wrong = await fetch(`${live.baseUrl}/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: live.baseUrl },
        body: JSON.stringify({ email: person.email, password: `${person.key}-demo-2026` }),
      });
      expect(wrong.status).toBe(401);
    }
  });

  test("running it twice leaves the same state", async () => {
    await reset(live.baseUrl);
    const once = await health(live.baseUrl);

    const second = (await (await reset(live.baseUrl)).json()) as ResetBody;
    const twice = await health(live.baseUrl);

    expect(second.people.before).toBe(second.people.after);
    expect(twice.people).toBe(once.people);
    expect(twice.oauth.client_id).toBe(once.oauth.client_id);
  });

  // Changed by #33: the response split the demo cast (re-seeded) from the
  // users `bun run users` added (kept). Nobody is re-seeded now, so everybody
  // is kept, and identity has no notion of a demo cast to split them by.
  test("the response names everybody it kept, and that everyone was signed out (#32, #33)", async () => {
    const body = (await (await reset(live.baseUrl)).json()) as ResetBody & {
      demo_cast?: string[];
      kept: string[];
      signed_out: string;
    };
    expect(body.kept).toEqual(people.map((person) => person.email).sort());
    expect(body.demo_cast).toBeUndefined();
    expect(body.signed_out).toBe("everyone");
  });

  test("the response names what it did not touch, the client row first", async () => {
    const body = (await (await reset(live.baseUrl)).json()) as ResetBody;
    expect(body.reset).toBe("idp.db");
    expect(Object.keys(body.not_reset)).toContain("oauthClient");
    expect(Object.keys(body.not_reset)).toContain("jwks");
  });
});

describe("the bearer", () => {
  test("no token is 401 and nothing is reset", async () => {
    const before = await health(live.baseUrl);
    expect((await reset(live.baseUrl, null)).status).toBe(401);
    expect((await health(live.baseUrl)).people).toBe(before.people);
  });

  test("the wrong token is 401", async () => {
    expect((await reset(live.baseUrl, "not-the-token")).status).toBe(401);
  });

  test("a GET is refused even with the right token", async () => {
    expect((await reset(live.baseUrl, RESET_TOKEN, "GET")).status).toBe(405);
  });

  test("/health says the route is there", async () => {
    expect((await health(live.baseUrl)).reset).toBe("enabled");
  });
});

describe("unset RESET_TOKEN takes the route away", () => {
  let bare: Instance;

  beforeAll(async () => {
    bare = await boot({ RESET_TOKEN: "" });
  });

  test("the route answers 404, exactly as an unknown path does", async () => {
    expect((await reset(bare.baseUrl)).status).toBe(404);
  });

  test("/health explains the 404", async () => {
    const body = await health(bare.baseUrl);
    expect(body.status).toBe("ok");
    expect(body.reset).toBe("disabled");
  });
});
