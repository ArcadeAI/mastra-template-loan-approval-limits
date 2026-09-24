/**
 * `scripts/orca-setup.sh` gives every worktree its own Studio port (#8).
 *
 * `bun run studio` binds `STUDIO_PORT`, and without one it takes Mastra's
 * default, 4111 — the same number in every worktree on the machine. The hook is
 * what makes the number per-worktree, so this runs the real hook, twice, in two
 * throwaway directories that share one throwaway claims directory: two
 * worktrees, two blocks, two Studio ports.
 *
 * `bun` is taken off `PATH` for the run, so the hook's install step is skipped
 * rather than run against a directory with no manifest. Nothing here reads or
 * writes the real claims in `~/.cache`.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const HOOK = join(import.meta.dir, "..", "scripts", "orca-setup.sh");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cg-orca-setup-")));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** `PATH` minus every directory that holds a `bun`. */
function pathWithoutBun(): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && !existsSync(join(dir, "bun")))
    .join(delimiter);
}

function runHook(
  worktree: string,
  cache = join(scratch, "cache"),
): { stdout: string; env: Record<string, string> } {
  const result = Bun.spawnSync(["bash", HOOK], {
    cwd: worktree,
    env: { PATH: pathWithoutBun(), HOME: scratch, XDG_CACHE_HOME: cache },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0) throw new Error(`orca-setup.sh exited ${result.exitCode}:\n${stdout}${result.stderr}`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(worktree, ".env.local"), "utf8").split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  return { stdout, env };
}

test("two worktrees get two blocks and two Studio ports, each inside its own block", () => {
  const worktrees = ["a", "b"].map((name) => {
    const dir = join(scratch, name);
    mkdirSync(join(dir, "apps", "idp"), { recursive: true });
    mkdirSync(join(dir, "apps", "loan-app"), { recursive: true });
    return dir;
  });
  const [a, b] = worktrees.map((dir) => runHook(dir));

  for (const { env, stdout } of [a!, b!]) {
    const base = Number(env.CG_PORT_BASE);
    expect(Number.isInteger(base)).toBe(true);
    expect(env.STUDIO_PORT).toBe(String(base + 5));
    expect(env.CG_PORT_STUDIO).toBe(env.STUDIO_PORT);
    // Clear of every port the block already hands out.
    const taken = [env.PORT, env.CG_PORT_WEB, env.CG_PORT_HOOKS, env.CG_PORT_LOAN_APP, env.CG_PORT_IDP];
    expect(taken).not.toContain(env.STUDIO_PORT);
    expect(stdout).toContain(`studio ${env.STUDIO_PORT})`);
  }
  expect(a!.env.CG_PORT_BASE).not.toBe(b!.env.CG_PORT_BASE);
  expect(a!.env.STUDIO_PORT).not.toBe(b!.env.STUDIO_PORT);
  expect([a!.env.STUDIO_PORT, b!.env.STUDIO_PORT]).not.toContain("4111");
});

test("re-running the hook keeps the worktree's Studio port", () => {
  const dir = join(scratch, "a");
  const before = readFileSync(join(dir, ".env.local"), "utf8");
  const again = runHook(dir);
  expect(again.stdout).toContain("keeping CG_PORT_BASE=");
  expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe(before);
});

/**
 * #9: the claims directory and the range are this repo's own. The hook was
 * copied from the stage demo claiming 4400-4559 in
 * `~/.cache/mastra-contextual-governance/portblocks`, where on 2026-09-24 ten of
 * the sixteen blocks were the stage demo's stale claims. The old hook fails
 * every assertion below: it writes the claim into the stage demo's directory,
 * inside the stage demo's range, and never gives a legacy claim back.
 */
const OWN = "mastra-template-loan-approval-limits/portblocks";
const STAGE_DEMO = "mastra-contextual-governance/portblocks";

function freshWorktree(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("the claim is written to this repo's own directory, in this repo's own range", () => {
  const cache = join(scratch, "cache-own");
  const worktree = freshWorktree("own");
  const { env } = runHook(worktree, cache);

  const base = Number(env.CG_PORT_BASE);
  expect(base).toBeGreaterThanOrEqual(4560);
  expect(base).toBeLessThanOrEqual(4710);
  expect(readFileSync(join(cache, OWN, String(base)), "utf8").trim()).toBe(worktree);
  expect(existsSync(join(cache, STAGE_DEMO))).toBe(false);
});

test("a full stage-demo pool neither blocks this repo nor loses a single claim", () => {
  const cache = join(scratch, "cache-full");
  const legacy = join(cache, STAGE_DEMO);
  mkdirSync(legacy, { recursive: true });
  // Every block of the stage demo's range, each held by a worktree that still
  // exists, so nothing is stale and nothing may be reaped.
  const owner = freshWorktree("stage-demo-worktree");
  for (let base = 4400; base <= 4550; base += 10) writeFileSync(join(legacy, String(base)), `${owner}\n`);

  const { env } = runHook(freshWorktree("beside-a-full-pool"), cache);

  expect(Number(env.CG_PORT_BASE)).toBeGreaterThanOrEqual(4560);
  expect(readdirSync(legacy).sort()).toEqual(
    Array.from({ length: 16 }, (_, i) => String(4400 + i * 10)).sort(),
  );
  for (const file of readdirSync(legacy)) expect(readFileSync(join(legacy, file), "utf8").trim()).toBe(owner);
});

test("a worktree set up before #9 gives its stage-demo claim back, and only its own", () => {
  const cache = join(scratch, "cache-legacy");
  const legacy = join(cache, STAGE_DEMO);
  mkdirSync(legacy, { recursive: true });
  const worktree = freshWorktree("set-up-before-9");
  const other = freshWorktree("someone-else");
  writeFileSync(join(legacy, "4400"), `${worktree}\n`);
  writeFileSync(join(legacy, "4410"), `${other}\n`);

  const { stdout, env } = runHook(worktree, cache);

  expect(stdout).toContain(`released legacy claim 4400`);
  expect(existsSync(join(legacy, "4400"))).toBe(false);
  expect(readFileSync(join(legacy, "4410"), "utf8").trim()).toBe(other);
  expect(Number(env.CG_PORT_BASE)).toBeGreaterThanOrEqual(4560);
});
