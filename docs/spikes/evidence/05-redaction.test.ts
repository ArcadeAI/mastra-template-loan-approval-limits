/**
 * No OAuth value reaches a committed file under `docs/spikes`.
 *
 * Round 2 of this spike's review found a real OAuth `state` in the committed
 * transcript *and* a `redact` helper that did not list `state` or `code_challenge`.
 * Those are one bug, not two: the redactor and the reviewer were working from
 * different lists of what counts as sensitive. So there is one list —
 * `05-drive.ts:SENSITIVE_FIELDS` — and this file checks both halves of it:
 *
 *   1. the helper actually neutralises every field on the list, and
 *   2. no committed file under `docs/spikes` contains a value of those shapes.
 *
 * It is a test rather than a script so that it runs inside the `bun test` a
 * reviewer already runs, which means a transcript cannot drift back without the
 * suite going red. It can also be run alone:
 *
 *   bun test docs/spikes/evidence/05-redaction.test.ts
 *
 * Fixture values are generated per run rather than written down, for the obvious
 * reason: a file that asserts "no secret-shaped literals live here" must not contain
 * secret-shaped literals. That also means the scan covers this file like any other.
 */
import { describe, expect, test } from "bun:test";
import { SENSITIVE_FIELDS, redact, redactQuery } from "./05-drive.ts";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

/** Random, so nothing here is a literal, and different every run. */
function generatedValue(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

describe("the redaction helper covers every field it claims to", () => {
  test.each([...SENSITIVE_FIELDS])("%s is removed from a JSON body", (field) => {
    const value = generatedValue();
    const out = redact(`{"before":"keep","${field}":"${value}","after":"keep"}`);
    expect(out).not.toContain(value);
    expect(out).toContain(`"${field}":"<redacted>"`);
    // Redaction is surgical: the neighbours survive.
    expect(out).toContain('"before":"keep"');
    expect(out).toContain('"after":"keep"');
  });

  test.each([...SENSITIVE_FIELDS])("%s is removed from a query string", (field) => {
    const value = generatedValue();
    const out = redact(`https://idp.example/authorize?first=keep&${field}=${value}&last=keep`);
    expect(out).not.toContain(value);
    expect(out).toContain(`${field}=<redacted>`);
    expect(out).toContain("first=keep");
    expect(out).toContain("last=keep");
  });

  test("redactQuery applies the same list", () => {
    const value = generatedValue();
    expect(redactQuery(`https://x/cb?code=${value}&iss=https%3A%2F%2Fy`)).not.toContain(value);
  });

  test("a UUID state is removed — the exact shape round 2 found committed", () => {
    const state = crypto.randomUUID();
    expect(redact(`?state=${state}&code_challenge_method=S256`)).toBe(
      "?state=<redacted>&code_challenge_method=S256",
    );
  });

  test("redacting twice changes nothing the second time", () => {
    const once = redact(`?state=${crypto.randomUUID()}&code=${generatedValue()}&keep=1`);
    expect(redact(once)).toBe(once);
  });

  /**
   * The boundary assertions in the helper earn their keep here. Every one of these
   * contains a sensitive field name as a substring and none of them is sensitive;
   * a redactor that mangles them makes the transcripts unreadable, which is how a
   * redactor stops being used.
   */
  test.each([
    ['{"client_secret_state":"unchanged"}', "client_secret_state"],
    ['{"stateMatches":true}', "stateMatches"],
    ["?code_challenge_method=S256", "code_challenge_method"],
    ['{"token_endpoint_auth_method":"client_secret_basic"}', "token_endpoint_auth_method"],
    ["?ba_param=state&exp=1789136288", "ba_param=state"],
  ])("leaves %s alone", (input) => {
    expect(redact(input)).toBe(input);
  });
});

/**
 * A value that looks machine-generated, as opposed to a placeholder or an English
 * word.
 *
 * Shape rather than an allowlist of accepted placeholders, on purpose. An allowlist
 * grows every time someone writes `notacode` or `not-the-secret-this-client-has` or
 * `{{client_secret}}`, and a list that grows under pressure to stay green stops
 * being a check. Entropy is the thing actually worth catching: a UUID, a JWT, or a
 * long token-shaped run of base64url with at least one digit and one letter.
 */
function looksGenerated(value: string): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const jwt = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
  const token = /^[A-Za-z0-9_-]{16,}$/;
  return uuid.test(value) || jwt.test(value) || (token.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value));
}

/** Only what is committed: an ignored `.env.local` next door is not this test's business. */
function committedFilesUnderDocsSpikes(): string[] {
  const git = Bun.spawnSync(["git", "ls-files", "docs/spikes"], { cwd: REPO_ROOT });
  if (git.exitCode !== 0) throw new Error(`git ls-files failed: ${git.stderr.toString()}`);
  return git.stdout
    .toString()
    .split("\n")
    .filter((path) => path && !/\.(png|jpe?g|gif|pdf|db)$/i.test(path));
}

describe("no committed file under docs/spikes carries an OAuth value", () => {
  const files = committedFilesUnderDocsSpikes();

  test("there are files to check", () => {
    // A `git ls-files` that silently returns nothing would make every test below
    // pass while checking exactly nothing.
    expect(files.length).toBeGreaterThan(5);
  });

  test.each(files)("%s", async (path) => {
    const text = await Bun.file(`${REPO_ROOT}/${path}`).text();
    const lines = text.split("\n");
    const hits: string[] = [];

    for (const field of SENSITIVE_FIELDS) {
      // `field = value` or `"field": "value"`, in prose, JSON, a query string or
      // source. The value stops at anything that cannot be inside one.
      const pattern = new RegExp(
        `(?<![A-Za-z0-9_])${field}(?![A-Za-z0-9_])["']?\\s*[=:]\\s*["']?([^"'&\\s,;(){}\\[\\]]+)`,
        "g",
      );
      lines.forEach((line, index) => {
        for (const match of line.matchAll(pattern)) {
          const value = match[1].replace(/[.,;:!?"'`]+$/, "");
          if (!looksGenerated(value)) continue;
          hits.push(`${path}:${index + 1}  ${field} = ${value.slice(0, 48)}`);
        }
      });
    }

    expect(hits).toEqual([]);
  });
});
