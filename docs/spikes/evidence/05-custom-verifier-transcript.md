# Spike 05 — raw transcript

Every run is against the live services on **2026-09-11** unless it says otherwise.

**Redaction.** `05-drive.ts:redact` removes the value of every field in
`SENSITIVE_FIELDS` — tokens, `code`, `code_verifier`, `code_challenge`, `state`,
`client_secret`, `password`, `flow_state`, `sig` and the two Ory challenges — and
`05-redaction.test.ts` greps every file under `docs/spikes` for those shapes and fails
on a hit, so this file cannot drift back. The persona domain is redacted by hand, as in
spikes 03 and 04.

Where a measurement turns on two values being *the same*, the value is replaced by a
stable label rather than by `<redacted>`, so the claim survives without the secret:
`<dana-flow-1>`, `<dana-flow-2>`, `<sam-flow>`. Arcade uses the authorization
`flow_id` as the OAuth `state`, so those are one value wearing two names and both are
labelled.

Three classes of identifier are deliberately **not** redacted, because none is a
credential and each is load-bearing evidence: OAuth **client ids** (`apps/idp`
publishes its own on `/health`; Arcade's upstream and the spike's
dynamically-registered one are public), Arcade **`auth_id`s** (`ar_…`, which name a
grant rather than authorising anything), and the **`sub`** claims our IdP returns —
the whole point of §11.10 is that Sam's `sub` differs from Dana's.

The ngrok hostname is left in where it appears: the tunnel was dead within the hour
and it is the only way to read the flow.

**Read the write-up's framing first.** Sections 1–9 are round 1, and round 1
conflated two hops. Hop 1 (MCP client → gateway) is governed by the **User
Source**; hop 2 (tool-level OAuth) is governed by the **custom verifier**.
Everything below about hop 1 stands; what round 1 called "question 1 — does the
verifier move the login" turned out to be the wrong question, and hop 2 is
unmeasured. Section 10 is the round-2 fixes.

Scripts: [`05-verifier.ts`](05-verifier.ts), [`05-verifier-flow.ts`](05-verifier-flow.ts),
[`05-redirect-allowlist.ts`](05-redirect-allowlist.ts), [`05-token-auth-methods.ts`](05-token-auth-methods.ts),
[`05-drive.ts`](05-drive.ts).

---

## 1. The blocker found before anything else: the verifier needs a client secret, and it cannot be read back

`apps/idp` registers exactly one OAuth client. The live one, off the public
`/health`, no secret in it:

```console
$ curl -s https://cg-idp-or5b.onrender.com/health
{"status":"ok","service":"idp","issuer":"https://cg-idp-or5b.onrender.com","people":4,
 "oauth":{"client_id":"RskTFjl6AqkUO8FKYWjpDCLd139YE36F",
          "authorize":"https://cg-idp-or5b.onrender.com/oauth2/authorize",
          "token":"https://cg-idp-or5b.onrender.com/oauth2/token",
          "userinfo":"https://cg-idp-or5b.onrender.com/oauth2/userinfo",
          "jwks":"https://cg-idp-or5b.onrender.com/jwks",
          "id_token_signing_alg":"RS256",
          "client_secret_state":"unchanged",
          "client_secret_note":"stored hashed; it cannot be printed again — `bun run oauth-client --rotate` mints a new one"}}
```

Dynamic client registration is off, so the verifier cannot mint its own:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST https://cg-idp-or5b.onrender.com/oauth2/register \
    -H 'content-type: application/json' -d '{"client_name":"probe","redirect_uris":["http://localhost:1/cb"]}'
403
```

(`apps/idp/src/auth.ts` sets `allowDynamicClientRegistration: false`, deliberately —
"Arcade is registered by hand, so nothing needs `/oauth2/register`.")

And there is no PKCE-only path around the secret. Measured against a **local**
`apps/idp` at the same version, driving a real login for Dana and then exchanging
the same kind of code three ways:

```
=== no client_secret (PKCE only) -> HTTP 400
{"error_description":"client registered for client_secret_post cannot use none","error":"invalid_client"}

=== wrong client_secret -> HTTP 400
{"error_description":"invalid client_secret","error":"invalid_client"}

=== correct client_secret -> HTTP 200
{"access_token":"<redacted>","expires_in":3600,"token_type":"Bearer","scope":"openid email","id_token":"<redacted>"}

userinfo -> 200 {"sub":"ab7cb2b0-…","email":"dana.okafor@…","email_verified":true}
id_token claims: {"iss":"http://localhost:4423","aud":"k93D04bR2YHYSe2paqsG9eQgrG00mX0l","email":"dana.okafor@…","sub":"ab7cb2b0…"}
```

Note the live token endpoint checks the **code before the client**, so probing it
with a junk code tells you nothing:

```console
$ curl -s -X POST https://cg-idp-or5b.onrender.com/oauth2/token \
    -d 'grant_type=authorization_code&code=notacode&…&client_id=RskTFjl6AqkUO8FKYWjpDCLd139YE36F&code_verifier=…'
{"error_description":"invalid code","error":"invalid_grant"}      # with no secret
{"error_description":"invalid code","error":"invalid_grant"}      # with a wrong secret
```

That ordering is why the local instance was needed to answer it.

---

## 2. The live IdP's redirect-URI allowlist, read from outside

`apps/idp` answers `/oauth2/authorize` with a 302 either way: onward to `/login`
for an allowlisted URI, to `/error?error=invalid_redirect` for anything else.
Unauthenticated, no dashboard, no secret.

```console
$ bun docs/spikes/evidence/05-redirect-allowlist.ts
redirect-URI allowlist on https://cg-idp-or5b.onrender.com, client RskTFjl6AqkUO8FKYWjpDCLd139YE36F

