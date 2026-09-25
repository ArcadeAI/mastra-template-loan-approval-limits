/**
 * `bun run setup-arcade <ngrok-host> [--dry-run] [--gateway <slug>]` (#9)
 *
 * Everything the Arcade side of this template needs, from one command, after
 * the developer has filled in the few required values in `.env`
 * (`ARCADE_API_KEY` among them). In order:
 *
 * 1. **Refuses** to go on if `.env` is tracked by git or not gitignored: this
 *    command writes secrets into it.
 * 2. **Reads** the hop-2 provider `app-identity` back from Arcade. It is
 *    create-only (DESIGN.md → "Arcade config is read-only"): if it exists and
 *    differs from what this app needs, the differences are printed and the run
 *    stops, having written nothing.
 * 3. **Mints** the app's three OAuth clients in `idp.db`: `arcade` (hop 2),
 *    `arcade-user-source` (hop 1) and `web` (the app's own sign-in).
 * 4. **Fills in `.env`**, blanks only, never overwriting: `APP_PUBLIC_HOST`,
 *    `SESSION_SECRET`, `BETTER_AUTH_SECRET`, `ARCADE_HOOK_SIGNING_SECRET`, `APPROVALS_STORE_TOKEN`,
 *    `IDP_OAUTH_CLIENTS` and the clients' redirect URIs, `IDP_CLIENT_ID` and
 *    `IDP_CLIENT_SECRET`, `ARCADE_GATEWAY_ID`, and `GOVERNANCE_STREAM=hooks`.
 * 5. **Registers by API**: the provider, the tool secrets `APP_PUBLIC_HOST`
 *    and `APPROVALS_STORE_TOKEN`, the hook extension (three URLs and
 *    `health_check_path`), and the custom verifier, which it reads back.
 * 6. **Prints** the two dashboard forms the API cannot fill, the User Source
 *    and the gateway, and what is left, in the README Quickstart's order:
 *    restart the app, start the tunnel, fill in the User Source form,
 *    `arcade deploy` both toolkits, fill in the gateway form, open the app.
 *
 * `--dry-run` writes nothing and sends nothing: it prints every request a real
 * run makes, in order, with the key and every secret as a placeholder. Which
 * registration goes which way, and the spec path of each call, is in
 * `scripts/setup-arcade/arcade.ts`. `app-test/setup-arcade.test.ts` runs this
 * against a local stand-in; it has never been run against the real API.
 *
 * Run it with `--no-env-file` (the package script does): it reads `.env` and
 * `.env.local` itself, so it knows which values `.env` holds and which come
 * from elsewhere, and writes only to `.env`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ArcadeAdmin, ArcadeError, pluginBody, PLUGIN_NAME, PROVIDER_ID, providerBody, providerDifferences, type Registration, verifierBody } from "./setup-arcade/arcade.ts";
import { fillBlanks, parseEnv, readEnvFile, writeEnvFile } from "./setup-arcade/env-file.ts";
import { gatewayForm, nextSteps, userSourceForm } from "./setup-arcade/forms.ts";

const USER_SOURCE_CALLBACK = "https://cloud.arcade.dev/oauth2/intermediate_callback";
const CLIENT_KEYS = ["arcade", "arcade-user-source", "web"] as const;
const DEFAULT_GATEWAY = "loan-approval-limits";

const out = (line = "") => console.log(line);
function fail(message: string, code = 1): never {
  console.error(`\nsetup-arcade: ${message}`);
  process.exit(code);
}

// --- Arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const gatewayFlag = argv.indexOf("--gateway");
const gatewaySlug = gatewayFlag === -1 ? null : argv[gatewayFlag + 1];
const positional = argv.filter((arg, i) => !arg.startsWith("--") && !(gatewayFlag !== -1 && i === gatewayFlag + 1));

if (positional.length !== 1) {
  fail(
    "usage: bun run setup-arcade <ngrok-host> [--dry-run] [--gateway <slug>]\n" +
      "  <ngrok-host> is the public host Arcade reaches this app at, e.g. my-app.ngrok.app",
    64,
  );
}
if (gatewaySlug !== null && !/^[a-z0-9][a-z0-9-]*$/.test(gatewaySlug ?? "")) {
  fail(`--gateway ${gatewaySlug ?? "(missing)"}: a slug is lowercase letters, digits and hyphens`, 64);
}

// A pasted URL is accepted and cut down to the host form everything else uses.
const host = positional[0]!.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
if (!/^[a-z0-9.-]+(:\d+)?$/.test(host) || !host.includes(".")) {
  fail(`${positional[0]} is not a public host. Pass the ngrok domain, e.g. my-app.ngrok.app`, 64);
}
if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
  fail(`${host} is this machine; Arcade Cloud cannot reach it. Pass the ngrok domain that tunnels to it.`, 64);
}
const origin = `https://${host}`;

// --- The environment, the way Bun would load it for the app -----------------

const cwd = process.cwd();
const envPath = join(cwd, ".env");
const examplePath = join(cwd, ".env.example");
let envText = readEnvFile(envPath);
const envExists = existsSync(envPath);
if (!envExists && existsSync(examplePath)) envText = readFileSync(examplePath, "utf8");
const fileEnv = parseEnv(envText);
const localEnv = parseEnv(readEnvFile(join(cwd, ".env.local")));
// Real environment first, then .env.local, then .env: Bun's own precedence.
for (const source of [localEnv, fileEnv]) {
  for (const [key, value] of Object.entries(source)) if (process.env[key] === undefined) process.env[key] = value;
}
// What the app would see, frozen before this run adds its own values to
// `process.env` for the identity module below.
const loaded: Record<string, string | undefined> = { ...process.env };
const effective = (key: string): string => loaded[key]?.trim() ?? "";
/** Set somewhere other than `.env`, which is where the app will read it from. */
const setElsewhere = (key: string): boolean => effective(key) !== "" && (fileEnv[key]?.trim() ?? "") !== effective(key);

