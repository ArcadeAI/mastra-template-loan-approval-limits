/**
 * Reading and filling in `.env` for `bun run setup-arcade` (#9).
 *
 * The one rule: **blanks only.** A key with a value is never changed, whoever
 * wrote it. A key present and empty (`KEY=`, as `.env.example` ships them) is
 * filled where it stands; a key that is absent is appended under one header.
 * Comments and order survive, so the file stays the one the developer copied.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** `KEY=value` lines to a record. Comments, blanks and `export ` are handled; quotes are stripped. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) continue;
    env[match[1]!] = unquote(match[2]!);
  }
  return env;
}

function unquote(raw: string): string {
  const value = raw.trim();
  const quoted = /^(['"])(.*)\1$/.exec(value);
  if (quoted) return quoted[2]!;
  // An unquoted value ends at a ` #` comment, the way dotenv reads it.
  return value.replace(/\s+#.*$/, "");
}

export function readEnvFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export interface FillResult {
  text: string;
  /** Keys this call wrote, in order. */
  written: string[];
  /** Keys it was asked to fill and left alone because they already had a value. */
  kept: string[];
}

/** Fills each blank or absent key in `text`; never touches a key that has a value. */
export function fillBlanks(text: string, values: Record<string, string>): FillResult {
  const existing = parseEnv(text);
  const written: string[] = [];
  const kept: string[] = [];
  const lines = text.split("\n");
  const appended: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (existing[key] !== undefined && existing[key] !== "") {
      kept.push(key);
      continue;
    }
    const index = lines.findIndex((line) => LINE.exec(line)?.[1] === key);
    if (index === -1) appended.push(`${key}=${value}`);
    else lines[index] = `${key}=${value}`;
    written.push(key);
  }

  let out = lines.join("\n");
  if (appended.length > 0) {
    if (out !== "" && !out.endsWith("\n")) out += "\n";
    out += `\n# Written by \`bun run setup-arcade\`.\n${appended.join("\n")}\n`;
  }
  return { text: out, written, kept };
}

export function writeEnvFile(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
}

/**
 * The variables `bun run setup-arcade` decides about (#30): `.env.example`'s
 * three required values, which it reads, and its second block, which it
 * writes. `app-test/setup-arcade.test.ts` holds both lists to `.env.example`.
 * No persona addresses since #33: users are added with `bun run users`.
 */
export const REQUIRED_KEYS = ["ANTHROPIC_API_KEY", "ARCADE_API_KEY", "APP_PUBLIC_HOST"] as const;

export const WRITTEN_KEYS = [
  "SESSION_SECRET",
  "BETTER_AUTH_SECRET",
  "IDP_CLIENT_ID",
  "IDP_CLIENT_SECRET",
  "IDP_OAUTH_CLIENTS",
  "IDP_OAUTH_REDIRECT_URIS_ARCADE",
  "IDP_OAUTH_REDIRECT_URIS_ARCADE_USER_SOURCE",
  "IDP_OAUTH_REDIRECT_URIS_WEB",
  "ARCADE_HOOK_SIGNING_SECRET",
  "APPROVALS_STORE_TOKEN",
  "ARCADE_GATEWAY_ID",
  "GOVERNANCE_STREAM",
] as const;

export const MANAGED_KEYS: readonly string[] = [...REQUIRED_KEYS, ...WRITTEN_KEYS];

/**
 * The managed variables the shell exports with a value `.env` does not hold,
 * names only. A shell variable equal to `.env`'s value is no conflict.
 */
export function shellConflicts(shell: Record<string, string | undefined>, file: Record<string, string>): string[] {
  return MANAGED_KEYS.filter((key) => shell[key] !== undefined && shell[key]!.trim() !== (file[key]?.trim() ?? ""));
}

/**
 * `key`'s line set to `value`, whatever it held. For the one variable whose
 * source of truth is Arcade rather than `.env` (#30): every other key keeps
 * the never-overwrite rule of {@link fillBlanks}.
 */
export function replaceValue(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => LINE.exec(line)?.[1] === key);
  if (index === -1) return fillBlanks(text, { [key]: value }).text;
  lines[index] = `${key}=${value}`;
  return lines.join("\n");
}
