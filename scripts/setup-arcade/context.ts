/**
 * The Arcade org and project `bun run setup-arcade` registers the hooks and
 * the gateway in (#30).
 *
 * Both live only under `/v1/orgs/{org_id}/projects/{project_id}/…`, and no
 * route tells a project key its own org or project (#28). The human measured
 * that the key does work on those routes once they are named, so the ids come
 * from somewhere a developer already has them, without a click:
 *
 * 1. `ARCADE_ORG_ID` and `ARCADE_PROJECT_ID`, together, from `.env`, `.env.local`
 *    or the shell. They win.
 * 2. The Arcade CLI's active context, which `arcade login`, `arcade org set`
 *    and `arcade project set` maintain, and which `arcade whoami` prints. The
 *    CLI has no machine-readable way to print it (1.16.1: `whoami` and
 *    `context show` print styled text), so this reads the CLI's own file,
 *    `credentials.yaml`, where `arcade_core.config_model.Config` keeps it:
 *    `cloud.contexts[<active>].context`, and the older flat `cloud.context`.
 *    The directory is `ARCADE_WORK_DIR`, else `~/.arcade`, and the context is
 *    `ARCADE_CONTEXT`, else the file's `active_context`, both as the CLI
 *    resolves them. **Only `org_id` and `project_id` are taken.** The file also
 *    holds the CLI's OAuth tokens: nothing here keeps, prints or passes on any
 *    other field.
 *
 * With neither, the hooks and the gateway fall back to the dashboard forms, and
 * the run says why.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ArcadeContext {
  orgId: string;
  projectId: string;
  /** Where the ids came from, as the run prints it. */
  source: string;
}

export type Resolution = { context: ArcadeContext } | { context: null; why: string };

/** The CLI's credentials file, where the CLI itself looks for it. */
export function credentialsPath(env: Record<string, string | undefined>): string {
  const configured = env.ARCADE_WORK_DIR?.trim();
  const home = env.HOME?.trim() || homedir();
  const dir = configured ? configured.replace(/^~(?=$|\/)/, home) : join(home, ".arcade");
  return join(dir, "credentials.yaml");
}

export function resolveContext(env: Record<string, string | undefined>): Resolution {
  const orgId = env.ARCADE_ORG_ID?.trim() ?? "";
  const projectId = env.ARCADE_PROJECT_ID?.trim() ?? "";
  if (orgId !== "" && projectId !== "") return { context: { orgId, projectId, source: "ARCADE_ORG_ID and ARCADE_PROJECT_ID" } };
  if (orgId !== "" || projectId !== "") {
    return { context: null, why: `${orgId !== "" ? "ARCADE_ORG_ID" : "ARCADE_PROJECT_ID"} is set without ${orgId !== "" ? "ARCADE_PROJECT_ID" : "ARCADE_ORG_ID"}; set both, or neither to use the Arcade CLI's active project` };
  }

  const path = credentialsPath(env);
  if (!existsSync(path)) {
    return { context: null, why: `ARCADE_ORG_ID and ARCADE_PROJECT_ID are unset, and there is no ${path}: run \`arcade login\`` };
  }
  let cloud: unknown;
  try {
    cloud = (Bun.YAML.parse(readFileSync(path, "utf8")) as { cloud?: unknown } | null)?.cloud;
  } catch {
    return { context: null, why: `${path} is not YAML the Arcade CLI wrote: run \`arcade logout\`, then \`arcade login\`` };
  }
  const name = env.ARCADE_CONTEXT?.trim() || stringAt(cloud, "active_context");
  const contexts = objectAt(cloud, "contexts");
  const named = name && contexts ? objectAt(contexts, name) : null;
  if (name && contexts && named === null) {
    return { context: null, why: `${path} has no context named ${name}: run \`arcade context list\`` };
  }
  const active = objectAt(named ?? cloud, "context");
  const found = { orgId: stringAt(active, "org_id"), projectId: stringAt(active, "project_id") };
  if (!found.orgId || !found.projectId) {
    return { context: null, why: `${path} has no active org and project${name ? ` in the context ${name}` : ""}: run \`arcade project set <project_id>\`` };
  }
  return { context: { ...found, source: `the Arcade CLI's active context, ${path}${name ? `, context ${name}` : ""}` } };
}

function objectAt(value: unknown, key: string): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  const found = (value as Record<string, unknown>)[key];
  return found !== null && typeof found === "object" ? (found as Record<string, unknown>) : null;
}

function stringAt(value: unknown, key: string): string {
  if (value === null || typeof value !== "object") return "";
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" ? found.trim() : "";
}
