/**
 * The OAuth clients: Arcade, and optionally a second Arcade registration.
 *
 * Better Auth generates `client_id` and `client_secret`; they cannot be pinned
 * from env. So they are born on first bootstrap, live in `idp.db`, and
 * `scripts/oauth-client.ts` prints them for whoever fills in the Arcade
 * dashboard (#13).
 *
 * Since #70 the secret is stored **hashed**, so it is readable exactly once —
 * by whoever created or rotated it. Everything here is still idempotent in the
 * sense that matters: a second call finds the existing client and returns the
 * same `client_id`, never a new one. It just cannot hand the secret back.
 *
 * Since #79 there may be more than one. A deployment that names extra keys in
 * `IDP_OAUTH_CLIENTS` gets one independent client per key — its own id, its own
 * hashed secret, its own redirect allowlist — because an Arcade **User Source**
 * and an Arcade **custom OAuth provider** are two registrations with two
 * generated redirect URIs, and a human may want them not to share a secret.
 * With the variable unset there is exactly one client and nothing about this
 * file's behaviour changes.
 */
import { generateRandomString } from "better-auth/crypto";

import type { Auth } from "./auth.ts";
import { decryptLegacyClientSecret, hashClientSecret, SCOPES } from "./auth.ts";
import { PRIMARY_CLIENT_KEY, type OAuthClientSpec } from "./config.ts";

/** Shown on the login and consent pages: "Arcade is asking you to sign in." */
export const OAUTH_CLIENT_NAME = "Arcade";

/**
 * The first client's row primary key, fixed. The `client_id` is generated, and
 * `name` has no unique index, so the row is found — and, if two bootstraps
 * interleave (the service booting on a fresh disk while someone runs
 * `oauth-client` in a shell), the second insert is refused — on the one column
 * SQLite will enforce for us.
 *
 * Since #79 every client key is a row id the same way; this is the one that is
 * always present, and the same string as `config.ts`'s `PRIMARY_CLIENT_KEY`.
 */
export const OAUTH_CLIENT_ROW_ID = PRIMARY_CLIENT_KEY;

/**
 * PKCE is **on**. OAuth 2.1 requires it, Better Auth defaults to it, and
 * Arcade supports it (`pkce.enabled: true`, S256) but ships with it off — #13
 * must turn it on when registering the provider, or the authorize step fails
 * with no hook fired and nothing on the panel. Stated here so the two sides
 * can be checked against one line.
 */
export const REQUIRE_PKCE = true;

/**
 * How a client proves who it is at `/oauth2/token`: **HTTP Basic**, the
 * credentials in the `Authorization` header, RFC 6749 §2.3.1.
 *
 * It was `client_secret_post` until #61. Two measurements forced the change.
 *
 * First, `@better-auth/oauth-provider` permits **exactly one** method per
 * client, and checks it *before* it checks the secret
 * (`utils-C2yu_zRr.mjs:640`):
 *
 * ```js
 * const registeredAuthMethod = client.tokenEndpointAuthMethod ?? "client_secret_basic";
 * if (authMethod && registeredAuthMethod !== authMethod)
 *   throwInvalidClient(`client registered for ${registeredAuthMethod} cannot use ${authMethod}`)
 * ```
 *
 * So there is no "accept both": whichever value this constant holds, the other
 * form is refused with `invalid_client`, and the refusal says nothing about
 * whether the secret was right. Nothing negotiates it — the client sends one
 * form and we either registered for it or we did not.
 *
 * Second, Arcade sends Basic. `client_secret_basic` is the Arcade dashboard's
 * default for a custom OAuth provider, and an Arcade **User Source** form has
 * no auth-method field at all — so a User Source can only ever be registered
 * against a client that accepts Basic. Spike #75 measured `cg-demo-us` getting
 * through consent at this IdP and then failing with `Token exchange with
 * identity provider failed`; a client registered for the post form is the
 * explanation that fits.
 *
 * Registering for the method Arcade already defaults to is also what makes the
 * registration **dashboard-only**, which is what this issue is for: nobody has
 * to change a field they would not otherwise have touched.
 *
 * Arcade's custom provider then sends the credentials **twice** — Basic *and*
 * the template's `client_id`/`client_secret` parameter rows — which is a
 * separate problem, solved at the token endpoint rather than here: see
 * `src/index.ts`, `classifyDualCredentials` (#79).
 */
