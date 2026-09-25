# lib/identity/provider — the identity provider

**This is a demo fixture standing in for the enterprise's real IdP** — the same category
of thing as the persona switcher. A forker with a real IdP replaces the identity module and
points both hops at it (DESIGN.md → Identity and OAuth). It depends on nothing else in the
template: it declares nothing under `packages/`, and it knows people, not loans and not
policy.

**A module of the app since #6, not a service.** It was `apps/idp`, booted on its own port
as a service of its own. Now the app serves it on the app's own port (`instance.ts`, the routes under
`app/`), its issuer is `APP_PUBLIC_HOST`, and `scripts/identity.ts` runs the same handler on
a port of its own for the tests. The app depends on it now, by DESIGN.md's decision, through
one door: **only this module mints tokens**, and `app-test/identity/only-identity-mints.test.ts`
fails if another module imports its signing keys or its issuance.

[Better Auth](https://www.better-auth.com) 1.7.5 with the
[`@better-auth/oauth-provider`](https://www.better-auth.com/docs/plugins/oauth-provider)
plugin as an OAuth 2.1 authorization server, owning `idp.db`.

> `@better-auth/oauth-provider` (the `oauthProvider()` plugin) supersedes the older
> `oidc-provider` plugin, which still appears in the docs tree and in search results.
> Do not switch to it.

## What it serves

| Path | What |
|---|---|
| `GET /oauth2/authorize` | Authorization endpoint. Sends the browser to `/login`, then `/consent`, then back to the client with a code. |
| `POST /oauth2/token` | Token endpoint. `client_secret_basic` (HTTP Basic), PKCE `S256` required. Tolerates Arcade's duplicated credentials — see below. Access tokens are opaque; the ID token is an RS256 JWT. Every request is logged, successes included; a replayed code is refused without revoking the first exchange's tokens. |
| `GET /oauth2/userinfo` | The persona's identity. `email` is the claim Arcade extracts. |
| `GET /jwks` | The key set the ID token is verified against. One RSA key, `alg: RS256`. |
| `POST /oauth2/introspect`, `POST /oauth2/revoke` | For a resource server that needs to validate or revoke an opaque token. |
| `GET /.well-known/openid-configuration` | Discovery. A custom OAuth provider does not read it; an Arcade **User Source** does, and refuses an issuer without a `jwks_uri`. |
| `GET /login`, `GET /consent` | The two pages a persona sees. Server-rendered HTML, legible on a projector. |
| `POST /sign-in/email` | Better Auth's own sign-in. The login page calls it in-process. |
| `GET /identity/health` | The module's own health: the client id, the endpoint URLs, the JWKS URL, what happened to the client secret at boot, and whether the reset route exists. `/health` until #6; the app's `/health` is the app's, and carries `identity: {status, issuer, people}`. |
| `POST /identity/admin/reset` | Back to the seeded personas, leaving the OAuth client alone. Bearer `RESET_TOKEN`; 404 when that is unset. See below. `/admin/reset` until #6. |

Every Better Auth route hangs off the site root, so the URLs a human types into the
Arcade dashboard have no `/api/auth` prefix to forget. Anything else is a 404 from here
(`IDENTITY_PATHS` in `server.ts`), so an endpoint nobody routed is not reachable by accident.
Where this document below says `/health` or `/admin/reset`, read `/identity/health` and
`/identity/admin/reset`; where it says `cg-idp`, it is describing the demo's deployed
service, whose measurements these are.

## ID tokens, the key set, and the User Source

`/.well-known/openid-configuration` carries a `jwks_uri`, ID tokens are signed
**RS256**, and `GET /jwks` publishes the public half of one RSA key.

This is not decoration. Arcade's **User Source** mode redirects the persona to this
IdP and identifies them from a claim on the ID token, which it verifies against the key
set it fetches from `jwks_uri`. Until #70 this service ran Better Auth's OAuth provider
with `disableJwtPlugin: true`, so it signed ID tokens HS256, published no keys, and the
Arcade form refused the issuer outright:

> OIDC discovery document does not include a `jwks_uri`.

RS256 rather than Better Auth's default EdDSA, deliberately: Ed25519 JWS support is uneven
across verifiers, and an IdP whose only key a relying party cannot verify passes the
discovery check and fails at the token.

**The subject claim is `email`.** Better Auth blanks every standard profile claim in the
ID token by default and points relying parties at `/oauth2/userinfo`, which would leave
`sub` — an opaque uuid — as the only identity on the token. DESIGN.md's third identity
rule is that the Arcade `user_id`, the OAuth subject and the loan book's actor are the
same string, joined on email, so `customIdTokenClaims` puts `email` and `email_verified`
on the ID token, lowercased. `app-test/identity/flow.test.ts` asserts the claim is byte-equal to what
`/oauth2/userinfo` returns for the same session.

The signing key lives in the `jwks` table in `idp.db`, private half encrypted under
`BETTER_AUTH_SECRET`. The reset leaves it alone, for the same reason it leaves the
OAuth client alone: minting a new key pair would start failing ID-token verification for
anything holding the old key set.

## The people

Four personas, seeded from [`fixtures/people.json`](./fixtures/people.json) the
first time `idp.db` is opened, in one transaction, following the loan book's pattern
(#29): a seed that fails leaves no schema, so the next boot retries instead of coming up
green and empty. All four personas use the same checked-in password,
`megaforce-demo-2026`. It is a demo-only fixture credential, not a production secret;
never reuse it outside this demo. A merged fixture change reaches a persistent deployment
only after the new code is deployed **and** `bun run reset` (or the reset control) is run —
a redeploy alone does not reseed `idp.db`.

The emails are the join key for the whole system — Arcade `user_id`, OAuth subject, loan
book actor. The fixture ships placeholder addresses; set
`PERSONA_LOAN_OFFICER_EMAIL`, `PERSONA_CREDIT_ANALYST_EMAIL`, `PERSONA_VP_CREDIT_EMAIL` and
`PERSONA_CHIEF_CREDIT_OFFICER_EMAIL` (the same role variables the persona switcher uses)
**before the first boot** to seed the addresses the Arcade accounts were created under
(#13). A seed is not re-read; change them afterwards and you need a reset. Deprecated
name-based variables are refused before seeding.

**Every address is lowercased on the way in, and `user.email` is `collate nocase`.** Type
the variables in whatever case the Arcade invites used. Before #58 a persona configured
as `Alice@…` could not log in at all: Better Auth lowercases the address before it
looks the row up, SQLite compares text case-sensitively, and the login page reports the
unreachable row as "That email and password did not match" — the same sentence it gives a
wrong password.

## The OAuth client

One by default, named `Arcade`, created on first boot if absent: confidential,
`token_endpoint_auth_method: client_secret_basic`, PKCE required, redirect URIs from
`IDP_OAUTH_REDIRECT_URIS`. Better Auth generates the `client_id` and `client_secret`; they
cannot be pinned from env.

```sh
bun run oauth-client           # client ids and endpoints
bun run oauth-client --json    # the same, machine-readable
bun run oauth-client --rotate  # mint a new secret, same client id
```

### A second client, if the two Arcade registrations should not share one

`IDP_OAUTH_CLIENTS` names the clients by key; unset, it is exactly `arcade` and nothing
below applies. Each extra key gets its own row — its own generated `client_id`, its own
hashed secret, its own redirect allowlist — because an Arcade **User Source** and an
Arcade **custom OAuth provider** are two registrations with two generated redirect URIs,
and a rotated secret should cost one dashboard field rather than two.

```sh
IDP_OAUTH_CLIENTS=arcade,arcade-user-source
IDP_OAUTH_REDIRECT_URIS=https://cloud.arcade.dev/api/v1/oauth/<provider>/callback
IDP_OAUTH_REDIRECT_URIS_ARCADE_USER_SOURCE=https://cloud.arcade.dev/oauth2/intermediate_callback
```

A key becomes the row's primary key and, upper-snake-cased, the suffix of its redirect
variable; without that variable a client falls back to the shared
`IDP_OAUTH_REDIRECT_URIS`. `/health` lists every client under `oauth.clients`, and the
pre-#79 fields at `oauth.*` keep describing the first one, so nothing that read `/health`
before has to change.

With more than one configured, `--rotate` demands `--client <key>` and exits 2 otherwise:
rotating costs a human one field in one Arcade registration, and which one must not be a
guess this script makes for them.

```sh
bun run oauth-client --client arcade-user-source --rotate
```

Dropping a key from `IDP_OAUTH_CLIENTS` deletes nothing. The row stays on the disk and
**Better Auth still resolves it**, so that registration keeps working; what stops is this
service reconciling its redirect URIs and auth method at boot, and `oauth-client`
printing it. Remove a client for real by deleting its row.

What *is* refused is the reverse: creating a client while a row exists that this
configuration does not name, because that row may be the one Arcade holds. The service
fails to boot and names the ids it found — a dead service is a thing a human can act on,
and a silently rotated `client_id` fails at the authorize step, where no hook fires and
the panel stays dark.

### Client authentication is `client_secret_basic`, and only that

The client sends its credentials as HTTP Basic, RFC 6749 §2.3.1:

```
Authorization: Basic base64(client_id ":" client_secret)
```

**Better Auth registers exactly one method per client and checks it before it checks the
secret** (`@better-auth/oauth-provider`, `utils-*.mjs:640`):

```js
const registeredAuthMethod = client.tokenEndpointAuthMethod ?? "client_secret_basic";
if (authMethod && registeredAuthMethod !== authMethod)
  throwInvalidClient(`client registered for ${registeredAuthMethod} cannot use ${authMethod}`)
```

So there is no "accept both". Credentials in the token request body — the `client_secret_post`
form this client used until #61 — now come back `400 invalid_client`, with a correct id and
a correct secret, and the same is true of `/oauth2/introspect` and `/oauth2/revoke`.

Two reasons for Basic rather than post. It is the Arcade dashboard's default for a custom
OAuth provider, so registering the provider touches no field a forker would not otherwise
touch — which is the whole point of #61. And an Arcade **User Source** form has no
auth-method knob at all, so a User Source can only ever authenticate against a client that
accepts Basic; spike #75 measured `cg-demo-us` reaching consent here and then failing with
`Token exchange with identity provider failed`.

**An existing `idp.db` is reconciled at boot**, the same way the redirect URIs are, so the
live client changes in place: same `client_id`, same `client_secret`, no re-registration.
The boot log says so on stderr the one time it happens:

```
[idp] OAuth client token auth method reconciled to client_secret_basic (#61). …
```

and `/health` reports the current value, so the state of the live row is one curl away:

```sh
curl -s https://<idp-host>/health | jq -r '.oauth.token_endpoint_auth_method'
# client_secret_basic
```

### It tolerates Arcade sending the credentials twice, and nothing else

Arcade's custom OAuth provider presents the same credentials **twice**. Its token
request carries `auth_method: client_secret_basic`, which puts them in the
`Authorization` header, *and* the dashboard template's Request Parameter rows
`client_id={{client_id}}` / `client_secret={{client_secret}}`, which put the same pair
in the form body — on Token Settings and Refresh Token Settings alike. RFC 6749 §2.3
forbids two client authentication methods in one request, Better Auth enforces it in
`normalizeClientAuthenticationParameters` (`utils-*.mjs:541`) before it checks anything
else, and the live `cg-idp` refused Arcade for it (spike #75, 2026-09-11T17:38Z):

```
[idp] POST /oauth2/token rejected: status=400 error=invalid_request \
  error_description="A request must use only one client authentication method" \
  client_auth="client_secret_basic" client_id=<id>
```

Nothing on the Arcade side removes those rows, so this service accepts the request as
sent. The rule, in `server.ts`:

| The request carries | What happens |
|---|---|
| Basic, and a body `client_id`/`client_secret` pair **identical** to the header's | The body `client_secret` is dropped and the request is passed through. 200. |
| Basic, and a body pair that **differs** in either half | `400 invalid_request`, one log line, `client_auth="mixed"`. |
| Basic, and half a pair — a body `client_secret` with no `client_id` | Refused the same way. A half pair is not a duplicate. |
| Basic, and a client assertion | Refused the same way. An assertion is a different method, not the same one twice. |
| Basic alone | Unchanged: this is the registered method. |
| A body pair alone | Unchanged: `400 invalid_client`, "client registered for client_secret_basic cannot use client_secret_post". |

Three bounds worth stating, because a tolerance that quietly widens is the failure
this repo keeps out of its controls:

- **It is not "accept both methods".** The client is still registered for
  `client_secret_basic` and only that. Credentials in the body *alone* are refused
  exactly as #61 left them.
- **It is not a way past the credential check.** Identical credentials are accepted as
  one presentation, and a wrong presentation is still wrong: the same wrong secret in
  both places comes back `401 invalid_client`, logged as `client_secret_basic`.
- **Only `client_secret` is stripped.** A body `client_id` beside a Basic header is not
  a second method — the plugin expects it and cross-checks it against the authenticated
  client (`index.mjs:161`) — so leaving it keeps that check alive on the request that
  is passed through.

The running service states its own bound, so it can be checked from outside without
reading this file:

```sh
curl -s https://<idp-host>/health | jq -r '.oauth.duplicate_client_credentials'
# accepted when the Authorization: Basic pair and the body client_id/client_secret pair are identical; refused invalid_request when they differ
```

`app-test/identity/dual-client-credentials.test.ts` measures every row of that table over HTTP,
including a field-for-field replay of Arcade's request as the dashboard stores it.

### When the token endpoint says no, it says why

Every `/oauth2/token` rejection writes one line:

```
[idp] POST /oauth2/token rejected: status=401 error=invalid_client \
  error_description="invalid client_secret" client_auth="client_secret_basic" client_id=<id>
```

`client_auth` is the field that matters, and the reason this exists. A wrong secret and a
client registered for the other auth method both come back `invalid_client`; the exchange
is server to server, so nothing user-visible reports either; and before #61 this service
logged only its boot lines, which is why spike #75 could not tell the two apart.

Two things are deliberately **not** on that line. The secret, ever. And the `client_id` the
request supplied — under Basic it shares one base64 blob with the secret, so it is compared
against the registered id and the line says `client_id=<the registered id>` or
`client_id=(not the registered client)` instead of echoing it.

One more trap, measured: the `authorization_code` grant consumes the code **before** it
authenticates the client. Reproducing a client-auth failure by hand with a placeholder code
returns `invalid_grant: invalid code` and never reaches the check. Use a real code, or ask
`/oauth2/introspect`, which authenticates the client first.

### Every token request leaves a line

Since #100 round 2, **every** `/oauth2/token` request writes a census line — successes
included:

```
[idp] POST /oauth2/token at=2026-09-14T21:05:28.383Z grant=authorization_code \
  code=Ab3xK9pQ code_state=already_consumed outcome=invalid_grant client_id=<id> \
  ua="arcade-engine/1.4" ip=203.0.113.7
```

| Field | What it is |
| --- | --- |
| `at` | Millisecond UTC, captured when the request **arrived**. The same shape `apps/web` prints, so the two logs read side by side. |
| `grant` | `authorization_code`, `refresh_token`, or `(none)`. |
| `code` | The first 8 characters of the authorization code — enough to pair two requests, not enough to spend one. `(none)` on a grant that carries no code. |
| `code_state` | `already_consumed` / `unknown`, only when the answer was the ambiguous `invalid_grant "invalid code"`. |
| `outcome` | `success`, the OAuth error code, or `http_<status>`. |
| `client_id` | The registered id, or `(not the registered client)`. Never echoed from the request. |
| `ua` | `User-Agent`, quoted and capped at 120 characters. |
| `ip` | The **first** hop of `X-Forwarded-For` — a reverse proxy appends, so the left-most entry is the caller. `(none)` on a direct connection. |

This exists because round 1 of #100 could not be finished without it. The log showed two
`invalid_grant` rejections 216 ms apart and nothing else: the *successful* first exchange
left no trace, so a double exchange could be inferred but never counted, and neither caller
was ever attributed. On the stage demo's deployment at 21:05:28Z the missing half was the whole answer — cg-web's
single `next_uri` fetch was already in its own log, and the 290 ms gap to cg-idp's rejection
belonged to nobody.

The detailed `rejected:` line above is unchanged and still follows a failure. This line is
the census; that one is the diagnosis.

### A replayed code is named as one, and no longer costs anything

When the rejection is `invalid_grant "invalid code"`, the `rejected:` line carries one more
field:

```
[idp] POST /oauth2/token rejected: status=400 error=invalid_grant \
  error_description="invalid code" client_auth="client_secret_basic" client_id=<id> code=already_consumed
[idp] that code had already been exchanged — the tokens its first exchange minted were kept,
  so the grant the relying party holds still works (RFC 6749 §4.1.2 deviation, #100).
  Something is exchanging the code twice.
[idp] replay revocation refused: kept 1 oauthAccessToken row minted by the first exchange
  of that code (RFC 6749 §4.1.2 deviation, #100).
```

A code this service **never issued** takes the same revocation path inside the plugin, but
it is not a replay: nothing was minted under it, so nothing is kept and none of the three
lines above appear. It gets the census line and the `rejected:` line, both saying
`unknown`:

```
[idp] POST /oauth2/token at=2026-09-14T22:01:56.599Z grant=authorization_code code=not-a-co \
  code_state=unknown outcome=invalid_grant client_id=<id> ua="arcade-engine/1.4" ip=(none)
[idp] POST /oauth2/token rejected: status=400 error=invalid_grant \
  error_description="invalid code" client_auth="client_secret_basic" client_id=<id> code=unknown
```

The guard counts the rows before it suppresses anything, and that count is what separates
the two cases — the same question `code_state` asks, so the census and the intercept cannot
disagree about whether a request was a replay.

Better Auth answers a code it redeemed a moment ago and a code it never issued with the
same four words, and the difference is the whole diagnosis. `code=unknown` is everything
else: expired, from another deployment, or a guess. It is not called "expired" — a code
whose tokens have since been revoked or rotated away also lands there, because the rows
this reads are gone by then, and this field exists precisely because a previous line
guessed.

#### The deviation

Out of the box a replay is **not** a harmless refusal. `checkVerificationValue` calls
`revokeTokensIssuedForAuthorizationCode` on the way out, deleting the access and refresh
tokens the first, *successful* exchange minted. The relying party keeps a grant that has
been emptied, and the failure surfaces somewhere else entirely — for this demo,
`apps/loan-app` getting a 401 from `/oauth2/userinfo` and reporting "The identity provider
rejected the token."

That is #100. Measured on the stage demo's deployment on 2026-09-14: cg-web fetched `next_uri` exactly once
(`21:05:28.094Z [verifier] next_uri answered 200, location (none)`) and cg-idp rejected a
second `authorization_code` exchange 290 ms later. The second hit came from neither cg-web
nor the browser — it is Arcade's, and the standing decision of 2026-09-11 is that the
Arcade provider configuration is never edited and **the IdP adapts**.

So `replay-tolerance.ts` refuses that one revocation. **This is a deliberate deviation
from RFC 6749 §4.1.2**, which says an authorization server SHOULD revoke the tokens
previously issued for a code it sees replayed. That advice assumes a replay is evidence of
a leaked code; here it is a measured property of one relying party, arriving with the same
client credentials milliseconds after a legitimate exchange. **The refusal is unchanged —
a replayed code still answers `invalid_grant`** — only the collateral is dropped.

The guard is deliberately exact rather than broad, in two ways. It matches one call shape,
and it acts only when there is something to protect. The plugin makes four `deleteMany` calls
against the token tables; three key on `clientId`+`userId` or on `refreshId` and are real
revocations a user or client asked for. Only `revokeTokensIssuedForAuthorizationCode`
deletes by a lone `authorizationCodeId` equality, so that is the whole predicate. A wider
guard would disarm `/oauth2/revoke` and sign-out too, and a token that cannot be revoked is
a worse bug than the one being fixed — `flow.test.ts` asserts that boundary from outside by
revoking a refresh token and checking the paired access token really dies.

The `already_consumed` / `unknown` distinction is not on the wire. It is read from the token
tables before the request is forwarded, because it was the revocation that erased the
evidence. The code itself is never printed in full: it is a credential until it is spent.

### ⚠️ The secret is printed exactly once

The secret is stored **hashed**, so it can be read only by whichever run produced it —
creation or `--rotate`. Every later run prints the id and the endpoints and says plainly
that the secret cannot be shown again. Write it down when it appears.

This is the price of the key set. Before #70 the secret was stored encrypted and could be
re-printed on any later day, which Better Auth permits only with the JWT plugin off — and
with it off there is no `jwks_uri`, and no Arcade User Source (#65).

If the secret is lost, `--rotate` mints a new one under the **same client id**. Only the
secret field in the Arcade dashboard changes; the registration itself survives. Rotating
leaves the redirect URIs, the consents and the signing keys alone.

Note that the service itself creates the client when it boots on an empty disk, and
nothing prints that secret. `/health` says so — `client_secret_state: "created"` — and the
way to get a usable one is `--rotate`.

On a deployment: open a shell where the app runs and run `bun run oauth-client`. The boot
log carries the id, never the secret. If the shell does not carry `APP_PUBLIC_HOST`, the
script warns on stderr that the URLs it prints point at localhost; the credentials are
still right, and `/identity/health` on the running app has the real URLs.

Changing `IDP_OAUTH_REDIRECT_URIS` updates the client in place. The credentials do not change.

### What `/health` says about the secret

`oauth.client_secret_state` is one of four values, and the boot log says the same thing in
a sentence. Only one of them costs a human anything:

| State | Meaning |
|---|---|
| `unchanged` | Stored hashed already. Nothing happened. |
| `created` | This boot created the client. The secret has never been disclosed; `--rotate` to get one. |
| `migrated` | A secret stored by the pre-#70 build was re-hashed in place. **Client id and secret unchanged — the Arcade registration is still valid.** |
| `rotated` | The pre-#70 secret could not be decrypted with this `BETTER_AUTH_SECRET`, so it was unrecoverable and a new one was minted. **The Arcade `cg-idp` provider must be re-registered.** Logged on stderr. |

One line tells you which the live service took:

```sh
curl -s https://<idp-host>/health | jq -r '.oauth.client_secret_state'
```

### Registering it in Arcade (#13)

Custom OAuth 2.0 provider, from the output of the script above:

| Arcade field | Value |
|---|---|
| Client ID | as printed by `oauth-client` |
| Client secret | as printed **at creation or by `--rotate`**; it is not retrievable afterwards |
| Authorize URL | `https://<idp-host>/oauth2/authorize` |
| Token URL | `https://<idp-host>/oauth2/token` |
| Client authentication | **`client_secret_basic`** — the dashboard default. Leave it alone. Anything else is refused with `invalid_client` before the secret is checked. |
| **PKCE** | **enable it**, `S256`. Arcade defaults PKCE off; this client requires it. A mismatch fails at the authorize step, where no hook fires and nothing on the panel says why. |
| Scopes | `openid profile email offline_access` |
| User info endpoint | `https://<idp-host>/oauth2/userinfo`, bearer token |
| Identity JSONPath | `$.email` |
| Redirect URL | the one Arcade shows you — put it in `IDP_OAUTH_REDIRECT_URIS` if it is not `https://cloud.arcade.dev/api/v1/oauth/callback` |

The userinfo payload, for reference:

```json
{ "sub": "<user id>", "email": "alice@bank.example", "email_verified": true,
  "name": "Alice", "given_name": "Alice", "family_name": "" }
```

### Registering it as an Arcade User Source (#65)

A different Arcade object from the provider above, and the reason #70 exists. It reads
OIDC discovery, so it needs far fewer fields — and it is the one that refused this issuer
before the key set existed.

| Arcade field | Value |
|---|---|
| Issuer | `https://<idp-host>` — must match `iss` on the ID token exactly, no trailing slash |
| Client ID / Client secret | the same client as above |
| **Subject claim** | **`email`** — on the ID token, put there by `customIdTokenClaims`. Not `sub`, which is an opaque uuid and would break the join key. |
| Redirect URI to allowlist | `https://cloud.arcade.dev/oauth2/intermediate_callback`, added to `IDP_OAUTH_REDIRECT_URIS` |

Arcade discovers `jwks_uri` itself. Confirm it is there before filling the form in:

```sh
curl -s https://<idp-host>/.well-known/openid-configuration \
  | jq '{jwks_uri, id_token_signing_alg_values_supported}'
# { "jwks_uri": "https://<idp-host>/jwks", "id_token_signing_alg_values_supported": ["RS256"] }
```

## ⚠️ Reset does not rotate the client

`scripts/reset` (#23) exists so the demo can be rehearsed from clean. If resetting
`idp.db` regenerated the client, the registration in the Arcade dashboard would go stale
and OAuth would break at the next authorize — minutes before presenting, with no hook
fired and the panel dark.

So the reset for this database is its own script, and it clears **people and their
state** — users, credentials, sessions, tokens, consents — while leaving the `oauthClient`
row and the `jwks` signing keys alone:

```sh
bun run identity:reset
```

It prints the client id before and after and exits non-zero if they differ. The client
row is written unowned (no `userId`), so deleting every user cannot cascade into it either;
Better Auth's own create-client endpoints would have made a signed-in user the owner.
`app-test/identity/flow.test.ts` runs the reset against the live service and completes a full flow
afterwards with the pre-reset credentials; `app-test/identity/db.test.ts` holds the cascade line.

Deleting the disk (or the whole database) *is* a rotation. Do that only when you intend to
re-register in Arcade.

### The same reset, over HTTP

```sh
curl -fsS -X POST https://<idp-host>/admin/reset -H "authorization: Bearer $RESET_TOKEN"
```

Same code as the script — `reset.ts`, one implementation and two callers — and the
same assertion, returned as a **500** with the old and new ids when it ever fires. It
exists because a presenter between takes has no shell on the service, and because a
script in a hosted shell attaches to whichever instance the host picked while the endpoint
is served by the process that is actually answering requests.

`RESET_TOKEN` unset means the route does not exist: 404, and `/health` reports
`reset: "disabled"`, so the 404 has an explanation somebody can find. It is the same
variable and the same rules `apps/hooks` and `apps/loan-app` use, and `bun run reset` at
the repo root presents one bearer to all three (#23). `app-test/identity/reset-endpoint.test.ts` holds
the client id, the re-seeded people signing in again, idempotence and both refusals.

## Running it

```sh
bun install                         # at the repo root
bun run dev                         # the app, with this module on the app's port
curl localhost:3000/identity/health
bun run identity                    # or this module alone, on PORT (scripts/identity.ts)
```

Its tests are `app-test/identity/`. Most boot `scripts/identity.ts` exactly as `apps/idp`
was booted (env only) and drive the authorization-code flow over HTTP — authorize, login,
consent, code, token, userinfo; `app-test/identity/app-one-port.test.ts` does the same
against the real app on its one port:

```sh
bun test ./app-test/identity/
```

`schema.sql` is generated from the installed Better Auth (`bun run generate:identity-schema`);
`app-test/identity/schema.test.ts` fails when it is stale.

## The schema on a disk that already exists

**Since #6, a fresh schema and no upgrade path.** Better Auth 1.7.5 drops `account.issuer`,
which 1.7.2 declared `NOT NULL`, so a disk written by the 1.7.2 build holds a column this
build never writes and fails at its first seed or reset. DESIGN.md → Services records the
choice: the demo held Better Auth at 1.7.2 to avoid a migration on a live disk, and the
template's `idp.db` starts fresh instead. `SCHEMA_VERSION` is 2, and there are three paths:

- **Fresh database** — `seed()`: the DDL, the fixture rows *and* the version stamp in one
  transaction, so a half-failed seed leaves no tables at all rather than a schema with no
  people. `schema.sql` stays byte-identical to what Better Auth compiles (so
  `generate:check` compares like with like) and `idempotentSchema` derives the
  `CREATE ... IF NOT EXISTS` form, **throwing** on a statement it cannot rewrite.
- **A database this build wrote** — opened as it is, no DDL, no inserts.
- **Any other version** — newer throws `SchemaTooNewError`, older (0 before #70, 1 from #70
  to #6) throws `SchemaTooOldError`, both from `openPeople`, before anything is served,
  naming the file and the way out: delete it and restart, which reseeds — and rotates the
  OAuth client, so Arcade has to be re-registered.

The demo's upgrade path — replaying the DDL onto a pre-#70 disk and rebuilding `user` with
`COLLATE NOCASE` for a pre-#58 one (#69, #58) — went with #6, and so did its tests and the
frozen pre-`3d2dd9d` fixture they read. `app-test/identity/schema-upgrade.test.ts` holds what
is still true: the replay is idempotent, and every other version is refused.

### A workspace member, and still separable

It is a workspace member for its manifest, `package.json` here, which declares Better Auth
and carries `cg.external` for `packages/policy-schema`'s sweep, as `lib/loans` carries
`cg.governed`. It declares no `@cg/*` dependency, and knows no loan or policy vocabulary:
`app-test/identity/knows-people-not-loans.test.ts` checks both.

The other half of that test, "nothing else in the template depends on it", did not survive
#6: the app mounts the provider, by DESIGN.md's decision. What replaces it is narrower and
is what the fold needs — `only-identity-mints.test.ts`: only the identity routes, the app's
`/health` and `instrumentation.ts` reach the provider, through `instance.ts`, and nothing
outside the identity module imports Better Auth, its signing keys or its issuance.

## Environment

| Variable | Purpose |
|---|---|
| `PORT` | The app's. `scripts/identity.ts` binds it too (`0` for whatever the OS gives). |
| `IDP_DB_PATH` | `/data/idp.db` on the deployment's disk, `./idp.db` locally. Parent directory is created. |
| `BETTER_AUTH_SECRET` | Signs sessions and the OAuth query, and encrypts the ID-token signing key at rest. Written by `bun run setup-arcade`. Required in production; a fixed dev value otherwise. Changing it on a pre-#70 disk is what turns the client-secret migration into a rotation. |
| `APP_PUBLIC_HOST` | The app's public host; the issuer is it with its scheme — http for localhost and 127.0.0.1, https otherwise. Falls back to `localhost:PORT`. It replaced `IDP_PUBLIC_URL` on #6. |
| `IDP_OAUTH_REDIRECT_URIS` | Comma-separated. Defaults to Arcade Cloud's callback. |
| `PERSONA_LOAN_OFFICER_EMAIL`, `PERSONA_CREDIT_ANALYST_EMAIL`, `PERSONA_VP_CREDIT_EMAIL`, `PERSONA_CHIEF_CREDIT_OFFICER_EMAIL` | The four role addresses, read at first seed. Lowercased before they are stored; case does not have to match Arcade. |
