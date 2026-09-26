/**
 * CI's four test shards (#38): the split, the record of what ran, and the check
 * that fails when the two disagree.
 *
 * The failure this exists for makes no noise. Four shard jobs that each pass
 * say nothing about whether they ran the suite between them: a file the split
 * dropped, or one that died while it was imported, leaves every job green. So
 * the check is shown red here on exactly that — a split that drops one file —
 * and on the other ways a shard can run less than it was given, and the record
 * it reads is shown catching the two files Bun's own JUnit report leaves out,
 * both in one shared global and under the `--isolate` the shards run with.
 * The last test is the reason for `--isolate`: a file that passes only through
 * what an earlier file leaked passes in a shared global and fails isolated.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkShards,
  parseRecord,
  parseSummary,
  readWeights,
  split,
  testFiles,
  type ShardRecord,
  type Summary,
} from "../scripts/test-shards.ts";

const ROOT = join(import.meta.dir, "..");
const RECORDER = join(ROOT, "scripts", "test-shards-record.ts");
const scratch = mkdtempSync(join(tmpdir(), "cg-test-shards-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const FILES = testFiles();
const { seconds: WEIGHTS } = readWeights();

describe("the split", () => {
  test("finds the suite: this file, the app's group, the root group and both workspaces' tests", () => {
    expect(FILES).toContain("test/readme.test.ts");
    expect(FILES).toContain("app-test/frame.test.ts");
    expect(FILES).toContain("app-test/control-plane/handlers.test.ts");
    expect(FILES).toContain("packages/governance-core/test/policy-engine.test.ts");
    expect(FILES).toContain("packages/policy-schema/test/generator.test.ts");
    expect(FILES.some((file) => file.includes("node_modules"))).toBe(false);
  });

  test("hands every tracked test file to exactly one shard, however many shards", () => {
    for (const shards of [1, 2, 3, 4, 5, 6]) {
      const lists = split(FILES, WEIGHTS, shards);
      expect(lists).toHaveLength(shards);
      const handed = lists.flat();
      expect(handed.length).toBe(FILES.length);
      expect([...handed].sort()).toEqual(FILES);
    }
  });

  test("is the same split whatever order the files come in", () => {
    const shuffled = [...FILES].reverse();
    shuffled.push(shuffled.shift() as string);
    expect(split(shuffled, WEIGHTS, 4)).toEqual(split(FILES, WEIGHTS, 4));
  });

  test("balances the measured seconds: no shard is heavier than the mean by more than one file", () => {
    const lists = split(FILES, WEIGHTS, 4);
    const load = lists.map((list) => list.reduce((sum, file) => sum + (WEIGHTS[file] ?? 0), 0));
    const mean = load.reduce((a, b) => a + b, 0) / load.length;
    const heaviestFile = Math.max(...FILES.map((file) => WEIGHTS[file] ?? 0));
    expect(Math.max(...load) - mean).toBeLessThanOrEqual(heaviestFile);
    // The measured suite is 500 seconds with a 57-second file, so this is the
    // claim with teeth: within a few seconds of a quarter each.
    expect(Math.max(...load) - Math.min(...load)).toBeLessThan(10);
  });

  test("deals files with no weight yet round-robin, rather than all onto one shard", () => {
    const fresh = Array.from({ length: 8 }, (_, index) => `app-test/new-${index}.test.ts`);
    const lists = split([...fresh, "a.test.ts", "b.test.ts"], { "a.test.ts": 100, "b.test.ts": 1 }, 4);
    expect(lists.map((list) => list.filter((file) => file.startsWith("app-test/new-")).length)).toEqual([2, 2, 2, 2]);
    expect(lists[0]).toContain("a.test.ts");
    expect(lists[1]).toContain("b.test.ts");
  });

  test("the committed weights name only files that exist", () => {
    const missing = Object.keys(WEIGHTS).filter((file) => !FILES.includes(file));
    expect(missing).toEqual([]);
  });
});

const clean: Summary = { pass: 3, skip: 0, todo: 0, fail: 0, error: 0, tests: 3, files: 0, seconds: 1 };

/** Records for a run where every shard ran exactly what it was handed. */
function honest(lists: string[][]): ShardRecord[] {
  return lists.map((assigned, index) => ({
    shard: index + 1,
    assigned,
    loaded: assigned.map((file) => ({ file, seconds: 1 })),
    complete: true,
    summary: { ...clean, files: assigned.length },
    exitCode: 0,
    jobStatus: "success",
  }));
}

