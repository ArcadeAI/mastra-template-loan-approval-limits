/**
 * `docs/DOMAIN-SWAP.md` and `docs/control-plane.md` ship with the template, and
 * a forker follows them file by file. Both were written for the stage demo's
 * four services and named `apps/*` paths for months after the folds (#3 to #6)
 * made them one app; #11 corrected them. This keeps them corrected: every repo
 * path either one names exists, and neither mentions `apps/`.
 *
 * A path is a backticked token or a Markdown link target that contains a `/` or
 * ends in a file extension. Routes the app serves (`/hooks/pre`), placeholders
 * (`tools/<yours>/…`), package names, MCP methods and the runtime databases are
 * not files, so they are skipped, and the skip is tested below so it cannot
 * quietly grow to swallow a real path.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO = join(import.meta.dir, "..");
const DOCS = ["docs/DOMAIN-SWAP.md", "docs/control-plane.md"];

const EXT = /\.(ts|tsx|js|mjs|json|md|py|toml|yaml|yml|sh|css|db|lock|txt|png|html)$/;
/** The app's own URL prefixes: a token starting with one is a route, not a file. */
const ROUTE = /^\/(hooks|bank|identity|api|approvals|admin|health|events|access|pre|post|panel|loans|chat|oauth2|v1|arcade|audit|\.well-known)\b/;
/** The repo's top-level entries, so a bare `lib/...` is read as a repo path. */
const TOP = new Set(["app", "app-test", "components", "lib", "packages", "public", "scripts", "src", "test", "tools", "docs", ".github", ".env.example", "Dockerfile", ".dockerignore", "package.json", "DESIGN.md", "README.md", "tsconfig.json", "next.config.ts", "instrumentation.ts"]);

const TRACKED = Bun.spawnSync(["git", "ls-files"], { cwd: REPO }).stdout.toString().split("\n");

interface Findings {
  checked: number;
  missing: string[];
  apps: string[];
}

/** Every path `text` names that does not exist, read as if it were `doc`. */
function check(doc: string, text: string): Findings {
  const found: Findings = { checked: 0, missing: [], apps: [] };
  text.split("\n").forEach((line, i) => {
    const at = `${doc}:${i + 1}`;
    if (/apps\//.test(line)) found.apps.push(at);

    const candidates: Array<{ raw: string; link: boolean }> = [];
    // A backticked span may be a whole command, so each token is a candidate.
    for (const match of line.matchAll(/`([^`]+)`/g)) for (const raw of match[1]!.split(/\s+/)) candidates.push({ raw, link: false });
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) candidates.push({ raw: match[1]!, link: true });

    for (const { raw, link } of candidates) {
      if (/^(https?|mailto):/.test(raw)) continue;
      let path = raw
        .replace(/^["'(]+|["'),;:.]+$/g, "")
        .replace(/#.*$/, "")
        .replace(/::.*$/, "")
        .replace(/:\d+([-,]\d+)*$/, "");
      if (path === "" || !(path.includes("/") || EXT.test(path))) continue;
      if (skipReason(path, link) !== null) continue;

      let file: string;
      if (link || path.startsWith("../")) file = resolve(dirname(join(REPO, doc)), path);
      else {
        path = path.replace(/^\.\//, "");
        if (!path.includes("/")) {
          // A bare file name: it has to be tracked somewhere.
          found.checked++;
          if (!TRACKED.some((each) => each === path || each.endsWith(`/${path}`))) found.missing.push(`${at}: ${raw}`);
          continue;
        }
        if (!TOP.has(path.split("/")[0]!)) continue;
        file = join(REPO, path);
      }
      found.checked++;
      if (!existsSync(file)) found.missing.push(`${at}: ${raw}`);
    }
  });
  return found;
}

/** Why a path-shaped token is not a file, or `null` when it is one. */
function skipReason(path: string, link: boolean): string | null {
  if (/^(tools\/list|tools\/call|notifications\/)/.test(path)) return "MCP method";
  if (/[<>{}*$]|…/.test(path) || /\.\.\./.test(path.replace(/\[\.\.\.\w+\]/g, ""))) return "placeholder";
  if (ROUTE.test(path) && !link) return "route";
  if (/^[a-z]+:\/\//.test(path) || /^(localhost|127\.)/.test(path)) return "URL";
  if (path.startsWith("@")) return "package name";
  if (/^\/(data|tmp)\//.test(path)) return "runtime path";
  if (/^[A-Z_]+=/.test(path)) return "assignment";
  if (/^(application|text)\//.test(path)) return "MIME type";
  if (/^\.?\/?[\w.-]+\.db$/.test(path)) return "runtime database";
  return null;
}

describe("the docs that ship name only paths that exist", () => {
  for (const doc of DOCS) {
    test(doc, () => {
      const found = check(doc, readFileSync(join(REPO, doc), "utf8"));
      // A doc this checker read nothing in would pass for the wrong reason.
      expect(found.checked).toBeGreaterThan(20);
      expect(found.missing).toEqual([]);
      expect(found.apps).toEqual([]);
    });
  }
});

describe("the check bites", () => {
  test("a missing file, a stale link and an apps/ path, planted in a real doc", () => {
    const doc = "docs/DOMAIN-SWAP.md";
    const planted = `${readFileSync(join(REPO, doc), "utf8")}\nSee \`lib/loans/no-such-file.ts\` and [the old one](../apps/loan-app/README.md).\n`;
    const found = check(doc, planted);
    expect(found.missing.map((each) => each.split(": ")[1])).toEqual(["lib/loans/no-such-file.ts", "../apps/loan-app/README.md"]);
    expect(found.apps).toHaveLength(1);
  });

  test("a bare file name that is tracked nowhere", () => {
    expect(check("docs/control-plane.md", "Read `no-such-module.ts` first.").missing).toEqual(["docs/control-plane.md:1: no-such-module.ts"]);
  });

  test("the skips are routes and placeholders, never a repo path", () => {
    expect(skipReason("/hooks/pre", false)).toBe("route");
    expect(skipReason("tools/<yours>/server.py", false)).toBe("placeholder");
    expect(skipReason("governance.db", false)).toBe("runtime database");
    for (const path of ["lib/control-plane/index.ts", "app/bank/[...path]/route.ts", "../README.md", "hooks/pre.ts"]) {
      expect(skipReason(path, false)).toBeNull();
    }
    // A link is always a file, even one that reads like a route.
    expect(skipReason("/hooks/pre", true)).toBeNull();
  });
});
