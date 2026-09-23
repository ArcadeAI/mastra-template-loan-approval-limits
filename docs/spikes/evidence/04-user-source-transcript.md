# Spike 04 — raw transcripts

Everything here is against the live services on **2026-09-11**, from the worktree
for issue #65. Sections 1 to 3 are the first pass; section 4 is a second pass,
a few hours later, after the human recreated the `cg-demo-us` gateway mid-spike.

The persona's email domain is replaced with `<persona-domain>` throughout: the
four addresses live in Render environment variables and are deliberately not in
git. Every flow value is scrubbed by `redact` and `redactQuery` in
`04-oauth-drive.ts` — authorization codes, access and refresh and ID tokens,
client secrets, PKCE verifiers **and challenges**, `state`, `nonce`, and the
IdP's login and consent challenges. The list lives in one place,
`REDACTED_PARAMS`, and `04-redaction.test.ts` greps this file with the same
pattern the scripts redact by, so a value that stops being scrubbed fails
`bun test` rather than sitting here unnoticed.

Two things deliberately survive, because they are the evidence: the throwaway
`client_id` of each dynamically registered client, and the loopback ports. A
short `state=p` or `code_challenge=…` in hand-written prose survives too; those
are illustrations, not values.

Reproduce with:

```
PERSONA_EMAIL=dana.okafor@<persona-domain> PERSONA_PASSWORD=<fixture password> \
  bun docs/spikes/evidence/04-user-source-flow.ts

mkdir -p /tmp/mastra-probe && cd /tmp/mastra-probe
echo '{"name":"p","private":true,"type":"module"}' > package.json && bun add @mastra/mcp
MASTRA_MCP_MODULE=/tmp/mastra-probe/node_modules/@mastra/mcp \
PERSONA_EMAIL=dana.okafor@<persona-domain> PERSONA_PASSWORD=<fixture password> \
  bun docs/spikes/evidence/04-mastra-authprovider.ts
```

---

## 1. `04-user-source-flow.ts` against `cg-demo-us`

Exit status **1**: the script refuses to type a persona password into a host that
is not the configured User Source issuer, and says which host served the page.

