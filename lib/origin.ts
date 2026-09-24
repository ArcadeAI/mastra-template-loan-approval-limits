/**
 * The origin trap (#9, from #6's assumptions on #7).
 *
 * Better Auth's session cookie, the app's sealed session and the custom
 * verifier all live on one origin, `https://<APP_PUBLIC_HOST>`. A browser on
 * `http://localhost:<port>` has none of them: sign-in sets its cookies for the
 * other host, and when Arcade sends that browser to the verifier it arrives
 * signed out and is sent to sign in again. Nothing fails loudly; it just never
 * works. So when `APP_PUBLIC_HOST` is set and a page is served under any other
 * host, the home page says so and links to the right one. It does not
 * redirect: a redirect to a tunnel that is not running lands on ngrok's error
 * page, and `localhost` stays useful for `/health` and the panel.
 *
 * The host a request arrived on is `x-forwarded-host`'s first entry when a
 * proxy set one, else `Host`. Only a hint is decided on it, never access.
 */
import { appPublicHost, appPublicHostIsFallback, baseUrl } from "./config.ts";

export interface OriginMismatch {
  /** Where this page was served, e.g. `http://localhost:3000`. */
  current: string;
  /** Where it has to be opened: `https://<APP_PUBLIC_HOST>`. */
  expected: string;
}

interface HeaderReader {
  get(name: string): string | null;
}

/** `null` when there is nothing to say: no `APP_PUBLIC_HOST`, no host header, or the right host. */
export function originMismatch(
  headers: HeaderReader,
  env: Record<string, string | undefined> = process.env,
): OriginMismatch | null {
  if (appPublicHostIsFallback(env)) return null;
  let expectedHost: string;
  try {
    expectedHost = appPublicHost(env);
  } catch {
    // An unusable APP_PUBLIC_HOST is the configuration banner's to report.
    return null;
  }
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded || headers.get("host")?.trim();
  if (!host) return null;
  if (host.toLowerCase() === expectedHost.toLowerCase()) return null;

  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const current = forwardedProto ? `${forwardedProto}://${host}` : baseUrl(host);
  return { current, expected: baseUrl(expectedHost) };
}

/**
 * What `bun run dev` prints before Next starts (#9): the one URL to open, and
 * when that is the tunnel, the tunnel command that serves it. `port` is the
 * port the app binds.
 */
export function openInstructions(env: Record<string, string | undefined>, port: string): string {
  const local = `http://localhost:${port}`;
  if (appPublicHostIsFallback(env)) {
    return `▶ Open ${local}\n  APP_PUBLIC_HOST is not set, so sign-in and Arcade are off; /health says what else is missing.`;
  }
  let host: string;
  try {
    host = appPublicHost(env);
  } catch (error) {
    return `▶ APP_PUBLIC_HOST is not usable: ${(error as Error).message}\n  Open ${local}/health to see what else is missing.`;
  }
  const expected = baseUrl(host);
  if (expected.startsWith("http://")) return `▶ Open ${expected}`;
  return [
    `▶ Open ${expected}`,
    `  Sign-in, sessions and the Arcade verifier live on that host only, not on ${local}.`,
    `  It reaches this machine through the tunnel: ngrok http --url=${host} ${port}`,
  ].join("\n");
}
