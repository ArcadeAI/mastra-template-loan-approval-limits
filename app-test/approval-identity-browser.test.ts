/**
 * #180, as the human reported it, in a real browser.
 *
 * > Alice escalates a loan above her authority. The approval is routed to
 * > Charlie and a Slack DM goes out with the approval link. **Alice opens that
 * > link herself and approves the loan.** It succeeds.
 *
 * Every word of that is driven here and nothing is stood in for except Arcade's
 * transport. `apps/idp` is a real subprocess and Alice's session is the one a
 * real authorization-code flow left behind after a real password was typed into
 * a real login form. `apps/hooks` is a real subprocess answering `/pre` from the
 * real policy. `next dev` serves the actual page. Headless Chrome opens the
 * link and **presses the button**, which is the part a render test cannot do:
 * the defect was never in what the page displayed, it was in the `user_id` the
 * server action chose when nobody had chosen one.
 *
 * ## Why it is written this way and not more cheaply
 *
 * This file imports nothing that #180 added. That is deliberate and it is the
 * evidence: the same file, dropped unchanged into a worktree at `ab21b48`,
 * compiles and runs, and Alice's Approve is **recorded** instead of refused.
 * A test that could only fail there by failing to import would prove nothing
 * about the defect.
 *
 * ## Both directions, because one is not a control
 *
 * A refusal that fires on everybody is indistinguishable from a page that is
 * simply broken, which on this project is the recurring failure mode. So
 * Charlie — the routed approver, signed in as himself, opening the same link —
 * has to still get through. The second half of this test is what makes the
 * first half mean something.
 *
 * The rig is the repo's: `app-test/cdp.ts` drives the browser and `app-test/chrome.ts`
 * finds one. Since #152 a missing browser is a failure on CI rather than a
 * silent skip.
 */
import type { Subprocess } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserRequired, missingBrowserMessage, resolveChrome } from "./chrome.ts";
import { browserTarget, Cdp, evaluate, serveOnFreePort, startChrome, stopProcess, waitFor } from "./cdp.ts";
import { spawnChild } from "./child.ts";
import { chunk, chunkName, joinChunks, openSealed, seal } from "../lib/identity/seal.ts";
import { SESSION_COOKIE, type Session } from "../lib/identity/session.ts";
import { appIdentityEnv } from "./app-identity.ts";
import { Browser, PEOPLE, SESSION_SECRET, signInAs, type PersonaKey } from "./identity-harness.ts";
import { DANA, HOOK_SECRET, RILEY, startHarness, type Harness } from "./harness.ts";

const WEB = join(import.meta.dir, "..");

const chromeResolution = resolveChrome();
const REQUIRED = browserRequired();
if (chromeResolution.path === null && !REQUIRED) console.warn(missingBrowserMessage(chromeResolution));