ALLOWED   https://cloud.arcade.dev/oauth2/intermediate_callback
REJECTED  https://cloud.arcade.dev/api/v1/oauth/callback
            -> https://cg-idp-or5b.onrender.com/error?error=invalid_redirect
               invalid+redirect+uri
REJECTED  https://cloud.arcade.dev/api/v1/oauth/callback/
REJECTED  https://cloud.arcade.dev/oauth/callback
REJECTED  https://api.arcade.dev/v1/oauth/callback
REJECTED  https://example.com/definitely-not-allowlisted
```

`https://cloud.arcade.dev/oauth2/intermediate_callback` is the redirect URL
Arcade's User Source documentation names. `https://cloud.arcade.dev/api/v1/oauth/callback`
is the one `apps/idp/src/config.ts` carries as `DEFAULT_ARCADE_REDIRECT_URI` and
`.env.example` ships, for the **auth provider** the loan tools use.

**Corrected later the same day, and the correction matters.** That generic
auth-provider callback is not the one Arcade actually uses. The human read the
live `IDP_OAUTH_REDIRECT_URIS`, which carries two entries, and the real
auth-provider callback has a per-provider path segment. Re-probed with it:

```console
$ bun docs/spikes/evidence/05-redirect-allowlist.ts \
    "https://cloud.arcade.dev/api/v1/oauth/f4c6b_ap_GvSAhPpynQRj/callback"
ALLOWED   https://cloud.arcade.dev/oauth2/intermediate_callback
REJECTED  https://cloud.arcade.dev/api/v1/oauth/callback
REJECTED  https://cloud.arcade.dev/api/v1/oauth/callback/
REJECTED  https://cloud.arcade.dev/oauth/callback
REJECTED  https://api.arcade.dev/v1/oauth/callback
REJECTED  https://example.com/definitely-not-allowlisted
ALLOWED   https://cloud.arcade.dev/api/v1/oauth/f4c6b_ap_GvSAhPpynQRj/callback
```

So the live allowlist is correct and complete; what is wrong is `.env.example`'s
documented default, which is a URL Arcade never calls. Recorded as finding 7a.

---

## 3. Control: both gateways, with no custom verifier configured

Re-measured today, so the "after" has a same-day "before" to sit next to. Spike 04
got the same answer a week earlier.

```console
$ PROBE_ONLY=1 ARCADE_MCP_URL=https://api.arcade.dev/mcp/cg-demo-us \
    bun docs/spikes/evidence/05-verifier-flow.ts
```

```
─── 08 302 https://auth.arcade.dev/oauth2/auth -> https://auth.arcade.dev/ui/login
─── 09 303 https://auth.arcade.dev/ui/login -> https://auth.arcade.dev/self-service/login/browser
─── 10 303 https://auth.arcade.dev/self-service/login/browser -> https://account.arcade.dev/login
─── 11 page 1: account.arcade.dev rendered a form

─── 12 hop 1 — hosts that rendered a page
{
  "pageHosts": ["account.arcade.dev"],
  "pagesShown": 1,
  "reachedTheVerifier": false,
  "reachedTheIdP": false
}

─── 13 hop 1 — redirect chain
[
  "302 GET https://cloud.arcade.dev/oauth2/authorize",
  "302 GET https://auth.arcade.dev/oauth2/auth",
  "303 GET https://auth.arcade.dev/ui/login",
  "303 GET https://auth.arcade.dev/self-service/login/browser",
  "200 GET https://account.arcade.dev/login"
]
```

`cg-demo` (members mode) is byte-identical hop for hop, same upstream
`client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812`, same
`redirect_uri=https://cloud.arcade.dev/oauth2/intermediate_callback`, and it
stops on the same `account.arcade.dev` login page.

The protected-resource documents still differ exactly as spike 04 recorded:
`cg-demo-us` publishes `"urn:arcade:oauth:user_source_id":"us_3JA8GcvHfT17WNnnRazx6FZpxeg"`,
`cg-demo` publishes no such field.

---

## 4. The verifier, proven end to end against a real `apps/idp`

Before asking a human for anything, the verifier was run against a local
`apps/idp` (an instance of the same code as `cg-idp`, on this worktree's own port
4423, with a client this spike minted and therefore holds the secret for), and a
stand-in for Arcade drove it. This proves the verifier's own contract; it does
not prove anything about Arcade.

Startup:

```
spike 05 verifier — local :52571, public https://63be-…-3130.ngrok-free.app
  IdP issuer         http://localhost:4423
  IdP client         k93D04bR2YHYSe2paqsG9eQgrG00mX0l
  confirm_user       manual — the curl is printed per flow

  Two values for the human:
    Arcade dashboard, Auth → Settings → custom verifier :  https://63be-…-3130.ngrok-free.app/verify
    IdP IDP_OAUTH_REDIRECT_URIS, one more entry         :  https://63be-…-3130.ngrok-free.app/callback
```

A whole flow, second time for this persona (so consent was already granted):