export const TOKEN_ENDPOINT_AUTH_METHOD = "client_secret_basic";

/**
 * What happened to the stored client secret on this call. Reported in the boot
 * log and at `/health`, because the two outcomes that are not `unchanged` have
 * opposite consequences for the Arcade registration and telling them apart
 * from the outside is otherwise impossible (#70).
 */
export type ClientSecretState =
  /** The client row already stored a hash. Nothing happened. */
  | "unchanged"
  /** This call created the client. The secret is in `clientSecret` and will never be readable again. */
  | "created"
  /**
   * The row held a secret encrypted by the pre-#70 build. It was decrypted and
   * re-hashed in place: **same client id, same secret, the Arcade registration
   * is still valid.**
   */
  | "migrated"
  /**
   * The row held a pre-#70 encrypted secret this `BETTER_AUTH_SECRET` cannot
   * decrypt, so the secret was unrecoverable and a new one was minted under
   * the same client id. **Arcade must be re-registered.**
   */
  | "rotated";

/** One line a human can act on, for the boot log and `/health`. */
export const CLIENT_SECRET_STATE_MESSAGE: Record<ClientSecretState, string> = {
  unchanged: "stored hashed; it cannot be printed again — `bun run oauth-client --rotate` mints a new one",
  created:
    "created on this boot and never disclosed — run `bun run oauth-client --rotate` to mint one you can read",
  migrated:
    "re-hashed in place from the pre-#70 encrypted form; client id and secret UNCHANGED, the Arcade registration is still valid",
  rotated:
    "ROTATED: the pre-#70 encrypted secret could not be decrypted with this BETTER_AUTH_SECRET. The Arcade cg-idp provider MUST be re-registered — run `bun run oauth-client --rotate` to print a readable secret",
};

export interface OAuthClientCredentials {
  /** The row's primary key, and the name this client is configured under. */
  key: string;
  /** What the login and consent pages call it. */
  name: string;
  clientId: string;
  /**
   * The secret in plaintext, and **only** when this call is the one that
   * produced it — creation or rotation. `null` on every later call: storage is
   * hashed, so there is nothing to read back. See `ClientSecretState`.
   */
  clientSecret: string | null;
  redirectUris: string[];
  /** True when this call created the client; false when it already existed. */
  created: boolean;
  secretState: ClientSecretState;
  /** What the client row now registers for at the token endpoint. Always `TOKEN_ENDPOINT_AUTH_METHOD`. */
  tokenEndpointAuthMethod: string;
  /**
   * True when this call brought an existing row's method in line — the #61
   * upgrade on the live disk. Said out loud at boot, because it is the moment
   * the Arcade dashboard field stops matching what this service accepts.
   */
  authMethodReconciled: boolean;
}

interface StoredClient {
  id: string;
  clientId: string;
  clientSecret: string | null;
  name: string | null;
  redirectUris: string | string[];
  /** `null` on a row written before the column was set. Better Auth then reads it as `client_secret_basic`. */
  tokenEndpointAuthMethod: string | null;
}

/** How long a secret Better Auth generates is, and what `--rotate` mints. */
const SECRET_LENGTH = 48;

/** The one client every deployment has, when only its redirect URIs are known. */
function primarySpec(redirectUris: string[]): OAuthClientSpec {
  return { key: OAUTH_CLIENT_ROW_ID, name: OAUTH_CLIENT_NAME, redirectUris };
}

/**
 * A secret written by the pre-#70 build: `symmetricEncrypt` with a string key
 * returns bare lowercase hex (xchacha20poly1305, 24-byte nonce + ciphertext +
 * 16-byte tag), so the shortest possible one is far longer than the 43
 * base64url characters a SHA-256 hash occupies. The shape is only a cheap
 * pre-filter — `decryptLegacyClientSecret` is the actual test, and the cipher
 * is authenticated, so it cannot mistake anything else for a legacy secret.
 */
function looksLikeLegacyCipherText(stored: string): boolean {
  return /^[0-9a-f]{64,}$/.test(stored) && stored.length % 2 === 0;
}

