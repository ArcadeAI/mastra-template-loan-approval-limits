/**
 * The screenshots behind #37: Alice's $95K approval, refused, routed to
 * Charlie and resumed, in the real `/` page on the real Next dev server.
 *
 * Usage:
 *
 *     bun scripts/chat-evidence.ts --out /tmp/chat-evidence
 *
 * Everything is local and on OS-assigned ports. The agent harness supplies
 * the real control plane, the real loan module, the local IdP stub and the
 * gateway stand-in (`app-test/agent-harness.ts`); the model is the scripted
 * stand-in, so no key is used. Next serves the page. Chrome, headless, holds
 * Alice's sealed session and routes two things the page asks for to the
 * harness: `POST /api/chat` goes to the real chat handler bound to the
 * harness, and the governance stream and approval status go to the harness's
 * control plane, so the approval the turn waits on is the one Charlie decides.
 * Nothing is deployed, provisioned or authenticated anywhere, and every
 * process started here is stopped before it exits.
 *
 * The chat handler's stream is paced (one event every `--pace-ms`, 450 by
 * default) so the status line can be photographed mid-turn. Pacing changes
 * when the events arrive, never what they are.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

import {
  APPROVALS_TOOLKIT,
  DANA,
  DEV_IDP_TOKEN_PREFIX,
  LOAN_TOOLKIT,
  OVER_LIMIT_LOAN,
  RILEY,
  SESSION_SECRET,
  STORE_TOKEN,
  startAgentHarness,
  type AgentHarness,
} from "../app-test/agent-harness.ts";
import { browserTarget, Cdp, evaluate, serveOnFreePort, startChrome, stopProcess, waitFor } from "../app-test/cdp.ts";
import { spawnChild } from "../app-test/child.ts";
import { childEnv } from "../app-test/child-env.ts";
import { resolveChrome } from "../app-test/chrome.ts";
import { scriptedModel, type Turn } from "../app-test/model.ts";
import { chat, CHAT_PATH } from "../lib/agent/handlers.ts";
import { decodeEvents } from "../lib/agent/events.ts";
import { chunk, chunkName, seal } from "../lib/identity/seal.ts";
import { SESSION_COOKIE, writeSession, type Session } from "../lib/identity/session.ts";

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return value;
}

const outDir = resolve(flag("out"));
const paceMs = Number(flag("pace-ms", "450"));
const VIEWPORT = { width: 1440, height: 900 } as const;
const REPO = resolve(import.meta.dir, "..");
const DEMO_PROMPT = "Approve the loan for $95K and double-check your work so you don't make any mistakes.";
const APPROVE_LOAN = `${LOAN_TOOLKIT}_ApproveLoan`;
const GET_LOAN = `${LOAN_TOOLKIT}_GetLoan`;

mkdirSync(outDir, { recursive: true });

const chrome = resolveChrome().path;
if (chrome === null) throw new Error("no Chrome on this machine; set CG_CHROME_BIN");

/** One script per POST to the chat route, in the order the page makes them. */
const scripts: Array<readonly Turn[]> = [
  // 1. Alice reads the file; Arcade wants her to authorize the loan tools first.
  [{ call: GET_LOAN, input: { loan_id: OVER_LIMIT_LOAN } }],
  // 2. She types "done", which resumes that turn exactly as Continue would.
  [
    { call: GET_LOAN, input: { loan_id: OVER_LIMIT_LOAN } },
    {
      say: [
        "Northwind Bakery LLC is asking for ",
        "$95,000 for a second location build-out. ",
        "The file is pending; ",
        "the bank account number and tax ID came back as [REDACTED].",
      ],
    },
  ],
  // 3. The $95K prompt: found, refused by /pre, escalated.
  [
    { call: `${LOAN_TOOLKIT}_SearchLoans`, input: { status: "pending", min_amount: 95000, max_amount: 95000 } },
    { call: APPROVE_LOAN, input: { loan_id: OVER_LIMIT_LOAN, amount: 95000 } },
    {
      call: `${APPROVALS_TOOLKIT}_RequestApproval`,
      input: {
        action: "approve_loan",
        resource_id: OVER_LIMIT_LOAN,
        amount: 95000,
        justification: "Eight years in business, 712 credit score, debt service coverage 1.4x.",
      },
    },
    {
      say: [
        "I could not approve LN-2291 myself: ",
        "the control plane refused it as over my authority. ",
        "I have requested approval from Charlie. ",
        "Waiting for their decision.",
      ],
    },
  ],
  // 4. The resume, after Charlie approves.
  [
    { call: APPROVE_LOAN, input: { loan_id: OVER_LIMIT_LOAN, amount: 95000 } },
    { say: ["Approved: ", "LN-2291 for $95,000, ", "on Charlie's approval."] },
  ],
];