```
spike 04 — https://api.arcade.dev/mcp/cg-demo-us as dana.okafor@<persona-domain>
  expected user source issuer: https://cg-idp-or5b.onrender.com

─── 01 MCP initialize with no token -> 401
{
  "body": "{\"name\":\"invalid_authorization\",\"message\":\"Missing Authorization header\"}",
  "www-authenticate": "Bearer resource_metadata=\"https://api.arcade.dev/.well-known/oauth-protected-resource/mcp/cg-demo-us\", scope=\"mcp\", error=\"invalid_token\""
}

─── 02 protected-resource metadata
{
  "resource": "https://api.arcade.dev/mcp/cg-demo-us",
  "authorization_servers": [
    "https://cloud.arcade.dev/oauth2"
  ],
  "bearer_methods_supported": [
    "header"
  ],
  "scopes_supported": [
    "mcp"
  ],
  "resource_name": "contextual-governance (user source)"
}

─── 03 authorization server metadata
{
  "issuer": "https://cloud.arcade.dev/oauth2",
  "authorization_endpoint": "https://cloud.arcade.dev/oauth2/authorize",
  "token_endpoint": "https://cloud.arcade.dev/oauth2/token",
  "registration_endpoint": "https://cloud.arcade.dev/oauth2/register",
  "jwks_uri": "https://cloud.arcade.dev/.well-known/jwks/oauth2",
  "scopes_supported": [
    "mcp",
    "offline_access"
  ],
  "response_types_supported": [
    "code"
  ],
  "grant_types_supported": [
    "authorization_code",
    "refresh_token"
  ],
  "token_endpoint_auth_methods_supported": [
    "none",
    "private_key_jwt"
  ],
  "code_challenge_methods_supported": [
    "S256"
  ],
  "client_id_metadata_document_supported": true,
  "authorization_response_iss_parameter_supported": true
}

─── 04 dynamic client registration
{
  "client_id": "73b98c2a-d0fd-4867-ae99-ff28d9510e64",
  "client_id_issued_at": 1789133393,
  "redirect_uris": [
    "http://localhost:62459/callback"
  ],
  "scope": "mcp offline_access",
  "token_endpoint_auth_method": "none",
  "grant_types": [
    "authorization_code",
    "refresh_token"
  ],
  "response_types": [
    "code"
  ],
  "client_name": "cg-spike-65",
  "application_type": "web"
}

─── 05 authorize URL
https://cloud.arcade.dev/oauth2/authorize?response_type=code&client_id=73b98c2a-d0fd-4867-ae99-ff28d9510e64&redirect_uri=http%3A%2F%2Flocalhost%3A62459%2Fcallback&scope=mcp+offline_access&state=<redacted>&code_challenge=<redacted>&code_challenge_method=S256&resource=https%3A%2F%2Fapi.arcade.dev%2Fmcp%2Fcg-demo-us

─── 06 302 https://cloud.arcade.dev/oauth2/authorize -> https://auth.arcade.dev/oauth2/auth
https://auth.arcade.dev/oauth2/auth?response_type=code&client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812&redirect_uri=https%3A%2F%2Fcloud.arcade.dev%2Foauth2%2Fintermediate_callback&scope=openid+profile+email&state=<redacted>&code_challenge=<redacted>&code_challenge_method=S256

─── 07 302 https://auth.arcade.dev/oauth2/auth -> https://auth.arcade.dev/ui/login
https://auth.arcade.dev/ui/login?login_challenge=<redacted>

─── 08 303 https://auth.arcade.dev/ui/login -> https://auth.arcade.dev/self-service/login/browser
https://auth.arcade.dev/self-service/login/browser?aal=&refresh=&return_to=&organization=&via=&login_challenge=<redacted>

─── 09 303 https://auth.arcade.dev/self-service/login/browser -> https://account.arcade.dev/login
https://account.arcade.dev/login?flow=1b043816-7721-4fef-931d-2d026c0f01d8

─── 10 page 1: account.arcade.dev rendered the login, not cg-idp-or5b.onrender.com — stopping
{
  "action": "https://auth.arcade.dev/self-service/login?flow=1b043816-7721-4fef-931d-2d026c0f01d8",
  "fields": [
    "provider"
  ]
}

─── 11 hosts that rendered a page
{
  "pageHosts": [
    "account.arcade.dev"
  ],
  "pagesShown": 1,
  "expected": "cg-idp-or5b.onrender.com",
  "authenticatedAgainstTheUserSource": false
}

─── 12 redirect chain
[
  "302 GET https://cloud.arcade.dev/oauth2/authorize",
  "302 GET https://auth.arcade.dev/oauth2/auth",
  "303 GET https://auth.arcade.dev/ui/login",
  "303 GET https://auth.arcade.dev/self-service/login/browser",
  "200 GET https://account.arcade.dev/login"
]

FAILED: the chain stopped at https://account.arcade.dev/login?flow=1b043816-7721-4fef-931d-2d026c0f01d8 instead of reaching the redirect URI — the pages were served by account.arcade.dev, not cg-idp-or5b.onrender.com
```

---

## 2. `04-mastra-authprovider.ts` — question 4

`@mastra/mcp@1.17.3`. The noisy `MCPClient errored connecting…` blocks are the
library's own logger reporting the expected 401 on first contact; they are kept
verbatim.

