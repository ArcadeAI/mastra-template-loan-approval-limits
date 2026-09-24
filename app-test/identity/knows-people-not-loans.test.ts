/**
 * The identity provider knows people, not loans and not policy. It is the
 * enterprise's identity provider, standing in for the real one, and a forker
 * with a real IdP replaces it — so it must depend on nothing in the template.
 *
 * Carried from `apps/idp/test/` on #6, when the service became the app's
 * identity module (`lib/identity/provider/`, its scripts under
 * `scripts/identity/` and `scripts/identity.ts`). The source scan moved with
 * it and the assertions did not change. One test did not survive the fold:
 * "nothing else in the template depends on it". The app mounts the provider
 * now, by DESIGN.md's decision, so that claim is false by construction. Its
 * replacement is the narrower rule the fold needs,
 * `only-identity-mints.test.ts`: only the identity routes reach it, and no
 * other module imports its signing keys or its token issuance.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
/** The module's own directory, which holds its `package.json` as `apps/idp` did. */
const ROOT = join(REPO, "lib", "identity", "provider");

/**
 * Comments are stripped before matching, as in the loan book's sibling test:
 * a comment's job here is partly to say what this service does *not* know.
 * Block comments and whole-line `//` comments only.
 */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

/** What `apps/idp`'s `src/` and `scripts/` became: the module, its scripts, and its runner. */
const SOURCES = ["lib/identity/provider/**/*.ts", "scripts/identity/**/*.ts", "scripts/identity.ts"];

async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const files = [];
  for (const pattern of SOURCES) {
    for await (const path of new Glob(pattern).scan(REPO)) {
      if (path.includes("node_modules/")) continue;
      files.push({ path, text: stripComments(await Bun.file(join(REPO, path)).text()) });
    }
  }
  // Vacuous if the scan found nothing: the move is exactly when a path goes stale.
  expect(files.map((file) => file.path)).toContain("lib/identity/provider/server.ts");
  return files;
}

describe("the identity provider knows people, not loans", () => {
  test.each([
    ["loan", /\bloans?\b/i],
    ["borrower", /\bborrower/i],
    ["underwriter", /\bunderwrit/i],
    ["approve", /\bapprov(e|al)/i],
  ])("no source file mentions %s", async (_word, pattern) => {
    const offenders = (await sourceFiles()).filter((f) => pattern.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test("imports nothing from the governance packages", async () => {
    const offenders = (await sourceFiles())
      .filter((f) => /from\s+["']@cg\//.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test("declares no @cg/* dependency and is flagged external for the policy-schema sweep", async () => {
    const manifest = await Bun.file(join(ROOT, "package.json")).json();
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    expect(declared.filter((name) => name.startsWith("@cg/"))).toEqual([]);
    expect(manifest.cg?.external).toBe(true);
  });
});
