/**
 * `next dev` serves its dev resources to a page opened at `APP_PUBLIC_HOST` (#30).
 *
 * The third live run on #7 opened the app at `https://<APP_PUBLIC_HOST>`, as
 * the Quickstart says, and the page never hydrated: Send only appended `?` to
 * the URL, a native form submit. The terminal said why: "Blocked cross-origin
 * request to Next.js dev resource /_next/hmr from "<host>" … add it to
 * allowedDevOrigins". `next.config.ts` listed `127.0.0.1` only.
 *
 * Nothing here is a real tunnel. The app is booted by the real launcher,
 * `bun scripts/next.ts dev`, with `APP_PUBLIC_HOST` set to a name nothing
 * resolves, and reached two ways:
 *
 * 1. **Over HTTP, with that host's `Origin` and `Host`**, the headers the
 *    tunnel's browser request carries. A second origin, listed nowhere, is
 *    asked in the same run and must still be refused with Next's warning: the
 *    control that shows the check is live, not merely absent.
 * 2. **In Chrome, through a local alias.** `--host-resolver-rules` maps the
 *    name to 127.0.0.1 inside that browser alone, so the page is served under
 *    the host exactly as the tunnel serves it, and the test waits for React to
 *    hydrate the home page. No `/etc/hosts` edit and no proxy.
 *
 * Measured against the config before #30 (`allowedDevOrigins: ["127.0.0.1"]`):
 * the first test got 403 `Unauthorized` and the terminal printed the warning
 * the live run saw, and the second never hydrated. The output is on #30's PR.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

import { allowedDevOrigins } from "../lib/dev-origins.ts";
import { childEnv } from "./child-env.ts";
import { browserRequired, missingBrowserMessage, resolveChrome } from "./chrome.ts";
import { browserTarget, Cdp, evaluate, startChrome, stopProcess, waitFor } from "./cdp.ts";
import { captureOutput, retryOnPortRace, spawnChild, waitForChildHttp } from "./child.ts";

const ROOT = join(import.meta.dir, "..");
/** Not a real domain: `.example` is reserved (RFC 2606), and nothing but Chrome's alias resolves it. */
const TUNNEL_HOST = "lal-tunnel.example";
/** Listed nowhere, so Next must refuse it. */
const STRANGER = "somebody-else.example";
const BLOCKED = "Blocked cross-origin request to Next.js dev resource";

describe("the list, as next.config.ts reads it", () => {
  test("is the loopback address and the host of APP_PUBLIC_HOST, and nothing else", () => {
    expect(allowedDevOrigins({ APP_PUBLIC_HOST: "my-app.ngrok.app" })).toEqual(["127.0.0.1", "my-app.ngrok.app"]);
    // The hostname only: Next compares an Origin's hostname, so a port would never match.
    expect(allowedDevOrigins({ APP_PUBLIC_HOST: "My-App.ngrok.app:8443" })).toEqual(["127.0.0.1", "my-app.ngrok.app"]);
    expect(allowedDevOrigins({ APP_PUBLIC_HOST: " my-app.ngrok-free.dev " })).toEqual(["127.0.0.1", "my-app.ngrok-free.dev"]);
  });

  test("is the loopback address alone when APP_PUBLIC_HOST is unset, blank or unusable", () => {
    expect(allowedDevOrigins({})).toEqual(["127.0.0.1"]);
    expect(allowedDevOrigins({ APP_PUBLIC_HOST: "   " })).toEqual(["127.0.0.1"]);
    expect(allowedDevOrigins({ APP_PUBLIC_HOST: "127.0.0.1:4560" })).toEqual(["127.0.0.1"]);
    expect(allowedDevOrigins({ APP_PUBLIC_HOST: "https://" })).toEqual(["127.0.0.1"]);
  });

  test("is what next.config.ts hands Next", async () => {
    const saved = process.env.APP_PUBLIC_HOST;
    process.env.APP_PUBLIC_HOST = TUNNEL_HOST;
    try {
      // A fresh module instance, so the config reads the variable as it loads.
      const { default: config } = await import(`../next.config.ts?dev-origins=${Date.now()}`);
      expect(config.allowedDevOrigins).toEqual(["127.0.0.1", TUNNEL_HOST]);
    } finally {
      if (saved === undefined) delete process.env.APP_PUBLIC_HOST;
      else process.env.APP_PUBLIC_HOST = saved;
    }
  });
});

