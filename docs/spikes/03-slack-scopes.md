# Spike 03 — Does Arcade's stock Slack provider grant a user token with `chat:write`?

**Answer: yes.** Arcade's stock Slack provider (`arcade-slack`) issues a delegated **user**
token carrying `chat:write`, `im:write`, `users:read` and `users:read.email` when those scopes
are requested through the Arcade authorization API. A `chat.postMessage` with a `blocks`
payload succeeded with that token and renders in Slack as the user, not as a bot.

**Decision: act 2 posts as the requester.** No custom Slack app, no bot fallback.

Resolves [#3](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/3).
Clears open risk 3 in `DESIGN.md`. Unblocks #18.

**Reproduced.** Run end to end on 2026-09-02 against the same throwaway project spike 02 used,
in the `ArcadeDevTest` Slack workspace. Raw request/response pairs in
[`evidence/03-slack-scopes-transcript.md`](evidence/03-slack-scopes-transcript.md); the
rendered message in
[`evidence/03-slack-block-kit-render.png`](evidence/03-slack-block-kit-render.png).

## How this was answered

Exactly what #3 specified, with nothing in between Arcade and Slack:

1. `POST /v1/auth/authorize` with `provider_id: "slack"` and the four scopes.
2. Completed the Slack consent screen in a browser as `mateo@arcade.dev`.
3. `GET /v1/auth/status` → `completed`, token in `context.token`.
4. Hit Slack's Web API directly with that token: `auth.test`, `users.lookupByEmail`,
   `conversations.open`, `chat.postMessage` with a Block Kit body shaped like act 2's
   approval request.

Every call returned `ok: true`.

## What was recorded

### The stock provider passes requested scopes straight through as `user_scope`

The authorize URL Arcade generated for provider `slack` (resolved to `arcade-slack`) was:

```
https://slack.com/oauth/v2/authorize?client_id=…&redirect_uri=https://cloud.arcade.dev/api/v1/oauth/…/callback
  &user_scope=chat:write,im:write,users:read,users:read.email
```

`user_scope`, not `scope`. There is no bot scope in the request. This is what determines the
token type: Slack's OAuth v2 issues a user token (`xoxp`) for `user_scope` and a bot token
(`xoxb`) for `scope`. Arcade's stock Slack app is a user-token app.

The scopes on offer are the ones Arcade's Slack app is registered for. The published provider
page lists them as `channels:history`, `channels:read`, `chat:write`, `groups:history`,
`groups:read`, `groups:write`, `im:history`, `im:read`, `im:write`, `mpim:history`,
`mpim:read`, `mpim:write`, `users:read`, `users:read.email`, `users.profile:read`. All three
this demo needs are in that list.

### The granted token

`auth.test` on the token Arcade returned:

| Field | Value |
|---|---|
| token prefix | `xoxe.xoxp-` (rotating user token) |
| `X-OAuth-Scopes` response header | `identify, channels:history, groups:history, im:history, mpim:history, channels:read, groups:read, im:read, mpim:read, users:read, users:read.email, chat:write, im:write` |
| `user_id` | the authorizing user's own Slack ID |
| `expires_in` | 43165 s (~12 h) |

The scope list is a superset of what was requested because Arcade accumulates scopes per user
per provider across authorizations, and this user had authorized the stock Slack toolkit
before. Arcade's own `status.scopes` reports the same union. The authorize URL for a
never-seen `user_id` carries exactly the four requested scopes under `user_scope`, so a fresh
user should end up with exactly those four, but no fresh Slack account was available to
confirm the token's final scope list. Marked as unverified below.

### Each scope, exercised

| Scope | Call | Result |
|---|---|---|
| `users:read.email` | `users.lookupByEmail` with the approver's email | `ok`, returns Slack user ID |
| `im:write` | `conversations.open` with that user ID | `ok`, returns `D…` channel |
| `chat:write` | `chat.postMessage` to that channel with `blocks` | `ok`, `ts` returned |

This is the exact call sequence `request_approval` will make in #18: resolve the routed
approver's email to a Slack ID, open the DM, post the Block Kit message.

### It renders as the requester

The message shows in Slack under the authorizing user's name, avatar and timestamp, with the
full Block Kit layout (header, two-column fields, justification, a link button, a context
footer). No "APP" badge next to the name. Screenshot in
[`evidence/03-slack-block-kit-render.png`](evidence/03-slack-block-kit-render.png).

One thing to know: the `chat.postMessage` response carries `bot_id`, `app_id` and a
`bot_profile` named `Arcade.dev` **alongside** `user`. That is Slack's normal shape for any
message an app posts with a user token. Slack records which app posted it, but attributes and
renders it as the user. It does not mean the post went out as a bot.

## Consequences for #18

- **Post as the requester.** Fetch the requester's Slack token from Arcade at call time
  through the tool's `context.authorization.token`, declaring the `Slack` auth requirement
  with scopes `chat:write`, `im:write`, `users:read`, `users:read.email` on the tool. Do not
  cache the token: `auth.test` reports a ~12 h life. Arcade's provider model is that it
  holds the refresh token and renews on demand, but renewal past expiry was not observed in
  this spike (see the confidence table). If #18 sees `token_expired` from Slack, this is the
  first place to look.
- **`users:read` must be requested alongside `users:read.email`.** Observed: an authorize
  request for `users:read.email` alone produced a Slack error page, "Arcade.dev could not be
  installed. Invalid permissions requested", before any consent screen (transcript §8).
  Issue #3 listed three scopes; the tool needs four.
- **Every persona that can trigger act 2 must authorize Slack once.** With the design's
  persona switcher over real emails, that means Dana's real account authorizes once and the
  token is bound to her `user_id`. Riley and Morgan need no Slack authorization to *receive*
  the DM; they need one only if they themselves become requesters.
- **The requester sees the DM she sent.** Confirmed as a side effect: the DM appears in the
  sender's own DM list. This is why the approval link must carry no authority (#19).
- **The consent screen says "Arcade.dev" and "App is not approved by Slack."** Both are
  cosmetic for the demo, but rehearse the authorization before going on stage rather than
  clicking through it live.

## Fallbacks, not taken

Neither fallback in #3 is needed. Recorded here for forkers who want them anyway.

**Custom Slack app as an Arcade auth provider.** Do this only if you want your own app name and
icon on the consent screen, or a scope the stock app does not offer. Steps, per Arcade's Slack
provider reference:

1. Create a Slack app at api.slack.com/apps. Under *OAuth & Permissions* add **User Token
   Scopes** `chat:write`, `im:write`, `users:read`, `users:read.email`. Leave Bot Token
   Scopes empty if you want user-only posting.
2. In the Arcade dashboard: *Connections → Connected Apps → Add → Slack*. Give it a unique
   provider ID (this replaces `slack` in the tool's auth requirement), paste the Slack
   client ID and client secret.
3. Copy the redirect URL Arcade shows you back into the Slack app's *Redirect URLs*.
4. In the tool, reference your provider ID instead of the stock one.

**Posting as a bot.** Register the custom app above with **Bot Token Scopes** `chat:write`,
`im:write`, `users:read`, `users:read.email` instead, install it to the workspace, and store
the `xoxb` token as an Arcade secret the tool reads. The message then comes from the bot, the
requester never authorizes anything, and the delegated-auth beat of act 2 is lost.

## Confidence

| Claim | |
|---|---|
| Stock provider requests scopes as `user_scope`, so the token is a user token | ✅ observed on the authorize URL and on the `xoxp` prefix |
| `chat:write`, `im:write`, `users:read`, `users:read.email` are grantable through it | ✅ `X-OAuth-Scopes` header |
| `chat.postMessage` with `blocks` succeeds with that token | ✅ `ok: true`, rendered |
| Renders as the user, not a bot | ✅ screenshot |
| `users.lookupByEmail` and `conversations.open` work with the same token | ✅ |
| Slack rejects `users:read.email` without `users:read` | ✅ "Invalid permissions requested" on the consent redirect, nothing granted |
| Exact scope list on a token for a user with **no prior** Arcade Slack grant | ⬜ **not exercised** — both runs used a user holding the wider stock-toolkit grant. The authorize URL for a never-seen `user_id` carries exactly the four scopes, so the token type is settled; only the final list is unconfirmed |
| Arcade refreshes the rotating token past its ~12 h expiry | ⬜ **not observed** — a re-run 30 min later returned the same auth record with `expires_in` counting down, consistent but not proof |
| Opening a DM with a *different* user (the approver) | ⬜ **not exercised** — tested against self to avoid messaging a colleague. Slack's `im:write` covers any workspace member; the call is identical |
| Custom-app and bot fallbacks | ⬜ **not exercised** — written from Arcade's published provider reference |
