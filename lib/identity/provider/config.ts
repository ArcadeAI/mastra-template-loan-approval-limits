/**
 * Environment, read in one place so the server and the scripts agree on it.
 * Every variable is documented in the repo's `.env.example`.
 */

import { readPersonaEmailOverrides } from "../../../packages/policy-schema/contract/persona-email-contract.ts";
import { registerSecretFingerprint } from "../../secret-fingerprints.ts";

/** Arcade Cloud's OAuth callback. Confirm against the "Redirect URL" the Arcade dashboard shows (#13). */
export const DEFAULT_ARCADE_REDIRECT_URI = "https://cloud.arcade.dev/api/v1/oauth/callback";

/**
 * A fixed secret for local runs only, and published in this file. Refused
 * under NODE_ENV=production (a deployment sets a real one), and since #9 refused whenever the issuer is not this
 * machine, whatever NODE_ENV says: see {@link publicHostWithoutSecret}.
 */
const DEV_SECRET = "cg-idp-dev-secret-not-for-production-0000000000";

/**
 * One OAuth client this service keeps, as the environment asks for it.
 *
 * Better Auth generates the `client_id` and `client_secret` and they cannot be
 * pinned from env, so nothing here is a credential: a spec is a **key** (the
 * fixed primary key of the row, so the same client is found again on the next
 * boot), a display name for the login and consent pages, and the redirect URIs
 * allowlisted on it.
 */
export interface OAuthClientSpec {
  key: string;
  name: string;
  redirectUris: string[];
}

export interface IdpConfig {
  port: number;
  dbPath: string;
  /**
   * Public origin and OAuth issuer: the app's own, `APP_PUBLIC_HOST` with its
   * scheme (#6). The identity module is served by the app on the app's port,
   * so the issuer an Arcade User Source matches `iss` against, the origin
   * Better Auth sets its session cookie on and the origin the custom verifier
   * reads the app's sealed session from are one origin, by construction.
   */
  baseURL: string;
  /** True when nothing set `APP_PUBLIC_HOST` and `baseURL` is the localhost fallback. */
  baseURLIsFallback: boolean;
  secret: string;
  /** The first client's redirect URIs. Same value as `clients[0].redirectUris`. */
  redirectUris: string[];
  /**
   * Every client, in the order `IDP_OAUTH_CLIENTS` names them. Always at least
   * one — `clients[0]` is the Arcade registration everything before #79
   * assumed, and with nothing configured it is the only one.
   */
  clients: OAuthClientSpec[];
  /**
   * The bearer `POST /admin/reset` requires (#23). Blank is a state, not a
   * default: the route does not exist at all, `/health` reports
   * `reset: "disabled"`, and there is no development fallback because a
   * published one would be the same as no bearer. The same variable name and
   * the same rules as `apps/hooks` and `apps/loan-app`, so one value
   * configures all three.
   */
  resetToken: string;
}

/** The one client every deployment has, and the only one before #79. */
export const PRIMARY_CLIENT_KEY = "arcade";

/**
 * A client key is a row primary key and half of an environment variable name,
 * so it is kept to the shape both can hold without quoting or escaping.
 */
const CLIENT_KEY = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `arcade-user-source` -> `IDP_OAUTH_REDIRECT_URIS_ARCADE_USER_SOURCE`. The
 * per-client override; without it a client falls back to the shared
 * `IDP_OAUTH_REDIRECT_URIS`, which is what keeps a one-client deployment
 * configured exactly as it was.
 */
export function redirectUrisVar(key: string): string {
  return `IDP_OAUTH_REDIRECT_URIS_${key.toUpperCase().replace(/-/g, "_")}`;
}

