/**
 * `bun run setup-arcade <ngrok-host> [--dry-run] [--user-source <id>] [--skip-deploy] [--gateway <slug>]` (#9, #30)
 *
 * Everything the Arcade side of this template needs, from one command, after
 * the developer has filled in the few required values in `.env`
 * (`ARCADE_API_KEY` among them). In order:
 *
 * 1. **Refuses** to go on if `.env` is tracked by git or not gitignored: this
 *    command writes secrets into it.
 * 2. **Resolves the Arcade org and project** (`setup-arcade/context.ts`):
 *    `ARCADE_ORG_ID` and `ARCADE_PROJECT_ID`, else the Arcade CLI's active
 *    context. Then, before anything is written, **one read-only call** under
 *    them with the key, `GET …/plugins`: a 401, 403 or 404 means the key and
 *    the resolved project disagree, and the run stops (#30).
 * 3. **Reads** the hop-2 provider `app-identity` back from Arcade. It is
 *    create-only (DESIGN.md → "Arcade config is read-only"): if it exists and
 *    differs from what this app needs, the differences are printed and the run
 *    stops, having written nothing.
 * 4. **Mints** the app's three OAuth clients in `idp.db`: `arcade` (hop 2),
 *    `arcade-user-source` (hop 1) and `web` (the app's own sign-in).
 * 5. **Fills in `.env`**, blanks only, never overwriting: `APP_PUBLIC_HOST`,
 *    `SESSION_SECRET`, `BETTER_AUTH_SECRET`, `ARCADE_HOOK_SIGNING_SECRET`, `APPROVALS_STORE_TOKEN`,
 *    `IDP_OAUTH_CLIENTS` and the clients' redirect URIs, `IDP_CLIENT_ID` and
 *    `IDP_CLIENT_SECRET`, `ARCADE_GATEWAY_ID`, `GOVERNANCE_STREAM=hooks`, and
 *    `ARCADE_USER_SOURCE_ID` when `--user-source` gave one.
 * 6. **Registers by API**: the provider, the tool secrets `APP_PUBLIC_HOST`
 *    and `APPROVALS_STORE_TOKEN`, the custom verifier, and the contextual
 *    access hooks (#30), each read back.
 * 7. **Deploys both toolkits**: `arcade deploy` in `tools/loan`, then in
 *    `tools/approvals`, streaming their output and stopping on a failure
 *    (#30). `--skip-deploy` leaves them to the developer.
 * 8. **Creates the gateway** by API, through the User Source, once it has the
 *    User Source's id (`--user-source`, or `ARCADE_USER_SOURCE_ID`). Without
 *    one it prints the User Source form, the one registration Arcade's API
 *    cannot make, and the exact command that finishes the job.
 *
 * With no org and project to be found, the hooks and the gateway are printed as
 * the dashboard forms they were before #30, and the run says why.
 *
 * `--dry-run` writes nothing and sends nothing: it prints every request a real
 * run would make from the state on disk, in order, with the key and every
 * secret as a placeholder. Sending nothing, it cannot ask Arcade whether the
 * provider exists, so it infers it: `.env`'s `IDP_OAUTH_REDIRECT_URIS_ARCADE`
 * holds the callback Arcade returns when it creates the provider, and `idp.db`
 * holds the clients (#28). Which registration goes which way, and the spec
 * path of each call, is in `scripts/setup-arcade/arcade.ts`.
 * `app-test/setup-arcade.test.ts` runs this against a local stand-in, with the
 * Arcade CLI faked on `PATH` and its context faked in a throwaway `HOME`. Its
 * first run against the real API (#7) stopped at the tool secrets, sent as
 * POST; they are PUT since #26. The second stopped at `GET /v1/plugins`; the
 * hooks are registered under the project since #30. A rerun picks up from
 * either state.
 *
 * Run it with `--no-env-file` (the package script does): it reads `.env` and
 * `.env.local` itself, so it knows which values `.env` holds and which come
 * from elsewhere, and writes only to `.env`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  ArcadeAdmin,
  ArcadeError,
  arcadeMessage,
  gatewayBody,
  gatewayDifferences,
  type GatewaySpec,
  healthCheckUrl,
  HOOKS_NAME,
  isReachabilityError,
  pageItems,
  pluginBody,
  pluginDifferences,
  pluginPatch,
  unverifiedLine,
  type ProjectScope,
  projectPath,
  PROVIDER_ID,
  providerBody,
  providerDifferences,
  type Registration,
  secretRequest,
  toolSecrets,
  verifierBody,
} from "./setup-arcade/arcade.ts";
import { type ArcadeContext, resolveContext } from "./setup-arcade/context.ts";
import { fillBlanks, MANAGED_KEYS, parseEnv, readEnvFile, replaceValue, shellConflicts, writeEnvFile } from "./setup-arcade/env-file.ts";
import { gatewayForm, hooksForm, nextSteps, userSourceCommand, userSourceForm } from "./setup-arcade/forms.ts";

const USER_SOURCE_CALLBACK = "https://cloud.arcade.dev/oauth2/intermediate_callback";
const CLIENT_KEYS = ["arcade", "arcade-user-source", "web"] as const;
const DEFAULT_GATEWAY = "loan-approval-limits";
/** The toolkits `arcade deploy` ships, in order: the gateway lists their tools. */
const TOOLKIT_DIRS = ["tools/loan", "tools/approvals"] as const;

