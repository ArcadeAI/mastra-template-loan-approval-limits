/**
 * The name `arcade deploy` registers a toolkit's server under (#30).
 *
 * The CLI starts the server and reads `serverInfo.name` off its `initialize`
 * (`arcade_cli/deploy.py`, `get_server_info`), which `arcade_mcp_server` fills
 * from `MCPApp(name=…)`. So the name is read from the toolkit's own source,
 * without running it: the one `MCPApp(name="…")` under the toolkit's package,
 * else `[project] name` in its `pyproject.toml`, which this template keeps the
 * same. `null` when neither says, and the caller then deploys as before.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP_NAME = /MCPApp\(\s*name\s*=\s*["']([^"']+)["']/g;

export function serverName(dir: string): string | null {
  const names = new Set<string>();
  const glob = new Bun.Glob("**/*.py");
  for (const file of glob.scanSync({ cwd: dir, onlyFiles: true })) {
    if (/(^|\/)(tests?|\.venv|build|dist)\//.test(file)) continue;
    for (const [, name] of readFileSync(join(dir, file), "utf8").matchAll(APP_NAME)) names.add(name!);
  }
  if (names.size === 1) return [...names][0]!;
  const pyproject = join(dir, "pyproject.toml");
  if (!existsSync(pyproject)) return null;
  const project = /^\[project\][^[]*?^name\s*=\s*["']([^"']+)["']/ms.exec(readFileSync(pyproject, "utf8"));
  return project?.[1] ?? null;
}
