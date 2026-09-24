/**
 * `next dev` writes no agent rules into this project (#9).
 *
 * Next 16 writes `AGENTS.md` and `CLAUDE.md` at the project root whenever it
 * detects a coding agent in its environment (`AI_AGENT`, `CLAUDECODE` and
 * others; `@vercel/detect-agent`). A forker's agent would read instructions
 * nobody wrote for this project, so `next.config.ts` sets `agentRules: false`.
 *
 * Two throwaway Next projects, each booted by `next dev` the way `bun run dev`
 * boots the app, with `AI_AGENT=claude` in the environment. One uses the
 * repo's own `next.config.ts`, unchanged: no rules file may appear. The other
 * uses the same config with `agentRules` removed, which is the config before
 * #9, and Next must write them; if it does not, the first half proves nothing.
 *
 * The projects sit under `.test-fixtures/` (gitignored) for the reason
 * `dev-port.test.ts` gives: Turbopack will not follow a `node_modules` symlink
 * out of its root.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { childEnv } from "./child-env.ts";
import { captureOutput, retryOnPortRace, spawnChild, waitForChildHttp } from "./child.ts";

const ROOT = join(import.meta.dir, "..");
const projects: string[] = [];

afterAll(() => {
  for (const project of projects) rmSync(project, { recursive: true, force: true });
});

function fixture(name: string, config: string): string {
  const fixtures = join(ROOT, ".test-fixtures");
  mkdirSync(fixtures, { recursive: true });
  const project = mkdtempSync(join(fixtures, `agent-rules-${name}-`));
  projects.push(project);
  mkdirSync(join(project, "app"), { recursive: true });
  writeFileSync(
    join(project, "app", "layout.jsx"),
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
  );
  writeFileSync(join(project, "app", "page.jsx"), "export default function Page() { return null; }\n");
  writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: `agent-rules-${name}`, private: true })}\n`);
  symlinkSync(join(ROOT, "node_modules"), join(project, "node_modules"));
  writeFileSync(join(project, "next.config.ts"), config);
  return project;
}

/** Boots `next dev` in `project` as an agent would, waits for it to serve, and stops it. */
async function bootAsAnAgent(project: string): Promise<string> {
  return retryOnPortRace(async (port) => {
    const child = spawnChild(["bun", "--bun", "run", "next", "dev"], {
      cwd: project,
      env: childEnv({ PORT: String(port), NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", AI_AGENT: "claude" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = captureOutput(child);
    try {
      await waitForChildHttp(child, `http://127.0.0.1:${port}/`, { output, timeoutMs: 90_000 });
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain("<html");
      // The rules are written once the server is listening; give the write a moment.
      await Bun.sleep(1_000);
      return output();
    } finally {
      child.kill();
      await child.exited;
    }
  });
}

// Only `agentRules` is taken from the real config: the rest of it (the build
// tsconfig, the trace includes) names files this throwaway project does not have.
const real = `import config from ${JSON.stringify(join(ROOT, "next.config.ts"))};
export default { agentRules: config.agentRules, turbopack: { root: ${JSON.stringify(ROOT)} } };
`;
const before9 = `export default { turbopack: { root: ${JSON.stringify(ROOT)} } };
`;

test("next dev under a coding agent writes no AGENTS.md or CLAUDE.md with this repo's config", async () => {
  const withConfig = fixture("real", real);
  const control = fixture("before-9", before9);

  const output = await bootAsAnAgent(withConfig);
  expect(existsSync(join(withConfig, "AGENTS.md")), output).toBe(false);
  expect(existsSync(join(withConfig, "CLAUDE.md")), output).toBe(false);

  const controlOutput = await bootAsAnAgent(control);
  expect(existsSync(join(control, "AGENTS.md")), `the control wrote no AGENTS.md, so this test proves nothing:\n${controlOutput}`).toBe(true);
}, 240_000);
