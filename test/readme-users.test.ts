/**
 * The README's `bun run users` commands, run as written (#34).
 *
 * Since #33 nobody is seeded, so the Quickstart's "Add yourself and an
 * approver" step is the only way anybody can sign in, and Try it out adds Bob
 * and Michael the same way. A command there that the CLI refuses (a role the
 * policy does not know, a clearance it requires and the line leaves out) reads
 * exactly like one that works until somebody types it. So this reads the
 * commands out of the README, fills in the placeholders, and runs each one
 * against a scratch pair of databases, the way `app-test/users-cli.test.ts`
 * runs the command: `--no-env-file` and an allowlisted environment, so nothing
 * from this checkout's `.env` files reaches it.
 *
 * It also holds the step to the act it sets up: the loan officer's clearance
 * is under the $95K the Quickstart asks for, and the approver's covers it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnChild } from "../app-test/child.ts";
import { childEnv } from "../app-test/child-env.ts";

const REPO = join(import.meta.dir, "..");
const README = readFileSync(join(REPO, "README.md"), "utf8");
const DOMAIN_SWAP = readFileSync(join(REPO, "docs", "DOMAIN-SWAP.md"), "utf8");

const ADD_STEP = "8. **Add yourself and an approver**";
const ASK_STEP = "9. **Ask for the $95K approval**";

const scratch = mkdtempSync(join(tmpdir(), "cg-readme-users-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The text under one H2, up to the next H2. */
function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line === `## ${title}`);
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/** The Quickstart's add step, up to the step after it. */
function addStep(markdown: string): string {
  const quickstart = section(markdown, "Quickstart 🚀");
  const start = quickstart.indexOf(ADD_STEP);
  const end = quickstart.indexOf(ASK_STEP);
  return start === -1 || end === -1 || end < start ? "" : quickstart.slice(start, end);
}

/** Every backticked `bun run users add …` in the text, as argv after `users`. */
function addCommands(text: string): string[][] {
  return [...text.matchAll(/`bun run users (add [^`]+)`/g)].map((match) => match[1]!.trim().split(/\s+/));
}

/** The placeholders filled in with a different address each, as a reader would. */
function filled(argv: string[], index: number): string[] {
  return argv.map((arg) => (/^<[\w-]*email>$/.test(arg) ? `reader-${index}@example.test` : arg));
}

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

/** Whether the loan officer is refused the $95K and the approver may grant it: act 2, as step 8 sets it up. */
function coversTheAct(commands: string[][]): boolean {
  const [officer, approver] = commands.map((argv) => Number(flag(argv, "clearance")));
  return officer! < 95_000 && approver! >= 95_000;
}

/** The README with step 8 moved after step 9, the order in which nobody can sign in. */
function addStepAfterAsk(markdown: string): string {
  const start = markdown.indexOf(ADD_STEP);
  const ask = markdown.indexOf(ASK_STEP);
  const end = markdown.indexOf("\n## ", ask);
  return markdown.slice(0, start) + markdown.slice(ask, end) + markdown.slice(start, ask) + markdown.slice(end);
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function users(dir: string, args: string[]): Promise<Run> {
  const child = spawnChild(["bun", "--no-env-file", "scripts/users.ts", ...args], {
    cwd: REPO,
    env: childEnv({ IDP_DB_PATH: join(dir, "idp.db"), GOVERNANCE_DB_PATH: join(dir, "governance.db") }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

/** Runs every command against one fresh pair of databases; the failures, by command. */
async function runAll(commands: string[][]): Promise<{ failures: string[]; list: string }> {
  const dir = mkdtempSync(join(scratch, "case-"));
  const failures: string[] = [];
  for (const [i, argv] of commands.entries()) {
    const run = await users(dir, filled(argv, i));
    if (run.code !== 0) failures.push(`users ${argv.join(" ")} exited ${run.code}: ${run.stderr.trim()}`);
  }
  const list = await users(dir, ["list"]);
  return { failures, list: list.stdout };
}

describe("the README's users commands", () => {
  const step = addStep(README);
  const quickstartAdds = addCommands(step);
  const tryItOutAdds = addCommands(section(README, "Try it out"));

  test("step 8 adds a loan officer and a VP, right before the app is opened", () => {
    expect(step).not.toBe("");
    expect(quickstartAdds.map((argv) => flag(argv, "role"))).toEqual(["loan_officer", "vp_credit"]);
    const quickstart = section(README, "Quickstart 🚀");
    expect(quickstart.indexOf(ADD_STEP)).toBeLessThan(quickstart.indexOf("Open `https://<APP_PUBLIC_HOST>`"));
  });

  test("the loan officer's clearance is under $95K and the approver's covers it", () => {
    expect(coversTheAct(quickstartAdds)).toBe(true);
  });

  test("step 8 says the approver's email is their Slack one, names the Arcade invite, and offers seed-demo", () => {
    expect(step).toContain("Use the email the approver's Slack account uses");
    expect(step).toContain("under your project's Members");
    expect(step).toContain("(see [Do my users need Arcade accounts?](#faq))");
    expect(step).toContain("`bun run users seed-demo`");
  });

  test("Try it out adds Bob and Michael, with the demo's roles", () => {
    expect(tryItOutAdds.map((argv) => [flag(argv, "name"), flag(argv, "role")])).toEqual([
      ["Bob", "credit_analyst"],
      ["Michael", "chief_credit_officer"],
    ]);
  });

  test("every one of them runs as written, and adds who it says", async () => {
    const commands = [...quickstartAdds, ...tryItOutAdds];
    expect(commands).toHaveLength(4);
    const { failures, list } = await runAll(commands);
    expect(failures).toEqual([]);
    const rows = list.split("\n").filter((line) => line.startsWith("reader-"));
    expect(rows.map((row) => row.split(/\s{2,}/).slice(1, 4))).toEqual([
      ["Alice", "loan_officer", "50000"],
      ["Charlie", "vp_credit", "250000"],
      ["Bob", "credit_analyst", "0"],
      ["Michael", "chief_credit_officer", "5000000"],
    ]);
  }, 60_000);
});

describe("the FAQ the docs point at", () => {
  test("the README's FAQ answers it, and DOMAIN-SWAP links to it rather than repeating it", () => {
    const faq = section(README, "FAQ");
    expect(faq).toContain("**Do my users need Arcade accounts?** Anyone who requests an approval does, and nobody else.");
    expect(faq).toContain("register your own Slack app as a custom OAuth provider");
    expect(DOMAIN_SWAP).toContain("[Do my users need Arcade accounts?](../README.md#faq)");
    expect(DOMAIN_SWAP).not.toContain("Anyone who requests an approval does, and nobody else.");
  });
});

describe("the checks bite on a planted violation", () => {
  test("a role the policy does not know, and a clearance the role needs left out", async () => {
    const planted = addCommands(addStep(README.replace("--role vp_credit", "--role vp").replace("--clearance 50000", "")));
    const { failures } = await runAll(planted);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("--clearance is required for role loan_officer");
    expect(failures[1]).toContain('role "vp" is not one the policy knows');
  }, 60_000);

  test("an approver whose clearance does not cover the $95K, and a loan officer whose does", () => {
    expect(coversTheAct(addCommands(addStep(README.replace("--clearance 250000", "--clearance 90000"))))).toBe(false);
    expect(coversTheAct(addCommands(addStep(README.replace("--clearance 50000", "--clearance 100000"))))).toBe(false);
  });

  test("the add step moved after the step that opens the app", () => {
    const planted = addStepAfterAsk(README);
    expect(planted.length).toBe(README.length);
    expect(addStep(planted)).toBe("");
  });
});