out(dryRun ? "setup-arcade --dry-run: nothing is written and nothing is sent.\n" : "setup-arcade");
out(`  public host   ${host}  (${origin})`);

// --- 1. .env must be private ------------------------------------------------

function git(...args: string[]): number {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode;
}
if (git("rev-parse", "--is-inside-work-tree") === 0) {
  if (git("ls-files", "--error-unmatch", ".env") === 0) {
    fail(".env is tracked by git, and this command writes secrets into it. Untrack it first: git rm --cached .env");
  }
  if (git("check-ignore", "-q", ".env") !== 0) {
    fail(".env is not gitignored, and this command writes secrets into it. Add `.env` to .gitignore first.");
  }
} else {
  out("  warning       this is not a git work tree, so nothing checked that .env is kept out of version control");
}

// --- Inputs -----------------------------------------------------------------

const onFile = fileEnv.APP_PUBLIC_HOST?.trim() ?? "";
if (onFile !== "" && onFile.toLowerCase() !== host) {
  fail(`.env has APP_PUBLIC_HOST=${onFile}, and this run was given ${host}. Pass ${onFile}, or blank it in .env to use ${host}.`);
}
if (setElsewhere("APP_PUBLIC_HOST") && effective("APP_PUBLIC_HOST").toLowerCase() !== host) {
  out(`  warning       APP_PUBLIC_HOST=${effective("APP_PUBLIC_HOST")} is set outside .env (.env.local or the shell) and wins over it when the app runs`);
}
const apiKey = effective("ARCADE_API_KEY");
if (apiKey === "" && !dryRun) fail("ARCADE_API_KEY is blank. Fill it in .env (Arcade dashboard → API keys), then run this again.");
const apiUrl = (effective("ARCADE_API_URL") || "https://api.arcade.dev").replace(/\/+$/, "");
const slug = gatewaySlug ?? (effective("ARCADE_GATEWAY_ID") || DEFAULT_GATEWAY);
const onFileGateway = fileEnv.ARCADE_GATEWAY_ID?.trim() ?? "";
if (gatewaySlug !== null && onFileGateway !== "" && onFileGateway !== gatewaySlug) {
  fail(`.env has ARCADE_GATEWAY_ID=${onFileGateway}, and this run was given --gateway ${gatewaySlug}. Blank it in .env to use ${gatewaySlug}.`);
}

