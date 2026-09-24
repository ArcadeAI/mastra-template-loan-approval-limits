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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

function runHook(worktree: string): { stdout: string; env: Record<string, string> } {
  const result = Bun.spawnSync(["bash", HOOK], {
    cwd: worktree,
    env: { PATH: pathWithoutBun(), HOME: scratch, XDG_CACHE_HOME: join(scratch, "cache") },
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
  const [a, b] = worktrees.map(runHook);

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
