/**
 * Writes `src/schema.sql`: the DDL Better Auth itself would run for exactly
 * the configuration in `src/auth.ts`, on SQLite. Regenerate after bumping
 * Better Auth or changing the plugin list; `test/schema.test.ts` fails until
 * you do. `--check` exits 1 instead of writing when the file is stale.
 *
 *   bun run --cwd apps/idp generate:schema
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { compileSchema } from "../src/schema.ts";

const target = join(import.meta.dir, "..", "src", "schema.sql");
const fresh = await compileSchema(new Database(":memory:"));

if (process.argv.includes("--check")) {
  const current = await Bun.file(target).text().catch(() => "");
  if (current !== fresh) {
    console.error(`[idp] src/schema.sql is stale — run: bun run --cwd apps/idp generate:schema`);
    process.exit(1);
  }
  console.log("[idp] src/schema.sql is current");
} else {
  await Bun.write(target, fresh);
  console.log(`[idp] wrote ${target}`);
}
