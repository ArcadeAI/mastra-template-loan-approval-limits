/**
 * **Only the identity module mints tokens** (DESIGN.md → Services, → Identity
 * and OAuth; #6, criterion 2).
 *
 * The demo kept Better Auth in its own service, `apps/idp`, so that the answer
 * to "can the web app mint itself a token?" was no, by process boundary (#36
 * there). The template folds it into the app, and the same answer has to be
 * given by a module boundary instead. This file is that boundary, and it is
 * what a reviewer plants a violation against:
 *
 *  1. **Nothing outside the identity module imports Better Auth.** No
 *     `better-auth` and no `@better-auth/*` in shipped source anywhere but
 *     `lib/identity/`. Better Auth is where the signing keys (the JWT plugin,
 *     the `jwks` table) and the issuance (the OAuth provider plugin) live, so
 *     a module importing it could build its own instance over `idp.db` and
 *     sign whatever it liked.
 *  2. **Nothing outside the provider imports its internals.** The files that
 *     hold the keys and issue tokens — `auth.ts`, `client.ts`, `server.ts`,
 *     `db.ts`, `reset.ts`, `replay-tolerance.ts` and the rest — are imported
 *     only from inside `lib/identity/provider/`. From outside, the one door is
 *     `instance.ts`, which hands a request to the provider and gives nothing
 *     back but the answer, and only the identity routes, the app's `/health`
 *     and `instrumentation.ts` may open it.
 *  3. **Nothing outside the provider reads its secrets or its database.**
 *     `BETTER_AUTH_SECRET` encrypts the signing key at rest and `IDP_DB_PATH`
 *     locates it; the `jwks` table holds it.
 *
 * The web sign-in (`lib/identity/handlers.ts`, `oidc.ts`) is part of the
 * identity module and still does not reach round the door: it reaches the
 * provider through `lib/identity/link.ts`, which the provider registers itself
 * with, as an HTTP client would.
 *
 * Shipped source only. The module's own tests and the harnesses drive the
 * provider directly on purpose — that is how its behaviour is tested — and
 * they are not in the app.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

/** Where the app's shipped source is. Tests and docs are not in the app. */
const SHIPPED = [
  "lib/**/*.{ts,tsx}",
  "app/**/*.{ts,tsx}",
  "components/**/*.{ts,tsx}",
  "src/**/*.{ts,tsx}",
  "packages/*/src/**/*.{ts,tsx}",
  "scripts/**/*.ts",
  "instrumentation.ts",
];

/** The identity module. Everything under it may use Better Auth. */
const IDENTITY_MODULE = "lib/identity/";
/** The provider: the part that holds the keys and issues tokens. */
const PROVIDER = "lib/identity/provider/";
/** Its one door. */
const DOOR = "lib/identity/provider/instance.ts";

/**
 * Who may open the door: the routes the provider is mounted on, the app's
 * `/health`, and the boot hook. `app-test/identity/mount.test.ts` checks the
 * routes are exactly `IDENTITY_PATHS`.
 */
const MAY_OPEN_THE_DOOR = [
  "app/oauth2/[...path]/route.ts",
  "app/.well-known/[...path]/route.ts",
  "app/sign-in/[...path]/route.ts",
  "app/identity/[...path]/route.ts",
  "app/login/route.ts",
  "app/consent/route.ts",
  "app/jwks/route.ts",
  "app/health/route.ts",
  "instrumentation.ts",
];

/**
 * The provider's own scripts, which are the provider's tools rather than
 * another module: they are what `apps/idp/scripts/` was, run in a shell on the
 * machine that holds `idp.db` (`oauth-client` prints the secret it mints; the
 * reset re-seeds people). They are held to rule 1 like everything else, and
 * exempt from rules 2 and 3 because using the provider is their whole job.
 */
const PROVIDER_TOOLS = ["scripts/identity.ts", "scripts/identity/"];

export interface SourceFile {
  path: string;
  text: string;
}

/** Block comments and whole-line `//` comments, as the sibling boundary tests strip them. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

/** Every module specifier a file names: static imports, re-exports and dynamic imports. */
function specifiers(text: string): string[] {
  const pattern = /(?:^|[^\w.])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;
  return [...text.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]!);
}

/** A relative specifier, as a repo-relative path. Bare packages come back unchanged. */
function target(from: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return relative(REPO, resolve(REPO, dirname(from), specifier));
}

const isTool = (path: string) => PROVIDER_TOOLS.some((tool) => path === tool || path.startsWith(tool));

/**
 * The rule, as a function of the files it is asked about, so it can be shown
 * to catch a planted violation without planting one in the repo.
 */