```

─── 01 @mastra/mcp version
1.17.3
MCPClient errored connecting to MCP server: {
  error: "{\"message\":\"Failed to connect to MCP server arcade: UnauthorizedError: Unauthorized\\n    at handleOAuthUnauthorized (/private/tmp/claude-501/-Users-mateo-orca-workspaces-mastra-contextual-governance-issue-65-user-source-spike/1fb51a0e-8e7d-4a35-b0fa-a76e5fdf96d7/scratchpad/mastra-probe/node_modules/@modelcontextprotocol/client/dist/index.mjs:253:29)\\n    at processTicksAndRejections (native:7:39)\",\"domain\":\"MCP\",\"category\":\"THIRD_PARTY\",\"code\":\"MCP_CLIENT_CONNECT_FAILED\",\"details\":{\"name\":\"arcade\"},\"cause\":{\"message\":\"Unauthorized\",\"name\":\"UnauthorizedError\"}}",
}
Failed to list tools from server: {
  error: "{\"message\":\"Failed to connect to MCP server arcade: UnauthorizedError: Unauthorized\\n    at handleOAuthUnauthorized (/private/tmp/claude-501/-Users-mateo-orca-workspaces-mastra-contextual-governance-issue-65-user-source-spike/1fb51a0e-8e7d-4a35-b0fa-a76e5fdf96d7/scratchpad/mastra-probe/node_modules/@modelcontextprotocol/client/dist/index.mjs:253:29)\\n    at processTicksAndRejections (native:7:39)\",\"domain\":\"MCP\",\"category\":\"THIRD_PARTY\",\"code\":\"MCP_CLIENT_GET_TOOLS_FAILED\",\"details\":{\"serverName\":\"arcade\"},\"cause\":{\"message\":\"Failed to connect to MCP server arcade: UnauthorizedError: Unauthorized\\n    at handleOAuthUnauthorized (/private/tmp/claude-501/-Users-mateo-orca-workspaces-mastra-contextual-governance-issue-65-user-source-spike/1fb51a0e-8e7d-4a35-b0fa-a76e5fdf96d7/scratchpad/mastra-probe/node_modules/@modelcontextprotocol/client/dist/index.mjs:253:29)\\n    at processTicksAndRejections (native:7:39)\",\"domain\":\"MCP\",\"category\":\"THIRD_PARTY\",\"code\":\"MCP_CLIENT_CONNECT_FAILED\",\"details\":{\"name\":\"arcade\"},\"cause\":{\"message\":\"Unauthorized\",\"name\":\"UnauthorizedError\"}}}",
}

─── 02 listTools() before any authorization
{
  "result": [],
  "serverAuthState": "needs-auth"
}
MCPClient errored connecting to MCP server: {
  error: "{\"message\":\"Failed to connect to MCP server arcade: UnauthorizedError: Unauthorized\\n    at handleOAuthUnauthorized (/private/tmp/claude-501/-Users-mateo-orca-workspaces-mastra-contextual-governance-issue-65-user-source-spike/1fb51a0e-8e7d-4a35-b0fa-a76e5fdf96d7/scratchpad/mastra-probe/node_modules/@modelcontextprotocol/client/dist/index.mjs:253:29)\\n    at processTicksAndRejections (native:7:39)\",\"domain\":\"MCP\",\"category\":\"THIRD_PARTY\",\"code\":\"MCP_CLIENT_CONNECT_FAILED\",\"details\":{\"name\":\"arcade\"},\"cause\":{\"message\":\"Unauthorized\",\"name\":\"UnauthorizedError\"}}",
}
Failed to list tools from server: {
  error: "{\"message\":\"Failed to connect to MCP server arcade: UnauthorizedError: Unauthorized\\n    at handleOAuthUnauthorized (/private/tmp/claude-501/-Users-mateo-orca-workspaces-mastra-contextual-governance-issue-65-user-source-spike/1fb51a0e-8e7d-4a35-b0fa-a76e5fdf96d7/scratchpad/mastra-probe/node_modules/@modelcontextprotocol/client/dist/index.mjs:253:29)\\n    at processTicksAndRejections (native:7:39)\",\"domain\":\"MCP\",\"category\":\"THIRD_PARTY\",\"code\":\"MCP_CLIENT_GET_TOOLS_FAILED\",\"details\":{\"serverName\":\"arcade\"},\"cause\":{\"message\":\"Failed to connect to MCP server arcade: UnauthorizedError: Unauthorized\\n    at handleOAuthUnauthorized (/private/tmp/claude-501/-Users-mateo-orca-workspaces-mastra-contextual-governance-issue-65-user-source-spike/1fb51a0e-8e7d-4a35-b0fa-a76e5fdf96d7/scratchpad/mastra-probe/node_modules/@modelcontextprotocol/client/dist/index.mjs:253:29)\\n    at processTicksAndRejections (native:7:39)\",\"domain\":\"MCP\",\"category\":\"THIRD_PARTY\",\"code\":\"MCP_CLIENT_CONNECT_FAILED\",\"details\":{\"name\":\"arcade\"},\"cause\":{\"message\":\"Unauthorized\",\"name\":\"UnauthorizedError\"}}}",
}

─── 03 authenticate() with an https:// redirect URL
threw: Cannot authenticate MCP server arcade: the provider's redirect URL must be a loopback address, got https://cg-web-sa31.onrender.com.

─── 04 authenticate() emitted an authorization URL
{
  "authorizationUrl": "https://cloud.arcade.dev/oauth2/authorize?response_type=code&client_id=037e26fa-c453-4b4b-8d40-b448dd619258&code_challenge=<redacted>&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A62468%2Foauth%2Fcallback&state=<redacted>&scope=mcp+offline_access&prompt=consent&resource=https%3A%2F%2Fapi.arcade.dev%2Fmcp%2Fcg-demo-us",
  "redirect_uri": "http://localhost:62468/oauth/callback",
  "note": "Mastra bound this loopback port itself and is waiting for a browser to hit it"
}

─── 05 302 https://cloud.arcade.dev/oauth2/authorize -> https://auth.arcade.dev/oauth2/auth
https://auth.arcade.dev/oauth2/auth?response_type=code&client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812&redirect_uri=https%3A%2F%2Fcloud.arcade.dev%2Foauth2%2Fintermediate_callback&scope=openid+profile+email&state=<redacted>&code_challenge=<redacted>&code_challenge_method=S256

─── 06 302 https://auth.arcade.dev/oauth2/auth -> https://auth.arcade.dev/ui/login
https://auth.arcade.dev/ui/login?login_challenge=<redacted>

─── 07 303 https://auth.arcade.dev/ui/login -> https://auth.arcade.dev/self-service/login/browser
https://auth.arcade.dev/self-service/login/browser?aal=&refresh=&return_to=&organization=&via=&login_challenge=<redacted>

─── 08 303 https://auth.arcade.dev/self-service/login/browser -> https://account.arcade.dev/login
https://account.arcade.dev/login?flow=132a57d2-3ef1-4685-b472-78512c34a39d

─── 09 page 1: account.arcade.dev rendered the login, not cg-idp-or5b.onrender.com — stopping
{
  "action": "https://auth.arcade.dev/self-service/login?flow=132a57d2-3ef1-4685-b472-78512c34a39d",
  "fields": [
    "provider"
  ]
}

─── 10 hosts that rendered a page
{
  "pageHosts": [
    "account.arcade.dev"
  ],
  "pagesShown": 1,
  "expected": "cg-idp-or5b.onrender.com",
  "stoppedAt": "https://account.arcade.dev/login?flow=132a57d2-3ef1-4685-b472-78512c34a39d"
}

─── 11 authenticate() outcome
still pending after 20s
```

