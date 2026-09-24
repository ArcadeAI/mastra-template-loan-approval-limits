/**
 * Prints what the Arcade dashboard needs (#13): the client id, the endpoints,
 * and — exactly once, at the moment it produces one — the client secret.
 *
 *   bun run --cwd apps/idp oauth-client            # id and endpoints, every client
 *   bun run --cwd apps/idp oauth-client --json     # the same, machine-readable
 *   bun run --cwd apps/idp oauth-client --rotate   # mint a new secret, same client id
 *   bun run --cwd apps/idp oauth-client --client <key> --rotate   # rotate just that one
 *
 * **The secret is stored hashed and cannot be shown twice.** Before #70 it was
 * stored encrypted and this script could re-print it on any later day; that is
 * only permitted with the JWT plugin off, which is what left this IdP with no
 * `jwks_uri` and unable to back an Arcade User Source (#65). So: write it down
 * when it appears, and if it is lost, `--rotate` mints a new one under the
 * **same client id** — a lost secret costs one field in the Arcade dashboard,
 * not a re-registration.
 *
 * With more than one client configured (`IDP_OAUTH_CLIENTS`, #79) every client
 * is printed, and `--rotate` demands `--client <key>`: rotating a secret costs
 * a human a dashboard field, and which registration it costs must not be a
 * guess this script makes on their behalf.
 *
 * On Render: open a shell on the cg-idp service and run the same command.
 */
import { createAuth, JWKS_PATH } from "../src/auth.ts";
import {
  ensureOAuthClients,
  type OAuthClientCredentials,
  REQUIRE_PKCE,
  rotateOAuthClientSecret,
  TOKEN_ENDPOINT_AUTH_METHOD,
} from "../src/client.ts";
import { readConfig } from "../src/config.ts";
import { openPeople } from "../src/db.ts";

const config = readConfig();
const db = await openPeople(config.dbPath);
const auth = createAuth({ db, baseURL: config.baseURL, secret: config.secret });

const json = process.argv.includes("--json");
const rotate = process.argv.includes("--rotate");

const clientFlag = process.argv.indexOf("--client");
const selected = clientFlag === -1 ? null : process.argv[clientFlag + 1];
if (clientFlag !== -1 && !config.clients.some((spec) => spec.key === selected)) {
  console.error(
    `[idp] --client ${selected ?? "(missing)"}: not configured. ` +
      `IDP_OAUTH_CLIENTS names ${config.clients.map((spec) => spec.key).join(", ")}.`,
  );
  process.exit(2);
}

// Always first, even when rotating: it is what creates the clients on an empty
// database, and what carries a pre-#70 encrypted secret into hashed storage.
const ensured = await ensureOAuthClients(auth, { clients: config.clients, secret: config.secret });

/** The one this invocation is about: `--client`, or the first. */
const target = ensured.find((each) => each.key === (selected ?? ensured[0]!.key))!;

if (rotate && selected === null && ensured.length > 1) {
  console.error(
    `[idp] --rotate needs --client when more than one client is configured: ` +
      `${ensured.map((each) => each.key).join(", ")}. Rotating costs one field in one ` +
      `Arcade registration, and this script will not choose which.`,
  );
  process.exit(2);
}

// Rotating a client this call just created would throw away a secret nobody
// has seen and mint a second one for no reason.
const rotated = rotate && !target.created ? await rotateOAuthClientSecret(auth, target.key) : null;

/** What is printed: every configured client, with the rotation folded into its entry. */
const printed: OAuthClientCredentials[] = ensured.map((each) =>
  rotated && each.key === rotated.key ? rotated : each,
);
const client = printed.find((each) => each.key === target.key)!;

if (config.baseURLIsFallback) {
  // The credentials are right regardless; the three URLs are not. On Render
  // this means the shell did not carry RENDER_EXTERNAL_URL — set IDP_PUBLIC_URL
  // on the service, or read the URLs off /health, which the running service
  // computes from its own environment.
  console.error(
    `[idp] warning: no IDP_PUBLIC_URL or RENDER_EXTERNAL_URL set — the URLs below point at ` +
      `${config.baseURL}, which is not the address Arcade should be given.`,
  );
}

/** Why the secret is or is not on screen. One sentence, no euphemism. */
function secretNoteFor(each: OAuthClientCredentials): string {
  if (each.clientSecret === null) {
    return "not shown — the stored secret is hashed and cannot be printed again; run with --rotate to mint a new one under the same client id";
  }
  return each.secretState === "rotated"
    ? "NEW — the previous secret no longer works. Update it in the Arcade dashboard; the client id is unchanged."
    : "shown once, now — it is stored hashed and cannot be printed again. Write it down.";
}

const secretNote = secretNoteFor(client);

if (json) {
  console.log(
    JSON.stringify(
      {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        client_secret_state: client.secretState,
        client_secret_note: secretNote,
        created: client.created,
        rotated: client.secretState === "rotated",
        issuer: config.baseURL,
        authorize_url: `${config.baseURL}/oauth2/authorize`,
        token_url: `${config.baseURL}/oauth2/token`,
        userinfo_url: `${config.baseURL}/oauth2/userinfo`,
        jwks_url: `${config.baseURL}${JWKS_PATH}`,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: TOKEN_ENDPOINT_AUTH_METHOD,
        pkce: REQUIRE_PKCE ? "S256" : "off",
        scopes: "openid profile email offline_access",
        userinfo_email_jsonpath: "$.email",
        // Every configured client, this one included. One entry unless
        // IDP_OAUTH_CLIENTS names more (#79); the fields above are this entry,
        // so nothing that read this document before has to change.
        clients: printed.map((each) => ({
          key: each.key,
          name: each.name,
          client_id: each.clientId,
          client_secret: each.clientSecret,
          client_secret_state: each.secretState,
          client_secret_note: secretNoteFor(each),
          created: each.created,
          redirect_uris: each.redirectUris,
        })),
      },
      null,
      2,
    ),
  );
} else {
  for (const each of printed) {
    console.log(
      `OAuth client "${each.name}" (${each.key}) ${each.created ? "created" : "existing"} in ${config.dbPath}\n`,
    );
    console.log(`  client_id         ${each.clientId}`);
    console.log(`  client_secret     ${each.clientSecret ?? "(not shown)"}`);
    console.log(`                    ${secretNoteFor(each)}`);
    console.log(`  redirect URIs     ${each.redirectUris.join(", ")}`);
    console.log("");
  }
  console.log(`  authorize URL     ${config.baseURL}/oauth2/authorize`);
  console.log(`  token URL         ${config.baseURL}/oauth2/token`);
  console.log(`  userinfo URL      ${config.baseURL}/oauth2/userinfo`);
  console.log(`  JWKS URL          ${config.baseURL}${JWKS_PATH}`);
  console.log(
    `  client auth       ${TOKEN_ENDPOINT_AUTH_METHOD} (HTTP Basic — this is the Arcade dashboard default)`,
  );
  console.log(`  PKCE              ${REQUIRE_PKCE ? "required, S256 — enable it on the Arcade side" : "off"}`);
  console.log(`  scopes            openid profile email offline_access`);
  console.log(`  identity          userinfo JSONPath $.email`);
}

db.close();
