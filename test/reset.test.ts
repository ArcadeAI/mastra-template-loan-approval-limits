/**
 * `bun run reset` — the single command, end to end against the real app and
 * all three of its databases.
 *
 * The app booted the way a presenter runs it (`test/app.ts`), on a port the OS
 * handed out, with its own `governance.db`, `loans.db` and `idp.db` in a
 * temporary directory. Until #6 this was three services, each on its own port;
 * the identity provider was the last to fold in, and the command now resets
 * the three modules at one address. The command runs as a **subprocess**,
 * exactly as a presenter runs it between takes, and everything is then read
 * back over the modules' own HTTP surfaces. Nothing here opens a `.db` file: a
 * test that read the disk could pass against a module that never noticed the
 * rows moved.
 *
 * Since #123 the command has two scopes, and this file drives whichever one
 * the claim is about: `--hard` where the assertion is about all three
 * databases, and the bare command — which deliberately leaves `apps/idp`
 * alone — where it is about what a presenter runs between takes.
 * `test/reset-grants.test.ts` is where the difference between the two is the
 * subject rather than the setup.
 *
 * The three claims #23 is about, in the order they would go wrong:
 *
 *   1. one command, seconds, and afterwards LN-2291 is unapproved, the grants
 *      and approval requests and the audit log are empty, and the four policy
 *      tables are the fixture's;
 *   2. it is safe to run repeatedly — run it twice, assert identical state;
 *   3. the OAuth client Arcade holds does not move, and a run that could not
 *      prove that is a failure rather than a green tick.
 *
 * The loan module validates bearer tokens against an identity provider, and
 * the one it is pointed at here (`IDENTITY_HOST`) is a stand-in serving
 * `/oauth2/userinfo` and nothing else. The app's own provider has its own
 * reset to run, but joining the two would mean walking a whole authorize flow
 * to read one loan, which is `app-test/identity/flow.test.ts`'s job and
 * `test/reset-grants.test.ts`'s, not this file's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { join } from "node:path";

import { freePort, spawnChild } from "../app-test/child.ts";
import { bootApp, type App } from "./app.ts";

const ROOT = join(import.meta.dir, "..");
const RESET_TOKEN = "root-reset-token-for-tests";
const HOOK_SECRET = "root-reset-hook-secret-for-tests";
const DANA = "alice@example.test";
const OVER_LIMIT_LOAN = "LN-2291";

interface LoanBody {
  loan_id: string;
  status: string;
  decisions: unknown[];
}

interface HooksHealth {
  reset: string;
  counts: Record<string, number>;
  audit_rows: number;
  fixture_drift: unknown;
}

interface IdpHealth {
  reset: string;
  people: number;
  oauth: { client_id: string; clients: { key: string; client_id: string }[] };
}

interface LoanHealth {
  reset: string;
  loans: number;
}

let app: App;
let userinfo: Server<unknown>;

/** The three modules, each at its own paths on the one app. */
const hooks = { get baseUrl() { return app.origin; } };
const idp = { get baseUrl() { return `${app.origin}/identity`; } };
const loanApp = { get baseUrl() { return `${app.origin}/bank`; } };

