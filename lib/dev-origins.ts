/**
 * The hosts `next dev` serves its own dev resources to (`allowedDevOrigins`),
 * read by `next.config.ts` when the config loads (#30).
 *
 * Next 16 answers 403 to a `/_next/*` request whose `Origin` is not
 * `localhost` or a listed host, and says so once in the terminal: "Blocked
 * cross-origin request to Next.js dev resource /_next/hmr from "<host>"".
 * A page that cannot load them never hydrates, so a form falls back to a
 * native submit: on the third live run (#7) Send only appended `?` to the URL.
 * The Quickstart opens the app at `https://<APP_PUBLIC_HOST>`, so that host is
 * listed, next to the loopback address every browser test in `app-test/` opens.
 *
 * Nothing else is listed. Each entry lets that host's pages read this dev
 * server's resources, so the list is the two hosts the app is opened at.
 *
 * No imports, on purpose: Next loads this through its config loader, before
 * the app's own module graph exists.
 */

/** Where every browser test opens the app. */
export const LOOPBACK_DEV_ORIGIN = "127.0.0.1";

export function allowedDevOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const origins = [LOOPBACK_DEV_ORIGIN];
  const host = hostnameOf(env.APP_PUBLIC_HOST);
  if (host !== null && !origins.includes(host)) origins.push(host);
  return origins;
}

/**
 * The hostname part of a HOST-form value, lowercase: no port and no scheme.
 * Next compares an `Origin`'s hostname against the list, so a port in an entry
 * would never match. A value that does not parse lists nothing, because
 * `lib/config.ts` already refuses it with a reason and `/health` shows it.
 */
function hostnameOf(value: string | undefined): string | null {
  const host = value?.trim();
  if (!host) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
    return url.hostname === "" ? null : url.hostname.toLowerCase();
  } catch {
    return null;
  }
}