export function mintingOffences(files: SourceFile[]): string[] {
  const offences: string[] = [];
  for (const { path, text } of files) {
    const code = stripComments(text);
    for (const specifier of specifiers(code)) {
      const to = target(path, specifier);
      // 1. Better Auth is the identity module's alone.
      if (/^(better-auth|@better-auth\/)/.test(to) && !path.startsWith(IDENTITY_MODULE) && !isTool(path)) {
        offences.push(`${path} imports ${specifier}: only lib/identity/ may import Better Auth`);
      }
      // 2. The provider's internals are the provider's; the door is for the mount.
      if (to.startsWith(PROVIDER) && !path.startsWith(PROVIDER) && !isTool(path)) {
        const door = to === DOOR || to === DOOR.replace(/\.ts$/, "");
        if (!door) offences.push(`${path} imports ${specifier}: the provider's internals are not importable`);
        else if (!MAY_OPEN_THE_DOOR.includes(path)) {
          offences.push(`${path} imports ${specifier}: only the identity routes, /health and instrumentation.ts mount the provider`);
        }
      }
    }
    // 3. Its secrets and its database. App source only: a script under
    // `scripts/` is not in the image, and the one that names the secret
    // (`verify-standalone.ts`) is handing a throwaway to a container.
    if (!path.startsWith(PROVIDER) && !isTool(path) && !path.startsWith("scripts/")) {
      if (/BETTER_AUTH_SECRET/.test(code)) offences.push(`${path} reads BETTER_AUTH_SECRET`);
      if (/IDP_DB_PATH/.test(code)) offences.push(`${path} locates idp.db (IDP_DB_PATH)`);
      if (/(from|into|update|table)\s+["'`]?jwks\b/i.test(code)) offences.push(`${path} touches the jwks table`);
    }
  }
  return offences;
}

async function shippedSource(): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const seen = new Set<string>();
  for (const pattern of SHIPPED) {
    // `dot: true`, or `app/.well-known/` — one of the routes the provider is
    // mounted on — is silently not scanned. Measured: without it the door
    // test below found every mount but that one.
    for await (const path of new Glob(pattern).scan({ cwd: REPO, dot: true })) {
      if (path.includes("node_modules/") || seen.has(path)) continue;
      seen.add(path);
      files.push({ path, text: readFileSync(join(REPO, path), "utf8") });
    }
  }
  return files;
}

describe("only the identity module mints tokens", () => {
  test("no shipped file breaks the rule", async () => {
    const files = await shippedSource();
    // Vacuous if the scan found nothing, or found the app without its
    // identity module: the move is exactly when a path goes stale.
    const paths = files.map((file) => file.path);
    for (const expected of ["lib/identity/provider/auth.ts", DOOR, "app/oauth2/[...path]/route.ts", "lib/agent/gateway-token.ts"]) {
      expect(paths).toContain(expected);
    }
    expect(mintingOffences(files)).toEqual([]);
  });

  test("the door is actually used, by every route the rule names and by nothing it does not", async () => {
    const files = await shippedSource();
    const opening = files
      .filter(({ path, text }) =>
        !path.startsWith(PROVIDER) &&
        specifiers(stripComments(text)).some((specifier) => target(path, specifier) === DOOR),
      )
      .map(({ path }) => path)
      .sort();
    // If a route stopped mounting the provider, the list above would be
    // permitting something nobody does, which reads exactly like a rule that
    // holds.
    expect(opening).toEqual([...MAY_OPEN_THE_DOOR].sort());
  });

  test("Better Auth is imported where the keys and the issuance actually are", async () => {
    const files = await shippedSource();
    const importing = files
      .filter(({ text }) => specifiers(stripComments(text)).some((specifier) => /^(better-auth|@better-auth\/)/.test(specifier)))
      .map(({ path }) => path);
    // The JWT plugin (signing keys) and the OAuth provider plugin (issuance)
    // are built in `auth.ts`. If nothing imported Better Auth, rule 1 would
    // be true of an app that had no provider at all.
    expect(importing).toContain("lib/identity/provider/auth.ts");
    for (const path of importing) expect(path.startsWith(IDENTITY_MODULE) || isTool(path)).toBe(true);
  });
});

describe("the rule catches what it is for", () => {
  // Synthetic files, not planted ones: the rule is a function of what it is
  // handed, so this is the same check run against a violation, without a
  // violation in the repo. The PR shows the same offences planted for real.
  test("another module importing the provider's issuance", () => {
    expect(
      mintingOffences([
        { path: "lib/agent/mint.ts", text: `import { createAuth } from "../identity/provider/auth.ts";\n` },
      ]),
    ).toEqual(["lib/agent/mint.ts imports ../identity/provider/auth.ts: the provider's internals are not importable"]);
  });

  test("another module importing the signing keys straight from Better Auth", () => {
    expect(
      mintingOffences([{ path: "lib/control-plane/keys.ts", text: `import { jwt } from "better-auth/plugins/jwt";\n` }]),
    ).toEqual(["lib/control-plane/keys.ts imports better-auth/plugins/jwt: only lib/identity/ may import Better Auth"]);
  });

  test("a dynamic import is an import", () => {
    expect(
      mintingOffences([{ path: "app/api/chat/route.ts", text: `const { oauthProvider } = await import("@better-auth/oauth-provider");\n` }]),
    ).toHaveLength(1);
  });

  test("the door, opened from somewhere that is not a mount", () => {
    expect(
      mintingOffences([{ path: "lib/agent/sneak.ts", text: `import { identityFetch } from "../identity/provider/instance.ts";\n` }]),
    ).toEqual(["lib/agent/sneak.ts imports ../identity/provider/instance.ts: only the identity routes, /health and instrumentation.ts mount the provider"]);
  });

  test("its secret, its database and its key table", () => {
    const offences = mintingOffences([
      { path: "lib/loans/secret.ts", text: `const key = process.env.BETTER_AUTH_SECRET;\n` },
      { path: "lib/loans/path.ts", text: `const file = process.env.IDP_DB_PATH;\n` },
      { path: "lib/loans/keys.ts", text: `db.query('select * from "jwks"');\n` },
    ]);
    expect(offences).toHaveLength(3);
  });

  test("a comment is not an import", () => {
    expect(
      mintingOffences([{ path: "lib/agent/doc.ts", text: `// import { jwt } from "better-auth/plugins/jwt";\n/** better-auth is lib/identity's */\n` }]),
    ).toEqual([]);
  });

  test("the identity module itself is allowed what it is for", () => {
    expect(
      mintingOffences([
        { path: "lib/identity/provider/auth.ts", text: `import { betterAuth } from "better-auth";\n` },
        { path: DOOR, text: `import { openIdentityProvider } from "./server.ts";\n` },
        { path: "app/login/route.ts", text: `import { serve } from "../../lib/identity/provider/instance.ts";\n` },
      ]),
    ).toEqual([]);
  });
});