/** The command, run the way a presenter runs it. */
async function runResetCommand(
  overrides: Record<string, string> = {},
  args: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const proc = spawnChild(["bun", join(ROOT, "scripts", "reset.ts"), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      RESET_TOKEN,
      APP_PUBLIC_HOST: app.host,
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/**
 * The three-database run. Everything below that reads `apps/idp` back goes
 * through this: the bare command leaves the IdP alone on purpose (#123), so
 * asserting an idp line against it would be asserting the wrong contract.
 */
const runHardReset = (overrides: Record<string, string> = {}, args: string[] = []) =>
  runResetCommand(overrides, ["--hard", ...args]);

const json = async <T>(url: string, init?: RequestInit): Promise<T> =>
  (await (await fetch(url, init)).json()) as T;

const hooksHealth = () => json<HooksHealth>(`${hooks.baseUrl}/hooks/health`);
const idpHealth = () => json<IdpHealth>(`${idp.baseUrl}/health`);
const loanHealth = () => json<LoanHealth>(`${loanApp.baseUrl}/health`);
const loan = (id: string) =>
  json<LoanBody>(`${loanApp.baseUrl}/loans/${id}`, {
    headers: { authorization: "Bearer tok-dana" },
  });

/** One `/pre` call, which is the cheapest honest way to put a row in the audit log. */
async function governedCall(executionId: string): Promise<Response> {
  return fetch(`${hooks.baseUrl}/hooks/pre`, {
    method: "POST",
    headers: { authorization: `Bearer ${HOOK_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({
      execution_id: executionId,
      tool: { name: "ApproveLoan", toolkit: "Loan", version: "1.0.0" },
      inputs: { loan_id: OVER_LIMIT_LOAN, amount: 95_000 },
      context: { authorization: [{}], user_id: DANA },
    }),
  });
}

/** Everything the reset is supposed to put back, read through HTTP. */
async function snapshot() {
  const [hooksBody, idpBody, loanBody, record, control] = await Promise.all([
    hooksHealth(),
    idpHealth(),
    loanHealth(),
    loan(OVER_LIMIT_LOAN),
    loan("LN-2299"),
  ]);
  return {
    counts: hooksBody.counts,
    audit_rows: hooksBody.audit_rows,
    fixture_drift: hooksBody.fixture_drift,
    people: idpBody.people,
    client_id: idpBody.oauth.client_id,
    loans: loanBody.loans,
    record,
    control,
  };
}

beforeAll(async () => {
  // The token endpoint the loan module reads the actor off. A complete double:
  // that one route is the whole of its view of identity.
  userinfo = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      if (pathname !== "/oauth2/userinfo") return new Response("Not found", { status: 404 });
      if (token !== "tok-dana") return new Response("invalid_token", { status: 401 });
      return Response.json({ sub: DANA, email: DANA, email_verified: true });
    },
  });

  app = await bootApp({
    RESET_TOKEN,
    ARCADE_HOOK_SIGNING_SECRET: HOOK_SECRET,
    PERSONA_LOAN_OFFICER_EMAIL: DANA,
    BETTER_AUTH_SECRET: "root-reset-test-secret-".padEnd(48, "x"),
    IDP_OAUTH_REDIRECT_URIS: "http://127.0.0.1:9/callback",
    IDENTITY_HOST: `127.0.0.1:${userinfo.port}`,
  });
}, 240_000);

afterAll(async () => {
  await app?.stop();
  userinfo?.stop(true);
});

describe("one command, three databases", () => {
  let seeded: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    // A clean baseline first, so "back to the seeded state" is compared
    // against a reading rather than against a constant this file made up.
    expect((await runHardReset()).code).toBe(0);
    seeded = await snapshot();
  });

  test("a take of the demo is undone", async () => {
    // Dirty all three: an approved loan, audit rows, and a session in the IdP.
    const approved = await fetch(`${loanApp.baseUrl}/loans/${OVER_LIMIT_LOAN}/approve`, {
      method: "POST",
      headers: { authorization: "Bearer tok-dana", "content-type": "application/json" },
      body: JSON.stringify({ amount: 95_000 }),
    });
    expect(approved.status).toBe(200);
    for (const n of [1, 2, 3]) expect((await governedCall(`tc_reset_${n}`)).status).toBe(200);

    const dirty = await snapshot();
    expect(dirty.record.status).toBe("approved");
    expect(dirty.audit_rows).toBeGreaterThan(seeded.audit_rows);

    const { code, out, err } = await runHardReset();
    expect(err).toBe("");
    expect(code).toBe(0);

    // One line per service, each naming what moved.
    expect(out).toMatch(/\[reset\] idp\s+OK\s+people \d+→\d+, OAuth client \S+ unchanged/);
    expect(out).toMatch(/\[reset\] hooks\s+OK\s+demo at revision \d+ .*audit_log \d+→0/);
    expect(out).toMatch(/\[reset\] loan-app\s+OK\s+loans \d+→\d+, decisions \d+→\d+/);

    const after = await snapshot();
    expect(after.record.status).toBe("pending");
    expect(after.record).toEqual(seeded.record);
    expect(after.audit_rows).toBe(0);
    expect(after.counts.grants).toBe(0);
    expect(after.counts.approval_requests).toBe(0);
    expect(after.counts.audit_log).toBe(0);
    // The policy is the fixture's, said by the service rather than counted here.
    expect(after.fixture_drift).toBeNull();
  });

  test("it is safe to run repeatedly — twice leaves identical state", async () => {
    expect((await runHardReset()).code).toBe(0);
    const once = await snapshot();

    expect((await runHardReset()).code).toBe(0);
    const twice = await snapshot();

    expect(twice).toEqual(once);
  });

  test("no orphaned grants or approval requests are left behind", async () => {
    await runResetCommand();
    const { counts } = await hooksHealth();
    expect(counts.grants).toBe(0);
    expect(counts.approval_requests).toBe(0);
    // And the four tables the demo runs on are populated, not merely empty —
    // a reset that truncated everything would satisfy the two lines above.
    expect(counts.subjects).toBeGreaterThan(0);
    expect(counts.policy_rules).toBeGreaterThan(0);
    expect(counts.output_rules).toBe(2);
  });

  test("the OAuth client Arcade is registered against never moves", async () => {
    const before = await idpHealth();
    await runHardReset();
    const after = await idpHealth();
    expect(after.oauth.client_id).toBe(before.oauth.client_id);
    expect(after.people).toBe(before.people);
  });

  test("it finishes in seconds, not minutes", async () => {
    const started = performance.now();
    expect((await runHardReset()).code).toBe(0);
    // Generous on purpose: the claim is "between takes", not a benchmark, and
    // a threshold tight enough to be interesting would be a flake on a loaded
    // CI box. What this catches is a reset that went back to waiting on a
    // deploy.
    expect(performance.now() - started).toBeLessThan(30_000);
  });

  test("every module reports that its reset route exists", async () => {
    const [hooksBody, idpBody, loanBody] = await Promise.all([
      hooksHealth(),
      idpHealth(),
      loanHealth(),
    ]);
    expect([hooksBody.reset, idpBody.reset, loanBody.reset]).toEqual([
      "enabled",
      "enabled",
      "enabled",
    ]);
  });
});

describe("when it cannot do its job it says so and exits non-zero", () => {
  test("a wrong RESET_TOKEN is a failure, not a quiet no-op", async () => {
    const { code, out } = await runResetCommand({ RESET_TOKEN: "not-the-token" });
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSED");
    expect(out).toContain("different RESET_TOKEN");
    expect(out).toContain("The demo is NOT in a known state");
  });

  test("an unset RESET_TOKEN names the variable and exits EX_CONFIG", async () => {
    const { code, err } = await runResetCommand({ RESET_TOKEN: "" });
    expect(code).toBe(78);
    expect(err).toContain("RESET_TOKEN is unset");
  });

  test("a bare service name is refused before anything is reset", async () => {
    const { code, err } = await runResetCommand({ APP_PUBLIC_HOST: "cg-hooks" });
    expect(code).toBe(78);
    expect(err).toContain("APP_PUBLIC_HOST=cg-hooks");
    expect(err).toContain("has no dot and is not loopback");
  });

  /**
   * Until #6 this was "an unreachable service is reported, and the others
   * still run", with one of three hosts pointed at a dead port. There is one
   * host now, so an unreachable app is every module unreachable at once; what
   * survives is the rest of the claim — every module is still attempted, and
   * each says so on its own line, so a presenter reads every problem in one
   * run rather than one per run.
   */
  test("an unreachable app is reported for every module, and the command still tries each", async () => {
    const dead = `127.0.0.1:${freePort()}`;
    const { code, out } = await runHardReset({ APP_PUBLIC_HOST: dead });
    expect(code).not.toBe(0);
    expect(out).toMatch(/\[reset\] idp\s+UNREACHABLE/);
    expect(out).toMatch(/\[reset\] hooks\s+UNREACHABLE/);
    expect(out).toMatch(/\[reset\] loan-app\s+UNREACHABLE/);
  });

  test("a misspelt --hard is refused rather than quietly read as a soft reset", async () => {
    const { code, err } = await runResetCommand({}, ["--hard-reset"]);
    expect(code).toBe(78);
    expect(err).toContain("--hard-reset is not an option");
    // The quiet reading is the dangerous one: a presenter who typed this
    // believes the IdP is clean and is about to demonstrate an auth flow
    // against grants that were never cleared.
    expect(err).toContain("#123");
  });

  /**
   * Until #11, `--target` chose between this checkout and the stage demo's
   * hosted deployment, and this test refused a value it did not know. The flag
   * is gone, and still refused, in either spelling: a presenter who typed it
   * expects some other environment to be reset, and quietly resetting this
   * checkout's app instead would be the half-reset believed clean.
   */
  test("--target is refused, and the refusal names the one address there is", async () => {
    for (const args of [["--target", "staging"], ["--target=local"]]) {
      const { code, out, err } = await runResetCommand({}, args);
      expect(code).toBe(78);
      expect(err).toContain("--target is not an option");
      expect(err).toContain("APP_PUBLIC_HOST");
      // Refused before anything ran, not after.
      expect(out).toBe("");
    }
  });
});
