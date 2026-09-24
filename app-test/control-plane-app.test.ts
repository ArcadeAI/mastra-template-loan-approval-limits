/**
 * The control plane, served by the app (#4): the real Next server, booted the
 * way `bun run dev` boots it, driven over HTTP on the app's own port.
 *
 * Everything under `app-test/control-plane/` drives the module on a socket of
 * its own (`createServer`, `scripts/control-plane.ts`), which is fast and is
 * where the behaviour is pinned. What those tests cannot see is the fold
 * itself: that `app/pre/route.ts` and its siblings reach that module at the
 * paths Arcade is registered against, that `/pre` and `/events` in one app
 * share one event bus, that `/health` is one response, and that the app runs
 * on a runtime that can open `bun:sqlite` at all. Each of those failed, or
 * would have, without a crash anywhere a unit test looks: under Node the route
 * answers 500, and two module instances would record a decision the panel
 * never sees.
 *
 * Its own `distDir` under `.next/` (gitignored), because Next allows one
 * `next dev` per build directory and a developer may have one running here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { HealthResponse } from "@cg/policy-schema";

import { serveOnFreePort, stopProcess, type Booted } from "./cdp.ts";
import { spawnChild } from "./child.ts";
import { loanFixture } from "./control-plane/loan-fixture.ts";
import { openEventStream } from "./control-plane/sse-reader.ts";

const ROOT = join(import.meta.dir, "..");
/** The development values the control plane and the web both fall back to. */
const HOOK_SECRET = "cg-hooks-dev-secret-not-for-production";
const STORE_TOKEN = "cg-approvals-store-dev-token-not-for-production";
const ALICE = "alice@bank.example";
const BOOT_MS = 120_000;

interface App {
  origin: string;
  child: Subprocess;
  output: () => string;
  cleanup: () => void;
}