---

## 3. Supporting one-off measurements

### `apps/idp` discovery after #70

```
$ curl -s https://cg-idp-or5b.onrender.com/.well-known/openid-configuration | jq '{issuer, jwks_uri, id_token_signing_alg_values_supported, authorization_endpoint, token_endpoint, userinfo_endpoint, code_challenge_methods_supported, claims_supported}'
{
  "issuer": "https://cg-idp-or5b.onrender.com",
  "jwks_uri": "https://cg-idp-or5b.onrender.com/jwks",
  "id_token_signing_alg_values_supported": ["RS256"],
  "authorization_endpoint": "https://cg-idp-or5b.onrender.com/oauth2/authorize",
  "token_endpoint": "https://cg-idp-or5b.onrender.com/oauth2/token",
  "userinfo_endpoint": "https://cg-idp-or5b.onrender.com/oauth2/userinfo",
  "code_challenge_methods_supported": ["S256"],
  "claims_supported": ["sub","iss","aud","exp","iat","sid","scope","azp","name","picture","given_name","family_name","email","email_verified"]
}

$ curl -s https://cg-idp-or5b.onrender.com/jwks
{"keys":[{"alg":"RS256","e":"AQAB","kty":"RSA","n":"1DdrpjUYYiB-NDcx4P205Lgsym_QgoESiKoe1CKBtqXJj5JEtQ6DRm88WSJYKRBEiyLQTdvnlc-cvTv2LpviEKF0OH2cvQ2S8dypcc7qUVvXw4u7pLN1C6X3UkFbDOdynJ9iT9CTCJueqM20s9uTaTUIh3Eeig7HG6IPfNGaAq0YIHt7hz86ikRxL18di600icqA2NM1SNPK_eEgo6vXShviOS3yYHNw_7996zkP_wB4imD1UMFCUr99YMUL4lz2Y5cMCtg--Ej1kR1li7ofrJjEN-exJfTCik94LNtmTvjX7NJOG9py9Fly-cZUYfzCFWeA08GNoD5qsqTfJ_6eRw","kid":"MNIE6RdQNKHOzcq78K6SbkXcEPB7MAfM"}]}
```

