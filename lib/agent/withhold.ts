/**
 * Secrets out of what the chat shows of a tool call (#37).
 *
 * The chat renders every tool call's arguments and every result exactly as the
 * model received them, after `/post` rewrote it, because the demo is about
 * what goes over the wire. That puts arbitrary tool output on a screen, and a
 * tool output can carry a credential: a bearer echoed back in an error, a
 * token field, the approvals store's own token in a misbehaving toolkit's
 * reply. None of those may reach the page, so this runs on the server, before
 * the event is written, and the page is told how many values it removed.
 *
 * Three nets, because each misses what the others catch:
 *
 * - **Known values.** Every secret the app holds for this turn: every token in
 *   the sealed session (`sessionSecrets`, in the identity module), every
 *   secret field of the configuration (`configSecrets`), and the service
 *   secrets from the environment. Matched as substrings, so a token inside a
 *   URL or a sentence goes too. The identity provider's signing secret, which
 *   nothing outside the provider may read, is matched by fingerprint instead
 *   (`lib/secret-fingerprints.ts`).
 * - **Key names.** A string under `access_token`, `client_secret`, `password`
 *   and the like, whatever its value. Covers OAuth tokens this process never
 *   held, such as the hop-2 token Arcade keeps.
 * - **Shapes.** `Bearer …` and anything that looks like a JWT.
 *
 * This is display, not governance: the model has already received the result,
 * and `/post` is the control over what it receives. This file only decides
 * what the browser is shown of it.
 */

import { sha256, type SecretFingerprint } from "../secret-fingerprints.ts";

/** What replaces a withheld value. */
export const WITHHELD = "[withheld: secret]";

/**
 * The environment variables whose values are secrets. Read by name, so a
 * value that is set is withheld wherever it turns up.
 *
 * Not the identity provider's signing secret: only the provider may read it
 * (`app-test/identity/only-identity-mints.test.ts`), so it registers a
 * fingerprint instead, and `withholdSecrets` matches that.
 */
export const SECRET_ENV = [
  "APPROVALS_STORE_TOKEN",
  "SESSION_SECRET",
  "RESET_TOKEN",
  "ARCADE_API_KEY",
  "ARCADE_HOOK_SIGNING_SECRET",
  "ANTHROPIC_API_KEY",
  "IDP_CLIENT_SECRET",
] as const;

/**
 * Shorter than this is not matched as a known value. A secret of three
 * characters would mask every occurrence of those three characters in a loan
 * record, and nothing here is that short on purpose.
 */
const MIN_SECRET_LENGTH = 8;

const SECRET_KEY =
  /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|authorization|client[_-]?secret|api[_-]?key|password|secret|token)$/i;

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;

/**
 * What a turn withholds: secret values it holds, and fingerprints of secrets it
 * may not hold (`lib/secret-fingerprints.ts`).
 */
export interface WithheldSet {
  readonly values: readonly string[];
  readonly fingerprints: readonly SecretFingerprint[];
}

export const NOTHING_WITHHELD: WithheldSet = { values: [], fingerprints: [] };

/** The secret values to look for, deduplicated, longest first so a prefix never masks half of one. */
export function secretValues(values: ReadonlyArray<string | undefined | null>): string[] {
  const kept = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= MIN_SECRET_LENGTH) kept.add(trimmed);
  }
  return [...kept].sort((a, b) => b.length - a.length);
}

/** The values of `SECRET_ENV` in this environment. */
export function environmentSecrets(env: Record<string, string | undefined>): string[] {
  return secretValues(SECRET_ENV.map((name) => env[name]));
}

/**
 * A copy of `value` with every secret replaced by `WITHHELD`, and how many
 * were replaced. `value` itself is not touched.
 *
 * The whole value is scanned, however deep: the walk keeps its own stack
 * rather than recursing, so there is no cutoff and no stack to overflow. Round
 * 1 of #41's review found the old cutoff at depth 32 returning a bearer
 * nested 33 levels down unscanned. A value that refers to itself is copied
 * with the same shape and scanned once.
 */
export function withholdSecrets<T>(value: T, secrets: WithheldSet | readonly string[]): { value: T; withheld: number } {
  const set: WithheldSet = Array.isArray(secrets)
    ? { values: secrets as readonly string[], fingerprints: [] }
    : (secrets as WithheldSet);
  const lengths = [...new Set(set.fingerprints.map((print) => print.length))].filter(
    (length) => length >= MIN_SECRET_LENGTH,
  );
  const hashes = new Set(set.fingerprints.map((print) => `${print.length}:${print.sha256}`));
  let withheld = 0;

  const inString = (text: string): string => {
    let out = text;
    for (const secret of set.values) {
      if (!out.includes(secret)) continue;
      const parts = out.split(secret);
      withheld += parts.length - 1;
      out = parts.join(WITHHELD);
    }
    // A fingerprint: hash every window of the secret's length.
    for (const length of lengths) {
      let at = 0;
      let rebuilt = "";
      let from = 0;
      while (at + length <= out.length) {
        if (hashes.has(`${length}:${sha256(out.slice(at, at + length))}`)) {
          withheld += 1;
          rebuilt += out.slice(from, at) + WITHHELD;
          at += length;
          from = at;
          continue;
        }
        at += 1;
      }
      if (from > 0) out = rebuilt + out.slice(from);
    }
    out = out.replace(BEARER, () => {
      withheld += 1;
      return `Bearer ${WITHHELD}`;
    });
    out = out.replace(JWT, () => {
      withheld += 1;
      return WITHHELD;
    });
    return out;
  };

  const copies = new Map<object, unknown>();
  const pending: Array<{ from: object; into: Record<string, unknown> | unknown[] }> = [];

  /** A string scanned, a leaf as is, an object or array as a shell queued for its children. */
  const shell = (node: unknown): unknown => {
    if (typeof node === "string") return inString(node);
    if (node === null || typeof node !== "object") return node;
    const seen = copies.get(node);
    if (seen !== undefined) return seen;
    const into: Record<string, unknown> | unknown[] = Array.isArray(node) ? [] : {};
    copies.set(node, into);
    pending.push({ from: node, into });
    return into;
  };

  const root = shell(value);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { from, into } = next;
    if (Array.isArray(from)) {
      const list = into as unknown[];
      for (let index = 0; index < from.length; index += 1) list[index] = shell(from[index]);
      continue;
    }
    const record = into as Record<string, unknown>;
    for (const [key, child] of Object.entries(from as Record<string, unknown>)) {
      if (SECRET_KEY.test(key) && typeof child === "string" && child !== "" && child !== WITHHELD) {
        withheld += 1;
        record[key] = WITHHELD;
        continue;
      }
      record[key] = shell(child);
    }
  }

  return { value: root as T, withheld };
}