const configuredClients = effective("IDP_OAUTH_CLIENTS");
if (configuredClients !== "") {
  const listed = configuredClients.split(",").map((each) => each.trim());
  const missing = CLIENT_KEYS.filter((key) => key !== "arcade" && !listed.includes(key));
  if (missing.length > 0) {
    fail(`IDP_OAUTH_CLIENTS=${configuredClients} leaves out ${missing.join(", ")}. Add ${missing.length === 1 ? "it" : "them"}, or blank it.`);
  }
}

/** A value this run needs: what the app already has, else a fresh one. */
function secretFor(key: string): { value: string; generated: boolean } {
  const existing = effective(key);
  if (existing !== "") return { value: existing, generated: false };
  if (dryRun) return { value: `<generated ${key}>`, generated: true };
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { value: Buffer.from(bytes).toString("hex"), generated: true };
}

const sessionSecret = secretFor("SESSION_SECRET");
// The identity provider's own secret (#9). On a public host it refuses the
// published development one, and it must exist before the clients are minted
// below: `oauth-client` reads the same configuration the provider boots on.
const identitySecret = secretFor("BETTER_AUTH_SECRET");
const hookToken = secretFor("ARCADE_HOOK_SIGNING_SECRET");
const storeToken = secretFor("APPROVALS_STORE_TOKEN");

/** Everything this run writes to `.env`, before the clients are minted. */
const planned: Record<string, string> = {
  APP_PUBLIC_HOST: host,
  SESSION_SECRET: sessionSecret.value,
  BETTER_AUTH_SECRET: identitySecret.value,
  ARCADE_HOOK_SIGNING_SECRET: hookToken.value,
  APPROVALS_STORE_TOKEN: storeToken.value,
  IDP_OAUTH_CLIENTS: CLIENT_KEYS.join(","),
  IDP_OAUTH_REDIRECT_URIS_WEB: `${origin}/api/auth/callback`,
  IDP_OAUTH_REDIRECT_URIS_ARCADE_USER_SOURCE: USER_SOURCE_CALLBACK,
  ARCADE_GATEWAY_ID: slug,
  // Arcade calls the hooks from here on, so the panel watches them rather
  // than the fixture replay a blank value means under `next dev`.
  GOVERNANCE_STREAM: "hooks",
};
// The identity module reads these from the environment when it mints. The
// host is always this run's: an `.env.local` naming localhost must not make
// it mint for another issuer.
for (const [key, value] of Object.entries(planned)) if (effective(key) === "") process.env[key] = value;
process.env.APP_PUBLIC_HOST = host;

const admin = new ArcadeAdmin(apiUrl, apiKey, dryRun, out);

// --- Dry run: the whole sequence, nothing sent ------------------------------

