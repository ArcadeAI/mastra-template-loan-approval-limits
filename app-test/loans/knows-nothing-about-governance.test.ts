/**
 * The defining constraint of the loan module, enforced rather than asserted.
 *
 * `lib/loans/` is the system being governed. It was `apps/loan-app`, its own
 * service, until #5 folded it into the app; the boundary moved with it and
 * still covers every file in the module. If a check ever appears in
 * here, the demo stops proving anything: the whole claim is that the controls
 * live outside the business system, in a control plane it cannot influence.
 * The pull to add "just one guard" here is real, so this test is the thing
 * that says no.
 *
 * Sibling of `packages/governance-core/test/no-app-dependencies.test.ts`,
 * which enforces the boundary from the other side.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The whole module: every `.ts` under `lib/loans/`, at any depth. Not a list
 * of files, so a file added to the module is scanned without anybody
 * remembering to add it.
 */
const SRC = join(import.meta.dir, "..", "..", "lib", "loans");

/**
 * Comments are stripped before matching, because a comment's job here is
 * partly to say what this service deliberately does *not* do — "it does not
 * check authority" has to be sayable. Code and string literals are not
 * stripped: a tool description that talked about authority would reach the
 * model and is exactly what this test is for.
 *
 * Block comments and whole-line `//` comments only. A trailing comment on a
 * line of code will trip this, which is a fine trade for not having to parse
 * TypeScript to tell a comment from a string.
 */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Source only. `fixtures/loans.json` is exempt on purpose: it is domain
 * data, and one of its `underwriter_notes` deliberately contains an
 * instruction aimed at whatever model reads the record — that is act 4's
 * payload, and it has to survive here to be stripped downstream.
 */
async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const files = [];

  for await (const path of new Glob("**/*.ts").scan(SRC)) {
    const source = await Bun.file(join(SRC, path)).text();
    files.push({ path, text: stripComments(source) });
  }

  return files;
}

/**
 * Each word is one of the vocabularies this service must not have. A match is
 * not automatically a bug — but it means someone taught the loan book
 * something it is not allowed to know, and the fix is almost always to move
 * the code to the control plane.
 */
const FORBIDDEN = [
  ["policy", /\bpolic(y|ies)\b/i],
  ["role", /\brole/i],
  ["limit", /\blimit/i],
  ["redact", /\bredact/i],
  ["authority", /\bauthorit/i],
  ["approver", /\bapprover/i],
  ["permission", /\bpermission/i],
  // Deliberately not on this list: "allowed". HTTP owns that word — a 405's
  // reason phrase is "Method not allowed" — so matching it would only teach
  // people to add exemptions.
] as const;

describe("the loan module knows nothing about governance", () => {
  test.each(FORBIDDEN)("no source file mentions %s", async (_word, pattern) => {
    const offenders = (await sourceFiles())
      .filter((file) => pattern.test(file.text))
      .map((file) => relative(".", join(SRC, file.path)));

    expect(offenders).toEqual([]);
  });

  /**
   * Added on #5, when the module moved. A boundary test that scans nothing
   * passes, and so does one whose glob was quietly narrowed to the files that
   * happen to be clean. So the scan is compared with the module's files as the
   * filesystem lists them — every `.ts` under `lib/loans/`, dependencies aside
   * — and it has to be the same set, and not empty.
   */
  test("scans every source file in the module", async () => {
    const onDisk = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((path) => path.endsWith(".ts") && !path.split(sep).includes("node_modules"))
      .sort();
    const scanned = (await sourceFiles()).map((file) => file.path).sort();

    expect(onDisk).toContain("server.ts");
    expect(onDisk).toContain("instance.ts");
    expect(scanned).toEqual(onDisk);
  });

  test("does not import from the governance packages", async () => {
    const offenders = (await sourceFiles())
      .filter((file) => /from\s+["']@cg\//.test(file.text))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  test("declares itself the governed app, so the boundary is enforced from both sides", async () => {
    const manifest = await Bun.file(join(SRC, "package.json")).json();

    // `packages/policy-schema` sweeps every workspace and requires it to
    // declare `@cg/policy-schema`; this flag is how it knows to exempt this
    // one. Without it the sweep puts the governance vocabulary back inside the
    // business system, and the two tests contradict each other. #33.
    expect(manifest.cg?.governed).toBe(true);
  });

  test("declares no dependency on anything under packages/", async () => {
    const manifest = await Bun.file(join(SRC, "package.json")).json();
    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });

    expect(declared.filter((name) => name.startsWith("@cg/"))).toEqual([]);
  });
});