/**
 * Carries the live `cg-idp` client across #70's change of storage.
 *
 * Before #70 the secret was stored **encrypted** so `oauth-client` could
 * re-print it. Enabling the JWT plugin — which is what publishes the `jwks_uri`
 * an Arcade User Source requires (#65) — makes encrypted storage illegal; the
 * plugin throws `encryption method not recommended` at init. Storage becomes
 * hashed, and the secret already on the disk would never verify again.
 *
 * So the encrypted value is read one last time, with the same
 * `BETTER_AUTH_SECRET` that wrote it, and stored as the hash the plugin will
 * check from now on. **The client id and the secret both survive**, which is
 * the whole point: the credentials in the Arcade dashboard keep working and
 * nobody has to re-register anything.
 *
 * If it cannot be decrypted — a changed `BETTER_AUTH_SECRET`, a hand-edited
 * row — the secret is gone either way, since nothing can turn that value back
 * into something the token endpoint accepts. Leaving it would be a client that
 * silently fails to authenticate at the token endpoint, where no hook fires
 * and the panel stays dark (DESIGN.md, and the reason `bun run reset` exists
 * in the shape it does). So it is rotated instead, and said loudly, twice: in
 * the boot log and at `/health`.
 */
async function migrateStoredClientSecret(
  auth: Auth,
  existing: StoredClient,
  secret: string,
): Promise<{ state: ClientSecretState; clientSecret: string | null }> {
  if (!looksLikeLegacyCipherText(existing.clientSecret!)) {
    return { state: "unchanged", clientSecret: null };
  }

  const ctx = await auth.$context;

  let plaintext: string | null = null;
  try {
    plaintext = await decryptLegacyClientSecret(secret, existing.clientSecret!);
  } catch {
    plaintext = null;
  }

  const rotated = plaintext === null;
  const clientSecret = plaintext ?? generateRandomString(SECRET_LENGTH, "a-z", "A-Z", "0-9");

  await ctx.adapter.update({
    model: "oauthClient",
    where: [{ field: "id", value: existing.id }],
    update: { clientSecret: await hashClientSecret(clientSecret), updatedAt: new Date() },
  });

  return {
    state: rotated ? "rotated" : "migrated",
    // On a migration the caller already has whatever Arcade holds, and
    // printing it would put a still-valid secret into a boot log. Only the
    // rotation produces a secret nobody has yet.
    clientSecret: rotated ? clientSecret : null,
  };
}

/**
 * Mints a new secret for the existing client id, and returns it — the one
 * other moment a secret is readable.
 *
 * A lost secret must not cost a new client id: the id is half of what is
 * registered in Arcade, and changing it means editing more fields under more
 * pressure. Rotating leaves the id, the redirect URIs and every consent alone.
 * Exported for `scripts/oauth-client.ts --rotate`.
 *
 * `key` picks which client, so rotating the second one leaves the first's
 * secret — and therefore the registration built on it — untouched (#79).
 */
export async function rotateOAuthClientSecret(
  auth: Auth,
  key: string = OAUTH_CLIENT_ROW_ID,
): Promise<OAuthClientCredentials> {
  const ctx = await auth.$context;
  const existing = await findStoredClient(auth, key);
  if (!existing) throw new Error(`No OAuth client to rotate: idp.db holds no row with id "${key}"`);

  const clientSecret = generateRandomString(SECRET_LENGTH, "a-z", "A-Z", "0-9");
  await ctx.adapter.update({
    model: "oauthClient",
    where: [{ field: "id", value: existing.id }],
    update: { clientSecret: await hashClientSecret(clientSecret), updatedAt: new Date() },
  });

  return {
    key,
    name: existing.name ?? OAUTH_CLIENT_NAME,
    clientId: existing.clientId,
    clientSecret,
    redirectUris: parseUris(existing.redirectUris),
    created: false,
    secretState: "rotated",
    // Rotation touches the secret and nothing else; `ensureOAuthClients` ran
    // first (both callers) and is what reconciles the method.
    tokenEndpointAuthMethod: existing.tokenEndpointAuthMethod ?? TOKEN_ENDPOINT_AUTH_METHOD,
    authMethodReconciled: false,
  };
}

/**
 * Finds every configured client or creates it, in the order configured.
 *
 * The clients are independent: one secret each, one redirect allowlist each,
 * and rotating or creating one never writes to another's row. That is the
 * point of #79 — the human may hold two Arcade registrations, and a mistake on
 * one must not cost the other.
 */