```
─── 01 303 https://63be-….ngrok-free.app/verify -> http://localhost:4423/oauth2/authorize
─── 02 302 http://localhost:4423/oauth2/authorize -> http://localhost:4423/login
─── 03 page 1: login at http://localhost:4423/login
       { "action": "http://localhost:4423/login", "fields": ["oauth_query","email","password"] }
─── 04 303 https://63be-….ngrok-free.app/callback -> https://cloud.arcade.dev/pretend/next
─── 05 the chain lands back on the redirect URI

== result {
  "visited": [
    "303 GET https://63be-….ngrok-free.app/verify",
    "302 GET http://localhost:4423/oauth2/authorize",
    "200 GET http://localhost:4423/login",
    "303 POST http://localhost:4423/login",
    "303 GET https://63be-….ngrok-free.app/callback"
  ],
  "pagesShown": 1,
  "pageHosts": ["localhost:4423"]
}
```

What the verifier itself recorded, off `GET /state`:

```json
{
  "flow_id": "spike75-local-1",
  "started_at": "2026-09-11T14:14:53.622Z",
  "arcade_query": { "flow_id": "spike75-local-1", "provider": "cg-idp" },
  "email": "dana.okafor@…",
  "waiting": true
}
```

and the manual `confirm_user` step, resumed by hand because this spike holds no
Arcade API key:

```console
$ curl -sS -X POST https://63be-….ngrok-free.app/confirm -H 'content-type: application/json' \
    -d '{"flow_id":"spike75-local-1","response":{"auth_id":"ac_fake123","next_uri":"https://cloud.arcade.dev/pretend/next?ok=1"}}'
{"resumed":"spike75-local-1"}
```

`auth_id`/`next_uri` there are stand-ins, not Arcade's: this run never reached
Arcade. It exercises the resume path and the final 303.

### How many pages a persona sees at `apps/idp`

Three runs, same verifier, same IdP:

| Run | Persona state | Pages rendered |
|---|---|---:|
| First ever authorization | no session, no prior consent | **2** — `/login`, then `/consent` |
| Later authorization, new browser | no session, consent on record | **1** — `/login` |
| Second authorization, same browser | live session, consent on record | **0** — entirely silent |

The third row is the one that matters for #75 question 3, and it is measured:

```
== flow spike75-riley-a: pagesShown=2 pageHosts=["localhost:4423","localhost:4423"] jar=["localhost"]
== flow spike75-riley-b: pagesShown=0 pageHosts=[]                                  jar=["localhost"]
```

Two complete authorization flows through the verifier, one cookie jar. The second
showed the persona nothing at all.

---

## 5. Hop 1 on `cg-demo-us`, at 14:24Z: the persona logs in at our IdP

Same script, same persona, nine minutes after section 3's control. This is the
spike's headline measurement.

```
─── 02 protected-resource metadata
{"resource":"https://api.arcade.dev/mcp/cg-demo-us",
 "authorization_servers":["https://cloud.arcade.dev/oauth2"],
 "bearer_methods_supported":["header"],"scopes_supported":["mcp"],
 "resource_name":"contextual-governance (user source)",
 "urn:arcade:oauth:user_source_id":"us_3JA8GcvHfT17WNnnRazx6FZpxeg"}

─── 05 dynamic client registration
{"client_id":"bdd5093b-a579-4421-9248-5a786a88bfc4",
 "redirect_uris":["http://localhost:56575/callback"],
 "token_endpoint_auth_method":"none","scope":"mcp offline_access",
 "client_name":"cg-spike-75","application_type":"web"}

─── 07 302 https://cloud.arcade.dev/oauth2/authorize -> https://cg-idp-or5b.onrender.com/oauth2/authorize
https://cg-idp-or5b.onrender.com/oauth2/authorize
  ?response_type=code
  &client_id=RskTFjl6AqkUO8FKYWjpDCLd139YE36F
  &redirect_uri=https%3A%2F%2Fcloud.arcade.dev%2Foauth2%2Fintermediate_callback
  &scope=openid+profile+email
  &state=…&code_challenge=…&code_challenge_method=S256

─── 08 302 https://cg-idp-or5b.onrender.com/oauth2/authorize -> https://cg-idp-or5b.onrender.com/login

─── 09 page 1: login at https://cg-idp-or5b.onrender.com/login
{ "action": "https://cg-idp-or5b.onrender.com/login",
  "fields": ["oauth_query","email","password"] }

─── 10 page 2: consent at https://cg-idp-or5b.onrender.com/consent
{ "action": "https://cg-idp-or5b.onrender.com/consent",
  "fields": ["oauth_query","decision"] }

─── 13 hop 1 — hosts that rendered a page
{
  "pageHosts": ["cg-idp-or5b.onrender.com","cg-idp-or5b.onrender.com"],
  "pagesShown": 2,
  "reachedTheVerifier": false,
  "reachedTheIdP": true,
  "stoppedBecause": null
}

─── 14 hop 1 — redirect chain
[
  "302 GET https://cloud.arcade.dev/oauth2/authorize",
  "302 GET https://cg-idp-or5b.onrender.com/oauth2/authorize",
  "200 GET https://cg-idp-or5b.onrender.com/login",
  "303 POST https://cg-idp-or5b.onrender.com/login",
  "200 GET https://cg-idp-or5b.onrender.com/consent",
  "303 POST https://cg-idp-or5b.onrender.com/consent",
  "302 GET https://cloud.arcade.dev/oauth2/intermediate_callback"
]
```

`auth.arcade.dev` and `account.arcade.dev` do not appear. Compare section 3, which
is the same gateway at 14:15Z.

`reachedTheVerifier: false` is not incidental — the verifier's tunnel was up and
serving for the whole window, and `GET /state` on it shows five flows, all of them
this spike's own local tests and none from Arcade.

## 6. …and the token exchange fails

The last hop of the chain above:

