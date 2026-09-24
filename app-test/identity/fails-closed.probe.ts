/**
 * The probe `fails-closed.test.ts` runs in a process of its own (#6,
 * criterion 5 and the Q7 condition). Not a `*.test.ts`, so the root `bun test`
 * never collects it: it sets `NODE_ENV=production` and, in one of its two
 * modes, leaves the identity provider unable to boot — and the provider, like
 * the loan book and the control plane, is one per process and remembers.
 *
 * `CG_PROBE_EXPECT` says which world this run is in:
 *
 *   - `failed` — the provider refuses to boot, and `CG_PROBE_ERROR` is a
 *     phrase its reason must contain: no `BETTER_AUTH_SECRET` in production,
 *     none on a public host (#9), or an `idp.db` whose signing key the secret
 *     cannot open (#9);
 *   - `ok` — a control: every difference between the runs is the identity
 *     provider's doing.
 *
 * Next's request-context APIs (`cookies()`, `revalidatePath`) are the only
 * things substituted, because the decide action is a server action and there
 * is no Next request here. The action itself is the real one.
 */
import { expect, mock, test } from "bun:test";

import { chunk, chunkName } from "../../lib/identity/seal.ts";
import { seal } from "../../lib/identity/seal.ts";
import { SESSION_COOKIE, readSessionFromCookies } from "../../lib/identity/session.ts";

const EXPECT = process.env.CG_PROBE_EXPECT;
if (EXPECT !== "failed" && EXPECT !== "ok") throw new Error(`CG_PROBE_EXPECT=${String(EXPECT)}; want failed or ok`);
const FAILED = EXPECT === "failed";
const REASON = process.env.CG_PROBE_ERROR ?? "";
if (FAILED && REASON === "") throw new Error("CG_PROBE_EXPECT=failed needs CG_PROBE_ERROR, a phrase the refusal must contain");

const CHARLIE = "charlie@bank.example";

/** The browser's cookie jar, as `next/headers` would hand it to the action. */
const jar = new Map<string, string>();
mock.module("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
}));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));

/** A session sealed the way sign-in seals it, for somebody who really did sign in. */
async function signedInAsCharlie(): Promise<void> {
  jar.clear();
  const pieces = chunk(await seal({ email: CHARLIE, signed_in_at: Date.now() }, process.env.SESSION_SECRET!));
  pieces.forEach((piece, index) => jar.set(chunkName(SESSION_COOKIE, index), piece));
}

const { identityProviderFailure, serve } = await import("../../lib/identity/provider/instance.ts");
const failure = await identityProviderFailure();

test(`the identity provider ${FAILED ? "refused to boot" : "booted"}`, () => {
  if (FAILED) expect(failure).toContain(REASON);
  else expect(failure).toBeNull();
});

test(`/health reports identity as ${FAILED ? "failed" : "ok"}, still with HTTP 200`, async () => {
  const { GET } = await import("../../app/health/route.ts");
  const response = await GET();
  expect(response.status).toBe(200);
  const body = (await response.json()) as { status: string; identity: Record<string, unknown> };
  if (FAILED) {
    expect(body.identity).toMatchObject({ status: "failed", issuer: null, people: null });
    expect(String(body.identity.error)).toContain(REASON);
    // And the whole answer is degraded — for that reason alone: the `ok` run,
    // identical but for the secret, answers `ok`.
    expect(body.status).toBe("degraded");
  } else {
    expect(body.identity).toMatchObject({ status: "ok", people: 4 });
    expect(body.status).toBe("ok");
  }
});

test(`every identity route ${FAILED ? "answers 503 and names why" : "answers"}`, async () => {
  const origin = `http://${process.env.APP_PUBLIC_HOST}`;
  for (const [method, path] of [
    ["GET", "/.well-known/openid-configuration"],
    ["GET", "/oauth2/authorize?client_id=x"],
    ["POST", "/oauth2/token"],
    ["GET", "/oauth2/userinfo"],
    ["GET", "/login"],
    ["GET", "/jwks"],
  ] as const) {
    const response = await serve(new Request(`${origin}${path}`, { method }));
    if (FAILED) {
      expect({ path, status: response.status }).toEqual({ path, status: 503 });
      expect(await response.text()).toContain(REASON);
    } else {
      expect({ path, unavailable: response.status === 503 }).toEqual({ path, unavailable: false });
    }
  }
});

test(`a session sealed for Charlie reads as ${FAILED ? "nobody" : "Charlie"}`, async () => {
  await signedInAsCharlie();
  const session = await readSessionFromCookies(jar);
  if (FAILED) expect(session).toBeNull();
  else expect(session?.email).toBe(CHARLIE);
});

test(`the decide action ${FAILED ? "refuses: nobody to decide as" : "gets past the session"}`, async () => {
  await signedInAsCharlie();
  const { decide } = await import("../../app/approvals/[id]/actions.ts");
  const form = new FormData();
  form.set("decision", "approved");
  const result = await decide("apr_000000000001", { state: "idle" } as never, form);
  if (FAILED) {
    expect(result).toEqual({
      state: "failed",
      message:
        "This browser is not signed in, so there is nobody to make this decision as. " +
        "Sign in and open the link again — nothing was sent to the control plane.",
    });
  } else {
    // Past the session and on to Arcade, which is a stand-in address nothing
    // answers — so it fails later, for a different reason, as Charlie.
    expect(JSON.stringify(result)).not.toContain("not signed in");
  }
});