let harness: AgentHarness | undefined;
let backend: ReturnType<typeof Bun.serve> | undefined;
let next: Subprocess | undefined;
let browser: Subprocess | undefined;
let cdp: Cdp | undefined;
let profile: string | undefined;
const shots: Array<{ file: string; state: string }> = [];

try {
  harness = await startAgentHarness();
  const agents = harness;
  harness.gateway.requireAuthorizationFor(GET_LOAN, "https://example.invalid/oauth2/authorize?request=local-evidence");

  // The chat handler, bound to the harness, paced.
  backend = Bun.serve({
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      if (new URL(request.url).pathname !== CHAT_PATH) return new Response(null, { status: 404 });
      const script = scripts.shift();
      if (script === undefined) return Response.json({ error: "no script left" }, { status: 500 });
      const scripted = scriptedModel(script);
      const answer = await chat(request, {
        config: agents.config,
        model: () => scripted.model,
        store: { controlPlaneHost: agents.hooksHost, approvalsStoreToken: STORE_TOKEN },
      });
      if (!answer.body) return answer;
      const reader = answer.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const paced = new ReadableStream<Uint8Array>({
        async start(controller) {
          let buffered = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffered += decoder.decode(value, { stream: true });
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) {
              if (line.trim() === "") continue;
              await Bun.sleep(paceMs);
              controller.enqueue(encoder.encode(`${line}\n`));
            }
          }
          controller.close();
        },
      });
      return new Response(paced, { status: answer.status, headers: answer.headers });
    },
  });

  const web = await serveOnFreePort((webPort) =>
    spawnChild({
      cmd: ["bun", "--bun", "run", "next", "dev", "--port", String(webPort)],
      cwd: REPO,
      env: childEnv({
        NODE_ENV: "development",
        PORT: String(webPort),
        GOVERNANCE_DB_PATH: ":memory:",
        GOVERNANCE_STREAM: "hooks",
        APP_PUBLIC_HOST: `127.0.0.1:${webPort}`,
        IDP_DB_PATH: ":memory:",
        ARCADE_API_URL: agents.gateway.url,
        ARCADE_API_KEY: "arcade-key-for-local-chat-evidence",
        ARCADE_GATEWAY_ID: "cg-demo-us",
        ARCADE_LOAN_TOOLKIT: LOAN_TOOLKIT,
        ARCADE_APPROVALS_TOOLKIT: APPROVALS_TOOLKIT,
        ANTHROPIC_API_KEY: "not-used-the-chat-route-is-routed-to-the-harness",
        MODEL_ID: "claude-sonnet-5",
        SESSION_SECRET,
        IDP_CLIENT_ID: "web",
        IDP_CLIENT_SECRET: "not-used-by-local-chat-evidence",
        APPROVALS_STORE_TOKEN: STORE_TOKEN,
        LOANS_DB_PATH: agents.loansDbPath,
        IDENTITY_HOST: agents.idpHost,
        // The local fixture's cast, so the roster names the persona the page acts as.
        PERSONA_LOAN_OFFICER_EMAIL: DANA,
        PERSONA_CREDIT_ANALYST_EMAIL: "bob@bank.example",
        PERSONA_VP_CREDIT_EMAIL: RILEY,
        PERSONA_CHIEF_CREDIT_OFFICER_EMAIL: "michael@bank.example",
      }),
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  next = web.child;
  const origin = `http://127.0.0.1:${web.port}`;

  profile = mkdtempSync(join(tmpdir(), "cg-chat-evidence-chrome-"));
  const booted = await startChrome((debugPort) => [
    chrome,
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    "about:blank",
  ]);
  browser = booted.child;

  const session: Session = {
    email: DANA,
    signed_in_at: Date.now(),
    gateway: { access_token: agents.tokenFor(DANA), expires_at: Date.now() + 3_600_000, client_id: "chat-evidence" },
    idp: { access_token: `${DEV_IDP_TOKEN_PREFIX}${DANA}`, expires_at: Date.now() + 3_600_000 },
  };
  const cookies = chunk(await seal(session, SESSION_SECRET)).map((value, index) => ({
    name: chunkName(SESSION_COOKIE, index),
    value,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax" as const,
  }));

  const page = (cdp = new Cdp((await browserTarget(booted.port)).webSocketDebuggerUrl));
  await page.command("Page.enable");
  await page.command("Runtime.enable");
  await page.command("Network.enable");
  await page.command("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await page.command("Network.setCookies", { cookies });
  await page.command("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  page.on("Fetch.requestPaused", (params) => {
    const requestId = String(params.requestId ?? "");
    const url = new URL(String((params.request as { url?: string } | undefined)?.url ?? ""));
    let target: string | null = null;
    if (url.origin === origin && url.pathname === CHAT_PATH) target = `http://127.0.0.1:${backend?.port}${CHAT_PATH}`;
    else if (url.origin === origin && url.pathname === "/hooks/events") target = `http://${agents.hooksHost}${url.pathname}${url.search}`;
    else if (url.origin === origin && url.pathname.startsWith("/api/approvals/")) target = `http://${agents.hooksHost}${url.pathname}`;
    void page
      .command("Fetch.continueRequest", target === null ? { requestId } : { requestId, url: target })
      .catch(() => undefined);
  });

  await page.command("Page.navigate", { url: origin });
  await waitFor(
    "the page to hydrate with the composer",
    async () =>
      evaluate<boolean>(
        page,
        `document.querySelector('.bank[data-hydrated="true"]') !== null && document.querySelector('form.chat-composer') !== null`,
      ),
    120_000,
  );

  const status = () => evaluate<string | null>(page, `document.querySelector('.chat-status')?.textContent ?? null`);
  const idle = () =>
    evaluate<boolean>(page, `document.querySelector('form.chat-composer button')?.textContent === 'Send'`);
  const type = async (text: string) => {
    await evaluate(
      page,
      `(() => {
        const box = document.querySelector('textarea[aria-label="Message the assistant"]');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)});
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    );
  };
  const send = () =>
    evaluate(page, `(document.querySelector('form.chat-composer button[type="submit"]').click(), true)`);
  const toBottom = () =>
    evaluate(page, `(() => { const s = document.querySelector('.chat-transcript-scroll'); s.scrollTop = s.scrollHeight; return true; })()`);
  const shoot = async (name: string, state: string) => {
    const shot = (await page.command("Page.captureScreenshot", { format: "png" })) as { data: string };
    const file = join(outDir, `${name}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    const clip = (await evaluate<{ x: number; y: number; width: number; height: number }>(
      page,
      `(() => { const r = document.querySelector('.chat-shell').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    )) as { x: number; y: number; width: number; height: number };
    const chatShot = (await page.command("Page.captureScreenshot", {
      format: "png",
      clip: { ...clip, scale: 1 },
    })) as { data: string };
    writeFileSync(join(outDir, `${name}-chat.png`), Buffer.from(chatShot.data, "base64"));
    shots.push({ file: `${name}.png`, state });
    console.log(`[chat-evidence] ${name}: ${state}`);
  };

  // 1. The read, challenged at layer 2.
  await type(`Read ${OVER_LIMIT_LOAN} and tell me about the borrower.`);
  await send();
  await waitFor("Thinking… or Calling…", async () => ((await status()) ?? "").length > 0);
  await waitFor("the first turn to end", idle, 60_000);
  await waitFor("the authorization wait", async () => (await status()) === `Waiting for you to authorize ${GET_LOAN}…`);
  await toBottom();
  await shoot("01-authorization-held", `status line: ${await status()}`);

  // 2. "done", typed rather than clicked.
  await type("done");
  await send();
  await waitFor("the resumed attempt to end", async () => (await idle()) && (await status()) === null, 60_000);
  await evaluate(
    page,
    `(() => {
      const rows = [...document.querySelectorAll('details[data-kind="tool"][data-tool="${GET_LOAN}"][data-state="returned"]')];
      const row = rows[rows.length - 1];
      row.open = true;
      row.scrollIntoView({ block: 'start' });
      return true;
    })()`,
  );
  await Bun.sleep(200);
  await shoot("02-typed-done-tool-json", "typed 'done' resumed the read; Loan_GetLoan row expanded to its arguments and post-hook result");

  // 3. The $95K approval, mid-turn.
  await type(DEMO_PROMPT);
  await send();
  await waitFor("Calling Loan_ApproveLoan…", async () => (await status()) === `Calling ${APPROVE_LOAN}…`, 60_000);
  await toBottom();
  await shoot("03-calling-approve", `status line: ${await status()}`);

  // 4. Refused and routed.
  await waitFor("the $95K turn to end", async () => (await idle()) && (await status()) === "Waiting for Charlie's approval…", 60_000);
  await toBottom();
  await shoot("04-denied-waiting", `status line: ${await status()}`);

  // 5. Charlie approves, through the same governed tool the approval page uses.
  const requestId = await evaluate<string>(
    page,
    `[...document.querySelectorAll('[data-kind="waiting"] p')].map((p) => p.textContent).find((t) => t.startsWith('apr_')) ?? ''`,
  );
  const charlie: Session = {
    email: RILEY,
    signed_in_at: Date.now(),
    gateway: { access_token: agents.tokenFor(RILEY), expires_at: Date.now() + 3_600_000, client_id: "chat-evidence" },
  };
  const headers = new Headers();
  await writeSession(headers, new Request("http://localhost/"), charlie, agents.config);
  const decider = scriptedModel([
    { call: `${APPROVALS_TOOLKIT}_Decide`, input: { request_id: requestId, decision: "approved", note: "Collateral verified." } },
    { say: "Recorded." },
  ]);
  const decided = await chat(
    new Request(`http://localhost${CHAT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: headers.getSetCookie().map((value) => value.split(";")[0]).join("; "),
      },
      body: JSON.stringify({ prompt: `Approve request ${requestId}.` }),
    }),
    { config: agents.config, model: () => decider.model },
  );
  const decision = decodeEvents(await decided.text());
  if (decision.some((event) => event.kind === "denied" || event.kind === "fault")) {
    throw new Error(`Charlie's decision did not go through: ${JSON.stringify(decision)}`);
  }

  await waitFor(
    "the resume to finish",
    async () =>
      evaluate<boolean>(
        page,
        `document.querySelector('[data-kind="resumed"]') !== null && document.querySelector('form.chat-composer button')?.textContent === 'Send'`,
      ),
    60_000,
  );
  await toBottom();
  await shoot("05-resumed-approved", `status line: ${(await status()) ?? "(none)"}`);

  // The computed borders the "no box per turn" criterion is about.
  const borders = await evaluate<Record<string, string>>(
    page,
    `(() => {
      const w = (el) => el ? getComputedStyle(el).borderTopWidth + ' ' + getComputedStyle(el).borderLeftWidth : 'missing';
      return {
        turn: w(document.querySelector('.chat-turn')),
        assistant: w(document.querySelector('.chat-message-assistant')),
        user: w(document.querySelector('.chat-message-user')),
        denied: w(document.querySelector('[data-kind="denied"]')),
        waiting: w(document.querySelector('[data-kind="waiting"]')),
        authorization: w(document.querySelector('[data-kind="authorization"]')),
      };
    })()`,
  );
  const transcript = await evaluate<string>(page, `document.querySelector('.chat-transcript').innerText`);
  writeFileSync(join(outDir, "evidence.json"), `${JSON.stringify({ viewport: VIEWPORT, shots, borders, transcript }, null, 2)}\n`);
  console.log(`[chat-evidence] borders (top left): ${JSON.stringify(borders)}`);
  console.log(`[chat-evidence] wrote ${shots.length * 2} PNGs and evidence.json to ${outDir}`);
} finally {
  cdp?.close?.();
  await stopProcess(browser);
  await stopProcess(next);
  backend?.stop(true);
  await harness?.stop();
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
}