```
─── 11 302 https://cloud.arcade.dev/oauth2/intermediate_callback -> http://localhost:56575/callback
http://localhost:56575/callback
  ?error=access_denied
  &iss=https%3A%2F%2Fcloud.arcade.dev%2Foauth2
  &error_description=Token+exchange+with+identity+provider+failed
  &state=…

─── 14 callback query
{ "keys": ["error","iss","error_description","state"],
  "stateMatches": true,
  "error": "access_denied",
  "error_description": "Token exchange with identity provider failed" }

FAILED: authorize failed: access_denied — Token exchange with identity provider failed
```

Reproduced on a two-minute timer for seventeen minutes. Every line identical but
the state:

```
14:32:29Z | Token+exchange+with+identity+provider+failed | no-pre
14:34:33Z | Token+exchange+with+identity+provider+failed | no-pre
14:36:38Z | Token+exchange+with+identity+provider+failed | no-pre
14:38:41Z | Token+exchange+with+identity+provider+failed | no-pre
14:40:46Z | Token+exchange+with+identity+provider+failed | no-pre
```

The 14:29:47Z run rendered **one** page rather than two: Dana's consent from
14:24Z is on record at our IdP, so only `/login` appeared. Consent persists across
runs; the session cookie did not, because each run used a fresh jar.

## 7. What `apps/idp` says at the token endpoint, per client-auth method

Four real single-use codes against a local instance, because the live one checks
the code before the client.

```console
$ IDP_ISSUER=http://localhost:4423 IDP_CLIENT_ID=… IDP_CLIENT_SECRET=… \
  IDP_REDIRECT_URI=http://localhost:4429/callback \
  PERSONA_EMAIL=morgan.ellis@… PERSONA_PASSWORD=… \
  bun docs/spikes/evidence/05-token-auth-methods.ts

client_secret_post, correct secret — the configuration we have
  -> HTTP 200 (a token was issued)
client_secret_post, WRONG secret — a stale secret in the dashboard
  -> HTTP 400 {"error_description":"invalid client_secret","error":"invalid_client"}
client_secret_basic, correct secret — a relying party that prefers the header
  -> HTTP 401 {"error_description":"client registered for client_secret_post cannot use client_secret_basic","error":"invalid_client"}
no client authentication at all — PKCE only, as a public client would
  -> HTTP 400 {"error_description":"client registered for client_secret_post cannot use none","error":"invalid_client"}
```

**The status code alone separates the two candidate causes.** 401 is an
auth-method mismatch; 400 is a wrong secret.

And the live IdP cannot be asked, because it validates the code first:

```console
$ # junk code, no secret
{"error_description":"invalid code","error":"invalid_grant"}
$ # junk code, wrong secret
{"error_description":"invalid code","error":"invalid_grant"}
$ # junk code, Basic auth
{"error_description":"invalid code","error":"invalid_grant"}
```

## 8. Why the cause stayed an inference

The discriminator above needs one line of the `cg-idp` Render log, for the
`POST /oauth2/token` at 14:24:07Z or 14:29:47Z. **The human looked: `apps/idp`
writes boot lines and nothing else. There is no request log.** So the cause is
recorded as an inference and the missing log as a finding in its own right.

## 9. Teardown

```console
$ pgrep -fl "05-verifier.ts|ngrok http|watch.sh|bun src/index.ts"
none
$ lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(442[0-9])\b'
no 4420-4429 listeners
$ curl -s -o /dev/null -w '%{http_code}\n' https://63be-….ngrok-free.app/health
404          # ngrok's own page: the tunnel is gone
```

The verifier, its tunnel, the local `apps/idp` and the repeat-measurement loop were
all shut down before this spike reported. Nothing this spike started is still
listening.

---

## 10. Round 2 — the two checks round 1's reviewer could not run

### 10.1 `05-token-auth-methods.ts` now boots its own IdP and needs no credential

Round 1 it exited 2 with *"IDP_CLIENT_ID is required"*, so the four outcomes were
transcript-only. From a clean checkout, nothing configured, nothing in the
environment:

```console
$ bun docs/spikes/evidence/05-token-auth-methods.ts ; echo "exit=$?"
spike 05 — apps/idp token-endpoint client authentication
  throwaway IdP  http://localhost:63470   (port bound as :0 and read back)
  scratch db     /var/folders/…/T/cg-spike75-token-auth-62092-1789139603291.db
  persona        dana.okafor@bank.example   (checked-in fixture, not a live address)

  client 5qW8brlosNnjGxtgVyhb2dj3NzDp0kkI, registered client_secret_post, secret minted on creation

══ four real single-use codes, four ways of authenticating the client ══

client_secret_post, correct secret — the configuration we have
  -> HTTP 200 (a token was issued)
client_secret_post, WRONG secret — a stale secret in the dashboard
  -> HTTP 400 {"error_description":"invalid client_secret","error":"invalid_client"}
client_secret_basic, correct secret — a relying party that prefers the header
  -> HTTP 401 {"error_description":"client registered for client_secret_post cannot use client_secret_basic","error":"invalid_client"}
no client authentication at all — PKCE only, as a public client would
  -> HTTP 400 {"error_description":"client registered for client_secret_post cannot use none","error":"invalid_client"}

✓ the status code alone separates the two causes: 401 is an auth-method mismatch (#61 item 1),
  400 with a client_secret is a wrong secret, 200 means the exchange worked.
exit=0
```

The persona is `dana.okafor@bank.example` — the **checked-in fixture** address, not
the live one. That is the whole trick: the live personas live in Render env vars,
the fixture ones live in git, and this measurement never needed a live anything.