export async function ensureOAuthClients(
  auth: Auth,
  { clients, secret }: { clients: OAuthClientSpec[]; secret: string },
): Promise<OAuthClientCredentials[]> {
  await adoptLegacyPrimaryRow(auth);

  const keys = clients.map((spec) => spec.key);
  const ensured: OAuthClientCredentials[] = [];
  for (const spec of clients) ensured.push(await ensureOne(auth, spec, secret, keys));
  return ensured;
}

/**
 * The first client, for callers that only ever had one. Same behaviour as
 * before #79 — including the refusal to create a row while a row this service
 * did not write exists.
 */
export async function ensureOAuthClient(
  auth: Auth,
  { redirectUris, secret }: { redirectUris: string[]; secret: string },
): Promise<OAuthClientCredentials> {
  const [client] = await ensureOAuthClients(auth, { clients: [primarySpec(redirectUris)], secret });
  return client!;
}

/**
 * Finds one client or creates it. On the existing client, brings the
 * redirect URIs **and the token-endpoint auth method** in line without touching
 * the credentials — Arcade's generated redirect URL is read off its dashboard,
 * so it may only be known after the first deploy, and correcting either of them
 * must not rotate anything — and carries a secret stored by the pre-#70 build
 * into hashed storage, see `migrateStoredClientSecret`.
 *
 * The method has to be reconciled here, not only set at creation, for the same
 * reason the redirect URIs are: `idp.db` is on a Render disk and the live
 * `cg-idp` client row was written by an earlier build. A constant changed in
 * this file and nowhere else would leave that row on `client_secret_post`
 * forever, and the failure lands at the token endpoint — server to server,
 * no hook, nothing on the panel (#61).
 */