### The same authorize chain for the members-mode gateway `cg-demo`

Identical hop for hop, which is the point: the two gateways are indistinguishable
from the client's side.

```
GATEWAY cg-demo
302 https://cloud.arcade.dev/oauth2/authorize
302 https://auth.arcade.dev/oauth2/auth
303 https://auth.arcade.dev/ui/login
303 https://auth.arcade.dev/self-service/login/browser
200 https://account.arcade.dev/login
```

`GET /.well-known/oauth-protected-resource/mcp/cg-demo` differs from `cg-demo-us`
only in `resource` and `resource_name`:

```
{"resource":"https://api.arcade.dev/mcp/cg-demo","authorization_servers":["https://cloud.arcade.dev/oauth2"],"bearer_methods_supported":["header"],"scopes_supported":["mcp"],"resource_name":"contextual-governance"}
{"resource":"https://api.arcade.dev/mcp/cg-demo-us","authorization_servers":["https://cloud.arcade.dev/oauth2"],"bearer_methods_supported":["header"],"scopes_supported":["mcp"],"resource_name":"contextual-governance (user source)"}
```

### The authorize chain does not depend on `resource`

Dropping the `resource` parameter entirely produces the same first redirect:

```
$ curl -sS -o /dev/null -D - "https://cloud.arcade.dev/oauth2/authorize?response_type=code&client_id=…&redirect_uri=http%3A%2F%2Flocalhost%3A…%2Fcallback&scope=mcp&state=x&code_challenge=…&code_challenge_method=S256"
HTTP/2 302
location: https://auth.arcade.dev/oauth2/auth?response_type=code&client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812&redirect_uri=https%3A%2F%2Fcloud.arcade.dev%2Foauth2%2Fintermediate_callback&scope=openid+profile+email&state=…&code_challenge=…&code_challenge_method=S256
```

### Arcade's own Kratos login flow, offered instead of `cg-idp`

`GET https://auth.arcade.dev/self-service/login/flows?id=<flow>` for the flow the
chain landed on:

```
identifier_first  identifier  ""                    text    "Work email"
identifier_first  method      "identifier_first"    submit  "Continue"
oidc              provider    "github-mEeDM_J0"     submit  "Sign in with GitHub"
oidc              provider    "google-jgnsnJ_f"     submit  "Sign in with Google"
oidc              provider    "microsoft-4jkNpo6k"  submit  "Sign in with Microsoft"
default           csrf_token  "…"                   hidden
```

Submitting `identifier=dana.okafor@<persona-domain>` with `method=identifier_first`
returns an Arcade **password** form, not a redirect to `cg-idp`:

```
identifier_first  identifier  "dana.okafor@<persona-domain>"  hidden  "Work email"
password          password                                   password "Password"
password          method      "password"                      submit  "Sign in with password"
UI MESSAGES []
```

Arcade resolves the persona as one of its own accounts. No user-source redirect
is offered at any point in the chain.


---

## 4. Second pass, after the gateway was recreated

The human confirmed the original `cg-demo-us` was not using the User Source at all
and recreated it. Everything below is from after that.

### The protected-resource document gained a field

```
$ curl -s https://api.arcade.dev/.well-known/oauth-protected-resource/mcp/cg-demo-us
{"resource":"https://api.arcade.dev/mcp/cg-demo-us","authorization_servers":["https://cloud.arcade.dev/oauth2"],"bearer_methods_supported":["header"],"scopes_supported":["mcp"],"resource_name":"contextual-governance (user source)","urn:arcade:oauth:user_source_id":"us_3JA8GcvHfT17WNnnRazx6FZpxeg"}

$ curl -s https://api.arcade.dev/.well-known/oauth-protected-resource/mcp/cg-demo
{"resource":"https://api.arcade.dev/mcp/cg-demo","authorization_servers":["https://cloud.arcade.dev/oauth2"],"bearer_methods_supported":["header"],"scopes_supported":["mcp"],"resource_name":"contextual-governance"}
```

`urn:arcade:oauth:user_source_id` was absent from `cg-demo-us` before the
recreation and is absent from `cg-demo` throughout. The MCP slug did not change.

### `04-user-source-flow.ts`, second run

Still exit **1**, still stopped at `account.arcade.dev`.