The ✓ line is an assertion, not a flourish. The script fails if the four statuses
stop being distinguishable, because the advice it hands the human — *"read the
status code off the Render log"* — is worthless the moment a Better Auth upgrade
collapses the 401 onto the 400.

Cleanup, checked:

```console
$ ls /tmp/cg-spike75-token-auth-*        ; # no matches
$ pgrep -fl "apps/idp/src/index.ts"      ; # no idp process left
```

### 10.2 `PROBE_ONLY=1` exits 0 when it stops on purpose

Round 1 it printed the right answer and then `FAILED: the chain stopped at
https://cg-idp-or5b.onrender.com/login …` and exited 1. Both gateways, now:

```console
$ PROBE_ONLY=1 ARCADE_MCP_URL=https://api.arcade.dev/mcp/cg-demo-us \
    PERSONA_EMAIL=nobody@example.invalid PERSONA_PASSWORD=unused \
    bun docs/spikes/evidence/05-verifier-flow.ts ; echo "exit=$?"

─── 11 hop 1 — redirect chain
[
  "302 GET https://cloud.arcade.dev/oauth2/authorize",
  "302 GET https://cg-idp-or5b.onrender.com/oauth2/authorize",
  "200 GET https://cg-idp-or5b.onrender.com/login"
]

══ PROBE OK — hop 1 on https://api.arcade.dev/mcp/cg-demo-us
══ 3 hops, first page rendered by cg-idp-or5b.onrender.com: our own IdP — hop 1 is brokered to the User Source.
══ No password was typed: the probe stops at the first page by design.
exit=0
```

```console
$ ARCADE_MCP_URL=https://api.arcade.dev/mcp/cg-demo … ; echo "exit=$?"
══ PROBE OK — hop 1 on https://api.arcade.dev/mcp/cg-demo
══ 5 hops, first page rendered by account.arcade.dev: account.arcade.dev, which is neither our IdP nor the verifier.
══ No password was typed: the probe stops at the first page by design.
exit=0
```

The credentials on the command line are deliberately fake: a probe that stops at
the first page never uses them, and a probe that *did* use them would not be a
probe. Note the second run still reports `account.arcade.dev` — members mode is
unchanged, hours later.

### 10.3 `--no-ngrok` is a real flag, and credentials come from an untracked file

Round 1's non-blocking finding was that `--no-ngrok` was ignored: the process
still started a tunnel. Now:

```console
$ bun docs/spikes/evidence/05-verifier.ts --no-ngrok
spike 05 verifier — local :63436, public http://localhost:63436
  IdP issuer         https://cg-idp-or5b.onrender.com
  IdP credentials    NOT YET SET (IDP_CLIENT_ID, IDP_CLIENT_SECRET) — write docs/spikes/evidence/.env.local
                     when you have them; this route re-reads it per flow, no restart, URL unchanged
  tunnel             off (--no-ngrok): this URL is not reachable from Arcade
  confirm_user       manual — the curl is printed per flow

$ pgrep -f "ngrok http"                  ; # no ngrok process
$ curl -s localhost:63436/health
{"status":"ok","public_url":"http://localhost:63436","idp_credentials":"missing: IDP_CLIENT_ID, IDP_CLIENT_SECRET"}
$ curl -s -o /dev/null -w '%{http_code}\n' "localhost:63436/verify?flow_id=t1"
503
```

With the file present — the values here are throwaway strings, written and deleted
inside one test:

```console
$ printf 'IDP_CLIENT_ID=probe-id\nIDP_CLIENT_SECRET="probe-secret"\n' > docs/spikes/evidence/.env.local
$ bun docs/spikes/evidence/05-verifier.ts --no-ngrok
  IdP credentials    read from docs/spikes/evidence/.env.local (never printed)
$ curl -s localhost:63449/health
{"status":"ok","public_url":"http://localhost:63449","idp_credentials":"present"}
$ curl -s localhost:63449/state | grep -c "probe-id\|probe-secret"
0
```

`/state` is the fullest thing this route will tell anyone, and neither value is in
it. The file itself is gitignored at any depth:

```console
$ git check-ignore -v docs/spikes/evidence/.env.local
.gitignore:14:.env.local	docs/spikes/evidence/.env.local
```

**Credentials are read per flow rather than at startup**, which is not tidiness:
the tunnel has to exist before the human can paste its URL into the dashboard, and
the human writes `.env.local` in the same sitting. Demanding credentials before
binding would force a restart, and a restart on ngrok's free tier means a new
hostname and a dashboard field that is now wrong.

---

## 11. Round 2, the measurement sitting — 2026-09-11, 15:25Z to 17:00Z

Timestamps are UTC and exact. Tokens, codes, `state` and PKCE values are redacted by
`05-drive.ts:redact` or by hand; the persona domain is redacted throughout.

### 11.1 Hop 1 completes, once #61 lands

`/health` on the live IdP after `aa98780` deployed:

```json
{ "oauth": { "client_id": "RskTFjl6AqkUO8FKYWjpDCLd139YE36F",
             "token_endpoint_auth_method": "client_secret_basic",
             "client_secret_state": "unchanged",
             "id_token_signing_alg": "RS256" } }
```

15:25:40Z, as Dana against `cg-demo-us`:

```
302 GET  https://cloud.arcade.dev/oauth2/authorize
302 GET  https://cg-idp-or5b.onrender.com/oauth2/authorize
200 GET  https://cg-idp-or5b.onrender.com/login                  ← page 1, ours
303 POST https://cg-idp-or5b.onrender.com/login
200 GET  https://cloud.arcade.dev/oauth2/intermediate_callback   ← page 2, Arcade's
303 POST https://cloud.arcade.dev/oauth2/consent
→ callback: code, iss, state — state matches, no error
token exchange -> 200 {"access_token":"<redacted>","expires_in":900,
                       "refresh_token":"<redacted>","scope":"mcp offline_access"}
```