async function ensureOne(
  auth: Auth,
  spec: OAuthClientSpec,
  secret: string,
  configuredKeys: string[],
): Promise<OAuthClientCredentials> {
  const ctx = await auth.$context;
  const existing = await findStoredClient(auth, spec.key);

  if (existing) {
    if (!existing.clientSecret) {
      throw new Error(`OAuth client "${spec.name}" has no stored secret`);
    }

    // A row written before the column existed reads as null, which Better
    // Auth treats as `client_secret_basic` — already what we want, so it is
    // still written, but it is not a change anyone has to act on.
    const authMethodReconciled =
      existing.tokenEndpointAuthMethod !== null &&
      existing.tokenEndpointAuthMethod !== TOKEN_ENDPOINT_AUTH_METHOD;

    const stored = parseUris(existing.redirectUris);
    const update: Record<string, unknown> = {};
    if (!sameSet(stored, spec.redirectUris)) update.redirectUris = spec.redirectUris;
    if (existing.tokenEndpointAuthMethod !== TOKEN_ENDPOINT_AUTH_METHOD) {
      update.tokenEndpointAuthMethod = TOKEN_ENDPOINT_AUTH_METHOD;
    }
    if (Object.keys(update).length > 0) {
      await ctx.adapter.update({
        model: "oauthClient",
        where: [{ field: "id", value: existing.id }],
        update: { ...update, updatedAt: new Date() },
      });
    }

    const migration = await migrateStoredClientSecret(auth, existing, secret);

    return {
      key: spec.key,
      name: existing.name ?? spec.name,
      clientId: existing.clientId,
      clientSecret: migration.clientSecret,
      redirectUris: spec.redirectUris,
      created: false,
      secretState: migration.state,
      tokenEndpointAuthMethod: TOKEN_ENDPOINT_AUTH_METHOD,
      authMethodReconciled,
    };
  }

  await refuseToMintBesideAStrangerRow(auth, spec.key, configuredKeys);

  // Written through Better Auth's adapter rather than its create-client
  // endpoints: every one of those, the admin one included, demands a signed-in
  // user and records that user as the client's owner — and `oauthClient.userId`
  // cascades on delete, so a reset that removes the people would remove the
  // client with them. That is the exact failure this service must not have.
  // Written this way the client belongs to nobody and outlives every reset.
  const clientId = generateRandomString(32, "a-z", "A-Z", "0-9");
  const clientSecret = generateRandomString(SECRET_LENGTH, "a-z", "A-Z", "0-9");
  const now = new Date();

  try {
    await ctx.adapter.create({
      model: "oauthClient",
      forceAllowId: true,
      data: {
        id: spec.key,
        clientId,
        clientSecret: await hashClientSecret(clientSecret),
        name: spec.name,
        redirectUris: spec.redirectUris,
        scopes: [...SCOPES],
        tokenEndpointAuthMethod: TOKEN_ENDPOINT_AUTH_METHOD,
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        applicationType: "web",
        requirePKCE: REQUIRE_PKCE,
        skipConsent: false,
        disabled: false,
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch (error) {
    // Lost the race: another bootstrap inserted the row between our lookup
    // and our insert. Theirs is the client; ours never existed.
    if (!/UNIQUE|constraint/i.test(String(error))) throw error;
    return ensureOne(auth, spec, secret, configuredKeys);
  }

  return {
    key: spec.key,
    name: spec.name,
    clientId,
    clientSecret,
    redirectUris: spec.redirectUris,
    created: true,
    secretState: "created",
    // Born correct, so there is nothing for a human to re-enter.
    authMethodReconciled: false,
    tokenEndpointAuthMethod: TOKEN_ENDPOINT_AUTH_METHOD,
  };
}

/** One client row, by its fixed key. */
async function findStoredClient(auth: Auth, key: string): Promise<StoredClient | null> {
  const ctx = await auth.$context;
  return ctx.adapter.findOne<StoredClient>({
    model: "oauthClient",
    where: [{ field: "id", value: key }],
  });
}

/**
 * A row written before the primary key was fixed is adopted and re-keyed, not
 * replaced: its `client_id` is what Arcade holds.
 *
 * Only the first client has ever had such a row, and only when exactly one row
 * carries the old name — two would be ambiguous, and the guard below is the
 * right answer to ambiguity.
 */
async function adoptLegacyPrimaryRow(auth: Auth): Promise<void> {
  const ctx = await auth.$context;
  if (await findStoredClient(auth, OAUTH_CLIENT_ROW_ID)) return;

  const byName = await ctx.adapter.findMany<StoredClient>({
    model: "oauthClient",
    where: [{ field: "name", value: OAUTH_CLIENT_NAME }],
    limit: 2,
  });
  if (byName.length !== 1) return;

  await ctx.adapter.update({
    model: "oauthClient",
    where: [{ field: "id", value: byName[0]!.id }],
    update: { id: OAUTH_CLIENT_ROW_ID },
  });
}

/**
 * The one rule of client creation: **never mint credentials while a client row
 * this service did not write exists.** Arcade holds whatever was issued first;
 * a second issuance is a silent rotation, and it fails at the authorize step
 * where no hook fires.
 *
 * "Did not write" means: not one of the keys this process is configured for.
 * A row for a configured key is ours, so creating the *other* configured
 * client beside it is safe — that is exactly what turning on a second client
 * does. Anything else and the boot fails loudly rather than serve credentials
 * Arcade does not have. A dead service is a thing a human can act on.
 */
async function refuseToMintBesideAStrangerRow(
  auth: Auth,
  key: string,
  configuredKeys: string[],
): Promise<void> {
  const ctx = await auth.$context;
  const rows = await ctx.adapter.findMany<StoredClient>({ model: "oauthClient", limit: 100 });
  const strangers = rows.filter((row) => !configuredKeys.includes(row.id));
  if (strangers.length === 0) return;

  // The legacy count is still named, because two rows carrying the old name is
  // the one ambiguity `adoptLegacyPrimaryRow` deliberately refuses to resolve.
  const byLegacyName = strangers.filter((row) => row.name === OAUTH_CLIENT_NAME).length;

  throw new Error(
    `idp.db holds ${strangers.length} OAuth client row(s) this service did not write ` +
      `(none with id "${key}", ${byLegacyName} named "${OAUTH_CLIENT_NAME}", ` +
      `configured keys ${configuredKeys.map((configured) => JSON.stringify(configured)).join(", ")}). ` +
      `Refusing to create another: the credentials registered in Arcade may be one of these. ` +
      `Inspect the oauthClient table and re-key the right row to id "${key}".`,
  );
}

/** Looks the client up by `client_id`, for the consent page's "X wants access" line. */
export async function findClientName(auth: Auth, clientId: string): Promise<string | null> {
  const ctx = await auth.$context;
  const client = await ctx.adapter.findOne<{ name: string | null }>({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
  return client?.name ?? null;
}

function parseUris(value: string | string[]): string[] {
  return Array.isArray(value) ? value : (JSON.parse(value) as string[]);
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((uri, i) => uri === [...b].sort()[i]);
}