```
spike 04 — https://api.arcade.dev/mcp/cg-demo-us as dana.okafor@<persona-domain>
  expected user source issuer: https://cg-idp-or5b.onrender.com

─── 01 MCP initialize with no token -> 401
{
  "body": "{\"name\":\"invalid_authorization\",\"message\":\"Missing Authorization header\"}",
  "www-authenticate": "Bearer resource_metadata=\"https://api.arcade.dev/.well-known/oauth-protected-resource/mcp/cg-demo-us\", scope=\"mcp\", error=\"invalid_token\""
}

─── 02 protected-resource metadata
{
  "resource": "https://api.arcade.dev/mcp/cg-demo-us",
  "authorization_servers": [
    "https://cloud.arcade.dev/oauth2"
  ],
  "bearer_methods_supported": [
    "header"
  ],
  "scopes_supported": [
    "mcp"
  ],
  "resource_name": "contextual-governance (user source)",
  "urn:arcade:oauth:user_source_id": "us_3JA8GcvHfT17WNnnRazx6FZpxeg"
}

─── 03 authorization server metadata
{
  "issuer": "https://cloud.arcade.dev/oauth2",
  "authorization_endpoint": "https://cloud.arcade.dev/oauth2/authorize",
  "token_endpoint": "https://cloud.arcade.dev/oauth2/token",
  "registration_endpoint": "https://cloud.arcade.dev/oauth2/register",
  "jwks_uri": "https://cloud.arcade.dev/.well-known/jwks/oauth2",
  "scopes_supported": [
    "mcp",
    "offline_access"
  ],
  "response_types_supported": [
    "code"
  ],
  "grant_types_supported": [
    "authorization_code",
    "refresh_token"
  ],
  "token_endpoint_auth_methods_supported": [
    "none",
    "private_key_jwt"
  ],
  "code_challenge_methods_supported": [
    "S256"
  ],
  "client_id_metadata_document_supported": true,
  "authorization_response_iss_parameter_supported": true
}

─── 04 dynamic client registration
{
  "client_id": "0033cb90-038b-49e8-9f9e-5d84fe68205b",
  "client_id_issued_at": 1789134593,
  "redirect_uris": [
    "http://localhost:64265/callback"
  ],
  "scope": "mcp offline_access",
  "token_endpoint_auth_method": "none",
  "grant_types": [
    "authorization_code",
    "refresh_token"
  ],
  "response_types": [
    "code"
  ],
  "client_name": "cg-spike-65",
  "application_type": "web"
}

─── 05 authorize URL
https://cloud.arcade.dev/oauth2/authorize?response_type=code&client_id=0033cb90-038b-49e8-9f9e-5d84fe68205b&redirect_uri=http%3A%2F%2Flocalhost%3A64265%2Fcallback&scope=mcp+offline_access&state=<redacted>&code_challenge=<redacted>&code_challenge_method=S256&resource=https%3A%2F%2Fapi.arcade.dev%2Fmcp%2Fcg-demo-us

─── 06 302 https://cloud.arcade.dev/oauth2/authorize -> https://auth.arcade.dev/oauth2/auth
https://auth.arcade.dev/oauth2/auth?response_type=code&client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812&redirect_uri=https%3A%2F%2Fcloud.arcade.dev%2Foauth2%2Fintermediate_callback&scope=openid+profile+email&state=<redacted>&code_challenge=<redacted>&code_challenge_method=S256

─── 07 302 https://auth.arcade.dev/oauth2/auth -> https://auth.arcade.dev/ui/login
https://auth.arcade.dev/ui/login?login_challenge=<redacted>

─── 08 303 https://auth.arcade.dev/ui/login -> https://auth.arcade.dev/self-service/login/browser
https://auth.arcade.dev/self-service/login/browser?aal=&refresh=&return_to=&organization=&via=&login_challenge=<redacted>

─── 09 303 https://auth.arcade.dev/self-service/login/browser -> https://account.arcade.dev/login
https://account.arcade.dev/login?flow=73f7a763-6eda-4e12-bfeb-b243a024ac4b

─── 10 page 1: account.arcade.dev rendered the login, not cg-idp-or5b.onrender.com — stopping
{
  "action": "https://auth.arcade.dev/self-service/login?flow=73f7a763-6eda-4e12-bfeb-b243a024ac4b",
  "fields": [
    "provider"
  ]
}

─── 11 hosts that rendered a page
{
  "pageHosts": [
    "account.arcade.dev"
  ],
  "pagesShown": 1,
  "expected": "cg-idp-or5b.onrender.com",
  "authenticatedAgainstTheUserSource": false
}

─── 12 redirect chain
[
  "302 GET https://cloud.arcade.dev/oauth2/authorize",
  "302 GET https://auth.arcade.dev/oauth2/auth",
  "303 GET https://auth.arcade.dev/ui/login",
  "303 GET https://auth.arcade.dev/self-service/login/browser",
  "200 GET https://account.arcade.dev/login"
]
[0m[31m
FAILED: the chain stopped at https://account.arcade.dev/login?flow=73f7a763-6eda-4e12-bfeb-b243a024ac4b instead of reaching the redirect URI — the pages were served by account.arcade.dev, not cg-idp-or5b.onrender.com[0m
```

### The upstream is the same for both gateways, and `resource` is validated

Each row is one `GET /oauth2/authorize` with only `resource` changed, reporting
the `Location` host and path plus the `client_id` on that redirect.

```
https://api.arcade.dev/mcp/cg-demo-us          302 -> auth.arcade.dev/oauth2/auth  upstream client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812
https://api.arcade.dev/mcp/cg-demo             302 -> auth.arcade.dev/oauth2/auth  upstream client_id=4eabdfa1-482e-4296-ba72-ba5fde2a3812
https://api.arcade.dev/mcp/does-not-exist-65   302 -> localhost:64998/callback  upstream client_id=null
https://example.com/nope                       302 -> localhost:64998/callback  upstream client_id=null
```

The full error for an unknown gateway:

```
302 http://localhost:64997/callback?error=server_error&iss=https%3A%2F%2Fcloud.arcade.dev%2Foauth2&error_description=Could+not+retrieve+protected+resource+metadata+for+the+gateway.+Verify+that+the+gateway+is+reachable+and+configured+correctly.&state=p
```

### Ten authorize parameters, in case the client must name the source

Same request each time, one extra parameter, reporting the `Location`.

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
