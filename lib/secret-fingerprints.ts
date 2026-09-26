/**
 * Fingerprints of secrets a module may not hand to anyone (#37).
 *
 * The chat withholds every secret the app holds from what it shows of a tool
 * call (`lib/agent/withhold.ts`). One of them it may not read at all: the
 * identity provider's `BETTER_AUTH_SECRET`, which encrypts its signing key and
 * which only `lib/identity/provider/` may read
 * (`app-test/identity/only-identity-mints.test.ts`). So the provider
 * registers a fingerprint of it here when it reads its configuration, and the
 * chat matches against the fingerprint.
 *
 * **A fingerprint is a length and a SHA-256, never the value.** To find the
 * secret inside a string, the matcher hashes every window of that length and
 * compares, so nothing outside the provider ever holds the secret itself.
 * `app-test/chat-leak-probes.test.ts` checks that this module holds no raw
 * value.
 *
 * Kept on `globalThis` because Next can load one module more than once in a
 * server process, one copy per route bundle, and the provider's copy and the
 * chat route's copy have to see the same registry.
 */
import { createHash } from "node:crypto";

export interface SecretFingerprint {
  readonly length: number;
  readonly sha256: string;
}

const REGISTRY = Symbol.for("cg.secret-fingerprints");

type Registry = Map<string, SecretFingerprint>;

function registry(): Registry {
  const holder = globalThis as { [REGISTRY]?: Registry };
  holder[REGISTRY] ??= new Map();
  return holder[REGISTRY];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Record that `value` is a secret. Only its length and hash are kept. */
export function registerSecretFingerprint(value: string): void {
  const trimmed = value.trim();
  if (trimmed === "") return;
  const fingerprint = { length: trimmed.length, sha256: sha256(trimmed) };
  registry().set(`${fingerprint.length}:${fingerprint.sha256}`, fingerprint);
}

/** Every fingerprint registered in this process. */
export function secretFingerprints(): SecretFingerprint[] {
  return [...registry().values()];
}
