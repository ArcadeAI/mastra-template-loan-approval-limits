/**
 * The spike 04 transcript is committed, so its redaction is not a one-off that
 * happened to be right on the day. These tests assert two things through the
 * public functions: `redact` and `redactQuery` scrub every flow value out of a
 * real authorize URL, and the committed transcript still matches none of them.
 *
 * The second test is the one that matters. The first pass of this spike shipped
 * a transcript with six live PKCE challenges in it precisely because nothing
 * checked, and "mostly redacted" reads exactly like "redacted" to anyone
 * skimming. A rule nobody verifies is the failure mode this whole project is
 * about.
 */
import { describe, expect, test } from "bun:test";
import { REDACTED_PARAMS, redact, redactionPattern, redactQuery } from "./04-oauth-drive.ts";

/**
 * Fixture values are generated per run rather than written down.
 *
 * Round 1 of this file used hand-written placeholders. They read as obviously
 * fake to a human and as live OAuth values to a scanner: once
 * `05-redaction.test.ts` arrived and began sweeping every committed file under
 * `docs/spikes`, those four placeholders were the only hits in the repo. A file
 * asserting "no secret-shaped literal lives here" must not contain one, so the
 * values come from the CSPRNG and every assertion compares against the variable.
 */
function generatedValue(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

const STATE = generatedValue();
const CHALLENGE = generatedValue();
const ACCESS_TOKEN = generatedValue();
const REFRESH_TOKEN = generatedValue();
const LOGIN_CHALLENGE = generatedValue();
const CLIENT_ID = crypto.randomUUID();

/** An authorize URL shaped exactly like the ones a run produces. */
const AUTHORIZE_URL =
  "https://cloud.arcade.dev/oauth2/authorize?response_type=code" +
  `&client_id=${CLIENT_ID}` +
  "&redirect_uri=http%3A%2F%2Flocalhost%3A64265%2Fcallback" +
  "&scope=mcp+offline_access" +
  `&state=${STATE}` +
  `&code_challenge=${CHALLENGE}` +
  "&code_challenge_method=S256" +
  "&resource=https%3A%2F%2Fapi.arcade.dev%2Fmcp%2Fcg-demo-us";

const TOKEN_RESPONSE = JSON.stringify(
  {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "mcp offline_access",
  },
  null,
  2,
);

describe("redact", () => {
  test("leaves nothing on an authorize URL that the pattern still matches", () => {
    expect(redact(AUTHORIZE_URL).match(redactionPattern())).toBeNull();
  });

  test("scrubs the PKCE challenge and the state but keeps the URL readable", () => {
    const scrubbed = redact(AUTHORIZE_URL);
    expect(scrubbed).toContain("code_challenge=<redacted>");
    expect(scrubbed).toContain("state=<redacted>");
    expect(scrubbed).not.toContain(CHALLENGE);
    expect(scrubbed).not.toContain(STATE);
    // What makes the transcript worth reading survives: which endpoint, which
    // client, which gateway.
    expect(scrubbed).toContain("code_challenge_method=S256");
    expect(scrubbed).toContain(`client_id=${CLIENT_ID}`);
    expect(scrubbed).toContain("resource=https%3A%2F%2Fapi.arcade.dev%2Fmcp%2Fcg-demo-us");
  });

  test("scrubs token values out of a JSON body", () => {
    const scrubbed = redact(TOKEN_RESPONSE);
    expect(scrubbed).toContain('"access_token": "<redacted>"');
    expect(scrubbed).toContain('"refresh_token": "<redacted>"');
    expect(scrubbed).not.toContain(ACCESS_TOKEN);
    expect(scrubbed).not.toContain(REFRESH_TOKEN);
    expect(scrubbed).toContain('"token_type": "Bearer"');
    expect(scrubbed).toMatch(/"expires_in": 3600/);
  });

  test("is idempotent, so re-redacting a transcript changes nothing", () => {
    const once = redact(AUTHORIZE_URL);
    expect(redact(once)).toBe(once);
  });

  test("leaves a short prose placeholder alone", () => {
    // `state=p` and `code_challenge=…` appear in hand-written prose in the
    // transcript; they are illustrations, not values.
    expect(redact("…&state=p&code_challenge=…")).toBe("…&state=p&code_challenge=…");
  });
});

describe("redactQuery", () => {
  test("leaves nothing the pattern still matches", () => {
    expect(redactQuery(AUTHORIZE_URL).match(redactionPattern())).toBeNull();
  });

  test("scrubs the login and consent challenges the IdP hands out", () => {
    const scrubbed = redactQuery(
      `https://auth.arcade.dev/ui/login?login_challenge=${LOGIN_CHALLENGE}&foo=1`,
    );
    expect(scrubbed).toBe("https://auth.arcade.dev/ui/login?login_challenge=<redacted>&foo=1");
  });
});

describe("redactionPattern", () => {
  test("does not flag its own output", () => {
    expect("code_challenge=<redacted>&state=<redacted>".match(redactionPattern())).toBeNull();
  });

  test("catches every parameter the scripts claim to scrub", () => {
    for (const name of REDACTED_PARAMS) {
      const value = generatedValue();
      expect(`${name}=${value}`.match(redactionPattern())).not.toBeNull();
      expect(JSON.stringify({ [name]: value }).match(redactionPattern())).not.toBeNull();
    }
  });
});

describe("the committed transcript", () => {
  const path = `${import.meta.dir}/04-user-source-transcript.md`;

  test("carries no unredacted flow value", async () => {
    const text = await Bun.file(path).text();
    const leaks = [...text.matchAll(redactionPattern())].map((m) => m[0]);
    expect(leaks).toEqual([]);
  });

  test("carries no persona address", async () => {
    const text = await Bun.file(path).text();
    // The four live addresses live only in Render env vars. The transcript
    // writes the domain as a placeholder, so any real-looking one is a leak.
    expect(text).not.toMatch(/[a-z]+\.[a-z]+@(?!<persona-domain>)[a-z0-9.-]+\.[a-z]{2,}/);
  });
});