if (dryRun) {
  const keys = Object.keys(planned).filter((key) => (fileEnv[key]?.trim() ?? "") === "" && !setElsewhere(key));
  out(`\n.env${envExists ? "" : " (created from .env.example)"}: would fill ${[...keys, "IDP_CLIENT_ID", "IDP_CLIENT_SECRET"].join(", ")}`);
  out("  and IDP_OAUTH_REDIRECT_URIS_ARCADE, with the callback Arcade generates for the provider");
  out(`idp.db: would mint the OAuth clients ${CLIENT_KEYS.join(", ")} (a client that already exists keeps its id)`);
  out(`\nRequests, in order (${apiUrl}):`);
  const registration: Registration = {
    host,
    origin,
    arcadeClientId: "<the arcade client id in idp.db>",
    arcadeClientSecret: "<the arcade client secret, minted by this run>",
    hookToken: hookToken.generated ? hookToken.value : "<ARCADE_HOOK_SIGNING_SECRET from .env>",
    approvalsStoreToken: storeToken.generated ? storeToken.value : "<APPROVALS_STORE_TOKEN from .env>",
  };
  await admin.request("GET", `/v1/admin/auth_providers/${PROVIDER_ID}`);
  out("    (404: the provider is created below. 200: it is compared, and a difference stops the run.)");
  await admin.request("POST", "/v1/admin/auth_providers", providerBody(registration));
  await admin.request("POST", "/v1/admin/secrets/APP_PUBLIC_HOST", { value: host, description: "The app's public host (setup-arcade)" });
  await admin.request("POST", "/v1/admin/secrets/APPROVALS_STORE_TOKEN", { value: registration.approvalsStoreToken, description: "Bearer for the app's approvals store (setup-arcade)" });
  await admin.request("GET", "/v1/plugins?limit=100");
  out(`    (a plugin named ${PLUGIN_NAME} is PATCHed to the body below; otherwise it is created)`);
  await admin.request("POST", "/v1/plugins", pluginBody(registration));
  await admin.request("PATCH", "/v1/plugins/<id>", { status: "active" });
  await admin.request("GET", "/v1/plugins/<id>");
  await admin.request("PUT", "/v1/admin/settings/session_verification", verifierBody(origin));
  await admin.request("GET", "/v1/admin/settings/session_verification");
  out("\nThen two dashboard forms, which Arcade's API cannot fill:\n");
  out(userSourceForm({ origin, clientId: "<the arcade-user-source client id>", clientSecret: "<its secret, minted by this run>" }));
  out();
  out(gatewayForm({ slug, loanToolkit: effective("ARCADE_LOAN_TOOLKIT") || "Loan", approvalsToolkit: effective("ARCADE_APPROVALS_TOOLKIT") || "Approvals" }));
  out();
  out(nextSteps({ host, origin, port: effective("PORT") || "3000" }));
  process.exit(0);
}

// --- 2. The provider is read back before anything is written ----------------

/**
 * The identity module's own tool, `bun run oauth-client`, as a subprocess.
 * Only the identity module mints (DESIGN.md → Services;
 * `app-test/identity/only-identity-mints.test.ts`), so this script never
 * imports the provider: it runs the same command a human would, with the
 * environment this run has built, and reads its `--json`.
 */
