/**
 * `.env.example` is minimal and honest (#9).
 *
 * Minimal: every variable it names is read by the code that ships, so nothing
 * in it is decoration. Honest: every variable that code reads is in it, as a
 * blank to fill or a commented default, or is on the short list below of
 * variables something else sets. And its required block is the few a developer
 * fills by hand; everything else is written by `bun run setup-arcade` or has a
 * default.
 *
 * The sweep reads the source rather than trusting a list, so a variable added
 * to the code without a line here, or left here after the code stops reading
 * it, fails this test by name.
 */
import { Glob } from "bun";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readConfig } from "../lib/identity/provider/config.ts";

const ROOT = join(import.meta.dir, "..");
const example = readFileSync(join(ROOT, ".env.example"), "utf8");

/** Every name the file mentions as a variable: `KEY=` and `# KEY=`. */
const named = [...example.matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map(([, key]) => key!);
const active = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=(.*)$/gm)].map(([, key, value]) => ({ key: key!, value: value! }));

/** The code that ships: the app, its modules, its scripts, the toolkits. Never tests. */
const SHIPPED = [
  "app",
  "lib",
  "src",
  "components",
  "scripts",
  "packages/governance-core/src",
  "packages/policy-schema/src",
  "packages/policy-schema/contract",
  "tools/loan/loan",
  "tools/approvals/approvals",
];
const files = [
  ...SHIPPED.flatMap((dir) => [...new Glob(`${dir}/**/*.{ts,tsx,py}`).scanSync({ cwd: ROOT })]),
  "instrumentation.ts",
  "next.config.ts",
].filter((file) => !/node_modules|\.test\.|\/tests?\//.test(file));

/** Source lines, comments dropped: a variable named only in a comment is not read. */
const code = files.flatMap((file) =>
  readFileSync(join(ROOT, file), "utf8")
    .split("\n")
    .map((line, index) => ({ at: `${file}:${index + 1}`, line }))
    .filter(({ line }) => !/^\s*(\*|\/\/|\/\*|#)/.test(line)),
);

/**
 * Read by the code and deliberately not in `.env.example`, because something
 * other than the developer sets them. A new entry needs a reason as good as these.
 */
const SET_ELSEWHERE: Record<string, string> = {
  NODE_ENV: "set by Next and by the Dockerfile",
  NEXT_RUNTIME: "set by Next",
  CG_NEXT_DIST_DIR: "set by test harnesses, to run a second `next dev`",
  CG_SHARD_RECORD: "set by CI's test shard runner (scripts/test-shards.ts), for its bun test preload",
  SLACK_API_BASE_URL: "the approvals toolkit's test override, in Arcade's worker, not the app",
  ARCADE_WORK_DIR: "the Arcade CLI's own, naming its config directory; setup-arcade reads the CLI's context where the CLI does",
  ARCADE_CONTEXT: "the Arcade CLI's own, choosing a saved context; setup-arcade honours it as the CLI does",
  HOME: "the shell's, where the Arcade CLI keeps ~/.arcade",
  MASTRA_PROJECT_ROOT: "the Mastra CLI's own, set on the Studio server `mastra dev` spawns; memory.db resolves against it (#36)",
};

/** Dynamic names: `IDP_OAUTH_REDIRECT_URIS_<KEY>` for each client key. */
const DYNAMIC = /^IDP_OAUTH_REDIRECT_URIS_[A-Z_]+$/;

test("every variable .env.example names is read by the code that ships", () => {
  expect(named.length).toBeGreaterThan(20);
  const unread: string[] = [];
  for (const key of named) {
    if (DYNAMIC.test(key)) continue;
    const hit = code.find(({ line }) => new RegExp(`\\b${key}\\b`).test(line));
    if (hit === undefined) unread.push(key);
  }
  expect(unread).toEqual([]);
});

test("each IDP_OAUTH_REDIRECT_URIS_<KEY> in .env.example reaches its client", () => {
  const dynamic = named.filter((key) => DYNAMIC.test(key));
  expect(dynamic.sort()).toEqual([
    "IDP_OAUTH_REDIRECT_URIS_ARCADE",
    "IDP_OAUTH_REDIRECT_URIS_ARCADE_USER_SOURCE",
    "IDP_OAUTH_REDIRECT_URIS_WEB",
  ]);
  const env: Record<string, string> = { IDP_OAUTH_CLIENTS: "arcade,arcade-user-source,web" };
  for (const key of dynamic) env[key] = `https://${key.toLowerCase()}.example/callback`;
  const { clients } = readConfig(env);
  for (const key of dynamic) {
    const client = clients.find((each) => `IDP_OAUTH_REDIRECT_URIS_${each.key.toUpperCase().replace(/-/g, "_")}` === key);
    expect(client?.redirectUris, key).toEqual([env[key]!]);
  }
});

test("every variable the code reads is in .env.example or is set by something else", () => {
  const reads = new Map<string, string>();
  const patterns = [
    /\benv\.([A-Z][A-Z0-9_]+)\b/g,
    /\benv\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
    /process\.env\.([A-Z][A-Z0-9_]+)/g,
    /os\.environ(?:\.get)?\(\s*["']([A-Z][A-Z0-9_]+)/g,
    /os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)/g,
  ];
  for (const { at, line } of code) {
    for (const pattern of patterns) for (const [, key] of line.matchAll(pattern)) if (!reads.has(key!)) reads.set(key!, at);
  }
  // The sweep has to have found the variables it exists for, or it proves nothing.
  for (const key of ["ANTHROPIC_API_KEY", "APP_PUBLIC_HOST", "SESSION_SECRET", "IDP_OAUTH_CLIENTS", "RESET_TOKEN"]) {
    expect(reads.has(key), `the sweep found no read of ${key}`).toBe(true);
  }
  const missing = [...reads].filter(([key]) => !named.includes(key) && !(key in SET_ELSEWHERE)).map(([key, at]) => `${key} (${at})`);
  expect(missing).toEqual([]);
  // And nothing on the list is also in the file, which would make one of the two wrong.
  expect(Object.keys(SET_ELSEWHERE).filter((key) => named.includes(key))).toEqual([]);
});

// #33: the four `PERSONA_*_EMAIL` role variables and their contract are gone.
// Users are added with `bun run users`, so no persona variable is documented,
// read or refused anywhere, and the contract module no longer exists.
test("no persona variable is in it, and the persona email contract is gone", () => {
  expect(example).not.toMatch(/PERSONA_/);
  expect(existsSync(join(ROOT, "packages/policy-schema/contract/persona-email-contract.ts"))).toBe(false);
  expect(example).toContain("bun run users seed-demo");
});

test("the required block is the few a developer fills, and nothing in the file ships a value", () => {
  const required = example.slice(example.indexOf("# --- Required"), example.indexOf("# --- Filled in by"));
  expect([...required.matchAll(/^([A-Z][A-Z0-9_]+)=$/gm)].map(([, key]) => key)).toEqual([
    "ANTHROPIC_API_KEY",
    "ARCADE_API_KEY",
    "APP_PUBLIC_HOST",
  ]);
  // `cp .env.example .env` is the "nothing filled" state the Quickstart boots
  // from, so no active line carries a value. Defaults live in the code and are
  // shown commented out.
  expect(active.filter(({ value }) => value !== "")).toEqual([]);
});
