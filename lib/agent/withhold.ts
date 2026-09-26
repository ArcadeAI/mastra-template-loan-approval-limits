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
 * - **Known values.** The strings this process holds as secrets for this turn:
 *   the persona's gateway and IdP tokens, and the service secrets from the
 *   environment. Matched as substrings, so a token inside a URL or a sentence
 *   goes too.
 * - **Key names.** A string under `access_token`, `client_secret`, `password`
 *   and the like, whatever its value. Covers OAuth tokens this process never
 *   held, such as the hop-2 token Arcade keeps.
 * - **Shapes.** `Bearer …` and anything that looks like a JWT.
 *
 * This is display, not governance: the model has already received the result,
 * and `/post` is the control over what it receives. This file only decides
 * what the browser is shown of it.
 */

/** What replaces a withheld value. */
export const WITHHELD = "[withheld: secret]";

/**
 * The environment variables whose values are secrets. Read by name, so a
 * value that is set is withheld wherever it turns up.
 *
 * Not the identity module's signing secret: only that module may read it
 * (`app-test/identity/only-identity-mints.test.ts`), and nothing on the MCP
 * path holds it to echo back.
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
 */
export function withholdSecrets<T>(value: T, secrets: readonly string[]): { value: T; withheld: number } {
  let withheld = 0;

  const inString = (text: string): string => {
    let out = text;
    for (const secret of secrets) {
      if (!out.includes(secret)) continue;
      const parts = out.split(secret);
      withheld += parts.length - 1;
      out = parts.join(WITHHELD);
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

  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") return inString(node);
    if (depth > 32 || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (SECRET_KEY.test(key) && typeof child === "string" && child !== "" && child !== WITHHELD) {
        withheld += 1;
        copy[key] = WITHHELD;
        continue;
      }
      copy[key] = walk(child, depth + 1);
    }
    return copy;
  };

  const masked = walk(value, 0) as T;
  return { value: masked, withheld };
}