interface MintedClient {
  key: string;
  client_id: string;
  client_secret: string | null;
  created: boolean;
  redirect_uris: string[];
}
async function oauthClient(...args: string[]): Promise<MintedClient[]> {
  const run = Bun.spawn(["bun", "--no-env-file", join(import.meta.dir, "identity", "oauth-client.ts"), "--json", ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  if (code !== 0) fail(`bun run oauth-client ${args.join(" ")} exited ${code}:\n${stderr}`);
  const printed = (JSON.parse(stdout) as { clients: MintedClient[] }).clients;
  // A secret is printed only by the call that minted it, and every later call
  // lists that client again with none: keep each one this run has seen.
  for (const each of printed) if (each.client_secret !== null) minted.set(each.key, each.client_secret);
  return printed.map((each) => ({ ...each, client_secret: minted.get(each.key) ?? null }));
}
const minted = new Map<string, string>();

out(`\nArcade (${apiUrl}):`);
const existingProvider = await admin.request("GET", `/v1/admin/auth_providers/${PROVIDER_ID}`);
if (existingProvider.status !== 200 && existingProvider.status !== 404) {
  fail(new ArcadeError("GET", `/v1/admin/auth_providers/${PROVIDER_ID}`, existingProvider.status, JSON.stringify(existingProvider.json)).message);
}
const providerExists = existingProvider.status === 200;

// --- 3. The OAuth clients ---------------------------------------------------

let clients = await oauthClient();
const client = (key: string) => {
  const found = clients.find((each) => each.key === key);
  if (!found) fail(`bun run oauth-client printed no ${key} client`);
  return found;
};

if (providerExists) {
  const desired = providerBody({ host, origin, arcadeClientId: client("arcade").client_id, arcadeClientSecret: "", hookToken: "", approvalsStoreToken: "" });
  const differences = providerDifferences(existingProvider.json, desired);
  if (differences.length > 0) {
    out(`\nThe provider ${PROVIDER_ID} already exists in this Arcade project, and it is not what this app needs:`);
    for (const line of differences) out(`  - ${line}`);
    fail(
      `nothing was changed in Arcade or in .env. This command never edits an existing provider (DESIGN.md: ` +
        `Arcade config is read-only). Correct it in the dashboard, or delete it there and run this again.`,
    );
  }
  out(`  the provider ${PROVIDER_ID} is already registered and matches; it is left as it is`);
}

/** The secret a client needs this run, minting a new one only where nothing registered depends on the old. */
async function secretOf(key: string, rotate: boolean): Promise<string | null> {
  const current = client(key);
  if (current.client_secret !== null) return current.client_secret;
  if (!rotate) return null;
  clients = await oauthClient("--client", key, "--rotate");
  return client(key).client_secret;
}

// `arcade`: rotated only when the provider is about to be created with it.
const arcadeSecret = await secretOf("arcade", !providerExists);
// `web`: its credentials live in .env, so rotating is safe whenever .env has none.
const webConfigured = effective("IDP_CLIENT_ID") !== "" && effective("IDP_CLIENT_SECRET") !== "";
const webSecret = webConfigured ? null : await secretOf("web", true);
if (webConfigured && effective("IDP_CLIENT_ID") !== client("web").client_id) {
  out(`  warning       IDP_CLIENT_ID is ${effective("IDP_CLIENT_ID")}, but idp.db's web client is ${client("web").client_id}; sign-in will fail until they match`);
}
// `arcade-user-source`: shown when minted now; never rotated behind a User Source that may exist.
const userSourceSecret = client("arcade-user-source").client_secret;

// --- 4. .env, blanks only ---------------------------------------------------

const toWrite: Record<string, string> = {};
for (const [key, value] of Object.entries(planned)) if (!setElsewhere(key)) toWrite[key] = value;
if (webSecret !== null) {
  toWrite.IDP_CLIENT_ID = client("web").client_id;
  toWrite.IDP_CLIENT_SECRET = webSecret;
}
let filled = fillBlanks(envText, toWrite);
writeEnvFile(envPath, filled.text);
out(`\n.env${envExists ? "" : " (created from .env.example)"}:`);
out(`  filled   ${filled.written.join(", ") || "(nothing: every value was already set)"}`);
if (filled.kept.length > 0) out(`  kept     ${filled.kept.join(", ")}  (already set; never overwritten)`);

// --- 5. Arcade --------------------------------------------------------------

const registration: Registration = {
  host,
  origin,
  arcadeClientId: client("arcade").client_id,
  arcadeClientSecret: arcadeSecret ?? "",
  hookToken: hookToken.value,
  approvalsStoreToken: storeToken.value,
};

async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    fail(
      `${what} failed: ${(error as Error).message}\n` +
        `.env and idp.db keep what this run wrote, so running the same command again picks up from here.`,
    );
  }
}

let provider = existingProvider.json;
if (!providerExists) {
  provider = await step("creating the provider", () => admin.expect("POST", "/v1/admin/auth_providers", providerBody(registration)));
}

// Arcade generates the provider's callback, one per provider (measured in the
// custom-verifier spike: `…/oauth/<id>/callback`), and the `arcade` client must
// allowlist it exactly.
const callback = (provider as { oauth2?: { redirect_uri?: string } } | null)?.oauth2?.redirect_uri;
if (callback && !client("arcade").redirect_uris.includes(callback)) {
  const key = "IDP_OAUTH_REDIRECT_URIS_ARCADE";
  if (setElsewhere(key) || (fileEnv[key]?.trim() ?? "") !== "") {
    out(`  warning       the provider's callback is ${callback}; add it to ${key} yourself, it is already set and never overwritten`);
  } else {
    filled = fillBlanks(filled.text, { [key]: callback });
    writeEnvFile(envPath, filled.text);
    process.env[key] = callback;
    // Brings the client's allowlist in line in place; the id and secret do not change.
    clients = await oauthClient();
    out(`  allowlisted the provider's callback on the arcade client: ${callback}`);
  }
}
await step("setting the tool secret APP_PUBLIC_HOST", () =>
  admin.expect("POST", "/v1/admin/secrets/APP_PUBLIC_HOST", { value: host, description: "The app's public host (setup-arcade)" }),
);
await step("setting the tool secret APPROVALS_STORE_TOKEN", () =>
  admin.expect("POST", "/v1/admin/secrets/APPROVALS_STORE_TOKEN", {
    value: storeToken.value,
    description: "Bearer for the app's approvals store (setup-arcade)",
  }),
);

