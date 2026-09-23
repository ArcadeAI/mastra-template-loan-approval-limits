#!/usr/bin/env bun
/**
 * Spike 05 — read back what Arcade actually stores for an OAuth **auth provider**,
 * read-only, so a dashboard field can be compared against the wire.
 *
 * This exists because the dashboard lied. The `cg-idp` provider's Authentication
 * Method dropdown read *"Client Secret Basic"*, greyed out, tooltip *"Currently,
 * client secret basic is the only supported authentication method"* — while the
 * provider was demonstrably sending `client_secret_post` on the wire, because its
 * Token Settings carried Request Parameters rows `client_id={{client_id}}` and
 * `client_secret={{client_secret}}`. Removing those rows did not switch it to a
 * Basic header; it made the provider send **no client credentials at all**
 * (`client_auth="absent"` in our IdP's log). So the label is decoration and the
 * parameter rows are the mechanism.
 *
 * A field that reports one thing and does another is the failure this project
 * exists to keep out, so: read the stored configuration and print it, rather than
 * trusting a screenshot.
 *
 *   bun docs/spikes/evidence/05-auth-provider-config.ts [provider-id]
 *
 * **Read-only. It issues GETs and nothing else.** The Arcade project API key comes
 * from `docs/spikes/evidence/.env.local`, the same untracked, gitignored file the
 * verifier uses; it is never printed, and every secret-shaped value in the response
 * is redacted before anything reaches the terminal.
 */
const PROVIDER_ID = process.argv[2] ?? "cg-idp";
const ENV_FILE = new URL("./.env.local", import.meta.url).pathname;

async function apiKey(): Promise<string> {
  const file = Bun.file(ENV_FILE);
  let key = process.env.ARCADE_API_KEY?.trim() ?? "";
  if (await file.exists()) {
    for (const line of (await file.text()).split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      const match = /^\s*(?:export\s+)?ARCADE_API_KEY\s*=\s*(.*)$/.exec(line);
      if (match) key = match[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  if (!key) {
    console.error(
      `ARCADE_API_KEY is required and is not in ${ENV_FILE}.\n` +
        `  Whoever holds the project key writes that file; it is gitignored at any depth\n` +
        `  and this process never prints it.`,
    );
    process.exit(2);
  }
  return key;
}

/**
 * Anything that could be a credential, gone before it is printed.
 *
 * Deliberately aggressive: a provider record carries a client secret, and the point
 * of this script is the *shape* of the configuration, never its secrets.
 */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        /secret|token|password|key$|credential/i.test(k) && typeof v === "string" && v.length > 0
          ? "<redacted>"
          : scrub(v),
      ]),
    );
  }
  return value;
}

const key = await apiKey();
const CANDIDATES = [
  `https://api.arcade.dev/v1/admin/auth_providers/${PROVIDER_ID}`,
  `https://api.arcade.dev/v1/admin/auth_providers`,
  `https://api.arcade.dev/v1/auth_providers/${PROVIDER_ID}`,
  `https://api.arcade.dev/v1/auth/providers/${PROVIDER_ID}`,
  `https://cloud.arcade.dev/api/v1/admin/auth_providers/${PROVIDER_ID}`,
];

console.log(`auth provider configuration for "${PROVIDER_ID}", read-only\n`);
for (const url of CANDIDATES) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
  const text = await res.text();
  console.log(`GET ${url}\n  -> ${res.status}`);
  if (!res.ok) {
    console.log(`     ${text.slice(0, 200)}`);
    continue;
  }
  try {
    console.log(JSON.stringify(scrub(JSON.parse(text)), null, 2));
  } catch {
    console.log(text.slice(0, 2000));
  }
  break;
}