async function bootApp(env: Record<string, string> = {}): Promise<App> {
  const data = mkdtempSync(join(tmpdir(), "cg-app-control-plane-"));
  const distDirs: string[] = [];
  const cleanup = () => {
    rmSync(data, { recursive: true, force: true });
    for (const distDir of distDirs) rmSync(join(ROOT, distDir), { recursive: true, force: true });
  };
  // The port is chosen inside `serveOnFreePort`, which starts the app again on
  // a new one if another process took it first (#9); each attempt gets its own
  // databases and `distDir`.
  let booted: Booted;
  try {
    booted = await serveOnFreePort(
      (port) => {
        const dir = join(data, String(port));
        mkdirSync(dir);
        const distDir = `.next/cg-test-${port}`;
        distDirs.push(distDir);
        return spawnChild(["bun", "scripts/next.ts", "dev"], {
          cwd: ROOT,
          env: {
            ...(process.env as Record<string, string>),
            PORT: String(port),
            CG_NEXT_DIST_DIR: distDir,
            GOVERNANCE_DB_PATH: join(dir, "governance.db"),
            // The app holds the loan book too since #5; this one's, not a loans.db
            // in the repo.
            LOANS_DB_PATH: join(dir, "loans.db"),
            // And the identity provider since #6: not a `./idp.db` in the repo.
            IDP_DB_PATH: join(dir, "idp.db"),
            APP_PUBLIC_HOST: `127.0.0.1:${port}`,
            GOVERNANCE_STREAM: "hooks",
            NEXT_TELEMETRY_DISABLED: "1",
            ...env,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
      },
      { url: (port) => `http://127.0.0.1:${port}/health`, timeoutMs: BOOT_MS },
    );
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    origin: `http://127.0.0.1:${booted.port}`,
    child: booted.child,
    output: booted.output,
    cleanup,
  };
}

async function stopApp(app: App | undefined): Promise<void> {
  if (app === undefined) return;
  await stopProcess(app.child);
  app.cleanup();
}

const hook = (app: App, path: string, body: unknown, token: string | null = HOOK_SECRET) =>
  fetch(`${app.origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

const approveLoan = (amount: number, execution_id: string) => ({
  execution_id,
  tool: { name: "ApproveLoan", toolkit: "Loan", version: "1.0.0" },
  inputs: { loan_id: "LN-2299", amount },
  context: { authorization: [{}], user_id: ALICE },
});

describe("the control plane, on the app's own port", () => {
  let app: App | undefined;

  beforeAll(async () => {
    app = await bootApp();
  }, BOOT_MS);

  afterAll(async () => {
    await stopApp(app);
  });

  test("/pre refuses Alice's $95K on LN-2299 with the remediation, and lets $50K through", async () => {
    const refused = await hook(app!, "/hooks/pre", approveLoan(95_000, "tc_app_95k"));
    expect(refused.status).toBe(200);
    const body = (await refused.json()) as { code: string; error_message: string };
    expect(body.code).toBe("CHECK_FAILED");
    expect(body.error_message).toContain("exceeds your approval authority of 50000");
    expect(body.error_message).toContain("call Approvals_RequestApproval");
    expect(body.error_message).toMatch(/\[ref evt_[0-9a-z]{10}\]$/);

    for (const amount of [50_000, 45_000]) {
      const allowed = await hook(app!, "/hooks/pre", approveLoan(amount, `tc_app_${amount}`));
      expect(await allowed.json()).toEqual({ code: "OK" });
    }
  }, 60_000);

  test("routing the escalation names Charlie, and not Michael, on the audit row", async () => {
    const response = await hook(app!, "/hooks/pre", {
      execution_id: "tc_app_route",
      tool: { name: "RequestApproval", toolkit: "Approvals", version: "1.0.0" },
      inputs: { action: "approve_loan", resource_id: "LN-2299", amount: 95_000, justification: "cash flow" },
      context: { authorization: [{}], user_id: ALICE },
    });
    expect(await response.json()).toEqual({ code: "OK" });

    const audit = await fetch(`${app!.origin}/hooks/audit?limit=1`, {
      headers: { authorization: `Bearer ${HOOK_SECRET}` },
    });
    const { rows } = (await audit.json()) as { rows: Array<{ execution_id: string; reason: string }> };
    expect(rows[0]?.execution_id).toBe("tc_app_route");
    expect(rows[0]?.reason).toContain("Routing 95000 from Alice to Charlie (clearance 250000)");
    expect(rows[0]?.reason).toContain("also sufficient and not asked: Michael (5000000)");
  }, 60_000);

  test.each(["GetLoan", "ApproveLoan", "DenyLoan"])(
    "/post redacts the account number and tax id from %s's record",
    async (name) => {
      const loan = loanFixture("LN-2291");
      const response = await hook(app!, "/hooks/post", {
        execution_id: `tc_app_post_${name}`,
        tool: { name, toolkit: "Loan", version: "1.0.0" },
        inputs: { loan_id: "LN-2291" },
        success: true,
        output: loan,
        context: { user_id: ALICE },
      });
      const body = (await response.json()) as { code: string; override?: { output: Record<string, unknown> } };
      expect(body.code).toBe("OK");
      expect(body.override?.output.bank_account_number).toBe("[REDACTED]");
      expect(body.override?.output.tax_id).toBe("[REDACTED]");
      expect(JSON.stringify(body)).not.toContain(loan.bank_account_number);
    },
    60_000,
  );

  test("GET /events delivers the frame for a /pre decision made on the same app", async () => {
    const stream = await openEventStream(`${app!.origin}/hooks`);
    try {
      await hook(app!, "/hooks/pre", approveLoan(95_000, "tc_app_sse"));
      await stream.untilFrames(1, 10_000);
      const frame = stream.frames.find((each) => each.data.includes("tc_app_sse"));
      expect(frame?.event).toBe("governance");
      expect(JSON.parse(frame?.data ?? "{}")).toMatchObject({
        hook: "pre",
        execution_id: "tc_app_sse",
        user_id: ALICE,
        tool: "Loan.ApproveLoan",
        decision: "deny",
        rule_id: "pre.approve-within-clearance",
      });
      expect(frame?.id).toBe(JSON.parse(frame?.data ?? "{}").id);
    } finally {
      stream.abort();
    }
  }, 60_000);

  test("a panel that closes its stream is let go", async () => {
    // Behind Next on Bun, two things had to change for this to hold (#4):
    // Bun's node:http never said the response closed (lib/runtime/
    // response-close.ts), and the stream only left the bus when its body was
    // cancelled, which Next does not do (lib/control-plane/events.ts).
    // Without either, every closed tab stayed subscribed for the life of the
    // process.
    const clients = async () =>
      ((await (await fetch(`${app!.origin}/health`)).json()) as { control_plane: { stream_clients: number } })
        .control_plane.stream_clients;
    const baseline = await clients();
    const streams = await Promise.all([1, 2, 3].map(() => openEventStream(`${app!.origin}/hooks`)));
    expect(await clients()).toBe(baseline + 3);
    for (const stream of streams) stream.abort();
    const deadline = Date.now() + 5_000;
    while ((await clients()) !== baseline && Date.now() < deadline) await Bun.sleep(50);
    expect(await clients()).toBe(baseline);
  }, 60_000);

  test("/hooks/health is the hook contract's health check, in Arcade's own vocabulary", async () => {
    // The human's decision on #4: Arcade's health probe gets the control
    // plane's own body, and its `status` is from the generated
    // `HealthResponse` enum (healthy|degraded|unhealthy). The app's `/health`
    // is a different endpoint, with DESIGN.md's ok|degraded.
    const response = await fetch(`${app!.origin}/hooks/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(HealthResponse.safeParse(body).success).toBe(true);
    expect(HealthResponse.shape.status.unwrap().options).toEqual(["healthy", "degraded", "unhealthy"]);
    expect(body).toMatchObject({ status: "healthy", service: "hooks", policy: { status: "ready", revision: 19 } });
  }, 60_000);

  test("the app's own /health keeps DESIGN.md's ok|degraded, which Arcade's enum does not have", async () => {
    const body = (await (await fetch(`${app!.origin}/health`)).json()) as { status: string };
    expect(["ok", "degraded"]).toContain(body.status);
    // Which is why Arcade is not pointed at it: `ok` is outside the contract.
    expect(HealthResponse.shape.status.unwrap().options).not.toContain("ok");
  }, 60_000);

  test("nothing the old service served is left at the root", async () => {
    for (const [method, path] of [
      ["POST", "/access"],
      ["POST", "/pre"],
      ["POST", "/post"],
      ["GET", "/events"],
      ["GET", "/audit"],
      ["POST", "/admin/reset"],
    ] as const) {
      const response = await fetch(`${app!.origin}${path}`, {
        method,
        headers: { authorization: `Bearer ${HOOK_SECRET}`, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(approveLoan(95_000, "tc_app_root")) } : {}),
      });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
  }, 60_000);

  test("/health is one response carrying the control plane's fields", async () => {
    const response = await fetch(`${app!.origin}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body).toMatchObject({
      service: "web",
      panel_stream: "live",
      policy: { status: "ready", revision: 19 },
      fixture_drift: null,
      injection_detection: { state: "armed", patterns: 6 },
      reset: "disabled",
      control_plane: { status: "healthy", service: "hooks", failure_mode: "fail-closed" },
    });
    expect(body.warnings).toBeArray();
    for (const key of ["signin", "gateway", "verifier", "agent"]) expect(body).toHaveProperty(key);
  }, 60_000);

  test("the panel's strip reads it back as a healthy control plane", async () => {
    const response = await fetch(`${app!.origin}/api/governance/control-plane`);
    expect(await response.json()).toMatchObject({
      reachable: true,
      status: "healthy",
      policy: { status: "ready", revision: 19, error: null },
      fixture_drift: null,
    });
  }, 60_000);

  test("the approvals store answers under /api/approvals, behind its own bearer", async () => {
    const roster = await fetch(`${app!.origin}/api/approvals/roster`, {
      headers: { authorization: `Bearer ${STORE_TOKEN}` },
    });
    expect(roster.status).toBe(200);
    const { subjects } = (await roster.json()) as { subjects: Array<{ display_name: string }> };
    expect(subjects.map((each) => each.display_name)).toEqual(["Alice", "Bob", "Charlie", "Michael"]);

    // Arcade's secret is not the store's: the two never stand in for each other.
    const wrong = await fetch(`${app!.origin}/api/approvals/roster`, {
      headers: { authorization: `Bearer ${HOOK_SECRET}` },
    });
    expect(wrong.status).toBe(401);
  }, 60_000);

  test("the hooks keep their bearer and their JSON 405 behind Next", async () => {
    expect((await hook(app!, "/hooks/pre", approveLoan(95_000, "tc_app_noauth"), null)).status).toBe(401);
    const get = await fetch(`${app!.origin}/hooks/pre`);
    expect(get.status).toBe(405);
    expect(await get.json()).toEqual({ error: "Method not allowed" });
  }, 60_000);

  test("the app booted the control plane once, and it is Next serving it", () => {
    const output = app!.output();
    expect(output).toContain("Next.js");
    expect(output).toContain(`- Local:`);
    const boots = output.match(/\[hooks\] mounted in the app/g) ?? [];
    expect(boots).toHaveLength(1);
    if (process.env.CG_SHOW_APP_OUTPUT) console.log(output);
  });
});

describe("a control plane that does not boot, in an app that does", () => {
  let app: App | undefined;

  beforeAll(async () => {
    app = await bootApp({ INJECTION_DETECTION: "sometimes" });
  }, BOOT_MS);

  afterAll(async () => {
    await stopApp(app);
  });

  test("/health still answers 200 and names the failure", async () => {
    const response = await fetch(`${app!.origin}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe("degraded");
    expect(body.policy.status).toBe("failed");
    expect(body.policy.error).toContain('INJECTION_DETECTION is "sometimes"');
    expect(body.control_plane.status).toBe("degraded");
    expect(body.warnings.join(" ")).toContain("every /access, /pre and /post call is being refused");
  }, 60_000);

  test("/hooks/health says unhealthy, in Arcade's vocabulary, and why", async () => {
    const response = await fetch(`${app!.origin}/hooks/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(HealthResponse.safeParse(body).success).toBe(true);
    expect(body.status).toBe("unhealthy");
    expect(String(body.error)).toContain('INJECTION_DETECTION is "sometimes"');
  }, 60_000);

  test("every hook refuses with a 5xx, which Arcade's fail_closed turns into a denial", async () => {
    for (const path of ["/hooks/access", "/hooks/pre", "/hooks/post"]) {
      const response = await hook(app!, path, approveLoan(45_000, "tc_app_dead"));
      expect(response.status).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe("CHECK_FAILED");
    }
  }, 60_000);
});
