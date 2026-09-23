#!/usr/bin/env bun
/**
 * Spike 05 — read an OAuth client's redirect-URI allowlist from outside, without
 * the dashboard and without the client secret.
 *
 * `apps/idp` answers `/oauth2/authorize` with a 302 either way. A URI on the
 * allowlist redirects *onward* to `/login`; one that is not redirects to
 * `/error?error=invalid_redirect`. That difference is a free, unauthenticated
 * read of the allowlist, and it is how this spike checked that a human's Render
 * change had landed without asking a second time.
 *
 * It is also how #75 found that the live `cg-idp` accepts the **User Source**
 * callback and rejects the **auth provider** callback the loan tools would need.
 *
 *   bun docs/spikes/evidence/05-redirect-allowlist.ts [extra-uri …]
 *
 * Optional: IDP_ISSUER, IDP_CLIENT_ID (defaults are read from the live IdP's
 * `/health`, which publishes the client id and no secret).
 */
import { pkce } from "./05-drive.ts";

const ISSUER = (process.env.IDP_ISSUER ?? "https://cg-idp-or5b.onrender.com").replace(/\/+$/, "");

const CANDIDATES = [
  "https://cloud.arcade.dev/oauth2/intermediate_callback",
  "https://cloud.arcade.dev/api/v1/oauth/callback",
  "https://cloud.arcade.dev/api/v1/oauth/callback/",
  "https://cloud.arcade.dev/oauth/callback",
  "https://api.arcade.dev/v1/oauth/callback",
  "https://example.com/definitely-not-allowlisted",
  ...process.argv.slice(2),
];

const clientId =
  process.env.IDP_CLIENT_ID?.trim() ?? ((await (await fetch(`${ISSUER}/health`)).json()) as any).oauth.client_id;

const { challenge } = await pkce();

console.log(`redirect-URI allowlist on ${ISSUER}, client ${clientId}\n`);
for (const uri of CANDIDATES) {
  const res = await fetch(
    `${ISSUER}/oauth2/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: uri,
      scope: "openid email",
      state: "probe",
      // A real S256 challenge, so a rejection is about the redirect URI and
      // nothing else. Generated per run rather than pinned: this file is scanned by
      // `05-redaction.test.ts` for exactly this shape, and a hardcoded challenge —
      // even the one out of RFC 7636's examples — is a value of the kind the test
      // exists to keep out of `docs/spikes`. The verifier is discarded and no token
      // is ever requested, so nothing depends on it being stable.
      code_challenge: challenge,
      code_challenge_method: "S256",
    })}`,
    { redirect: "manual" },
  );
  const location = res.headers.get("location") ?? "";
  const allowed = location.startsWith("/login") || location.includes("/login?");
  console.log(`${allowed ? "ALLOWED " : "REJECTED"}  ${uri}`);
  if (!allowed) console.log(`            -> ${location.split("&error_description=").join("\n               ")}`);
}
