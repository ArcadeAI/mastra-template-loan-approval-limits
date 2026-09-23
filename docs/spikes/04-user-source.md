# Spike 04 — can `apps/idp` back an Arcade User Source, so one login opens the gateway and the loan tools?

**Answer: `apps/idp` is now capable of it, and the gateway `cg-demo-us` does not use it.**

> ⚠️ **Read [the addendum](#addendum-2026-09-11) first.** That answer was true when
> it was measured and is now out of date: the gateway began redirecting to `cg-idp`
> later the same day, hop 1 completes, and the recommendation below is superseded.
> Nothing above the addendum has been rewritten, on purpose.

Two separate findings, both measured on 2026-09-11 and both in this document. The
first came out of the human's dashboard sitting earlier in the day, before #70;
the second is from the AFK measurement after it:

1. **`apps/idp` could not back a User Source as it stood, and now can.** The Arcade
   dashboard refused the issuer with *"OIDC discovery document does not include a
   `jwks_uri`"*. That was fixed for real on [#70](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/70)
   (merged `0c1cdab`): the live discovery document now publishes `jwks_uri` and
   `id_token_signing_alg_values_supported: ["RS256"]`, and the human created a
   User Source `cg-idp` against it.
2. **An MCP client connecting to `cg-demo-us` is still sent to Arcade's own
   account login, not to `cg-idp`.** Every hop of the authorization chain is
   identical to the members-mode gateway `cg-demo`. No persona ever sees
   `cg-idp-or5b.onrender.com`. Measured twice: before the human recreated the
   gateway, and after, once the gateway's protected-resource document began
   advertising `urn:arcade:oauth:user_source_id`. The attachment is real and does
   not change the login. So questions 2 and 3 could not be measured, and they are
   marked unverified rather than guessed.

**Recommendation for [#14](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/14): keep going with the User Source, backed by a
custom user verifier against `apps/idp`; fall back to every persona being an Arcade
project member.** Reasoning in [the last section](#recommendation-for-14), including
the option this spike originally recommended and why it is off the table.

Resolves [#65](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/65).
Feeds the #14 gate. Raw transcripts, redacted, in
[`evidence/04-user-source-transcript.md`](evidence/04-user-source-transcript.md);
the two scripts that produced them are
[`evidence/04-user-source-flow.ts`](evidence/04-user-source-flow.ts) and
[`evidence/04-mastra-authprovider.ts`](evidence/04-mastra-authprovider.ts).

**Reproduced.** Run against the live services on 2026-09-11, headlessly, as Dana,
twice: once against the original `cg-demo-us` and once after the human recreated
it.

## Setup

| | |
|---|---|
| IdP | `https://cg-idp-or5b.onrender.com` — `apps/idp` on Render, after #70 |
| User Source | `cg-idp`: issuer as above, subject claim `email`, scopes `openid profile email` |
| Gateway under test | `cg-demo-us` → `https://api.arcade.dev/mcp/cg-demo-us`, six tools (`Loan_*`, `Approvals_*`), created in User Source mode, then recreated mid-spike when the first one turned out not to be using the source |
| Control gateway | `cg-demo` → `https://api.arcade.dev/mcp/cg-demo`, "Members of this Project" mode |
| Control plane | `https://cg-hooks.onrender.com/events`, unauthenticated SSE, `last-event-id: 0` replays (#62) |
| Persona | Dana Okafor, password from `apps/idp/src/fixtures/people.json`; the address lives only in Render env vars |
| Client | two: raw `fetch` with a cookie jar, and `@mastra/mcp@1.17.3` |

No browser was used and no credential was provisioned. `apps/idp`'s login and
consent pages are server-rendered HTML forms, so a cookie jar and a regex form
parser are a sufficient user agent.

## How this was answered

`evidence/04-user-source-flow.ts` walks the MCP authorization spec end to end:

1. `POST` an `initialize` with no `Authorization` header, read `WWW-Authenticate`.
2. Fetch the protected-resource metadata it names, then the authorization server
   metadata that names.
3. Bind a loopback port (port 0, read back — never a guessed port), register a
   throwaway public client on it by dynamic client registration.
4. `GET /oauth2/authorize` with PKCE and follow every redirect by hand, filling in
   whatever forms appear.
5. Exchange the code, then `initialize`, `tools/list`, `tools/call Loan_GetLoan`.
6. Replay `/events` and print the `user_id` on the `/pre` frame.

The script carries one deliberate guard: **it will not type a persona's password
into a host that is not the configured issuer.** It stops, names the host that
served the page, and exits non-zero. That guard is what fired.

## Question 1 — does Arcade accept `apps/idp` as a User Source at all?

**Measured. No as `apps/idp` stood; yes after #70.**

The dashboard's refusal, quoted exactly:

> OIDC discovery document does not include a `jwks_uri`.

Measured against the discovery document at the time: `jwks_uri: null`,
`id_token_signing_alg_values_supported: ["HS256"]`. Arcade validates the ID token
against a JWKS, so an IdP that publishes no keys cannot back a User Source. There
is no symmetric-secret path around it.

**Why `apps/idp` had no JWKS**, and what the fix cost. This is the part worth
keeping, because a forker will hit the same trade. `apps/idp` set
`disableJwtPlugin: true` so that Better Auth would store the OAuth **client secret
encrypted**, which is what let `bun run oauth-client` re-print it. Better Auth only
permits encrypted client-secret storage with the JWT plugin off. Turning the plugin
on buys RS256 ID tokens and a `jwks_uri`, and costs:

- **hashed client-secret storage.** The secret is visible exactly once, at
  creation. That changed the operational story in `apps/idp/README.md`, the reset
  contract, and #61.
- **a client rotation on the live instance.** A new client row, so the `cg-idp`
  auth provider registered in Arcade has to be re-registered with the new secret.
  #70 handles the existing encrypted row explicitly and says in the boot log
  whether the client rotated.

Both were accepted by the human and shipped on #70. The live discovery document now
reads:

```json
{ "issuer": "https://cg-idp-or5b.onrender.com",
  "jwks_uri": "https://cg-idp-or5b.onrender.com/jwks",
  "id_token_signing_alg_values_supported": ["RS256"],
  "code_challenge_methods_supported": ["S256"],
  "claims_supported": ["sub","iss","aud","exp","iat","sid","scope","azp","name",
                       "picture","given_name","family_name","email","email_verified"] }
```

with one RS256 key at `/jwks`, `kid` `MNIE6RdQNKHOzcq78K6SbkXcEPB7MAfM`. The User
Source `cg-idp` was then created against it without complaint. **Arcade accepting
the issuer is therefore settled.** What follows is about whether a gateway then
uses it.

## Question 2 — does an MCP client complete the flow headlessly, and what `user_id` lands on `/pre`?

**Unverified, and blocked on Arcade-side configuration rather than on anything in
this repo.** The persona is never sent to `cg-idp`, so there is no ID token, no
subject claim, no tool call and no `/pre` frame to read a `user_id` off.

What was measured is the chain itself. `initialize` with no token:

```
HTTP/2 401
www-authenticate: Bearer resource_metadata="https://api.arcade.dev/.well-known/oauth-protected-resource/mcp/cg-demo-us", scope="mcp", error="invalid_token"

{"name":"invalid_authorization","message":"Missing Authorization header"}
```

That metadata document, and the authorization server it names:

```json
{"resource":"https://api.arcade.dev/mcp/cg-demo-us",
 "authorization_servers":["https://cloud.arcade.dev/oauth2"],
 "bearer_methods_supported":["header"],"scopes_supported":["mcp"],
 "resource_name":"contextual-governance (user source)",
 "urn:arcade:oauth:user_source_id":"us_3JA8GcvHfT17WNnnRazx6FZpxeg"}
```

That last field is the single most useful thing this spike found, and it was not
there on the first pass. See [the second pass](#the-second-pass-the-attachment-is-real-and-changes-nothing)
below: `urn:arcade:oauth:user_source_id` in a gateway's protected-resource
document is how anyone can tell from outside the dashboard whether a User Source
is attached. `cg-demo`, in members mode, has no such field.

Dynamic client registration at `https://cloud.arcade.dev/oauth2/register` succeeds
and returns a public client (`token_endpoint_auth_method: "none"`, no secret), so
**a server process can register itself with Arcade without a human or a dashboard
visit.** That is genuinely useful, and it is the one part of the flow that came
out better than I expected.

Then `GET /oauth2/authorize`:

```
302 https://cloud.arcade.dev/oauth2/authorize
 -> https://auth.arcade.dev/oauth2/auth
      ?client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812
      &redirect_uri=https%3A%2F%2Fcloud.arcade.dev%2Foauth2%2Fintermediate_callback
      &scope=openid+profile+email
302 -> https://auth.arcade.dev/ui/login?login_challenge=…
303 -> https://auth.arcade.dev/self-service/login/browser?…
303 -> https://account.arcade.dev/login?flow=…
200    a login page served by account.arcade.dev
```

The shape is right and the host is wrong. `.../oauth2/intermediate_callback` is
exactly the redirect URI Arcade's User Source documentation names, so
`cloud.arcade.dev/oauth2` really is brokering to an upstream OIDC provider. The
upstream it picked is Arcade's own Ory/Hydra deployment, not
`cg-idp-or5b.onrender.com`.

Three checks that rule out the obvious alternative explanations:

- **It is not the `resource` parameter.** Dropping `resource` entirely produces a
  byte-identical first redirect.
- **It is not this gateway.** The members-mode gateway `cg-demo` produces the same
  five hops to the same login page. The two gateways are indistinguishable from a
  client's side; only `resource_name` differs.
- **It is not an unrendered "choose your IdP" step.** The Kratos flow behind that
  page offers *Work email*, GitHub, Google and Microsoft, and nothing else.
  Submitting `identifier=dana.okafor@…` with `method=identifier_first` returns an
  Arcade **password** form: Arcade resolves the persona as one of its own project
  members and never offers `cg-idp`.

On the first pass this left two explanations that looked identical from outside
the dashboard: the User Source was not attached to `cg-demo-us`, or Arcade's
broker wanted something the MCP authorization spec does not carry. The human then
confirmed the gateway had not been using the User Source at all and recreated it,
which is what the second pass measures.

### The second pass: the attachment is real and changes nothing

After the gateway was recreated, on the same day:

**The attachment is now published.** The protected-resource document gained
`"urn:arcade:oauth:user_source_id":"us_3JA8GcvHfT17WNnnRazx6FZpxeg"`. It was
absent before, and `cg-demo` does not have it. The gateway knows which User Source
it belongs to, and says so to any client that asks.

**Arcade reads the `resource` parameter and fetches that document.** Point
`resource` at a gateway that does not exist and the authorize endpoint redirects
straight back with an error rather than to any login:

```
302 http://localhost:…/callback
  ?error=server_error
  &iss=https%3A%2F%2Fcloud.arcade.dev%2Foauth2
  &error_description=Could+not+retrieve+protected+resource+metadata+for+the+gateway.
    +Verify+that+the+gateway+is+reachable+and+configured+correctly.
  &state=p
```

So the broker resolves the gateway, retrieves metadata that names the User Source,
and then sends the persona to Arcade's own IdP anyway. `cg-demo-us` and `cg-demo`
produce the identical upstream `client_id`:

```
https://api.arcade.dev/mcp/cg-demo-us         302 -> auth.arcade.dev/oauth2/auth  upstream client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812
https://api.arcade.dev/mcp/cg-demo            302 -> auth.arcade.dev/oauth2/auth  upstream client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812
https://api.arcade.dev/mcp/does-not-exist-65  302 -> localhost:64998/callback      upstream client_id=null
https://example.com/nope                      302 -> localhost:64998/callback      upstream client_id=null
```

**Nothing the client can send changes the upstream.** Ten authorize parameters
were tried, in case a client is expected to name the source it wants. All ten
produced the same 302 to `auth.arcade.dev/oauth2/auth`:

```
(baseline, resource only)              302 -> auth.arcade.dev/oauth2/auth
user_source_id                         302 -> auth.arcade.dev/oauth2/auth
user_source                            302 -> auth.arcade.dev/oauth2/auth
urn:arcade:oauth:user_source_id        302 -> auth.arcade.dev/oauth2/auth
connection                             302 -> auth.arcade.dev/oauth2/auth
idp_hint                               302 -> auth.arcade.dev/oauth2/auth
kc_idp_hint                            302 -> auth.arcade.dev/oauth2/auth
login_hint                             302 -> auth.arcade.dev/oauth2/auth
user_source_id=cg-idp (name not id)    302 -> auth.arcade.dev/oauth2/auth
audience                               302 -> auth.arcade.dev/oauth2/auth
```

Two candidates survive, and I cannot separate them from outside the dashboard:

- **(A) Arcade's broker does not consult the gateway's `user_source_id` at the
  authorize step.** That would be a platform bug, and nothing we configure fixes
  it.
- **(B) The `cg-idp` User Source record fails validation at authorize time and
  Arcade falls back to its own IdP silently rather than erroring.** The likeliest
  cause is a stale client secret: #70 rotated the OAuth client on the live IdP, so
  a secret entered before that rotation is now wrong.

**(B) is the cheap one to rule out**, and it should be ruled out first: re-enter
the User Source's client id and secret from the current post-#70 client, whatever
`bun run oauth-client` prints on the live instance, and save. Then re-run
`evidence/04-user-source-flow.ts`. If the chain reaches `cg-idp-or5b.onrender.com`
it prints the `/pre` `user_id` and questions 2 and 3 are answered in about two
minutes. If it still lands on `account.arcade.dev`, this is (A) and it is Arcade's
to fix, not ours.

A silent fallback would be worth naming out loud either way, because it is this
project's own recurring failure mode wearing someone else's clothes: a control
that appears configured, reports itself configured in its own metadata, and
quietly does nothing. A gateway that fell back to Arcade's own accounts would
still hand the hooks a plausible `user_id` and the panel would look right.

**What "unverified" costs, concretely:** the exact string and case of `user_id` on
the `/pre` payload under a User Source is unknown. The subject claim is configured
as `email`, and #58 made every holder in `idp.db` and `governance.db` lowercase, so
lowercase `dana.okafor@…` is the expectation. It is only an expectation, and
DESIGN.md's open risk 4 is exactly that identity can split silently. Do not build
#14 on it unmeasured.

## Question 3 — does the tool's own OAuth need a second consent?

**Unverified, for the same reason**, and the shape of the answer is already clear
enough to plan #14 around. The thing to get straight first is that there are two
separate hops, configured in two separate places, and this spike only ever
reached the first.

### Hop 1 — gateway access, the User Source

Who is allowed to open an MCP session on `cg-demo-us` at all, and what
`context.user_id` the hooks then see. Configured on the **gateway**: user
authentication mode set to User Source, with `cg-idp` attached, and the subject
claim `email` deciding the string. This is the hop every measurement in question 2
is about, and it is the one that never reaches `cg-idp`.

### Hop 2 — tool authorization, the user verifier

Whether *this* persona holds a credential for the loan tools, which is layer 2 in
DESIGN.md's table, upstream of `/pre` and invisible to the control plane.
Configured on the **tool**: `tools/loan/loan/__init__.py:56-64` declares
`OAuth2(id="cg-idp", scopes=…)` on all four loan tools. That `cg-idp` is an Arcade
**auth provider**, a separate registration from the **User Source** of the same
name, pointed at the same IdP. Configuring one does not configure the other.

The part a #14 reader needs and that is easy to miss: hop 2 has its own notion of
*which user is authorizing*, and Arcade's default for it is **"sign in to a
project account"** — the persona proves who they are to Arcade before Arcade
starts the tool's OAuth flow. A custom **user verifier** against `apps/idp` is
what would replace that default, so that hop 2 identifies the persona from our IdP
rather than from an Arcade account. Left on the default, hop 2 reintroduces the
Arcade-account login that hop 1's User Source was meant to remove, and "one
identity, not two" ends up with two front doors.

### What that means for the round-trip count

The best case is not one browser round trip. It is two authorizations against one
login: hop 1 sends the persona to `cg-idp` and leaves a session cookie there, then
hop 2 sends them to `cg-idp` again, where that cookie should make the second pass
consent-only or silent. Whether Better Auth's consent page is skipped on the
second pass for an already-consented client is exactly the number #65 asked for,
and it was not measured. Recorded as **unverified: expected 2 authorizations and 1
credential prompt, unmeasured** — and that estimate assumes hop 2 runs against a
user verifier pointed at `apps/idp`. On Arcade's default it is 2 authorizations
across 2 different identity providers, which is a worse answer and a different
demo.

## Question 4 — can Mastra's `MCPClient` drive this from a server with no browser?

**Measured, and the answer has two halves.**

Against `@mastra/mcp@1.17.3`:

**No, not `MCPClient.authenticate()` from a hosted route handler.** Given a provider
whose `redirectUrl` is the HTTPS callback a Render-hosted `apps/web` would use, it
refuses before touching the network:

```
threw: Cannot authenticate MCP server arcade: the provider's redirect URL must be
a loopback address, got https://cg-web-sa31.onrender.com.
```

`authenticate()` is built for a CLI. It binds a loopback port itself and waits for
a browser to hit it. `apps/web` on Render cannot use it. The library's own reference says as much, *"Hosts with custom redirect handling
(e.g. a web app with an HTTPS redirect URL) should drive `MCPOAuthClientProvider`
directly instead"*, and the error above is that sentence enforced.

**Yes to everything up to the human hop.** With a loopback redirect URL,
`authenticate()`:

- runs discovery and dynamic client registration against Arcade unattended, a
  fresh `client_id` each run, no dashboard step;
- hands the fully-formed authorization URL to `onRedirectToAuthorization`, PKCE
  challenge and `resource` included:

  ```
  https://cloud.arcade.dev/oauth2/authorize?response_type=code
    &client_id=db8ae1b0-ee87-40bb-b737-2131b896bae8
    &code_challenge=…&code_challenge_method=S256
    &redirect_uri=http%3A%2F%2Flocalhost%3A62287%2Foauth%2Fcallback
    &state=…&scope=mcp+offline_access&prompt=consent
    &resource=https%3A%2F%2Fapi.arcade.dev%2Fmcp%2Fcg-demo-us
  ```

- binds that loopback port and blocks until a code arrives.

The server process can start the flow and finish it. It cannot be the user agent
in the middle. In `apps/web` the workable arrangement is to drive `MCPOAuthClientProvider`
directly, redirect the persona's own browser to that URL, take the code on a route
handler at an HTTPS callback, and hand it back to the provider. That is ordinary web OAuth, and it is the only supported shape for a
hosted app.

**One behaviour #14 must not inherit.** Before authorization, `listTools()` returns `{}`, an empty object rather than a
throw, while `getServerAuthState('arcade')` returns `"needs-auth"`. The library logs the 401 and carries on. An agent wired up naively
would simply have no tools and would explain to the user, plausibly and wrongly,
that it cannot help. This is the same failure class DESIGN.md names for policy rules, silence that
reads as permission. **#14 must check `getServerAuthState`
rather than trusting an empty tool list.**

## Findings

| # | Question | Verdict | Value |
|---|---|---|---|
| 1 | Arcade accepts `apps/idp` as a User Source | **measured** | No with HS256 / no JWKS: *"OIDC discovery document does not include a `jwks_uri`"*. Yes after #70, with `jwks_uri` published, RS256, one key |
| 1a | Cost of the fix | **measured** | JWT plugin on means the client secret is hashed, printed once, and the live OAuth client rotates. Shipped on #70 |
| 2 | Headless MCP client completes the flow as Dana | **unverified** | The chain never reaches `cg-idp`; it lands on `account.arcade.dev`, before and after the gateway was recreated |
| 2a | `user_id` on the `/pre` payload | **unverified** | No `/pre` frame produced. Expected lowercase `dana.okafor@…` from subject claim `email` + #58 |
| 2b | Dynamic client registration against Arcade | **measured** | Works unattended; public client, no secret, no dashboard step |
| 2c | `cg-demo-us` vs `cg-demo` authorization chain | **measured** | Identical hop for hop, down to the upstream `client_id` `4eabdfa1-482e-4296-ba72-ba5fde2a3812` |
| 2e | How to tell a User Source is attached, from outside the dashboard | **measured** | `urn:arcade:oauth:user_source_id` in the gateway's protected-resource document. `us_3JA8GcvHfT17WNnnRazx6FZpxeg` on `cg-demo-us`, absent on `cg-demo` |
| 2f | Arcade reads the `resource` parameter | **measured** | An unknown gateway returns `error=server_error`, *"Could not retrieve protected resource metadata for the gateway"* |
| 2g | A client can name which User Source it wants | **measured** | No. Ten parameters tried (`user_source_id`, `user_source`, `urn:arcade:oauth:user_source_id`, `connection`, `idp_hint`, `kc_idp_hint`, `login_hint`, `audience`, the source's name, and none at all); identical 302 every time |
| 2d | Arcade offers `cg-idp` at its login | **measured** | No. Work email / GitHub / Google / Microsoft; the persona resolves to an Arcade password form |
| 3 | Second consent for the tool's OAuth | **unverified** | Blocked. Tools declare `OAuth2(id="cg-idp")`; Arcade documents gateway and tool auth as separate, so expect 2 authorizations against 1 IdP session |
| 3a | Hop 1 and hop 2 are configured in different places | **measured, from configuration** | Hop 1 is the gateway's User Source with subject claim `email`; hop 2 is `OAuth2(id="cg-idp")` on the tool, whose own identity default is Arcade's "sign in to a project account". A custom user verifier against `apps/idp` is what replaces that default (#75) |
| 4 | `MCPClient.authenticate()` from a hosted route handler | **measured** | Refused: *"the provider's redirect URL must be a loopback address"* |
| 4a | `MCPOAuthClientProvider` from a server process | **measured** | Works up to the browser hop: discovery, DCR, PKCE, authorization URL emitted, loopback bound |
| 4b | Unauthenticated `listTools()` | **measured** | Returns `{}` and logs; `getServerAuthState` returns `"needs-auth"` |

## Confidence

| Claim | |
|---|---|
| Arcade refuses an issuer with no `jwks_uri` | ✅ the dashboard's own error text |
| `apps/idp` now publishes `jwks_uri` and RS256 | ✅ live discovery document and `/jwks` |
| `cg-demo-us` sends the persona to `account.arcade.dev`, not `cg-idp` | ✅ five hops, two independent clients, and again after the gateway was recreated |
| The User Source is genuinely attached to `cg-demo-us` | ✅ `urn:arcade:oauth:user_source_id` published on that gateway and absent on `cg-demo` |
| Arcade resolves the gateway from `resource` before choosing an upstream | ✅ the unknown-gateway error |
| No client-supplied parameter selects the User Source | ✅ ten tried, all identical |
| Not caused by the `resource` parameter | ✅ identical redirect with it dropped |
| Not a gateway-specific quirk | ✅ `cg-demo` produces the same chain |
| No `cg-idp` option hidden in Arcade's login UI | ✅ Kratos flow nodes enumerated; identifier-first returns a password form |
| Arcade DCR works unattended | ✅ 201 with a `client_id`, twice, from two clients |
| `authenticate()` rejects a non-loopback redirect URL | ✅ exact error text |
| `listTools()` is empty rather than throwing when unauthorized | ✅ `[]` alongside `"needs-auth"` |
| **Why** `cg-demo-us` does not broker to `cg-idp` | ⬜ **narrowed to two, not determined.** Either Arcade's broker ignores the gateway's `user_source_id` at the authorize step (a platform bug), or the `cg-idp` User Source record fails validation there and Arcade falls back silently, most likely on a client secret predating #70's rotation. Separating them needs the dashboard or an Arcade API key |
| `user_id` on `/pre` under a User Source | ⬜ **not measured.** Expectation only |
| Round trips on a persona's first use | ⬜ **not measured.** Expectation only, from Arcade's documentation, and it assumes hop 2 runs against a user verifier pointed at `apps/idp` rather than Arcade's default |
| That a custom user verifier is what makes hop 2 use `apps/idp` | ⬜ **not measured here.** Read off Arcade's tool-authorization configuration, not from a run; #75 measures it |
| Whether `MCPOAuthClientProvider` completes against Arcade end to end | ⬜ **not measured.** Everything up to the browser hop was; the hop itself needs a login this spike could not reach |

## Recommendation for #14

**Stay with the User Source and make hop 2 match it: a custom user verifier
against `apps/idp`. If that does not land, fall back to every persona being an
Arcade project member, which is how `cg-demo` runs today.** The reason to keep
going rather than route around it is that the two failures this spike hit are both
configuration, not architecture: `apps/idp` satisfies everything Arcade asks of an
issuer after #70, the source is demonstrably attached to `cg-demo-us`, and the one
remaining unknown is why the broker does not act on it. That is a two-minute
re-measure away for whoever can see the dashboard, and
[`evidence/04-user-source-flow.ts`](evidence/04-user-source-flow.ts) prints the
`/pre` `user_id` the moment the chain reaches `cg-idp-or5b.onrender.com`. Spike
[#75](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/75) is
measuring whether the custom user verifier is the missing piece, and question 3
above is why it matters: hop 2 on Arcade's default sends the persona to an Arcade
account login, so a User Source on hop 1 alone would still leave the demo with two
front doors. The fallback is unglamorous and it works: four Arcade member accounts
under the four persona addresses, the gateway in "Members of this Project" mode, and
`context.user_id` lands on exactly the same lowercase string, which is all DESIGN.md's
rule 3 asks. What #14 must carry either way is finding 4b — check
`getServerAuthState`, because an unauthorized `MCPClient` reports an empty tool list
rather than an error, and an agent that trusts it will explain, plausibly and
wrongly, that it cannot help.

### The option this spike recommended, and why it is rejected

Round 1 of this document recommended **(c) Arcade Headers**: an Arcade API key in
`Authorization` and the persona's email in `Arcade-User-ID`, which names the acting
persona per call from a route handler with no browser hop and, unlike the other two,
worked on the day. The human rejected it outright on 2026-09-11. The reason is not
that it fails a control: layer 2 would still gate it, because the loan tools declare
`OAuth2(id="cg-idp")`, so a forged `Arcade-User-ID` would get a governance decision
for a persona whose OAuth grant `apps/web` does not hold and the call would die
before reaching `apps/loan-app`, which derives its actor from the token and never
from a header. The reason is that **a backend asserting `user_id` in a header is not
the identity story this template exists to tell.** The deliverable is a forkable
template for a real multi-person production setting, and an enterprise audience that
sees `apps/web` naming the acting user has been handed the same question DESIGN.md
already refused about folding the IdP into `apps/web`: could the agent's host just
claim to be anyone? Recorded here so the next reader does not rediscover the
measurement and propose it again — the measurements stay, in the findings and
confidence tables; the recommendation does not.

## Follow-ups

- **#65 is answered; the Arcade side is not.** The attachment is confirmed, so what
  is left is candidate (B) above: re-enter the `cg-idp` User Source's client id and
  secret from the current post-#70 client and re-run the flow script. If that does
  not move the login to `cg-idp-or5b.onrender.com`, it is candidate (A) and belongs
  with Arcade. No repo change is proposed either way: `apps/idp` already does
  everything Arcade asks of a User Source issuer.
- **#14 must not trust an empty tool list.** Check `getServerAuthState` (finding
  4b).
- **The `cg-idp` name is overloaded three ways.** An Arcade *auth provider*
  (hop 2), an Arcade *User Source* (hop 1), and soon a *user verifier*, all
  carrying the same name, all pointed at the same IdP, each configured separately
  and doing a different job. Worth disambiguating in `.env.example` before any of
  them is wired, or a future reader will assume configuring one configures the
  others.
- **Hop 2's user verifier is #75's question.** Question 3 above explains why hop 2
  on Arcade's default "sign in to a project account" would undo hop 1's User
  Source. Whoever measures #75 should record the round-trip count question 3 could
  not.

## Addendum, 2026-09-11

Everything above this line is left as it was written. Three things changed after it
was written, and two of them contradict it. The corrections belong here rather than
upstairs, because what this spike measured on the day is the only reason anyone can
tell *when* Arcade's behaviour changed.

### 1. The gateway started redirecting to `cg-idp` while this PR was in review

The review verdict of **14:24Z** (labelled round 2) ran a no-credential DCR and PKCE
probe with the same `resource=https://api.arcade.dev/mcp/cg-demo-us` this document
uses, and got:

```
302 -> https://cg-idp-or5b.onrender.com/oauth2/authorize
   -> https://cg-idp-or5b.onrender.com/login
```

with the control gateway `cg-demo` still going to `https://auth.arcade.dev/oauth2/auth`.
That is the opposite of what question 2 above records, and the reviewer was right to
call the checked-in result stale.

**It is a live change on Arcade's side, not a measurement error here.** The window is
narrow and bounded by timestamps on this PR: the round-1 reply at **14:14Z** was
written against a chain that still ended at `account.arcade.dev`, and the verdict at
**14:24Z** found `cg-idp-or5b`. Whatever moved, moved inside those nine minutes.

What that settles, and what it does not:

- **Settled by observation.** As of **14:24Z** the User Source attached to
  `cg-demo-us` is honoured at authorize: the gateway brokers hop 1 to
  `cg-idp-or5b.onrender.com`, and `auth.arcade.dev` and `account.arcade.dev` are gone
  from the chain. `cg-demo` in members mode is unchanged.
- **Not explained.** *Why* it began to be honoured is unknown and on Arcade's side.
  Nothing of ours changed in that window: the driver comment on **#75 dated
  2026-09-11 14:41Z** records the human's answers that the custom verifier URL was
  **never saved** and the User Source was **not touched**, so the change was not
  caused by us, and it is recorded there as unexplained and Arcade-side between 14:15Z
  and 14:24Z. The comment on **#75 dated 2026-09-11 14:28Z** adds that the verifier
  tunnel received zero requests from Arcade, so even attributing it to the verifier
  was not separable from outside.

So the candidate-(A)-or-(B) framing above is **closed by observation rather than
answered**. Candidate (A), that Arcade's broker does not consult a gateway's
`user_source_id` at authorize, is not true of the live system as of 14:24Z, and the
#75 comment of 14:28Z says so in those terms. Whether it was true before 14:15Z, and
whether candidate (B) was ever the real cause, is not established either way and this
document should not be read as establishing it. **Do not cite (B) as the answer.**

The failure that remained at 14:24Z is a different thing and it *was* explained: the
chain reached our `/login` and `/consent` and then came back
`access_denied: Token exchange with identity provider failed`. That was the client
authentication-method mismatch — Arcade's OIDC client sends `client_secret_basic`
against a client registered `client_secret_post`, which Better Auth rejects before it
checks the secret — inferred at 14:41Z and fixed in code by **#61** (`aa98780`), then
measured working at **15:25Z**. See item 2 below.

**The committed evidence is not amended, and it should not be.** Every hop in
`evidence/04-user-source-transcript.md` is a true record of what the live services did
at the timestamp on it, and the ten-parameter negative, the `resource`-validation
error and `urn:arcade:oauth:user_source_id` are all still correct observations about
how the gateway advertises itself. A spike that quietly rewrites its own transcript to
match today's behaviour is worth nothing the next time something moves. Read sections
1 to 4 of the transcript as "before 14:15Z" and this addendum as "after".

### 2. Hop 1 completes, as of 15:25Z

Question 2 above is answered, elsewhere and by someone else. The driver comment on
**#61 dated 2026-09-11 15:32Z** records the live acceptance: after `aa98780` deployed,
the User Source token exchange against `cg-idp-or5b` returned **200** as Dana at
**15:25Z**. What had been failing was the token exchange specifically, from 14:24Z
onward once the chain started reaching our IdP at all, and its cause was the client
authentication method: `aa98780` registers the IdP's OAuth client
`client_secret_basic`. Spike 05 records that as measured rather than inferred —
inferred at 14:41Z, confirmed at 15:25Z by changing exactly that and nothing else. The
same #61 comment records that the `cg-idp` auth provider was already `client_secret_basic` in
the dashboard, so nothing had to change there and the #13 handoff's
"credentials in body" note was wrong about how Arcade stored it.

Hop 1 now does what DESIGN.md's "one identity, not two" asks for: Dana signs in at our
IdP, Arcade issues a gateway token, the tools list, and **every `/access` frame carries
her exact lowercase email**. The `user_id` string question 2 could not measure is
`dana.okafor@…`, lowercase, with no exceptions across the frames one `tools/list`
produced. Details, counts and raw hops are in
[`05-custom-verifier.md`](05-custom-verifier.md).

One thing that is still unmeasured and is easy to misread: `/access` carries it,
`/pre` has never fired for a loan tool. A layer-2 refusal fires no hook, which is
open risk 2 in DESIGN.md doing exactly what it says it does.

### 3. The recommendation above is superseded

Do not plan #14 from the *Recommendation for #14* section above. It was written while
hop 1 was broken, and it recommends a custom user verifier on the strength of that.

- **Hop 2** is settled by spike 05, merged as **`1c1ac4f`** (PR #77 for #75; see the
  driver comment on **#75 dated 2026-09-11 18:16Z**). Its own finding is that the
  custom verifier is not what moved hop 1 — the User Source was — so the verifier this
  document proposed is not the mechanism to build on.
- **What hop 2 actually needs** is issue **#79**: `apps/idp`'s token endpoint must
  tolerate Arcade's provider request shape, which presents credentials in a Basic
  header *and* in the body. Better Auth refuses that per RFC 6749 §2.3, and the
  human's decision, recorded on **#75 dated 2026-09-11 18:15Z**, is that Arcade's
  provider configuration is used as shipped and will not be hand-edited. So the change
  is ours, not the dashboard's.

What survives from this document is the measurement, not the plan: question 1 and its
cost, question 4 in full — `MCPClient.authenticate()` refusing a non-loopback redirect
URL, and an unauthorized `listTools()` returning an empty object rather than throwing,
which #14 still has to guard with `getServerAuthState` — and the discovery that
`urn:arcade:oauth:user_source_id` in a gateway's protected-resource document is how you
check an attachment without the dashboard.