/** `arcade-user-source` -> `Arcade User Source`, for the consent page. */
function displayName(key: string): string {
  return key
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Reads `IDP_OAUTH_CLIENTS`, which names the clients by key.
 *
 * Unset — the shape every deployment has today — means exactly
 * `[PRIMARY_CLIENT_KEY]`, so nothing changes for anyone who does not opt in.
 * The primary key is always first and always present: it is the row #13
 * registered in the Arcade dashboard, and dropping it from the list would
 * quietly stop reconciling the live client rather than fail.
 */
function readClients(env: Record<string, string | undefined>, sharedUris: string[]): OAuthClientSpec[] {
  const keys = splitList(env.IDP_OAUTH_CLIENTS);
  for (const key of keys) {
    if (!CLIENT_KEY.test(key)) {
      throw new Error(
        `IDP_OAUTH_CLIENTS: "${key}" is not a usable client key — lowercase letters, digits and hyphens only`,
      );
    }
  }

  const ordered = [PRIMARY_CLIENT_KEY, ...keys.filter((key) => key !== PRIMARY_CLIENT_KEY)];
  return [...new Set(ordered)].map((key) => {
    const override = splitList(env[redirectUrisVar(key)]);
    return {
      key,
      name: key === PRIMARY_CLIENT_KEY ? "Arcade" : displayName(key),
      redirectUris: override.length > 0 ? override : sharedUris,
    };
  });
}

/**
 * The issuer: `APP_PUBLIC_HOST` with its scheme, no trailing slash (#6).
 *
 * http for a localhost or 127.0.0.1 host and https for anything else, so a
 * local run needs no tunnel and the ngrok host is https. The same rule as the
 * app's `appOrigin` (`lib/config.ts`), written out here rather than imported
 * because this module depends on nothing else in the app — a forker with a
 * real IdP deletes it — and `app-test/identity/issuer.test.ts` fails if the
 * two ever disagree. Unset, it is the app's own port on localhost.
 */
export function issuerOf(env: Record<string, string | undefined>): string {
  const host = env.APP_PUBLIC_HOST?.trim() || `localhost:${env.PORT?.trim() || "3000"}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    throw new Error(`APP_PUBLIC_HOST=${host} is a URL; it is HOST-form, and the scheme is added here`);
  }
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  return `${local ? "http" : "https"}://${host}`.replace(/\/+$/, "");
}

export function readConfig(env: Record<string, string | undefined> = process.env): IdpConfig {
  // Validate before opening the database. An obsolete name-based variable
  // must not leave this service apparently healthy while seeding fixture
  // addresses.
  readPersonaEmailOverrides(env);
  const port = Number(env.PORT ?? 3000);

  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!secret && env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET is required in production");
  }

  // The app's own origin since #6, which replaced `IDP_PUBLIC_URL`: http for
  // a localhost or 127.0.0.1 host, https for anything else, so a local run
  // needs no tunnel. Unset, it is the app's own port on localhost.
  const baseURL = issuerOf(env);
  if (!secret) {
    const refusal = publicHostWithoutSecret(baseURL);
    if (refusal) throw new Error(refusal);
  }

  const redirectUris = splitList(env.IDP_OAUTH_REDIRECT_URIS ?? DEFAULT_ARCADE_REDIRECT_URI);
  const clients = readClients(env, redirectUris);

  // The chat must withhold this from anything it shows of a tool call, and
  // may not read it (#37): it gets a fingerprint, never the value.
  registerSecretFingerprint(secret || DEV_SECRET);

  return {
    port,
    dbPath: env.IDP_DB_PATH ?? "./idp.db",
    baseURL,
    baseURLIsFallback: !env.APP_PUBLIC_HOST?.trim(),
    secret: secret || DEV_SECRET,
    redirectUris: clients[0]!.redirectUris,
    clients,
    resetToken: env.RESET_TOKEN?.trim() ?? "",
  };
}

/**
 * Why a blank `BETTER_AUTH_SECRET` is refused for this issuer, or `null` (#9).
 *
 * The development secret is published above. It signs sessions and encrypts
 * the ID-token signing key, so on an issuer anyone can reach — the ngrok host
 * `bun run dev` is documented behind — anyone could forge a session or a
 * token. Only localhost and 127.0.0.1 keep the zero-config fallback, which is
 * what a fresh clone boots on. The refusal makes the provider fail closed
 * (`instance.ts`): no sign-in, no approval, no hop-2 exchange, and `/health`
 * says why in these words.
 */
export function publicHostWithoutSecret(baseURL: string): string | null {
  const host = new URL(baseURL).hostname;
  if (host === "localhost" || host === "127.0.0.1") return null;
  return (
    `BETTER_AUTH_SECRET is not set and the issuer is ${baseURL}, which is not this machine: ` +
    `the development secret is published in this repository, so the identity module will not sign ` +
    `sessions or tokens with it. Run \`bun run setup-arcade ${host}\`, which fills it in, or set ` +
    `BETTER_AUTH_SECRET in .env (openssl rand -hex 32), and restart.`
  );
}

export function usingDevSecret(config: IdpConfig): boolean {
  return config.secret === DEV_SECRET;
}

/** Whether `POST /admin/reset` exists on this deployment. */
export function resetEnabled(config: IdpConfig): boolean {
  return config.resetToken.length > 0;
}