Seven runs between 14:24Z and 14:41Z had ended `access_denied / "Token exchange with
identity provider failed"`. Nothing changed but the client's registered auth method.

`tools/list -> 200`:

```
System_ManageAuthorization  Arcade_ListApps
Loan_GetLoan  Loan_SearchLoans  Loan_ApproveLoan  Loan_DenyLoan
Approvals_RequestApproval  Approvals_Decide
```

### 11.2 Arcade's gateway consent screen, which is new

`cloud.arcade.dev/oauth2/intermediate_callback` used to be a redirect. Its form:

```html
<form method="POST" action="/oauth2/consent" class="consent-form">
    <input type="hidden" name="flow_state" value="<redacted>" />
    <button type="submit" name="action" value="deny">Deny</button>
    <button type="submit" name="action" value="allow">Allow</button>
</form>
```

Headings: *"Authorize access"*, *"Allow this application to access your Arcade.dev
account?"*, the MCP client's name, and a *"Development Mode"* warning because the
redirect URI is a loopback.

Two buttons on one form is why `05-drive.ts` now chooses a consent value explicitly:

```
─── 10 page 2: consent at https://cloud.arcade.dev/oauth2/intermediate_callback
       (cloud.arcade.dev, not our IdP — no credential asked for)
{ "action": "https://cloud.arcade.dev/oauth2/consent",
  "fields": ["flow_state","action"],
  "offered": { "action": ["deny","allow"] },
  "chosen":  { "action": "allow" } }
```

### 11.3 The join key

One `tools/list` produced **8278** `/access` frames on `cg-hooks`. Every one:

```
access | dana.okafor@… | Approvals.Decide            | allow | reason "No rule matched."
access | dana.okafor@… | Approvals.RequestApproval   | allow
access | dana.okafor@… | Loan.ApproveLoan            | allow
access | dana.okafor@… | Loan.DenyLoan               | allow
access | dana.okafor@… | Loan.GetLoan                | allow
access | dana.okafor@… | Loan.SearchLoans            | allow
access | dana.okafor@… | AirtableApi.AddBaseCollaborator | deny
…8272 more, all deny, all the same user_id
```

Exact and lowercase, no exceptions. **No `/pre` frame for a loan tool was produced by
this spike at any point**, because the tool never executed and a layer-2 refusal fires
no hook.

### 11.4 Hop 2 with no custom verifier: Arcade's account wall

15:29:21Z. `Loan_GetLoan` returns `isError: true` with a JSON text block
`{authorization_url, llm_instructions, message}` — *"The tool was not executed because
it requires authorization."* Walking it with hop 1's cookie jar:

```
GET  cg-idp-or5b.onrender.com/oauth2/authorize?client_id=RskTFjl6…&scope=openid+email
       &redirect_uri=…%2Fapi%2Fv1%2Foauth%2Ff4c6b_ap_GvSAhPpynQRj%2Fcallback
302 → cloud.arcade.dev/api/v1/oauth/f4c6b_ap_GvSAhPpynQRj/callback?code=<redacted>&…
303 → cloud.arcade.dev/api/v1/oauth/callback_verify?flow_id=<redacted>
303 → auth.arcade.dev/self-service/login/browser
303 → account.arcade.dev/login          ← stopped here, typed nothing
```

`account.arcade.dev/login` is a form with **no password field**: one control, `provider`,
offering `github-…`, `google-…`, `microsoft-…`. An earlier revision of the guard only
refused password forms, submitted this one, and ended up on
`login.microsoftonline.com`'s sign-in page — no credential was typed and the chain
stopped there, but cookies for that host appear in one transcript and this is why. The
rule is now: on a host we did not name, the form must offer an explicit yes/no consent
decision, and an identity-provider chooser is not one.

### 11.5 Hop 2 with the verifier saved: Arcade calls it

16:47:01Z, flow `<dana-flow-1>`:

```
302 GET  cg-idp-or5b.onrender.com/oauth2/authorize
303 GET  cloud.arcade.dev/api/v1/oauth/f4c6b_ap_GvSAhPpynQRj/callback
303 GET  <tunnel>/verify?flow_id=<dana-flow-1>          ← OURS
302 GET  cg-idp-or5b.onrender.com/oauth2/authorize   ← the verifier's own leg, SILENT
303 GET  <tunnel>/callback
200 GET  cloud.arcade.dev/api/v1/oauth/callback_success
```

`callback_verify` and `account.arcade.dev` are gone. The verifier's own log for the
same flow:

```
[verifier] GET /verify — Arcade sent 1 parameter(s) {"flow_id":"<dana-flow-1>"}
[verifier] 303 to the IdP for flow <dana-flow-1>
           {"issuer":"https://cg-idp-or5b.onrender.com",
            "redirect_uri":"<tunnel>/callback","scope":"openid email"}
[verifier] IdP token exchange, client_secret_basic -> 200
           {"access_token":"<redacted>","expires_in":3600,"token_type":"Bearer",
            "scope":"openid email","id_token":"<redacted>"}
[verifier] IdP /oauth2/userinfo -> 200
           {"sub":"9d8c2228-039e-4dac-87a8-f210fd3e31e8","email":"dana.okafor@…"}
[verifier] POST confirm_user -> 200
           {"auth_id":"ar_3JBpvQoFcPv8Pyb1mgAuz5smr8B",
            "next_uri":"https://cloud.arcade.dev/api/v1/oauth/callback_success"}
[verifier] 303 to Arcade's next_uri
```

