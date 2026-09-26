/**
 * CI's `bun test`, split four ways (#38), and the check that the split still
 * ran every file exactly once.
 *
 *   bun scripts/test-shards.ts list <shard> <of>          the files one shard runs, one per line
 *   bun scripts/test-shards.ts run <shard> <of> <dir>     run them, and write what ran into <dir>
 *   bun scripts/test-shards.ts check <dir> <of>           every shard's record, against `git ls-files`
 *   bun scripts/test-shards.ts weights <dir> <run>        rewrite scripts/test-weights.json from a run's records
 *
 * Serially the suite was 148 files and 502s on the runner (run 36230453689),
 * most of it a handful of files that each boot a Next server and a Chrome.
 *
 * **The split is deterministic.** `list` depends on nothing but the tracked
 * test files and `scripts/test-weights.json`: files with a measured weight are
 * placed heaviest first on whichever shard is lightest so far, and files with
 * no weight yet (a test added since the weights were measured) are dealt out
 * round-robin after them. Every shard job computes the same split, so no job
 * has to hand another a list. To re-measure, fetch a green run's records and
 * rewrite the weights from them:
 *
 *   gh run download <run> --pattern 'test-shard-*' --dir shards
 *   bun scripts/test-shards.ts weights shards "<run url> (<sha>)"
 *
 * **A shard that silently ran less is the failure this guards.** Four jobs
 * that each pass say nothing about whether, between them, they ran the suite:
 * a file dropped from the split, or one that failed to load, leaves four green
 * jobs. So `check` runs after every shard, whatever they concluded, and fails
 * unless the files the shards actually loaded (`scripts/test-shards-record.ts`,
 * not the lists they were handed) are exactly the tracked test files, each
 * once; unless each shard's Bun summary says it ran as many files as it was
 * given; and on any failed test or any Bun "error", which is an exception
 * thrown between tests and counted apart from failures.
 *
 * Locally none of this is in the way: `bun test` with no arguments still runs
 * every file in one process.
 */
import { spawn, spawnSync } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const WEIGHTS_FILE = join(ROOT, "scripts", "test-weights.json");

/** The names `bun test` picks up: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`. */
export const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;

/**
 * Every tracked test file, sorted: what `bun test` with no arguments runs.
 * Bun skips `node_modules` and dot-directories, so this does too.
 */
