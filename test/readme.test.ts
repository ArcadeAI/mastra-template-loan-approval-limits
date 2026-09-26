/**
 * The root `README.md` is what a new user reads first, and Mastra builds the
 * template page from it (#10). These are the mechanical halves of its
 * acceptance criteria: Mastra's outline in order, the Demo placeholder word for
 * word, every environment variable it names present in `.env.example`, its
 * Prerequisites naming exactly `.env.example`'s Required block, every relative
 * link and anchor resolving, every external link one somebody verified, no em
 * dash, and no ordinary paragraph indented.
 *
 * Each check is a function of the text, so each one is also run against a
 * planted violation below: a check that cannot fail is indistinguishable from
 * one that passes.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO = join(import.meta.dir, "..");
const README = readFileSync(join(REPO, "README.md"), "utf8");
const ENV_EXAMPLE = readFileSync(join(REPO, ".env.example"), "utf8");

/** Mastra's required outline (`.orca/local/human/mastra-contributing-guide.md`), before any contributor section. */
const REQUIRED_H2 = ["Why we built this", "Demo", "Prerequisites", "Quickstart 🚀", "Try it out", "Customization"];
const LAST_H2 = "About Mastra templates";
const DEMO_PLACEHOLDER = [
  "<!-- TODO: REPLACE THIS PLACEHOLDER WITH THE CLOUDINARY DEMO VIDEO URL -->",
  '<video controls width="640" height="360" src="CLOUDINARY_DEMO_VIDEO_URL_REQUIRED"></video>',
];

/**
 * Every external URL the README may link to, and where each was verified. A
 * new one fails here until somebody verifies it and adds it: the README never
 * guesses a URL (#10). `localhost` links are the reader's own machine and are
 * not listed.
 */
const VERIFIED_URLS = new Set([
  // The human's, relayed by the driver on #10 (2026-09-24).
  "https://api.arcade.dev/dashboard/api-keys",
  "https://github.com/ArcadeAI/mastra-template-loan-approval-limits",
  // Fetched on #10: "API keys | Claude Platform", where console.anthropic.com/settings/keys redirects.
  "https://platform.claude.com/settings/keys",
  // Fetched on #10: Arcade's "Deploying to the cloud with Arcade Deploy", which installs the CLI.
  "https://docs.arcade.dev/en/build/arcade-deploy",
  // Fetched on #10: ngrok's "Domains", on the free dev domain every account has.
  "https://ngrok.com/docs/universal-gateway/domains/",
  // Fetched on #30, for the Arcade CLI steps under Prerequisites: the CLI
  // reference (`uv tool install arcade-mcp`, `arcade login`), the cheat sheet
  // (`arcade org set`, `arcade project set`, `arcade whoami`, and "switching
  // organization also resets your active project"), the API key page, and the
  // Operate quickstart ("create administrator credentials and a project").
  "https://docs.arcade.dev/en/references/arcade-cli",
  "https://docs.arcade.dev/en/references/cli-cheat-sheet",
  "https://docs.arcade.dev/en/get-started/setup/api-keys",
  "https://docs.arcade.dev/en/operate/quickstart",
]);

/** Upper-snake words in the README that are not environment variables. Each is also proved absent from `.env.example`. */
const NOT_VARIABLES = new Set(["CHECK_FAILED", "CLOUDINARY_DEMO_VIDEO_URL_REQUIRED"]);

// --- Reading the Markdown ----------------------------------------------------

