/**
 * `scripts/orca-archive.sh` stops what is still running from the worktree it
 * tears down (#9).
 *
 * Eight `bun` stubs from #4's test harnesses outlived their worktree, still
 * listening on ephemeral ports after the directory was deleted. This plants
 * three long-lived processes, each started detached so that nothing but the
 * hook could stop it: one whose working directory is the throwaway worktree,
 * one whose command line names a file inside it from elsewhere, and a bystander
 * that has nothing to do with it. The hook must stop the first two and leave
 * the third alone. The hook before #9 only released port claims, so both of the
 * first two survive it and the test fails.
 *
 * The claims directories are throwaway too (`XDG_CACHE_HOME`), so nothing here
 * reads or writes the real claims in `~/.cache`.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "scripts", "orca-archive.sh");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cg-orca-archive-")));
const planted: number[] = [];

afterAll(() => {
  for (const pid of planted) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is the point.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A process that runs until killed, in its own session so that it is nobody's
 * child by the time the hook runs: `sh -c '… &'` exits at once and the sleeper
 * is re-parented. Its pid comes back through a file.
 */
function plant(cwd: string, script: string): number {
  const pidFile = join(scratch, `pid-${planted.length}`);
  const launched = Bun.spawnSync(["sh", "-c", `nohup bun ${JSON.stringify(script)} >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}`], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? scratch },
  });
  if (launched.exitCode !== 0) throw new Error(`could not plant a process in ${cwd}`);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  planted.push(pid);
  return pid;
}

test("the archive hook stops what runs from the worktree, and nothing else", async () => {
  const worktree = join(scratch, "worktree");
  const elsewhere = join(scratch, "elsewhere");
  mkdirSync(join(worktree, "scripts"), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  const sleeper = "setInterval(() => {}, 1000);\n";
  writeFileSync(join(worktree, "scripts", "stub.ts"), sleeper);
  writeFileSync(join(elsewhere, "bystander.ts"), sleeper);

  // A port claim, so the release half is exercised on the same run.
  const claims = join(scratch, "cache", "mastra-template-loan-approval-limits", "portblocks");
  mkdirSync(claims, { recursive: true });
  writeFileSync(join(claims, "4560"), `${worktree}\n`);

  const byCwd = plant(worktree, "scripts/stub.ts");
  const byPath = plant(elsewhere, join(worktree, "scripts", "stub.ts"));
  const bystander = plant(elsewhere, join(elsewhere, "bystander.ts"));
  await Bun.sleep(500);
  for (const pid of [byCwd, byPath, bystander]) expect(alive(pid)).toBe(true);

  const run = Bun.spawnSync(["bash", HOOK], {
    cwd: worktree,
    env: { PATH: process.env.PATH ?? "", HOME: scratch, XDG_CACHE_HOME: join(scratch, "cache") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = run.stdout.toString();
  expect(run.exitCode, `${stdout}${run.stderr}`).toBe(0);

  // SIGTERM, and the hook waits for them; a little slack for the kernel.
  const deadline = Date.now() + 3_000;
  while ((alive(byCwd) || alive(byPath)) && Date.now() < deadline) await Bun.sleep(100);

  expect(alive(byCwd), `still running from the worktree's cwd:\n${stdout}`).toBe(false);
  expect(alive(byPath), `still running a file inside the worktree:\n${stdout}`).toBe(false);
  expect(alive(bystander)).toBe(true);
  expect(stdout).toContain(`stopping ${byCwd}:`);
  expect(stdout).toContain(`stopping ${byPath}:`);
  expect(stdout).not.toContain(`stopping ${bystander}:`);
  expect(existsSync(join(claims, "4560"))).toBe(false);
}, 30_000);