**One parameter.** `flow_id` and nothing else. **A silent IdP leg** — line 4 is a bare
302, so the persona is not asked to log in again. **`confirm_user` 200, not
`user_mismatch`**, for the address our own IdP put on `/oauth2/userinfo`.

### 11.6 `confirm_user` by hand is unreliable

Two attempts, same shape, same persona, same roughly-8-minute delay:

```
flow 4bb88623-…  -> 200 {"auth_id":"ar_3JBhPrH06i8jjUEt4lzSCawNVLR",
                         "next_uri":"https://cloud.arcade.dev/api/v1/oauth/callback_success"}
flow b56507af-…  -> 400 {"code":400,"msg":"Bad request","data":null}
```

The 400 carries no `error` field, so it is not the documented `user_mismatch`; and
`b56507af` was not unknown to Arcade, which kept handing back that same id on fresh
tool calls twenty minutes later. Reading, labelled an inference: Arcade accepts
`confirm_user` only while the flow is awaiting verification, and that window is
narrower than a human's turnaround.

Two related measurements:

- `confirm_user` **401s on the key before it reads the body** — an unset
  `$ARCADE_API_KEY` in the shell returned `{"code":401,"msg":"Unauthorized"}`.
- **Arcade does not finalise the grant until something fetches `next_uri`.** The 200
  above left the tool unauthorized, because the browser had already given up: the
  verifier used to park the browser on the request, and Bun caps `idleTimeout` at
  255s. Both fixed — the verifier answers immediately and `POST /confirm` follows
  `next_uri` server-side — and the whole problem disappears when the verifier holds
  the key, which is the production shape.

### 11.7 Why the tool still does not execute: three causes, in sequence

Every line below is from `apps/idp`'s request log, which #61 added and which is the
only reason any of this was diagnosable.

**Cause 1 — the provider sent `client_secret_post` to a `client_secret_basic` client.**

```
2026-09-11T16:35:45.537Z [idp] POST /oauth2/token rejected: status=400
  error=invalid_grant error_description="invalid code"
  client_auth="client_secret_post" client_id=RskTFjl6AqkUO8FKYWjpDCLd139YE36F
```

Not the verifier — the verifier is in the same window sending `client_secret_basic`
and getting 200. The `invalid_grant` is in front of the method problem because the
IdP validates the code before the client.

The dashboard, meanwhile, showed an Authentication Method dropdown reading *"Client
Secret Basic"*, greyed out, tooltip *"Currently, client secret basic is the only
supported authentication method."* The actual mechanism was Request Parameters rows
carrying `client_id={{client_id}}` and `client_secret={{client_secret}}` on both Token
Settings and Refresh Token Settings, left over from the #13 sitting's template.

**Cause 2 — with those rows removed, the provider sent nothing.**

```
2026-09-11T16:48:41.847Z [idp] POST /oauth2/token rejected: status=400
  error=invalid_request error_description="client_id is required"
  client_auth="absent" client_id=(not the registered client)
```

The greyed label does not produce a Basic header. Credentials only ever travelled in
the parameter rows.

**Cause 3 — the recreated provider's Client ID held a URL.**

```
302 GET https://cg-idp-or5b.onrender.com/oauth2/authorize
          ?client_id=https%3A%2F%2Fcg-idp-or5b.onrender.com%2Foauth2%2Ftoken&…
302 → https://cg-idp-or5b.onrender.com/error
        ?error=invalid_client&error_description=client_id+is+required
```

Hop 2 now fails at our *authorize* endpoint, one step earlier than before.

Two of my own failures belong in this list, for symmetry:

```
15:57:10Z  client_auth="client_secret_post"    -> my verifier, before it learned to read
                                                  the method off the IdP's /health
16:19:02Z  invalid_grant "invalid code"
           client_auth="client_secret_basic"   -> my walker replaying a spent code
```

Single-use codes behaving exactly as they should; the client was wrong, not the server.

### 11.8 The provider's stored configuration, read back

`evidence/05-auth-provider-config.ts`, GETs only, secrets scrubbed before printing.

**Created 2026-09-10** — no `auth_method` on the token request at all:

```json
"token_request": {
  "endpoint": "https://cg-idp-or5b.onrender.com/oauth2/token",
  "method": "POST",
  "params": { "grant_type": "authorization_code", "redirect_uri": "{{redirect_uri}}" },
  "request_content_type": "application/x-www-form-urlencoded",
  "response_content_type": "application/json"
},
"user_info_request": {
  "endpoint": "https://cg-idp-or5b.onrender.com/oauth2/userinfo",
  "method": "GET",
  "auth_method": "bearer_access_token",
  "response_map": { "email": "$.email", "name": "$.name", "sub": "$.sub" },
  "triggers": { "on_token_grant": true, "on_token_refresh": false }
},
"pkce": { "enabled": true, "code_challenge_method": "S256" },
"redirect_uri": "https://cloud.arcade.dev/api/v1/oauth/f4c6b_ap_GvSAhPpynQRj/callback",
"client_secret": { "binding": "project", "editable": true, "exists": true }
```

**Recreated 2026-09-11T16:55:22Z** — `auth_method` present:

```json
"token_request": {
  "endpoint": "https://cg-idp-or5b.onrender.com/oauth2/token",
  "method": "POST",
  "auth_method": "client_secret_basic",
  "params": { "client_id": "{{client_id}}", "client_secret": "<redacted>",
              "grant_type": "authorization_code", "redirect_uri": "{{redirect_uri}}" }
},
"client_id": "https://cg-idp-or5b.onrender.com/oauth2/token",
"redirect_uri": "https://cloud.arcade.dev/api/v1/oauth/f4c6b_ap_1cWxRQzV98W4/callback"
```

Note the callback path changed, so the URI allowlisted at the IdP had to change with
it — confirmed from outside before running anything:

```
ALLOWED   https://cloud.arcade.dev/api/v1/oauth/f4c6b_ap_1cWxRQzV98W4/callback
REJECTED  https://cloud.arcade.dev/api/v1/oauth/f4c6b_ap_GvSAhPpynQRj/callback   (old)
ALLOWED   https://cloud.arcade.dev/oauth2/intermediate_callback                  (User Source)
ALLOWED   <tunnel>/callback                                                      (verifier)
```

### 11.9 Operational notes worth keeping

- **`ngrok` must not be a child of the verifier.** It was, at first; restarting the
  verifier tore the endpoint down (`ERR_NGROK_3200`), the free-tier hostname changed,
  and a human had to re-paste a dashboard field. Running `ngrok` as its own process and
  giving the verifier `PORT` and `VERIFIER_PUBLIC_URL` makes a restart free. Verified:
  the verifier was restarted three times afterwards on one tunnel.
- **Credentials are read per flow, not at startup**, so the tunnel can exist before the
  human writes `.env.local` and no restart is needed afterwards.
- **A placeholder is worse than an absence.** The credentials file arrived with the
  angle-bracket prompts still in it, and the verifier forwarded
  `client_id=<the cg-idp client id>` to our IdP, which answered *"client_id is
  required"* — a failure that reads as the counterparty's. The verifier now refuses
  placeholder-shaped values by shape, and defaults the client id from the IdP's own
  `/health`, which publishes it.

```console
$ git check-ignore -v docs/spikes/evidence/.env.local
.gitignore:14:.env.local	docs/spikes/evidence/.env.local
```

### 11.10 After the Client ID was corrected — two runs, 17:37Z and 17:38Z

Config re-read first, at 17:37:06Z:

```json
"client_id": "RskTFjl6AqkUO8FKYWjpDCLd139YE36F"
```

**Dana, 17:37:14Z — not a valid test of the fix.** Arcade handed back the *same*
`authorization_url` as the 16:59Z run — byte-identical `state` and `code_challenge`,
both written `<dana-flow-2>` and `<redacted>` here — and the old bad
`client_id=https%3A%2F%2F…%2Foauth2%2Ftoken` still baked into it. **The identity of the
two values is the finding; neither value is.**

```
302 GET https://cg-idp-or5b.onrender.com/oauth2/authorize?client_id=https%3A%2F%2F…%2Foauth2%2Ftoken&…
302 → https://cg-idp-or5b.onrender.com/error?error=invalid_client&error_description=client_id+is+required
```

**Arcade caches a pending authorization flow, `authorization_url` included**, so a
provider edit does not reach a flow already minted. A #24 note: after changing a
provider, existing pending flows are stale and keep failing with the old configuration.

**Sam, 17:38:46Z — a fresh flow, so a clean test, and it doubles as H2-d.**

```
GET  cg-idp-or5b/oauth2/authorize?client_id=RskTFjl6AqkUO8FKYWjpDCLd139YE36F
       &redirect_uri=…%2Fapi%2Fv1%2Foauth%2Ff4c6b_ap_1cWxRQzV98W4%2Fcallback
       &scope=openid+email&state=<sam-flow>            (PKCE S256)
302 → cloud.arcade.dev/api/v1/oauth/f4c6b_ap_1cWxRQzV98W4/callback?code=<redacted>&…
303 → <tunnel>/verify?flow_id=<sam-flow>
303 → cg-idp-or5b/oauth2/authorize
302 → <tunnel>/callback?code=<redacted>&…               ← SILENT, hop 1's session reused
303 → cloud.arcade.dev/api/v1/oauth/callback_success
200   callback_success
```

```
[verifier] GET /verify — Arcade sent 1 parameter(s) {"flow_id":"<sam-flow>"}
[verifier] IdP token exchange, client_secret_basic -> 200
[verifier] IdP /oauth2/userinfo -> 200
           {"sub":"25bb917b-4a90-4b9f-a18a-e9550b9f3275","email":"sam.reyes@…"}
[verifier] POST confirm_user -> 200
           {"auth_id":"ar_3JBxbZokKhznJwgMtAn5R0XfygV","next_uri":".../callback_success"}
```

Sam's `sub` (`25bb917b-…`) is **different** from Dana's (`9d8c2228-…`) and each email is
the right one, so the verifier binds two distinct personas correctly. 8280 `/access`
frames on that run, every one `sam.reyes@…` lowercase.

`Loan_SearchLoans` retried immediately afterwards still returns `isError: true` with a
new `authorization_url`.

**So the grant does not store even with a correct Client ID, a correct secret, an
`auth_method` of `client_secret_basic`, a fresh flow and a complete verification.** The
one step not visible from outside is Arcade's own token exchange at our IdP. For whoever
picks this up: the window is **2026-09-11T17:38:50Z to 17:40:00Z** on `cg-idp`, and the
line to find is a `POST /oauth2/token` for client `RskTFjl6…` that is *not* the
verifier's own 200. Its status says which cause: `401` a method our client refuses, `400
invalid client_secret` a pre-rotation secret on the provider, `400 invalid code` a code
our IdP does not recognise, and **no line at all** means Arcade never attempted it.