describe("the check", () => {
  const expected = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"];
  const lists = split(expected, {}, 2);

  test("passes a run where every file ran once, and prints each shard's counts", () => {
    const { report, problems } = checkShards(expected, honest(lists), "success");
    expect(problems).toEqual([]);
    expect(report[0]).toMatch(/^shard 1\/2: 3 files loaded of 3 handed, 3 pass, 0 skip, 0 todo, 0 fail, 0 error/);
    expect(report.at(-1)).toMatch(/^all shards: 5 files loaded of 5 tracked/);
  });

  test("is red on a split that drops one file, though every shard passed", () => {
    const dropped = lists.map((list) => list.filter((file) => file !== "c.test.ts"));
    const { problems } = checkShards(expected, honest(dropped), "success");
    expect(problems).toEqual(["the split handed c.test.ts to no shard", "no shard ran c.test.ts"]);
  });

  test("is red when a file runs twice", () => {
    const twice = [lists[0] ?? [], [...(lists[1] ?? []), "a.test.ts"]];
    const { problems } = checkShards(expected, honest(twice), "success");
    expect(problems).toContain("the split handed a.test.ts to shards 1 and 2");
    expect(problems).toContain("a.test.ts ran 2 times, in shards 1 and 2");
  });

  test("is red when a shard loaded less than it was handed, as a file that fails to import does", () => {
    const records = honest(lists);
    const first = records[0] as ShardRecord;
    first.loaded = first.loaded.slice(1);
    first.summary = { ...first.summary, files: first.assigned.length - 1 };
    const { problems } = checkShards(expected, records, "success");
    expect(problems).toContain(`no shard ran ${first.assigned[0]}`);
    expect(problems).toContain(`shard 1: Bun ran ${first.assigned.length - 1} files but was handed ${first.assigned.length}`);
  });

  test("is red on a Bun error even with no failed test, and on a missing shard", () => {
    const records: Array<ShardRecord | null> = honest(lists);
    (records[0] as ShardRecord).summary.error = 1;
    records[1] = null;
    const { problems } = checkShards(expected, records, "success");
    expect(problems).toContain("shard 1: 1 Bun error(s), exceptions thrown between tests");
    expect(problems).toContain("shard 2 left no record: it did not run, or its artifact was not uploaded");
  });

  test("is red on a failed test and a non-zero exit, which the shard job would also be", () => {
    const records = honest(lists);
    const first = records[0] as ShardRecord;
    first.summary.fail = 2;
    first.exitCode = 1;
    const { problems } = checkShards(expected, records, "success");
    expect(problems).toEqual(["shard 1: 2 failed", "shard 1: bun test exited 1"]);
  });

  // PR #42, round 1: a job its `if` skips reports success, so `tests ran` runs
  // `always()` and has to reach this decision itself. `needs.test.result` is one
  // of these four; only `success` passes.
  test.each(["success", "failure", "cancelled", "skipped", ""])(
    "the shard matrix ending %p passes only when it is success",
    (result) => {
      const { problems } = checkShards(expected, honest(lists), result);
      if (result === "success") expect(problems).toEqual([]);
      else expect(problems).toEqual([`the test shards ended "${result === "" ? "(no result)" : result}", not "success"`]);
    },
  );

  test.each(["failure", "cancelled", null])("is red, naming the shard, when a shard's own job ended %p", (status) => {
    const records = honest(lists);
    (records[1] as ShardRecord).jobStatus = status;
    const { problems } = checkShards(expected, records, "success");
    expect(problems).toEqual([`shard 2: its job ended "${status ?? "(no status recorded)"}", not "success"`]);
  });

  test("a cancelled run is red on every count it has: the matrix, the shard, and the record it never finished", () => {
    const records: Array<ShardRecord | null> = honest(lists);
    const first = records[0] as ShardRecord;
    first.jobStatus = "cancelled";
    first.complete = false;
    first.summary = { ...first.summary, files: null };
    first.exitCode = null;
    records[1] = null;
    const { problems } = checkShards(expected, records, "cancelled");
    expect(problems).toContain('the test shards ended "cancelled", not "success"');
    expect(problems).toContain('shard 1: its job ended "cancelled", not "success"');
    expect(problems).toContain("shard 1: its record has no END line; the test process did not exit normally");
    expect(problems).toContain("shard 2 left no record: it did not run, or its artifact was not uploaded");
  });
});

