/**
 * Where Studio's thread memory is stored (#36), and nothing else.
 *
 * Its own module, importing only `node:path`, because two very different
 * processes need the answer: Studio, under Node, which opens the file through
 * `@mastra/libsql` (`memory.ts`), and `bun run reset`, under Bun, which empties
 * it and has no reason to load libsql to find out where it is.
 *
 * `memory.db`, beside `loans.db`, `governance.db` and `idp.db`, in the
 * directory `bun run studio` ran from. `MEMORY_DB_PATH` moves it, as the other
 * three `*_DB_PATH` variables move theirs, and `:memory:` keeps it in the
 * process.
 *
 * A relative path resolves against the project, not the working directory.
 * `mastra dev` runs Studio's server from `src/mastra/public/`, which is where
 * the first version of this put `memory.db` (measured on #36 by
 * `app-test/studio-dev-server.test.ts`). The CLI says where the project is, in
 * `MASTRA_PROJECT_ROOT` on the server it spawns; `mastra dev` 1.31 sets it to
 * the project's `.mastra/` directory and `mastra start` to the project itself,
 * so a trailing `.mastra` is stepped out of. Everything else that asks — `bun
 * run reset`, the tests — runs from the project and has no such variable.
 */
import { basename, dirname, isAbsolute, resolve } from "node:path";

/** The file's name when `MEMORY_DB_PATH` does not say otherwise. */
export const MEMORY_DB_FILE = "memory.db";

/** SQLite's own name for a database that lives in the process and nowhere else. */
export const IN_MEMORY = ":memory:";

/**
 * The directory the other databases sit in: the project the Mastra CLI
 * announced, or the working directory when nothing announced one.
 */
export function projectRoot(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  const announced = env.MASTRA_PROJECT_ROOT?.trim();
  if (!announced) return cwd;
  return basename(announced) === ".mastra" ? dirname(announced) : announced;
}

/** Where the memory store is: `MEMORY_DB_PATH`, else `./memory.db`, against {@link projectRoot}. */
export function memoryDbPath(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = env.MEMORY_DB_PATH?.trim() || `./${MEMORY_DB_FILE}`;
  if (configured === IN_MEMORY || isAbsolute(configured)) return configured;
  return resolve(projectRoot(env, cwd), configured);
}