test.skipIf(chromeResolution.path === null && !REQUIRED)(
  "Alice opens her own approval link, presses Approve, and the pre-hook refuses her by name",
  async () => {
    if (chromeResolution.path === null) throw new Error(missingBrowserMessage(chromeResolution));
    const CHROME = chromeResolution.path;

    let control: Harness | undefined;
    const scratch = mkdtempSync(join(tmpdir(), "cg-approval-identity-app-"));
    let next: Subprocess | undefined;
    let chrome: Subprocess | undefined;
    let cdp: Cdp | undefined;
    let profile: string | undefined;

    try {
      // The real control plane with a stand-in Arcade that works by *calling
      // the real pre-hook*, and the app as its own real identity provider (#6).
      control = await startHarness();
      const harness = control;

      // Each child gets its port inside `serveOnFreePort` / `startChrome`, which
      // start it again on a new one if another process took it first (#9). The
      // app's identity is minted per attempt: its issuer is the app's origin.
      const web = await serveOnFreePort(async (webPort) => {
        const appIdentity = await appIdentityEnv(`http://127.0.0.1:${webPort}`, join(scratch, String(webPort)));
        return spawnChild({
          // `--bun`: the app runs on Bun since #4, because the control plane it
          // mounts opens governance.db with bun:sqlite (`scripts/next.ts`).
          cmd: ["bun", "--bun", "run", "next", "dev", "--port", String(webPort)],
          cwd: WEB,
          env: {
            ...process.env,
            NODE_ENV: "development",
            PORT: String(webPort),
            // The app mounts the control plane since #4; a throwaway one, not
            // a governance.db in the repo.
            GOVERNANCE_DB_PATH: ":memory:",
            // The app holds the loan book since #5; a throwaway one, not a
            // loans.db in the repo.
            LOANS_DB_PATH: ":memory:",
            // The key the sealed sessions below are sealed under. A mismatch here
            // is indistinguishable from "not signed in", which is exactly the
            // state this test is trying to tell apart from a real identity.
            SESSION_SECRET,
            // The app is its own identity provider since #6: its own throwaway
            // idp.db, client C minted in it, and APP_PUBLIC_HOST its own origin.
            ...appIdentity.env,
            // The app's server-side reads go to CONTROL_PLANE_HOST (#4), which
            // defaults to the app's own listener; this test's control plane is elsewhere.
            CONTROL_PLANE_HOST: harness.hooksHost,
            APPROVALS_STORE_TOKEN: harness.config.approvalsStoreToken,
            ARCADE_API_URL: harness.config.arcadeApiUrl,
            ARCADE_API_KEY: harness.config.arcadeApiKey,
            ARCADE_APPROVALS_TOOLKIT: harness.config.approvalsToolkit,
            ANTHROPIC_API_KEY: "not-used-by-this-suite",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
      });
      next = web.child;
      const origin = `http://127.0.0.1:${web.port}`;

      profile = mkdtempSync(join(tmpdir(), "cg-approval-identity-chrome-"));
      const browser = await startChrome((debugPort) => [
        CHROME,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--window-size=1440,900",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${debugPort}`,
        "about:blank",
      ]);
      chrome = browser.child;
      const debugPort = browser.port;

      cdp = new Cdp((await browserTarget(debugPort)).webSocketDebuggerUrl);
      await cdp.command("Page.enable");
      await cdp.command("Runtime.enable");
      await cdp.command("Network.enable");

      // ---- the escalation, exactly as `tools/approvals` writes it ---------
      // Alice raised it; routing sent it to Charlie and left Michael alone.
      const request = await control.escalate();
      const id = String(request.id);
      expect(request.requester_id).toBe(DANA);
      expect(request.approver_id).toBe(RILEY);
      const link = `${origin}/approvals/${id}`;

      // ---- Alice, signed in as Alice, opens her own link ------------------
      // Her own Chrome profile, holding the cookie her own password produced.
      // Nothing on the page and nothing in this test tells it who she is.
      await useSession(cdp, await sessionFor({ webUrl: origin }, "dana"));
      await cdp.command("Page.navigate", { url: link });
      await waitForButtons(cdp);

      // The page says whose decision it is about to make, and it is hers.
      const aliceHeader = await evaluate<string>(cdp, `document.body.innerText`);
      expect(aliceHeader).toContain("Alice");
      expect(aliceHeader).not.toContain("Signed in as Charlie");

      await pressApprove(cdp);
      const refusal = await waitForOutcome(cdp);

      // The control that #180 says was never consulted about her.
      expect(refusal).toContain("CHECK_FAILED");
      expect(refusal).toContain("separation of duties");
      expect(refusal).toContain("The request is unchanged.");

      // Nothing was decided. This is the assertion the reported bug fails.
      expect(await control.read(id)).toMatchObject({ status: "pending", decided_by: null });

      // The call reached the pre-hook as **Alice** — not as the routed
      // approver the page used to assume the opener was.
      expect(control.preCalls).toEqual([{ user_id: DANA, tool: "Approvals.Decide" }]);

      // And the audit row names her. A row naming Charlie for a decision
      // Charlie was not present for is worse than no row: it is wrong in a way
      // indistinguishable from the correct case.
      const denials = await audit(control.hooksHost, { hook: "pre", decision: "deny", tool: "Approvals.Decide" });
      expect(denials.length).toBe(1);
      expect(denials[0]).toMatchObject({ user_id: DANA });
      expect(JSON.stringify(denials[0])).toContain("decide-not-by-the-requester");
      // Nobody signed in as Charlie has touched this request.
      expect(denials.some((row) => row.user_id === RILEY)).toBe(false);

      // ---- Charlie, on the same link, still gets through ------------------
      // A refusal that fires on everybody is not a control. This is the half
      // that says the rule discriminates rather than blocks.
      control.preCalls.length = 0;
      await useSession(cdp, await sessionFor({ webUrl: origin }, "riley"));
      await cdp.command("Page.navigate", { url: link });
      await waitForButtons(cdp);

      expect(await evaluate<string>(cdp, `document.body.innerText`)).toContain("Charlie");

      await pressApprove(cdp);
      const recorded = await waitForOutcome(cdp);

      expect(recorded).toContain("Decision recorded");
      expect(recorded).not.toContain("CHECK_FAILED");
      expect(await control.read(id)).toMatchObject({ status: "approved", decided_by: RILEY });
      expect(control.preCalls).toEqual([{ user_id: RILEY, tool: "Approvals.Decide" }]);

      // ---- A browser whose session is gone by the time it presses ---------
      // #6, criterion 4: the decider comes from the sealed session and from
      // nothing else, so no input to the decide action can name one. A
      // browser that loaded the buttons signed in and lost its session before
      // pressing is the one way to reach the action with no session at all.
      // It gets the carried refusal — a fault, not a denial — and nothing is
      // sent to `/pre`.
      //
      // The refusal is read off the wire, as the action's own answer: Next
      // re-renders the page after an action, and without a session that
      // render is the signed-out view, which has no controls to show an
      // outcome in. What the browser is left looking at is asserted too.
      const orphaned = await control.escalate();
      const orphanedId = String(orphaned.id);
      control.preCalls.length = 0;
      await useSession(cdp, await sessionFor({ webUrl: origin }, "riley"));
      await cdp.command("Page.navigate", { url: `${origin}/approvals/${orphanedId}` });
      await waitForButtons(cdp);
      await cdp.command("Network.clearBrowserCookies");

      const actionCalls: string[] = [];
      const answered = new Set<string>();
      // Registered before the press; a listener added after it would miss it.
      // Whichever way the form went — the client's `Next-Action` fetch, or the
      // plain form post React's progressive enhancement falls back to — it is
      // a POST to this page, and its answer carries the action's result.
      cdp.on("Network.requestWillBeSent", (params) => {
        const request = params.request as { method: string; url: string };
        if (request.method === "POST" && request.url.endsWith(`/approvals/${orphanedId}`)) {
          actionCalls.push(String(params.requestId));
        }
      });
      cdp.on("Network.loadingFinished", (params) => answered.add(String(params.requestId)));

      await pressApprove(cdp);
      await waitFor("the decide action's answer", async () => actionCalls.some((id) => answered.has(id)), 60_000);
      const bodies = await Promise.all(
        actionCalls.map(
          async (requestId) =>
            (await cdp!.command<{ body: string }>("Network.getResponseBody", { requestId })).body,
        ),
      );
      const answer = bodies.join("\n");

      expect(answer).toContain("This browser is not signed in, so there is nobody to make this decision as.");
      expect(answer).toContain("nothing was sent to the control plane");
      expect(answer).not.toContain("CHECK_FAILED");
      await waitFor(
        "the signed-out view",
        async () => (await evaluate<string>(cdp!, `document.body.innerText`)).includes("Sign in to decide"),
        30_000,
      );
      expect(await control.read(orphanedId)).toMatchObject({ status: "pending", decided_by: null });
      expect(control.preCalls).toEqual([]);
    } finally {
      cdp?.close();
      await stopProcess(chrome);
      await stopProcess(next);
      await control?.stop();
      rmSync(scratch, { recursive: true, force: true });
      if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
    }
  },
  420_000,
);

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

/**
 * A real sign-in, unsealed back into the `Session` a browser would be carrying.
 * Against the booted app itself since #6: it is its own identity provider.
 */
async function sessionFor(harness: { webUrl: string }, persona: PersonaKey): Promise<Session> {
  const browser = new Browser();
  await signInAs(browser, harness, persona, { stopAt: "/api/arcade/start" });
  const session = await openSealed<Session>(joinChunks(SESSION_COOKIE, browser.cookies), SESSION_SECRET);
  if (session === null) throw new Error(`signing in as ${persona} left no session`);
  return session;
}

/**
 * Put this session in the browser, and only this session.
 *
 * Cleared first: one persona per browser is the design (`DESIGN.md` → Gateway
 * token storage), and a leftover chunk from a longer session would join onto a
 * shorter new one and refuse to open — which reads as "not signed in" and would
 * quietly turn the second half of this test into a repeat of the first.
 */
async function useSession(cdp: Cdp, session: Session): Promise<void> {
  await cdp.command("Network.clearBrowserCookies");
  await cdp.command("Network.setCookies", {
    cookies: chunk(await seal(session, SESSION_SECRET)).map((value, index) => ({
      name: chunkName(SESSION_COOKIE, index),
      value,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax" as const,
    })),
  });
}

const APPROVE = 'document.querySelector(\'button[value="approved"]\')';

async function waitForButtons(cdp: Cdp): Promise<void> {
  await waitFor("the Approve button", async () => evaluate<boolean>(cdp, `${APPROVE} !== null`), 60_000);
}

/**
 * Press Approve. **Once.**
 *
 * Exactly once, and the emphasis is the point: a retry would be a second
 * decision, and the second decision on a request that has just been recorded is
 * refused for a completely different reason — "already been decided" — which
 * would put a refusal on screen in the half of this test that is supposed to
 * prove a decision gets *through*.
 *
 * One click reaches the server action either way. Hydrated, `useActionState`
 * intercepts it; unhydrated, the same click is an ordinary form POST that Next
 * answers by re-rendering with the action's result. What neither does is answer
 * instantly under `next dev`, which compiles the route on the first request —
 * hence the wait rather than a retry.
 */
async function pressApprove(cdp: Cdp): Promise<void> {
  await evaluate<void>(cdp, `${APPROVE}.click()`);
}

async function waitForOutcome(cdp: Cdp): Promise<string> {
  await waitFor(
    "the outcome panel",
    async () => evaluate<boolean>(cdp, `document.querySelector('[role="status"]') !== null`),
    120_000,
  );
  return evaluate<string>(cdp, `document.querySelector('[role="status"]').innerText`);
}

/** `GET /audit` on the real control plane, with Arcade's bearer. */
async function audit(
  hooksHost: string,
  filters: Record<string, string>,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`http://${hooksHost}/hooks/audit?${new URLSearchParams(filters)}`, {
    headers: { authorization: `Bearer ${HOOK_SECRET}` },
  });
  if (!response.ok) throw new Error(`audit: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { rows: Array<Record<string, unknown>> }).rows;
}
