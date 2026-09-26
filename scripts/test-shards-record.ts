/**
 * A `bun test --preload` for CI's shards (#38): writes down every test file Bun
 * loads, and when.
 *
 * Bun's JUnit report cannot answer "which files ran". Measured on 1.3.14: a
 * file that throws while it is imported and a file that registers no test are
 * both missing from it, and a file's `time` leaves out its `beforeAll`, which
 * is where every browser test boots its server. So the check that every file
 * ran exactly once (`scripts/test-shards.ts check`) reads this instead.
 *
 * `onResolve` rather than `onLoad`: returning nothing from `onResolve` hands
 * the file back to Bun's own resolver, so the file is loaded exactly as it is
 * without this preload. An `onLoad` would have to return the file's contents
 * and a loader, which is a second transpiler path for every test in the suite.
 *
 * Each line is `<epoch ms>\t<path from the repo root>` when a file is loaded,
 * or `END\t<epoch ms>` when a preload's `afterAll` runs. The shards run with
 * `--isolate`, which gives every file a fresh global object and so runs this
 * preload again for each one: that is why it only ever appends (the runner
 * creates the file empty), why the clock is the epoch rather than
 * `performance.now()`, and why there is an `END` after every file there rather
 * than one at the very end. `parseRecord` reads both shapes: a file's wall time
 * is the next file's start, or the last `END`, minus its own start, its
 * `beforeAll` and `afterAll` included. Only CI's shard runner passes this
 * preload, so a local `bun test` is untouched by it.
 */
import { plugin } from "bun";
import { afterAll } from "bun:test";
import { appendFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { TEST_FILE } from "./test-shards.ts";

const out = process.env.CG_SHARD_RECORD;
if (out === undefined || out === "") {
  throw new Error("scripts/test-shards-record.ts needs CG_SHARD_RECORD, the file to write to");
}

const ROOT = join(import.meta.dir, "..");
// Bun resolves a test file more than once as it loads it; one line each.
const seen = new Set<string>();

plugin({
  name: "cg-shard-record",
  setup(build) {
    build.onResolve({ filter: TEST_FILE }, (args) => {
      const path = isAbsolute(args.path) ? args.path : join(args.importer === "" ? ROOT : join(args.importer, ".."), args.path);
      const file = relative(ROOT, path);
      if (!seen.has(file)) {
        seen.add(file);
        appendFileSync(out, `${Date.now()}\t${file}\n`);
      }
      return undefined;
    });
  },
});

// A preload's `afterAll` runs after the last file this global object ran: once
// at the very end without `--isolate`, after every file with it. Not
// `process.on("exit")`: under `bun test` it never fires (measured, 1.3.14).
afterAll(() => {
  appendFileSync(out, `END\t${Date.now()}\n`);
});
