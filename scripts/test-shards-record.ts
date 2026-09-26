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
 * Each line is `<ms since the process started>\t<path from the repo root>`, and
 * the last is `END\t<ms>`: a file's wall time is the next line's time minus
 * its own, `beforeAll` and `afterAll` included. Only CI's shard runner passes
 * this preload, so a local `bun test` is untouched by it.
 */
import { plugin } from "bun";
import { afterAll } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { TEST_FILE } from "./test-shards.ts";

const out = process.env.CG_SHARD_RECORD;
if (out === undefined || out === "") {
  throw new Error("scripts/test-shards-record.ts needs CG_SHARD_RECORD, the file to write to");
}

const ROOT = join(import.meta.dir, "..");
const started = performance.now();
const seen = new Set<string>();
writeFileSync(out, "");

plugin({
  name: "cg-shard-record",
  setup(build) {
    build.onResolve({ filter: TEST_FILE }, (args) => {
      const path = isAbsolute(args.path) ? args.path : join(args.importer === "" ? ROOT : join(args.importer, ".."), args.path);
      const file = relative(ROOT, path);
      if (!seen.has(file)) {
        seen.add(file);
        appendFileSync(out, `${(performance.now() - started).toFixed(0)}\t${file}\n`);
      }
      return undefined;
    });
  },
});

// A preload's `afterAll` runs once, after the last file's own. Not
// `process.on("exit")`: under `bun test` it never fires (measured, 1.3.14).
afterAll(() => {
  appendFileSync(out, `END\t${(performance.now() - started).toFixed(0)}\n`);
});