const plugin = await step("registering the hooks", async () => {
  const listed = await admin.expect("GET", "/v1/plugins?limit=100");
  const found = ((listed?.items as Array<{ id: string; name: string }> | undefined) ?? []).find((each) => each.name === PLUGIN_NAME);
  const body = pluginBody(registration);
  const id = found
    ? found.id
    : String(((await admin.expect("POST", "/v1/plugins", body)) as { id?: unknown } | null)?.id ?? "");
  if (id === "") throw new Error("POST /v1/plugins answered without an id");
  // Created inactive (measured), and a re-run brings an existing one up to date.
  const { name: _name, plugin_type: _type, ...patch } = body;
  await admin.expect("PATCH", `/v1/plugins/${id}`, found ? patch : { status: "active" });
  return (await admin.expect("GET", `/v1/plugins/${id}`)) as Record<string, unknown> | null;
});
{
  const config = plugin?.webhook_config as
    | { health_check_path?: string; endpoints?: Record<string, { url?: string }>; auth?: { token?: { exists?: boolean } } }
    | undefined;
  const problems = [
    ...(plugin?.status === "active" ? [] : [`status is ${JSON.stringify(plugin?.status)}, not "active"`]),
    ...(config?.health_check_path === "/hooks/health" ? [] : [`health_check_path is ${JSON.stringify(config?.health_check_path)}`]),
    ...(["access", "pre", "post"] as const).flatMap((point) =>
      config?.endpoints?.[point]?.url === `${origin}/hooks/${point}` ? [] : [`${point} is ${JSON.stringify(config?.endpoints?.[point]?.url)}`],
    ),
    ...(config?.auth?.token?.exists === false ? ["no bearer token is stored"] : []),
  ];
  if (problems.length > 0) fail(`the hook extension ${PLUGIN_NAME} read back wrong: ${problems.join("; ")}`);
  out(`  hooks: ${origin}/hooks/{access,pre,post}, health ${"/hooks/health"}, active`);
}

const verifier = await step("setting the custom verifier", async () => {
  await admin.expect("PUT", "/v1/admin/settings/session_verification", verifierBody(origin));
  return admin.expect("GET", "/v1/admin/settings/session_verification");
});
if (verifier?.verifier_url !== verifierBody(origin).verifier_url || verifier?.unsafe_skip_verification !== false) {
  fail(
    `the custom verifier did not take: Arcade reads back ${JSON.stringify(verifier)}. Without it a grant binds to ` +
      `whoever is signed in at Arcade, not to the app's user (DESIGN.md open risk 2). ` +
      `Set it in the dashboard: Auth → Settings → Custom verifier → ${verifierBody(origin).verifier_url}`,
  );
}
out(`  custom verifier: ${verifier.verifier_url} (read back)`);

// --- 6. What the API cannot do ----------------------------------------------

out("\nTwo dashboard forms are left. Arcade's API cannot fill these:\n");
out(userSourceForm({ origin, clientId: client("arcade-user-source").client_id, clientSecret: userSourceSecret }));
out();
out(gatewayForm({ slug, loanToolkit: effective("ARCADE_LOAN_TOOLKIT") || "Loan", approvalsToolkit: effective("ARCADE_APPROVALS_TOOLKIT") || "Approvals" }));
out();
out(nextSteps({ host, origin, port: effective("PORT") || "3000" }));