// Four files, two of which Bun's JUnit report omits: one that throws while it
// is imported, and one that registers no test at all. Then a pair where the
// second passes only because of what the first left in the global object —
// the "works because of what ran before it" bug, planted on purpose.
const PLANTED = {
  "slow.test.ts": `import { beforeAll, expect, test } from "bun:test";\nbeforeAll(() => Bun.sleep(400));\ntest("one", () => expect(1).toBe(1));\n`,
  "broken.test.ts": `throw new Error("fails while it is imported");\n`,
  "empty.test.ts": `export {};\n`,
  "late.test.ts": `import { test } from "bun:test";\ntest("throws after it returns", () => { setTimeout(() => { throw new Error("between tests"); }, 0); });\ntest("waits", () => Bun.sleep(50));\n`,
  "leaks.test.ts": `import { test } from "bun:test";\ntest("leaves a global behind", () => { (globalThis as { leaked?: boolean }).leaked = true; });\n`,
  "needs-the-leak.test.ts": `import { expect, test } from "bun:test";\ntest("passes only through the leak", () => expect((globalThis as { leaked?: boolean }).leaked).toBe(true));\n`,
};
for (const [name, source] of Object.entries(PLANTED)) writeFileSync(join(scratch, name), source);

/** `bun test` on the planted files, in that order, with the recorder: what the shards run, minus the split. */
function runPlanted(flags: string[]): { loaded: string; log: string; exitCode: number } {
  const record = join(scratch, `loaded${flags.join("")}.txt`);
  writeFileSync(record, "");
  const ran = Bun.spawnSync(["bun", "test", ...flags, "--preload", RECORDER, ...Object.keys(PLANTED).map((name) => `./${name}`)], {
    cwd: scratch,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? scratch, CG_SHARD_RECORD: record },
  });
  return { loaded: readFileSync(record, "utf8"), log: `${ran.stdout.toString()}${ran.stderr.toString()}`, exitCode: ran.exitCode };
}

describe.each([
  ["in one shared global, as a local bun test runs", [] as string[]],
  ["with --isolate, as the shards run", ["--isolate"]],
])("the record, from a real bun test %s", (_mode, flags) => {
  const { loaded, log, exitCode } = runPlanted(flags);

  test("lists every file Bun loaded, the two JUnit omits included, with beforeAll in its time", () => {
    const record = parseRecord(loaded);
    expect(record.complete).toBe(true);
    const names = record.loaded.map(({ file }) => file.split("/").at(-1));
    expect(names).toEqual(Object.keys(PLANTED));
    const slow = record.loaded.find(({ file }) => file.endsWith("slow.test.ts"));
    expect(slow?.seconds).toBeGreaterThanOrEqual(0.4);
  });

  test("reads Bun's summary, the error count apart from the failures", () => {
    const summary = parseSummary(log);
    expect(exitCode).not.toBe(0);
    expect(summary.files).toBe(Object.keys(PLANTED).length);
    expect(summary.pass).toBeGreaterThanOrEqual(1);
    expect(summary.error).toBeGreaterThanOrEqual(1);
    expect(summary.fail).toBeGreaterThanOrEqual(1);
  });
});

test("a test that passes only through an earlier file's leak passes in a shared global and fails under --isolate", () => {
  expect(runPlanted([]).log).not.toContain("(fail) passes only through the leak");
  expect(runPlanted(["--isolate"]).log).toContain("(fail) passes only through the leak");
});