const out = (line = "") => console.log(line);
function fail(message: string, code = 1): never {
  console.error(`\nsetup-arcade: ${message}`);
  process.exit(code);
}

// --- Arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const skipDeploy = argv.includes("--skip-deploy");
/** The value after a flag that takes one, or `null` when the flag is absent. */
const valueOf = (flag: string): string | null => (argv.includes(flag) ? (argv[argv.indexOf(flag) + 1] ?? "") : null);
const gatewaySlug = valueOf("--gateway");
const userSourceFlag = valueOf("--user-source");
const valued = new Set(["--gateway", "--user-source"].filter((flag) => argv.includes(flag)).map((flag) => argv.indexOf(flag) + 1));
const positional = argv.filter((arg, i) => !arg.startsWith("--") && !valued.has(i));

if (positional.length !== 1) {
  fail(
    "usage: bun run setup-arcade <ngrok-host> [--dry-run] [--user-source <id>] [--skip-deploy] [--gateway <slug>]\n" +
      "  <ngrok-host> is the public host Arcade reaches this app at, e.g. my-app.ngrok.app",
    64,
  );
}
if (gatewaySlug !== null && !/^[a-z0-9][a-z0-9-]*$/.test(gatewaySlug)) {
  fail(`--gateway ${gatewaySlug || "(missing)"}: a slug is lowercase letters, digits and hyphens`, 64);
}
/** A User Source id is a `us_`-prefixed KSUID (the swagger's `CreateGatewayRequest` description). */
const USER_SOURCE_ID = /^us_[A-Za-z0-9]+$/;
if (userSourceFlag !== null && !USER_SOURCE_ID.test(userSourceFlag)) {
  fail(`--user-source ${userSourceFlag || "(missing)"}: a User Source id starts with us_, as shown on the User Source's page`, 64);
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
// The environment this command was started in, before `.env` is read into it:
// what `arcade deploy` runs with, the way it runs from the developer's shell.
const shellEnv: Record<string, string | undefined> = { ...process.env };
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
// `process.env` for the identity module below. Used for the settings this run
// only reads (`ARCADE_API_URL`, `PORT`, `IDP_DB_PATH`, the toolkit names).
const loaded: Record<string, string | undefined> = { ...process.env };
const effective = (key: string): string => loaded[key]?.trim() ?? "";
/**
 * A variable this run manages, as `.env` holds it, and nothing else (#30).
 * What to fill, and what is "already set", is decided from the file alone,
 * because the file is what this run writes and what `bun run dev` reads. On
 * the fourth live run the shell still exported an old `.env`, the shell won,
 * and the run reported "nothing to fill" into a fresh `.env`: the app then
 * booted with no BETTER_AUTH_SECRET, and the provider was created with the
 * shell's old client. `shellConflicts` below refuses that state instead.
 */
const fromFile = (key: string): string => fileEnv[key]?.trim() ?? "";

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

// A managed variable the shell exports with another value than `.env`'s, or
// that `.env` leaves blank, stops the run before anything is sent or written
// (#30). At runtime a real environment variable still wins over `.env`, for
// the app as in `scripts/next.ts`, and that is the reason: whatever this run
// registered from `.env`, the app would run on the shell's value instead. So
// the shell is not overridden here and not ignored either: it has to agree.
const exported = shellConflicts(shellEnv, fileEnv);
if (exported.length > 0) {
  fail(
    `${exported.join(", ")} ${exported.length === 1 ? "is" : "are"} exported in this shell with a value .env does not hold ` +
      "(different, or blank in .env). This command decides what to write from .env alone, and the app would run on the " +
      "shell's values rather than the ones registered in Arcade. Nothing was sent or written.\n" +
      `  Open a new terminal, or run: unset ${exported.join(" ")}`,
  );
}

const onFile = fileEnv.APP_PUBLIC_HOST?.trim() ?? "";
if (onFile !== "" && onFile.toLowerCase() !== host) {
  fail(`.env has APP_PUBLIC_HOST=${onFile}, and this run was given ${host}. Pass ${onFile}, or blank it in .env to use ${host}.`);
}
const onLocal = localEnv.APP_PUBLIC_HOST?.trim() ?? "";
if (onLocal !== "" && onLocal.toLowerCase() !== host) {
  out(`  warning       APP_PUBLIC_HOST=${onLocal} is set in .env.local, and wins over .env when the app runs`);
}
const apiKey = fromFile("ARCADE_API_KEY");
if (apiKey === "" && !dryRun) fail("ARCADE_API_KEY is blank. Fill it in .env (Arcade dashboard → API keys), then run this again.");
const apiUrl = (effective("ARCADE_API_URL") || "https://api.arcade.dev").replace(/\/+$/, "");
const slug = gatewaySlug ?? (fromFile("ARCADE_GATEWAY_ID") || DEFAULT_GATEWAY);
const onFileGateway = fileEnv.ARCADE_GATEWAY_ID?.trim() ?? "";
if (gatewaySlug !== null && onFileGateway !== "" && onFileGateway !== gatewaySlug) {
  fail(`.env has ARCADE_GATEWAY_ID=${onFileGateway}, and this run was given --gateway ${gatewaySlug}. Blank it in .env to use ${gatewaySlug}.`);
}

const userSourceId = userSourceFlag ?? (effective("ARCADE_USER_SOURCE_ID") || null);
if (userSourceId !== null && !USER_SOURCE_ID.test(userSourceId)) {
  fail(`ARCADE_USER_SOURCE_ID=${userSourceId} is not a User Source id, which starts with us_`);
}
const onFileUserSource = fileEnv.ARCADE_USER_SOURCE_ID?.trim() ?? "";
if (userSourceFlag !== null && onFileUserSource !== "" && onFileUserSource !== userSourceFlag) {
  fail(`.env has ARCADE_USER_SOURCE_ID=${onFileUserSource}, and this run was given --user-source ${userSourceFlag}. Blank it in .env to use ${userSourceFlag}.`);
}

// The org and project the hooks and the gateway are registered in (#30).
const resolution = resolveContext(loaded);
const scope: (ArcadeContext & ProjectScope) | null = resolution.context;
if (scope !== null) {
  out(`  arcade        org ${scope.orgId}, project ${scope.projectId} (from ${scope.source})`);
  if (!scope.source.startsWith("the Arcade CLI") && !skipDeploy) {
    // `arcade deploy` always deploys into the CLI's own active project
    // (`arcade_cli/deploy.py`): these variables do not reach it.
    out("  warning       arcade deploy uses the Arcade CLI's active project, not these variables: `arcade whoami` must show the same one");
  }
} else {
  out(`  arcade        no org and project: ${"why" in resolution ? resolution.why : "unknown"}.`);
  out("                The hooks and the gateway are printed as dashboard forms instead. Set ARCADE_ORG_ID and");
  out("                ARCADE_PROJECT_ID in .env, or make the project the Arcade CLI's active one, to register them by API.");
}
const loanToolkit = effective("ARCADE_LOAN_TOOLKIT") || "Loan";
const approvalsToolkit = effective("ARCADE_APPROVALS_TOOLKIT") || "Approvals";

const configuredClients = fromFile("IDP_OAUTH_CLIENTS");
if (configuredClients !== "") {
  const listed = configuredClients.split(",").map((each) => each.trim());
  const missing = CLIENT_KEYS.filter((key) => key !== "arcade" && !listed.includes(key));
  if (missing.length > 0) {
    fail(`IDP_OAUTH_CLIENTS=${configuredClients} leaves out ${missing.join(", ")}. Add ${missing.length === 1 ? "it" : "them"}, or blank it.`);
  }
}

/** A value this run needs: what the app already has, else a fresh one. */
function secretFor(key: string): { value: string; generated: boolean } {
  const existing = fromFile(key);
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
  // Kept, so a later run can re-check the gateway without the flag.
  ...(userSourceFlag === null ? {} : { ARCADE_USER_SOURCE_ID: userSourceFlag }),
};
// The identity module reads these from the environment when it mints. The
// host is always this run's: an `.env.local` naming localhost must not make
// it mint for another issuer.
// Every managed variable is `.env`'s value or this run's, whatever .env.local
// or the shell had.
for (const key of MANAGED_KEYS) {
  const value = fromFile(key) || planned[key];
  if (value) process.env[key] = value;
  else delete process.env[key];
}
process.env.APP_PUBLIC_HOST = host;

const admin = new ArcadeAdmin(apiUrl, apiKey, dryRun, out);

/** Where the gateway will stand when this run ends; see `forms.ts` `NextSteps`. */
const gatewayState: "created" | "needs-user-source" | "form" = scope === null ? "form" : userSourceId === null ? "needs-user-source" : "created";
const gatewaySpec = (id: string): GatewaySpec => ({ slug, userSourceId: id, loanToolkit, approvalsToolkit });

/** The forms left for the dashboard, and the steps after them. The last thing every run prints. */
function finish(userSource: { clientId: string; clientSecret: string | null }): never {
  if (gatewayState === "form") {
    out("\nThree dashboard forms are left, in the order you fill them in:\n");
  } else if (gatewayState === "needs-user-source") {
    out("\nOne dashboard form is left, the User Source, which Arcade's API cannot create:\n");
  }
  if (gatewayState !== "created") out(userSourceForm({ origin, ...userSource }));
  if (gatewayState === "form") {
    out();
    out(gatewayForm({ slug, loanToolkit, approvalsToolkit }));
    out();
    out(hooksForm({ origin }));
  }
  out();
  out(nextSteps({ host, origin, port: effective("PORT") || "3000", gateway: gatewayState, deployed: !skipDeploy }));
  if (gatewayState === "needs-user-source") {
    out("\nOnce the User Source exists, finish with this, and the id shown on the User Source's page (us_…):");
    out(`  ${userSourceCommand(host)}`);
    out(`  (or set ARCADE_USER_SOURCE_ID in .env and run bun run setup-arcade ${host})`);
  }
  process.exit(0);
}

/**
 * What `arcade deploy` says about the tool secrets, and why it is fine: it
 * uploads a secret only from its own environment, and this run set both by API.
 */
const DEPLOY_SECRETS_NOTE =
  "  (arcade deploy may print \"Secret 'APP_PUBLIC_HOST' not found in environment, skipping upload\". That is expected:\n" +
  "  this run already set the tool secrets by API, above.)";

/** `arcade deploy`, as printed by the dry run and run by a real one. */
function deployLine(dir: string): string {
  return `  arcade deploy   (in ${dir})`;
}

// --- Dry run: the whole sequence, nothing sent ------------------------------

/** `.env` has the app's own sign-in client, so a real run leaves the `web` client's secret alone. */
const webConfigured = fromFile("IDP_CLIENT_ID") !== "" && fromFile("IDP_CLIENT_SECRET") !== "";
if (dryRun) {
  // What a real run would find, read off the disk alone: a dry run sends
  // nothing, so it cannot ask Arcade (#28). `IDP_OAUTH_REDIRECT_URIS_ARCADE`
  // is written only from the callback Arcade returns when it creates the
  // provider, and `idp.db` is where the clients are minted.
  const idpDb = resolve(cwd, effective("IDP_DB_PATH") || "./idp.db");
  const clientsOnDisk = existsSync(idpDb);
  const callbackRecorded = fromFile("IDP_OAUTH_REDIRECT_URIS_ARCADE") !== "";
  const registered = clientsOnDisk && callbackRecorded;

  const keys = Object.keys(planned).filter((key) => fromFile(key) === "");
  if (!webConfigured) keys.push("IDP_CLIENT_ID", "IDP_CLIENT_SECRET");
  if (!callbackRecorded) keys.push("IDP_OAUTH_REDIRECT_URIS_ARCADE (with the callback Arcade generates for the provider)");
  out(
    `\n.env${envExists ? "" : " (created from .env.example)"}: ` +
      (keys.length > 0 ? `would fill ${keys.join(", ")}` : "nothing to fill: every value is already set, and none is overwritten"),
  );
  if (!clientsOnDisk) {
    out(`idp.db: would mint the OAuth clients ${CLIENT_KEYS.join(", ")}`);
    if (callbackRecorded) {
      out(
        `  warning       .env records the provider's callback, but there is no ${idpDb}: a real run mints new clients, ` +
          `and a provider Arcade still holds names the old arcade client, so the run stops at the comparison`,
      );
    }
  } else {
    const rotated = [...(registered ? [] : ["arcade (the provider is created with it)"]), ...(webConfigured ? [] : ["web (.env has no IDP_CLIENT_ID and IDP_CLIENT_SECRET)"])];
    out(`idp.db: already holds the OAuth clients; each keeps its id, and a missing one is minted`);
    out(rotated.length > 0 ? `  a new secret, under the same id, for ${rotated.join(" and ")}` : "  no secret is minted or rotated");
  }

  out(`\nRequests, in order (${apiUrl}):`);
  if (scope !== null) {
    await admin.request("GET", projectPath(scope, "/plugins?limit=100"));
    out("    (before anything is written: a 401, 403 or 404 stops the run, because the key and this project disagree)");
  }
  const registration: Registration = {
    host,
    origin,
    arcadeClientId: "<the arcade client id in idp.db>",
    arcadeClientSecret: clientsOnDisk ? "<a new secret for the arcade client, rotated by this run>" : "<the arcade client secret, minted by this run>",
    approvalsStoreToken: storeToken.generated ? storeToken.value : "<APPROVALS_STORE_TOKEN from .env>",
  };
  await admin.request("GET", `/v1/admin/auth_providers/${PROVIDER_ID}`);
  if (registered) {
    out("    (expected 200: .env holds the callback Arcade made for this provider. It is compared, a difference stops");
    out("    the run, and nothing is created. If Arcade answers 404 instead, a real run mints a new secret for the");
    out("    arcade client and creates the provider with it.)");
  } else {
    out("    (404: the provider is created below. 200: it is compared, and a difference stops the run.)");
    await admin.request("POST", "/v1/admin/auth_providers", providerBody(registration));
  }
  for (const secret of toolSecrets(host, registration.approvalsStoreToken)) {
    const { method, path, body } = secretRequest(secret);
    await admin.request(method, path, body);
  }
  await admin.request("PUT", "/v1/admin/settings/session_verification", verifierBody(origin));
  await admin.request("GET", "/v1/admin/settings/session_verification");
  if (scope !== null) {
    const token = hookToken.generated ? hookToken.value : "<ARCADE_HOOK_SIGNING_SECRET from .env>";
    out(`    (the hooks: the list above is searched for ${HOOKS_NAME}. With none, it is created:)`);
    await admin.request("POST", projectPath(scope, "/plugins"), pluginBody(origin, token));
    out(`    (one that differs is updated instead, PATCH ${projectPath(scope, "/plugins/<plugin_id>")}, and one that matches is`);
    out("    left as it is. A created or updated one is read back:)");
    await admin.request("GET", projectPath(scope, "/plugins/<plugin_id>"));
    await admin.request("GET", projectPath(scope, "/hooks?plugin_id=<plugin_id>"));
  }
  if (scope !== null && userSourceId !== null) {
    await admin.request("GET", projectPath(scope, "/gateways?limit=100"));
    out(`    (searched for the slug ${slug}. With none, it is created; one that differs stops the run, and one that matches is left:)`);
    await admin.request("POST", projectPath(scope, "/gateways"), gatewayBody(gatewaySpec(userSourceId)));
    await admin.request("GET", projectPath(scope, "/gateways/<gateway_id>"));
  }
  out(skipDeploy ? "\nDeploys: skipped (--skip-deploy)." : "\nDeploys, after the hooks and before the gateway, each stopping the run if it fails:");
  if (!skipDeploy) {
    for (const dir of TOOLKIT_DIRS) out(deployLine(dir));
    out(DEPLOY_SECRETS_NOTE);
  }
  finish({ clientId: "<the arcade-user-source client id in idp.db>", clientSecret: clientsOnDisk ? null : "<its secret, minted by this run>" });
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

// The key's check, before anything is written (#30): one read-only call under
// the org and project this run resolved. Its list is the hooks' search too.
let listedPlugins: unknown[] = [];
if (scope !== null) {
  const path = projectPath(scope, "/plugins?limit=100");
  const answer = await admin.request("GET", path);
  if (answer.status === 401 || answer.status === 403 || answer.status === 404) {
    fail(
      `ARCADE_API_KEY and the Arcade project this run resolved disagree: GET ${path} answered ${answer.status}.\n` +
        `  The project is ${scope.projectId} in the org ${scope.orgId} (from ${scope.source}).\n` +
        "  Either make the key's own project the active one, `arcade project set <project_id>` (`arcade project list` shows the ids),\n" +
        `  or create an API key in the project ${scope.projectId} and put it in ARCADE_API_KEY. Nothing was written.`,
    );
  }
  if (answer.status !== 200) fail(new ArcadeError("GET", path, answer.status, JSON.stringify(answer.json)).message);
  listedPlugins = pageItems(answer.json);
  out(`  the key answers for the project ${scope.projectId}`);
}

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
  const desired = providerBody({ host, origin, arcadeClientId: client("arcade").client_id, arcadeClientSecret: "", approvalsStoreToken: "" });
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
const webSecret = webConfigured ? null : await secretOf("web", true);
if (webConfigured && fromFile("IDP_CLIENT_ID") !== client("web").client_id) {
  out(`  warning       IDP_CLIENT_ID is ${fromFile("IDP_CLIENT_ID")}, but idp.db's web client is ${client("web").client_id}; sign-in will fail until they match`);
}
// `arcade-user-source`: shown when minted now; never rotated behind a User Source that may exist.
const userSourceSecret = client("arcade-user-source").client_secret;

// --- 4. .env, blanks only ---------------------------------------------------

const toWrite: Record<string, string> = {};
for (const [key, value] of Object.entries(planned)) toWrite[key] = value;
if (webSecret !== null) {
  toWrite.IDP_CLIENT_ID = client("web").client_id;
  toWrite.IDP_CLIENT_SECRET = webSecret;
}
let filled = fillBlanks(envText, toWrite);
writeEnvFile(envPath, filled.text);
out(`\n.env${envExists ? "" : " (created from .env.example)"}:`);
out(`  filled   ${filled.written.join(", ") || "(nothing to fill: every value was already set)"}`);
if (filled.kept.length > 0) out(`  kept     ${filled.kept.join(", ")}  (already set; never overwritten)`);

// --- 5. Arcade --------------------------------------------------------------

const registration: Registration = {
  host,
  origin,
  arcadeClientId: client("arcade").client_id,
  arcadeClientSecret: arcadeSecret ?? "",
  approvalsStoreToken: storeToken.value,
};

async function step<T>(what: string, run: () => Promise<T>, hint?: (error: unknown) => string | undefined): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const said = arcadeMessage(error);
    const advice = hint?.(error);
    fail(
      `${what} failed: ${(error as Error).message}\n` +
        (said ? `Arcade says: ${said}\n` : "") +
        (advice ? `${advice}\n` : "") +
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
//
// The live provider is the source of truth for IDP_OAUTH_REDIRECT_URIS_ARCADE,
// the one variable this run replaces rather than only fills (#30). On run 4,
// app-identity was recreated, so Arcade made a new callback, and `.env` still
// named the old provider's: the run only warned, Arcade then sent the new one,
// and the identity provider refused it (invalid_redirect) at hop 2's Authorize.
const callback = (provider as { oauth2?: { redirect_uri?: string } } | null)?.oauth2?.redirect_uri;
const CALLBACK_KEY = "IDP_OAUTH_REDIRECT_URIS_ARCADE";
const onFileCallback = fromFile(CALLBACK_KEY);
if (callback && (onFileCallback !== callback || !client("arcade").redirect_uris.includes(callback))) {
  if (onFileCallback === "") {
    filled = fillBlanks(filled.text, { [CALLBACK_KEY]: callback });
  } else if (onFileCallback !== callback) {
    filled = { ...filled, text: replaceValue(filled.text, CALLBACK_KEY, callback) };
  }
  writeEnvFile(envPath, filled.text);
  process.env[CALLBACK_KEY] = callback;
  // Brings the client's allowlist in line in place; the id and secret do not change.
  clients = await oauthClient();
  out(
    onFileCallback !== "" && onFileCallback !== callback
      ? `  replaced the provider's callback: ${onFileCallback} -> ${callback}`
      : `  allowlisted the provider's callback on the arcade client: ${callback}`,
  );
}
for (const secret of toolSecrets(host, storeToken.value)) {
  const { method, path, body } = secretRequest(secret);
  await step(`setting the tool secret ${secret.key}`, () => admin.expect(method, path, body));
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

// --- 6. The hooks (#30) -----------------------------------------------------

const objectField = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

if (scope === null) {
  out("  hooks: no org and project, so the form below");
} else {
  const existing = listedPlugins.find((each) => objectField(each, "name") === HOOKS_NAME);
  const hooksOf = async (id: string) =>
    pageItems(await step("reading the hooks back", () => admin.expect("GET", projectPath(scope, `/hooks?plugin_id=${encodeURIComponent(id)}`))));
  let id = typeof objectField(existing, "id") === "string" ? (objectField(existing, "id") as string) : "";
  let wrote = false;
  if (existing === undefined) {
    const created = await step(
      "creating the contextual access hooks",
      () => admin.expect("POST", projectPath(scope, "/plugins"), pluginBody(origin, hookToken.value)),
      (error) =>
        isReachabilityError(error)
          ? `Arcade could not reach ${healthCheckUrl(origin)}: start \`bun run dev\` and the tunnel first.`
          : undefined,
    );
    id = typeof objectField(created, "id") === "string" ? (objectField(created, "id") as string) : "";
    if (id === "") fail(`Arcade created the hooks and answered with no id: ${JSON.stringify(created)}`);
    out(`  hooks: created ${HOOKS_NAME}`);
    wrote = true;
  } else {
    const { differences, unverified } = pluginDifferences(existing, await hooksOf(id), origin);
    if (differences.length === 0) {
      out(`  hooks: ${HOOKS_NAME} is already registered and matches; it is left as it is`);
      for (const field of unverified) out(`  ${unverifiedLine(field)}`);
    } else {
      out(`  hooks: ${HOOKS_NAME} is registered and differs from what this app needs, so it is updated:`);
      for (const line of differences) out(`    - ${line}`);
      await step("updating the contextual access hooks", () =>
        admin.expect("PATCH", projectPath(scope, `/plugins/${encodeURIComponent(id)}`), pluginPatch(origin, hookToken.value)),
      );
      wrote = true;
    }
  }
  if (wrote) {
    const plugin = await step("reading the hooks back", () => admin.expect("GET", projectPath(scope, `/plugins/${encodeURIComponent(id)}`)));
    const { differences, unverified } = pluginDifferences(plugin, await hooksOf(id), origin);
    if (differences.length > 0) {
      fail(`the hooks did not take: Arcade reads back\n${differences.map((line) => `  - ${line}`).join("\n")}`);
    }
    const healthUnread = unverified.some(({ path }) => path === "webhook_config.health_check_path");
    out(
      `  hooks: ${origin}/hooks/access, /hooks/pre and /hooks/post, fail closed` +
        `${healthUnread ? "" : `, health check ${healthCheckUrl(origin)}`} (read back)`,
    );
    for (const field of unverified) out(`  ${unverifiedLine(field)}`);
  }
}

// --- 7. The deploys (#30) ---------------------------------------------------

if (skipDeploy) {
  out("\nDeploys: skipped (--skip-deploy). Deploy both toolkits before the gateway: arcade deploy, in tools/loan and in tools/approvals.");
} else {
  out(`\n${DEPLOY_SECRETS_NOTE.trimStart()}`);
  for (const dir of TOOLKIT_DIRS) {
    const where = join(cwd, dir);
    if (!existsSync(where)) fail(`there is no ${dir} under ${cwd} to deploy. Run this from the project's root, or pass --skip-deploy.`);
    out(`\n${deployLine(dir).trim()}:`);
    let code: number;
    try {
      // The developer's own environment, not this run's: `arcade deploy`
      // reads its login and active project the way it does from their shell.
      // No stdin (#30): the CLI asks "View full deployment logs? [y/n]" when
      // stdin and stdout are both a terminal (arcade_cli/deploy.py, 1.16.1),
      // and with the developer's terminal inherited every deploy waited for a
      // key. Its output still streams to this one.
      const child = Bun.spawn(["arcade", "deploy"], { cwd: where, env: shellEnv, stdio: ["ignore", "inherit", "inherit"] });
      code = await child.exited;
    } catch (error) {
      fail(
        `could not run arcade deploy: ${(error as Error).message}. Install the Arcade CLI (uv tool install arcade-mcp) and ` +
          "run `arcade login`, or pass --skip-deploy and deploy the toolkits yourself.",
      );
    }
    if (code !== 0) {
      fail(
        `arcade deploy in ${dir} exited ${code}; its output is above, and nothing after it ran. Fix that and run this again ` +
          "(every step before it checks what is already there), or pass --skip-deploy and deploy it yourself.",
      );
    }
  }
}

// --- 8. The gateway (#30) ---------------------------------------------------

if (scope !== null && userSourceId !== null) {
  out(`\nThe gateway (${apiUrl}):`);
  const spec = gatewaySpec(userSourceId);
  const listed = pageItems(await step("listing the gateways", () => admin.expect("GET", projectPath(scope, "/gateways?limit=100"))));
  const existing = listed.find((each) => objectField(each, "slug") === slug);
  if (existing !== undefined) {
    const differences = gatewayDifferences(existing, spec);
    if (differences.length > 0) {
      out(`\nThe gateway ${slug} already exists in this Arcade project, and it is not what this app needs:`);
      for (const line of differences) out(`  - ${line}`);
      fail(
        "nothing was changed in Arcade. This command never edits an existing gateway: its authentication is hop 1, the " +
          "access model itself. Correct it in the dashboard, or blank ARCADE_GATEWAY_ID in .env and run this with --gateway <another-slug>.",
      );
    }
    out(`  gateway: ${slug} is already registered and matches; it is left as it is`);
  } else {
    const path = projectPath(scope, "/gateways");
    const created = await admin.request("POST", path, gatewayBody(spec));
    if (created.status === 409) {
      fail(`Arcade says the gateway slug ${slug} is taken. Blank ARCADE_GATEWAY_ID in .env and run this with --gateway <another-slug>.`);
    }
    if (created.status < 200 || created.status >= 300) fail(new ArcadeError("POST", path, created.status, JSON.stringify(created.json)).message);
    const id = objectField(created.json, "id");
    if (typeof id !== "string" || id === "") fail(`Arcade created the gateway and answered with no id: ${JSON.stringify(created.json)}`);
    const readBack = await step("reading the gateway back", () => admin.expect("GET", projectPath(scope, `/gateways/${encodeURIComponent(id)}`)));
    const differences = gatewayDifferences(readBack, spec);
    if (differences.length > 0) fail(`the gateway did not take: Arcade reads back\n${differences.map((line) => `  - ${line}`).join("\n")}`);
    out(`  gateway: created ${slug}, through the User Source ${userSourceId}, with the six tools of ${spec.loanToolkit} and ${spec.approvalsToolkit} (read back)`);
  }
}

finish({ clientId: client("arcade-user-source").client_id, clientSecret: userSourceSecret });