/** Every variable `.env.example` names, as it ships: blank. `origin-fresh-clone.test.ts` does the same. */
function asCopied(): Record<string, string> {
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  return Object.fromEntries([...example.matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map(([, key]) => [key!, ""]));
}

describe("next dev, with APP_PUBLIC_HOST set to a host that is not localhost", () => {
  let child: Subprocess | undefined;
  let output: () => string = () => "";
  let port = 0;
  let cleanup: () => void = () => undefined;

  beforeAll(async () => {
    ({ child, output, port, cleanup } = await retryOnPortRace(async (candidate) => {
      const data = mkdtempSync(join(tmpdir(), "cg-dev-origins-"));
      const distDir = `.next/cg-dev-origins-${candidate}`;
      const spawned = spawnChild(["bun", "scripts/next.ts", "dev"], {
        cwd: ROOT,
        env: childEnv({
          ...asCopied(),
          NODE_ENV: "development",
          NEXT_TELEMETRY_DISABLED: "1",
          PORT: String(candidate),
          CG_NEXT_DIST_DIR: distDir,
          GOVERNANCE_DB_PATH: join(data, "governance.db"),
          LOANS_DB_PATH: join(data, "loans.db"),
          IDP_DB_PATH: join(data, "idp.db"),
          // With the port, so the page Chrome opens below is on its public host.
          APP_PUBLIC_HOST: `${TUNNEL_HOST}:${candidate}`,
        }),
        stdout: "pipe",
        stderr: "pipe",
      });
      const captured = captureOutput(spawned);
      const remove = () => {
        rmSync(data, { recursive: true, force: true });
        rmSync(join(ROOT, distDir), { recursive: true, force: true });
      };
      try {
        await waitForChildHttp(spawned, `http://127.0.0.1:${candidate}/health`, { output: captured, timeoutMs: 180_000 });
      } catch (error) {
        spawned.kill();
        await spawned.exited;
        remove();
        throw error;
      }
      return { child: spawned, output: captured, port: candidate, cleanup: remove };
    }));
  }, 200_000);

  afterAll(async () => {
    await stopProcess(child);
    cleanup();
  });

  /** A dev-resource request as a browser on `host` sends it. */
  const devResource = (host: string, path = "/_next/hmr") =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { origin: `https://${host}`, host: `${host}:${port}`, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
    });

  test("serves /_next/hmr to the tunnel's Origin and Host, and still refuses an origin it does not list", async () => {
    // The control first: Next's check is live in this server, so a pass below is not an absent check.
    const stranger = await devResource(STRANGER);
    expect(stranger.status).toBe(403);
    expect(await stranger.text()).toBe("Unauthorized");
    await waitFor("Next's warning about the refused origin", async () => output().includes(`${BLOCKED} /_next/hmr from "${STRANGER}"`), 10_000);

    const tunnel = await devResource(TUNNEL_HOST);
    const body = await tunnel.text();
    console.log(`[dev-origins] /_next/hmr with Origin https://${TUNNEL_HOST} -> ${tunnel.status} ${JSON.stringify(body.slice(0, 80))}`);
    await Bun.sleep(200);
    for (const line of output().split("\n").filter((text) => text.includes(BLOCKED))) console.log(`[dev-origins] next dev said: ${line.trim()}`);
    expect(tunnel.status).not.toBe(403);
    expect(body).not.toBe("Unauthorized");

    // A client chunk the home page names, fetched the same way: what hydration needs.
    const home = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { host: `${TUNNEL_HOST}:${port}` } })).text();
    const chunk = /<script[^>]+src="(\/_next\/static\/chunks\/[^"]+\.js)"/.exec(home)?.[1];
    expect(chunk, "the home page names no client chunk").toBeString();
    const script = await devResource(TUNNEL_HOST, chunk!);
    expect(script.status).toBe(200);
    expect(output()).not.toContain(`from "${TUNNEL_HOST}"`);
  }, 60_000);

  const chrome = resolveChrome();
  test.skipIf(chrome.path === null && !browserRequired())(
    "hydrates the home page in Chrome, served under that host through a local alias",
    async () => {
      if (chrome.path === null) throw new Error(missingBrowserMessage(chrome));
      const profile = mkdtempSync(join(tmpdir(), "cg-dev-origins-chrome-"));
      let browser: Subprocess | undefined;
      let cdp: Cdp | undefined;
      try {
        const started = await startChrome((debugPort) => [
          chrome.path!,
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          `--user-data-dir=${profile}`,
          `--remote-debugging-port=${debugPort}`,
          // The local alias: this name resolves to loopback in this browser and nowhere else.
          `--host-resolver-rules=MAP ${TUNNEL_HOST} 127.0.0.1`,
          "about:blank",
        ]);
        browser = started.child;
        cdp = new Cdp((await browserTarget(started.port)).webSocketDebuggerUrl);
        const refused: string[] = [];
        cdp.on("Network.responseReceived", (params) => {
          const response = (params.response ?? {}) as { url?: string; status?: number };
          if (response.status === 403 && response.url?.includes("/_next/")) refused.push(response.url);
        });
        await cdp.command("Network.enable");
        await cdp.command("Runtime.enable");
        await cdp.command("Page.enable");

        const url = `http://${TUNNEL_HOST}:${port}/`;
        await cdp.command("Page.navigate", { url });
        await waitFor(`the page at ${url} to load`, async () => (await evaluate<string>(cdp!, "location.host")) === `${TUNNEL_HOST}:${port}`);

        // Hydrated means React has attached a fiber to the server-rendered DOM.
        // Before `hydrateRoot()` finishes, the markup is there and no node carries one.
        await waitFor(
          `React to hydrate the home page served as ${TUNNEL_HOST} (403s on /_next: ${refused.join(", ") || "none"})`,
          () =>
            evaluate<boolean>(
              cdp!,
              `[...document.querySelectorAll("body *")].some((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber$")))`,
            ),
          60_000,
        );
        expect(refused).toEqual([]);
        expect(output()).not.toContain(`from "${TUNNEL_HOST}"`);
      } finally {
        cdp?.close();
        await stopProcess(browser);
        rmSync(profile, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