export function testFiles(root = ROOT): string[] {
  const listed = spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed in ${root}: ${listed.stderr.toString()}`);
  return listed.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "" && TEST_FILE.test(path))
    .filter((path) => !path.split("/").some((part) => part === "node_modules" || part.startsWith(".")))
    .sort();
}

export interface Weights {
  /** Where the numbers were measured: a CI run, so they are the runner's seconds and not a laptop's. */
  run: string;
  seconds: Record<string, number>;
}

export function readWeights(path = WEIGHTS_FILE): Weights {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Weights>;
  if (typeof parsed.run !== "string" || typeof parsed.seconds !== "object" || parsed.seconds === null) {
    throw new Error(`${path} has no "run" and "seconds"`);
  }
  return { run: parsed.run, seconds: parsed.seconds };
}

/**
 * `files` into `shards` lists. Weighted files go heaviest first to the
 * lightest shard (ties to the lower index, then by name, so the result never
 * depends on input order); unweighted ones are dealt round-robin afterwards.
 */
export function split(files: readonly string[], seconds: Record<string, number>, shards: number): string[][] {
  if (!Number.isInteger(shards) || shards < 1) throw new Error(`cannot split into ${shards} shards`);
  const out: string[][] = Array.from({ length: shards }, () => []);
  const load: number[] = Array.from({ length: shards }, () => 0);
  const weight = (file: string): number | undefined => {
    const value = seconds[file];
    return typeof value === "number" && value >= 0 ? value : undefined;
  };
  const unique = [...new Set(files)].sort();
  const weighted = unique
    .filter((file) => weight(file) !== undefined)
    .sort((a, b) => (weight(b) ?? 0) - (weight(a) ?? 0) || a.localeCompare(b));
  for (const file of weighted) {
    let lightest = 0;
    for (let shard = 1; shard < shards; shard += 1) if ((load[shard] ?? 0) < (load[lightest] ?? 0)) lightest = shard;
    out[lightest]?.push(file);
    load[lightest] = (load[lightest] ?? 0) + (weight(file) ?? 0);
  }
  unique
    .filter((file) => weight(file) === undefined)
    .forEach((file, index) => out[index % shards]?.push(file));
  return out.map((list) => list.sort());
}

/** Shard `shard` (1-based) of `of`, from the tracked files and the committed weights. */
export function shardFiles(shard: number, of: number, root = ROOT): string[] {
  if (!Number.isInteger(shard) || shard < 1 || shard > of) throw new Error(`there is no shard ${shard} of ${of}`);
  return split(testFiles(root), readWeights().seconds, of)[shard - 1] ?? [];
}

/** One line of a shard's record: a file Bun loaded, and how long it had until the next one. */
export interface Loaded {
  file: string;
  seconds: number;
}

/** `scripts/test-shards-record.ts`'s output, as files and wall times. */
export function parseRecord(text: string): { loaded: Loaded[]; complete: boolean } {
  const rows: { file: string; at: number }[] = [];
  let end: number | undefined;
  let endedLast = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const [first = "", second = ""] = line.split("\t");
    if (first === "END") {
      end = Number(second);
      endedLast = true;
    } else {
      rows.push({ at: Number(first), file: second });
      endedLast = false;
    }
  }
  const loaded = rows.map((row, index) => ({
    file: row.file,
    seconds: ((rows[index + 1]?.at ?? end ?? row.at) - row.at) / 1000,
  }));
  // Complete when an `END` follows the last file: its `afterAll` ran.
  return { loaded, complete: endedLast };
}

/** What Bun's closing summary says. Any count Bun left out is zero; `files` is `null` if there was no summary at all. */
export interface Summary {
  pass: number;
  skip: number;
  todo: number;
  fail: number;
  error: number;
  tests: number | null;
  files: number | null;
  seconds: number | null;
}

export function parseSummary(log: string): Summary {
  const count = (word: string): number => {
    const matches = [...log.matchAll(new RegExp(`^\\s*(\\d+) ${word}s?\\s*$`, "gm"))];
    return Number(matches.at(-1)?.[1] ?? 0);
  };
  const ran = [...log.matchAll(/^Ran (\d+) tests? across (\d+) files?\. \[([\d.]+)(m?s)\]/gm)].at(-1);
  return {
    pass: count("pass"),
    skip: count("skip"),
    todo: count("todo"),
    fail: count("fail"),
    error: count("error"),
    tests: ran === undefined ? null : Number(ran[1]),
    files: ran === undefined ? null : Number(ran[2]),
    seconds: ran === undefined ? null : Number(ran[3]) / (ran[4] === "ms" ? 1000 : 1),
  };
}

/** One shard's artifact: what it was handed, what Bun loaded, and what Bun said. */
export interface ShardRecord {
  shard: number;
  assigned: string[];
  loaded: Loaded[];
  complete: boolean;
  summary: Summary;
  exitCode: number | null;
}

export function readShard(dir: string, shard: number): ShardRecord | null {
  const base = join(dir, `test-shard-${shard}`);
  if (!existsSync(join(base, "assigned.txt"))) return null;
  const read = (name: string) => (existsSync(join(base, name)) ? readFileSync(join(base, name), "utf8") : "");
  const record = parseRecord(read("loaded.txt"));
  const status = read("exit-code").trim();
  return {
    shard,
    assigned: read("assigned.txt").split("\n").filter((line) => line !== ""),
    loaded: record.loaded,
    complete: record.complete,
    summary: parseSummary(read("bun.log")),
    exitCode: status === "" ? null : Number(status),
  };
}

/**
 * Everything `check` has to say: a report to print, and the problems that fail
 * it. Pure, so the tests can hand it a split that drops a file.
 */
export function checkShards(
  expected: readonly string[],
  records: ReadonlyArray<ShardRecord | null>,
): { report: string[]; problems: string[] } {
  const report: string[] = [];
  const problems: string[] = [];
  const ranBy = new Map<string, number[]>();
  const handedTo = new Map<string, number[]>();
  const totals = { files: 0, tests: 0, pass: 0, skip: 0, todo: 0, fail: 0, error: 0 };

  records.forEach((record, index) => {
    const shard = index + 1;
    if (record === null) {
      problems.push(`shard ${shard} left no record: it did not run, or its artifact was not uploaded`);
      return;
    }
    const { summary } = record;
    for (const file of record.assigned) handedTo.set(file, [...(handedTo.get(file) ?? []), shard]);
    for (const { file } of record.loaded) ranBy.set(file, [...(ranBy.get(file) ?? []), shard]);
    const wall = record.loaded.reduce((sum, { seconds }) => sum + seconds, 0);
    report.push(
      `shard ${shard}/${records.length}: ${record.loaded.length} files loaded of ${record.assigned.length} handed, ` +
        `${summary.pass} pass, ${summary.skip} skip, ${summary.todo} todo, ${summary.fail} fail, ${summary.error} error, ` +
        `${summary.tests ?? "?"} tests, ${wall.toFixed(1)}s in files`,
    );
    const slowest = [...record.loaded].sort((a, b) => b.seconds - a.seconds).slice(0, 5);
    for (const { file, seconds } of slowest) report.push(`    ${seconds.toFixed(1).padStart(6)}s  ${file}`);

    if (summary.files === null) problems.push(`shard ${shard}: Bun printed no "Ran … across … files" summary; it did not finish`);
    else if (summary.files !== record.assigned.length) {
      problems.push(`shard ${shard}: Bun ran ${summary.files} files but was handed ${record.assigned.length}`);
    }
    if (!record.complete) problems.push(`shard ${shard}: its record has no END line; the test process did not exit normally`);
    if (summary.fail > 0) problems.push(`shard ${shard}: ${summary.fail} failed`);
    if (summary.error > 0) problems.push(`shard ${shard}: ${summary.error} Bun error(s), exceptions thrown between tests`);
    if (record.exitCode !== 0) problems.push(`shard ${shard}: bun test exited ${record.exitCode ?? "without a status"}`);
    const assigned = new Set(record.assigned);
    for (const { file } of record.loaded) {
      if (!assigned.has(file)) problems.push(`shard ${shard} loaded ${file}, which it was not handed`);
    }
    totals.files += record.loaded.length;
    totals.tests += summary.tests ?? 0;
    for (const key of ["pass", "skip", "todo", "fail", "error"] as const) totals[key] += summary[key];
  });

  const wanted = new Set(expected);
  for (const file of expected) {
    if (!handedTo.has(file)) problems.push(`the split handed ${file} to no shard`);
    if (!ranBy.has(file)) problems.push(`no shard ran ${file}`);
  }
  for (const [file, shards] of handedTo) {
    if (shards.length > 1) problems.push(`the split handed ${file} to shards ${shards.join(" and ")}`);
    if (!wanted.has(file)) problems.push(`the split handed out ${file}, which is not a tracked test file`);
  }
  for (const [file, shards] of ranBy) {
    if (shards.length > 1) problems.push(`${file} ran ${shards.length} times, in shards ${shards.join(" and ")}`);
    if (!wanted.has(file)) problems.push(`${file} ran, but is not a tracked test file`);
  }

  report.push(
    `all shards: ${totals.files} files loaded of ${expected.length} tracked, ${totals.tests} tests, ` +
      `${totals.pass} pass, ${totals.skip} skip, ${totals.todo} todo, ${totals.fail} fail, ${totals.error} error`,
  );
  return { report, problems };
}

/** Run one shard: `bun test` on its files, recording what loaded, teeing the output. */
async function runShard(shard: number, of: number, dir: string): Promise<number> {
  mkdirSync(dir, { recursive: true });
  const files = shardFiles(shard, of);
  writeFileSync(join(dir, "assigned.txt"), files.map((file) => `${file}\n`).join(""));
  console.log(`shard ${shard}/${of}: ${files.length} files`);
  // The record is appended to, by every file's own copy of the preload.
  writeFileSync(join(dir, "loaded.txt"), "");
  // `./` on every path: a bare `test/x.test.ts` is a substring filter, and
  // also runs `app-test/x.test.ts` (.orca/project.md, "run the root group as
  // bun test ./test/"). `check` would catch it as a duplicate; this avoids it.
  //
  // `--isolate`: every file gets a fresh global object, so no file can depend
  // on which files the split put before it. Without it the split surfaced
  // leaks the serial order had always hidden, measured on 1.3.14 by running
  // one file before another: `chat-rendering`, `chat-resume` and
  // `control-plane-strip` each leave React DOM bound to a closed happy-dom
  // window, and `panel-live` then times out; `panel-keyboard` does the same to
  // `chat-resume`. #142 fixed two such files by moving their DOM into an
  // isolated worker (`chat-conversation.test.tsx`); this does it for every file,
  // at no measured cost (a 75-file shard, 53.2s without, 53.7s with). A local
  // `bun test` still runs everything in one shared global, in Bun's order.
  const child = spawn(
    ["bun", "test", "--isolate", "--preload", "./scripts/test-shards-record.ts", ...files.map((file) => `./${file}`)],
    {
      cwd: ROOT,
      env: { ...process.env, CG_SHARD_RECORD: join(dir, "loaded.txt") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let log = "";
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      log += decoder.decode(chunk, { stream: true });
      sink.write(chunk);
    }
  };
  await Promise.all([pump(child.stdout, process.stdout), pump(child.stderr, process.stderr)]);
  const code = await child.exited;
  writeFileSync(join(dir, "bun.log"), log);
  writeFileSync(join(dir, "exit-code"), `${code}\n`);
  return code;
}

function usage(): never {
  console.error(
    [
      "usage: bun scripts/test-shards.ts list <shard> <of>",
      "       bun scripts/test-shards.ts run <shard> <of> <dir>",
      "       bun scripts/test-shards.ts check <dir> <of>",
      "       bun scripts/test-shards.ts weights <dir> <run>",
    ].join("\n"),
  );
  process.exit(64);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const args = rest.map((arg) => arg ?? "");
  const [first = "", second = "", third = ""] = args;
  if (command === "list" && args.length === 2) {
    for (const file of shardFiles(Number(first), Number(second))) console.log(`./${file}`);
  } else if (command === "run" && args.length === 3) {
    process.exit(await runShard(Number(first), Number(second), third));
  } else if (command === "check" && args.length === 2) {
    const of = Number(second);
    const records = Array.from({ length: of }, (_, index) => readShard(first, index + 1));
    const { report, problems } = checkShards(testFiles(), records);
    for (const line of report) console.log(line);
    if (problems.length > 0) {
      for (const problem of problems) console.log(`::error::${problem}`);
      process.exit(1);
    }
    console.log(`every tracked test file ran exactly once, in ${of} shards`);
  } else if (command === "weights" && args.length === 2) {
    const seconds: Record<string, number> = {};
    for (let shard = 1, record = readShard(first, shard); record !== null; shard += 1, record = readShard(first, shard)) {
      for (const { file, seconds: s } of record.loaded) seconds[file] = Number(s.toFixed(1));
    }
    if (Object.keys(seconds).length === 0) throw new Error(`no shard records under ${first}`);
    const sorted = Object.fromEntries(Object.entries(seconds).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(WEIGHTS_FILE, `${JSON.stringify({ run: second, seconds: sorted }, null, 2)}\n`);
    console.log(`wrote ${Object.keys(sorted).length} weights to ${WEIGHTS_FILE}`);
  } else {
    usage();
  }
}