/** The lines outside fenced code blocks, with their 1-based line numbers. */
function proseLines(markdown: string): Array<{ n: number; text: string }> {
  const lines: Array<{ n: number; text: string }> = [];
  let fenced = false;
  markdown.split("\n").forEach((text, i) => {
    if (/^\s*```/.test(text)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) lines.push({ n: i + 1, text });
  });
  return lines;
}

function headings(markdown: string): Array<{ level: number; title: string }> {
  return proseLines(markdown).flatMap(({ text }) => {
    const match = /^(#{1,6}) (.+?)\s*$/.exec(text);
    return match ? [{ level: match[1]!.length, title: match[2]! }] : [];
  });
}

/** The text under one H2, up to the next H2. */
function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line === `## ${title}`);
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/** GitHub's heading anchors: lowercased, punctuation and emoji dropped, spaces to hyphens, repeats suffixed. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const found = new Set<string>();
  for (const { title } of headings(markdown)) {
    const base = title
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.add(count === 0 ? base : `${base}-${count}`);
  }
  return found;
}

function links(markdown: string): string[] {
  return proseLines(markdown).flatMap(({ text }) => [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!));
}

/** Every upper-snake word in the text, which is how this repo spells an environment variable. */
function variablesNamed(markdown: string): Set<string> {
  const words = markdown.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [];
  return new Set(words.filter((word) => !NOT_VARIABLES.has(word)));
}

/** Every variable `.env.example` carries, set or commented out. */
function exampleVariables(example: string): Set<string> {
  return new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!));
}

/** The variables in `.env.example`'s "Required: you fill these" block. */
function requiredBlock(example: string): Set<string> {
  const lines = example.split("\n");
  const start = lines.findIndex((line) => /^# --- Required/.test(line));
  const end = lines.findIndex((line, i) => i > start && /^# --- /.test(line));
  return exampleVariables(lines.slice(start + 1, end).join("\n"));
}

// --- The checks ---------------------------------------------------------------

/** Relative links whose file, or whose anchor in that file, does not exist. */
function brokenRelativeLinks(markdown: string, from = join(REPO, "README.md")): string[] {
  return links(markdown).flatMap((target) => {
    if (/^(https?:|mailto:)/.test(target)) return [];
    const [path, anchor] = target.split("#") as [string, string | undefined];
    const file = path === "" ? from : resolve(dirname(from), path);
    if (!existsSync(file)) return [`${target}: no such file`];
    if (anchor === undefined) return [];
    if (statSync(file).isDirectory() || !file.endsWith(".md")) return [`${target}: an anchor into something that is not Markdown`];
    const text = file === from ? markdown : readFileSync(file, "utf8");
    return anchors(text).has(anchor) ? [] : [`${target}: no heading with that anchor`];
  });
}

/** External links nobody verified. */
function unverifiedUrls(markdown: string): string[] {
  return links(markdown).filter(
    (target) => /^https?:/.test(target) && !/^https?:\/\/localhost[:/]/.test(target) && !VERIFIED_URLS.has(target),
  );
}

/** Indented lines outside fenced code that do not belong to a list item. */
function indentedParagraphs(markdown: string): number[] {
  const offending: number[] = [];
  let inList = false;
  for (const { n, text } of proseLines(markdown)) {
    if (text.trim() === "") continue;
    if (/^\S/.test(text)) {
      inList = /^([-*]|\d+\.) /.test(text);
      continue;
    }
    if (!inList) offending.push(n);
  }
  return offending;
}

/** Lines that are only bold text, the shape the guide forbids as a section title. */
function boldTitles(markdown: string): number[] {
  return proseLines(markdown)
    .filter(({ text }) => /^\s*(?:[-*]\s+)?\*\*[^*]+\*\*:?\s*$/.test(text))
    .map(({ n }) => n);
}

/**
 * The Quickstart's remaining steps, from starting the app, in the one order
 * the dependencies allow (#28, #30): Arcade reads the User Source's issuer
 * through the tunnel, so the form comes after it, and the gateway
 * authenticates through the User Source, so the second `setup-arcade` run that
 * creates it needs the User Source's id. The hooks and the deploys are the
 * first run's, in step 4. `setup-arcade`'s "Then:" list is held to the same
 * order in `app-test/setup-arcade.test.ts`.
 */
const QUICKSTART_ORDER: Array<[string, RegExp]> = [
  ["start the app", /Run `bun run dev`/],
  ["start the tunnel", /`ngrok http --url=/],
  ["the User Source form", /fill in the User Source form/i],
  ["the gateway, by the second run", /`bun run setup-arcade <APP_PUBLIC_HOST> --user-source <id>`/],
  ["open the app", /Open `https:\/\/<APP_PUBLIC_HOST>`/],
];

/**
 * The Arcade CLI's setup under Prerequisites, in the order it has to happen
 * (#30): `setup-arcade` takes the org and project from the CLI's active
 * context, so the CLI is installed, logged in and pointed at the project the
 * key belongs to before the first run. `arcade org set` comes before
 * `arcade project set` because switching org resets the active project.
 */
const CLI_SETUP: Array<[string, RegExp]> = [
  ["install the CLI", /`uv tool install arcade-mcp`/],
  ["log in", /`arcade login`/],
  ["create a project", /Create a project for this template in the Arcade dashboard/],
  ["an API key in that project", /Create an API key in that project and set `ARCADE_API_KEY`/],
  ["make it the active project", /`arcade project set <project_id>`/],
  ["check it", /`arcade whoami` shows that org and project/],
];

function inOrder(text: string, steps: Array<[string, RegExp]>): string[] {
  const found = steps.map(([name, pattern]) => ({ name, at: text.search(pattern) }));
  const missing = found.filter(({ at }) => at === -1).map(({ name }) => `missing: ${name}`);
  return missing.length > 0 ? missing : found.sort((a, b) => a.at - b.at).map(({ name }) => name);
}

/** The steps in the order the Quickstart's remainder first names them, or the ones it never does. */
function quickstartOrder(markdown: string): string[] {
  const quickstart = section(markdown, "Quickstart 🚀");
  const rest = quickstart.slice(Math.max(0, quickstart.indexOf("5. **Start the app")));
  const found = QUICKSTART_ORDER.map(([name, pattern]) => ({ name, at: rest.search(pattern) }));
  const missing = found.filter(({ at }) => at === -1).map(({ name }) => `missing: ${name}`);
  return missing.length > 0 ? missing : found.sort((a, b) => a.at - b.at).map(({ name }) => name);
}

// --- The README ---------------------------------------------------------------

describe("README.md follows Mastra's outline", () => {
  test("one H1, the template's title", () => {
    expect(headings(README).filter((h) => h.level === 1).map((h) => h.title)).toEqual(["Loan Approval Limits with Arcade"]);
  });

  test("the required H2s come first and in order, and About Mastra templates is last", () => {
    const h2 = headings(README).filter((h) => h.level === 2).map((h) => h.title);
    expect(h2.slice(0, REQUIRED_H2.length)).toEqual(REQUIRED_H2);
    expect(h2.at(-1)).toBe(LAST_H2);
    expect(h2.filter((title) => title === LAST_H2)).toHaveLength(1);
    expect(h2.some((title) => /feature/i.test(title))).toBe(false);
  });

  test("no section title is a bold line", () => {
    expect(boldTitles(README)).toEqual([]);
  });

  test("Demo carries the guide's placeholder, word for word", () => {
    const demo = section(README, "Demo");
    for (const line of DEMO_PLACEHOLDER) expect(demo).toContain(line);
  });

  test("Quickstart is numbered steps with bold labels, from create-mastra to https://<APP_PUBLIC_HOST>", () => {
    const quickstart = section(README, "Quickstart 🚀");
    const steps = quickstart.split("\n").filter((line) => /^\S/.test(line));
    expect(steps.length).toBeGreaterThan(3);
    for (const step of steps) expect(step).toMatch(/^\d+\. \*\*[^*]+\*\*$/);

    const create = /`npx create-mastra@latest (\S+) --template arcade-governance[^`]*`/.exec(quickstart);
    expect(create).not.toBeNull();
    expect(quickstart).toContain(`\`cd ${create![1]}\``);
    for (const command of ["`bun install`", "`cp .env.example .env`", "`bun run setup-arcade <APP_PUBLIC_HOST>`", "`bun run dev`", "`arcade deploy`"]) {
      expect(quickstart).toContain(command);
    }
    expect(quickstart).toContain("https://<APP_PUBLIC_HOST>");
    expect(quickstart).not.toContain("git clone");
  });

  test("the Quickstart's last steps run in the order the dependencies allow: tunnel, User Source, the gateway run, the app", () => {
    expect(quickstartOrder(README)).toEqual(QUICKSTART_ORDER.map(([name]) => name));
  });

  test("step 4 is the run that registers the hooks and deploys both toolkits", () => {
    const quickstart = section(README, "Quickstart 🚀");
    const register = quickstart.slice(quickstart.indexOf("4. **Register the app with Arcade**"), quickstart.indexOf("5. **Start the app"));
    expect(register).toContain("the contextual access hooks through Arcade's API");
    expect(register).toContain("it runs `arcade deploy` in `tools/loan` and then in `tools/approvals`");
    expect(register).toContain("the one form Arcade's API cannot fill, the User Source");
    expect(quickstart).not.toMatch(/fill in the (gateway|contextual access hooks) form/i);
  });

  test("Prerequisites sets up the Arcade CLI in order, each step with its command", () => {
    const prerequisites = section(README, "Prerequisites");
    expect(inOrder(prerequisites, CLI_SETUP)).toEqual(CLI_SETUP.map(([name]) => name));
    expect(prerequisites).toContain("run `arcade org set <org_id>` first, because switching org resets the active project");
  });

  test("the Quickstart warns about ngrok's page on a free domain, once, where the app is first opened", () => {
    const quickstart = section(README, "Quickstart 🚀");
    const open = quickstart.slice(quickstart.indexOf("8. **Ask for the $95K approval**"));
    expect(open).toContain("The first time a browser opens a free ngrok domain, ngrok shows its own warning page first: click **Visit Site**.");
    expect(open).toContain("Arcade's own calls to the app never see that page.");
    expect(README.match(/Visit Site/g)).toHaveLength(1);
  });

  test("About Mastra templates is the partnership pattern, with no monorepo language", () => {
    const about = section(README, LAST_H2);
    expect(about).toContain("This partnership template was contributed by Arcade");
    expect(about).toContain("Partnership templates live in their own repositories.");
    expect(about).toContain("[Want to contribute?](https://github.com/ArcadeAI/mastra-template-loan-approval-limits)");
    expect(README).not.toMatch(/monorepo|synchroni[sz]/i);
  });
});

describe("README.md's variables are .env.example's", () => {
  test("every variable the README names is in .env.example", () => {
    const missing = [...variablesNamed(README)].filter((name) => !exampleVariables(ENV_EXAMPLE).has(name));
    expect(missing).toEqual([]);
  });

  test("Prerequisites names exactly the Required block", () => {
    const required = requiredBlock(ENV_EXAMPLE);
    expect([...required].sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "APP_PUBLIC_HOST",
      "ARCADE_API_KEY",
      "PERSONA_CHIEF_CREDIT_OFFICER_EMAIL",
      "PERSONA_CREDIT_ANALYST_EMAIL",
      "PERSONA_LOAN_OFFICER_EMAIL",
      "PERSONA_VP_CREDIT_EMAIL",
    ]);
    expect([...variablesNamed(section(README, "Prerequisites"))].sort()).toEqual([...required].sort());
  });

  test("the words exempted from the check are not variables .env.example knows", () => {
    for (const word of NOT_VARIABLES) expect(exampleVariables(ENV_EXAMPLE).has(word)).toBe(false);
  });
});

describe("README.md's links and typography", () => {
  test("every relative link and anchor resolves", () => {
    expect(links(README).filter((target) => !/^https?:/.test(target)).length).toBeGreaterThan(0);
    expect(brokenRelativeLinks(README)).toEqual([]);
  });

  test("every external link is one somebody verified", () => {
    expect(unverifiedUrls(README)).toEqual([]);
  });

  test("no em dash", () => {
    expect(README.split("—").length - 1).toBe(0);
  });

  test("no ordinary paragraph is indented", () => {
    expect(indentedParagraphs(README)).toEqual([]);
  });
});

// --- Each check, shown failing ------------------------------------------------

describe("each check bites on a planted violation", () => {
  test("a variable .env.example does not have", () => {
    const planted = `${README}\nSet \`ARCADE_IDP_PROVIDER_ID\` too.\n`;
    expect([...variablesNamed(planted)].filter((name) => !exampleVariables(ENV_EXAMPLE).has(name))).toEqual(["ARCADE_IDP_PROVIDER_ID"]);
  });

  test("an eighth variable in Prerequisites", () => {
    const planted = README.replace("## Prerequisites\n", "## Prerequisites\n\n- Set `MODEL_ID`.\n");
    expect(variablesNamed(section(planted, "Prerequisites")).has("MODEL_ID")).toBe(true);
    expect(variablesNamed(section(planted, "Prerequisites")).size).toBe(requiredBlock(ENV_EXAMPLE).size + 1);
  });

  test("a stale path, and an anchor that is not there", () => {
    expect(brokenRelativeLinks("[web](./apps/web/README.md) and [setup](#setup-from-zero)")).toEqual([
      "./apps/web/README.md: no such file",
      "#setup-from-zero: no heading with that anchor",
    ]);
    expect(brokenRelativeLinks("[design](./DESIGN.md#identity-and-oauth) and [start](#quickstart-)", join(REPO, "README.md"))).toEqual([
      "#quickstart-: no heading with that anchor",
    ]);
    expect(brokenRelativeLinks(`${README}\n[start](#quickstart-)\n`)).toEqual([]);
  });

  test("a link into a doc #11 deleted, planted in the README itself", () => {
    // The README linked into all three until #11 removed them; each one is now
    // a dead link the check has to catch.
    const planted = `${README}\n[runbook](./docs/RUNBOOK.md), [app](./docs/app.md) and [spikes](./docs/spikes/04-user-source.md)\n`;
    expect(brokenRelativeLinks(planted)).toEqual([
      "./docs/RUNBOOK.md: no such file",
      "./docs/app.md: no such file",
      "./docs/spikes/04-user-source.md: no such file",
    ]);
  });

  test("a Quickstart with the gateway run before the User Source form, or the form before the tunnel, or no form", () => {
    const order = QUICKSTART_ORDER.map(([name]) => name);
    const gatewayFirst = README.split("\n");
    const [gateway] = gatewayFirst.splice(gatewayFirst.findIndex((line) => line.includes("--user-source <id>`")), 1);
    gatewayFirst.splice(gatewayFirst.findIndex((line) => /fill in the User Source form/i.test(line)), 0, gateway!);
    expect(quickstartOrder(gatewayFirst.join("\n"))).not.toEqual(order);
    const early = README.split("\n");
    const form = early.findIndex((line) => /fill in the User Source form/i.test(line));
    const [moved] = early.splice(form, 1);
    expect(quickstartOrder(early.join("\n"))).toEqual(["missing: the User Source form"]);
    early.splice(early.findIndex((line) => /`ngrok http --url=/.test(line)), 0, moved!);
    expect(quickstartOrder(early.join("\n"))).not.toEqual(order);
  });

  test("a Prerequisites whose CLI steps are out of order, or missing one", () => {
    const prerequisites = section(README, "Prerequisites");
    const lines = prerequisites.split("\n");
    const [whoami] = lines.splice(lines.findIndex((line) => line.includes("`arcade whoami`")), 1);
    expect(inOrder(lines.join("\n"), CLI_SETUP)).toContain("missing: check it");
    lines.splice(lines.findIndex((line) => line.includes("`arcade login`")), 0, whoami!);
    expect(inOrder(lines.join("\n"), CLI_SETUP)).not.toEqual(CLI_SETUP.map(([name]) => name));
  });

  test("a URL nobody verified", () => {
    expect(unverifiedUrls("[keys](https://console.anthropic.com/) and [studio](http://localhost:4111)")).toEqual([
      "https://console.anthropic.com/",
    ]);
  });

  test("an indented paragraph, and a bold line standing in for a heading", () => {
    expect(indentedParagraphs("Intro.\n\n    An indented paragraph.\n\n- a list\n  - nested, which is fine\n")).toEqual([3]);
    expect(boldTitles("Intro.\n\n**Customization**\n\n- **Label**: a bullet with a bold label is fine\n")).toEqual([3]);
  });
});
