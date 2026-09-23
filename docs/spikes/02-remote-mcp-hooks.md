# Spike 02 — Do contextual-access hooks fire for Remote MCP server tools?

**Answer: yes.** All three hooks — `/access`, `/pre`, `/post` — fire for tools served by a
Remote MCP server registered in Arcade, with a payload identical in shape to the one hosted
toolkits produce. `DESIGN.md`'s architecture holds: `apps/loan-mcp` can be an external Bun
service.

Resolves [#2](https://github.com/ArcadeAI-labs/mastra-contextual-governance/issues/2).
Clears open risk 1 in `DESIGN.md`.

**Reproduced.** Run end to end on 2026-09-02 against a throwaway project: a probe MCP server
registered as a Remote MCP server, a webhook extension with all three hooks, one allow pass
and one deny pass. Raw payloads in
[`evidence/02-remote-mcp-hooks-transcript.md`](evidence/02-remote-mcp-hooks-transcript.md).

## How this was answered

The experiment #2 specified. A probe service exposing one trivial MCP tool was registered as a
Remote MCP server; a webhook extension was attached with `/access`, `/pre` and `/post`; the
tool was called once with the hooks permitting and once with the pre-hook denying. The probe
logged every inbound hook request verbatim.

All three hooks fired. The full transcript, including every payload, is in
[`evidence/02-remote-mcp-hooks-transcript.md`](evidence/02-remote-mcp-hooks-transcript.md) —
anyone can re-run it and diff.

Then repeated over an **MCP gateway** — the path Mastra's `MCPClient` will use — including the
access hook hiding the tool from `tools/list`. Both paths are covered.

## What holds, and why it is stable

A Remote MCP server is not a special case in Arcade's execution path. It is registered as the
same kind of tool-serving backend as a hosted toolkit, differing only in the transport used to
reach it. The hook pipeline runs around that transport, not inside it: the pre-execution hook
runs, the tool is dispatched to whichever backend serves it, the post-execution hook runs.
Access filtering is applied to tool *definitions* during discovery, before transport enters
the picture.

Consequences worth relying on:

- The governance layer is not handed anything that distinguishes a remote MCP tool from a
  hosted-toolkit tool, so it does not treat them differently. This is not a coverage feature
  that could regress for remote servers alone.
- Calls arriving over an MCP gateway (`https://api.arcade.dev/mcp/{gateway}`, which is what
  Mastra's `MCPClient` will use) are governed on the same path as SDK calls. `tools/list` over
  that surface is access-filtered; `tools/call` runs pre and post.

Observed directly, on both paths. With the hooks permitting, the probe saw
**`/access` → `/pre` → tool reached the backend → `/post`**. With the pre-hook denying, it saw
**`/access` → `/pre`** and nothing further: the backend was never reached and `/post` never
ran. Identical over the SDK execute path and over an MCP gateway.

`execution_id` is identical across `/pre` and `/post`, so the two correlate exactly — but see
[Denials over MCP](#denials-over-mcp) for what the *client* can see, which is much less.

## Payload: identical to hosted toolkits

All of this section is public — it matches
[Build your own](https://docs.arcade.dev/en/guides/contextual-access/build-your-own) field for
field. The finding here is only that a remote MCP server produces the *same* shape.

`/pre` receives `{ execution_id, tool: { name, toolkit, version }, inputs, context }`.
`/post` receives the same plus `{ success, output, execution_code, execution_error }`.
`/access` receives `{ user_id, toolkits }`, keyed by toolkit name with each toolkit's `tools`
map keyed by raw tool name, and answers with `only` / `deny` lists.
`/pre` and `/post` answer `{ code, error_message?, override? }`, `code` being one of `OK`,
`CHECK_FAILED`, `RATE_LIMIT_EXCEEDED`.

**No field identifies the tool's origin** — confirmed on the captured payloads, which carry no
`servers` and no `headers`. A hook server cannot tell a remote MCP tool from a hosted-toolkit
tool by payload alone; it must derive that from `tool.toolkit`. That is what makes the naming
rules below load-bearing rather than cosmetic — and what makes getting them wrong silent.

The engine passes caller identity to the MCP server itself out-of-band, in
`_meta.arcade_context` on the `tools/call` params.

### `tool.metadata` is never populated — for either kind of tool

`ToolInfo` in the public schema
([`ArcadeAI/schemas`, `logic_extensions/http/1.0/schema.yaml`](https://github.com/ArcadeAI/schemas/blob/main/logic_extensions/http/1.0/schema.yaml))
has an optional fourth field beyond `name` / `toolkit` / `version`:

```
metadata → { classification.service_domains, behavior.operations, extras }
```

It was absent from every remote-tool payload. To find out whether that was a remote-server gap,
a hosted-toolkit tool that *does* carry it was executed with a `/pre` hook attached.
`Clickup.GetSystemGuidance@1.2.3` has this in its **definition**:

```json
{"behavior": {"operations": ["read"], "read_only": true, "destructive": false,
              "idempotent": true, "open_world": true}}
```

Its captured `/pre` payload:

```
Clickup.GetSystemGuidance | tool keys: ['name','toolkit','version'] | metadata: null
```

Identical to the remote tool. The metadata lives in the tool definition and **is not propagated
into hook payloads at all**.

Two conclusions, and the second is the one that bites:

1. "Payload identical to hosted toolkits" is confirmed, now including `metadata`. Both carry
   only the three required fields.
2. **`behavior.operations` is unavailable to hooks, full stop.** This is not a remote-server
   gap — it is a hook-payload gap. ⚠️ **#7 must not key a policy rule on it.** Such a rule
   matches nothing for hosted *and* remote tools alike, and a rule that matches nothing is
   indistinguishable from a rule that permits. Derive read/write from our own policy table
   keyed on `tool.name`, which is the only classification the hook actually receives.

### Requirement checks run before `/pre`

Executing a tool whose requirements are unmet returns
`{"name":"tool_requirements_not_met","message":"secret not found: APOLLO_API_KEY"}` and
**no `/pre` hook fires**. Authorization and secret requirements are evaluated before the
pre-execution hook.

A pre-hook therefore cannot observe, audit or override a call that failed requirements. For the
demo this matters in one place: if a persona is not authorized for a tool, the control plane
sees nothing at all — there is no `/pre` event to show on the panel, and no audit row. If an
act depends on showing an unauthorized attempt, it has to be staged as a policy denial rather
than an authorization failure.

## Tool namespacing

The toolkit name for a remote MCP server's tools is **not** the server ID you type into the
dashboard. It is derived from the `serverInfo.name` the MCP server itself returns in its
`initialize` response, normalised:

1. lowercase
2. **remove every occurrence of `mcp` and `server`** — as substrings, case-insensitively, not
   as whole words
3. split on non-alphanumeric characters
4. title-case each part and join
5. if nothing survives, fall back to `Tools`

Tool names pass through untouched. Version comes from `serverInfo.version`, reduced to
letters, numbers, `-` and `.`, falling back to `0.0.0`.

Separators: `.` for the Arcade fully-qualified name, `@` for version, `_` for the MCP /
function wire name.

For a server reporting `serverInfo.name = "loan-app"`, `version = "1.0.0"`, exposing
`approve_loan`:

| Surface | Form |
|---|---|
| Arcade fully-qualified name | `LoanApp.approve_loan@1.0.0` |
| MCP wire name (what Mastra's `MCPClient` sees) | `LoanApp_approve_loan` |
| `/pre` and `/post` payload | `tool.toolkit = "LoanApp"`, `tool.name = "approve_loan"` |
| `/access` payload | `toolkits["LoanApp"].tools["approve_loan"]` |

**The trap:** `loan-mcp` or `loan-mcp-server` collapses to `Loan`, because `mcp` and `server`
are stripped as substrings, not words. Choose a `serverInfo.name` containing neither, and pin
it.

### This contradicts Arcade's published example. Measured.

The [third-party-MCP announcement](https://www.arcade.dev/blog/bring-third-party-mcp-server-to-arcade/)
says you reference a remote tool as `render-mcp-server.get_key_value`, i.e. by the registered
server ID. That is not what the platform does.

The experiment was built to discriminate. The probe was registered under ID `spike-02-probe`
while reporting `serverInfo.name = "loan-mcp-server"` — so the three candidate rules predicted
three different strings:

| Rule | Predicted toolkit | Observed |
|---|---|---|
| Registered server ID (the blog's reading) | `spike-02-probe` | ✗ |
| Naive passthrough of `serverInfo.name` | `loan-mcp-server` | ✗ |
| Normalisation described above | `Loan` | ✓ |

Arcade resolved it to **`Loan.ping_probe@1.0.0`**. The `mcp` and `server` substrings are
stripped from `loan-mcp-server`, leaving `loan` → `Loan`.

**A policy rule keyed on `render-mcp-server.*` would match nothing**, because that is not what
`tool.toolkit` contains. Filed upstream as #26.

**And the registered-ID form is not an execution alias.** Tested directly:

| `tool_name` passed to Execute | Result |
|---|---|
| `Loan.ping_probe` | ✅ resolved |
| `Loan_ping_probe` | ✅ resolved |
| `spike-02-probe.ping_probe` | ❌ `400 failed to parse tool name` |
| `loan-mcp-server.ping_probe` | ❌ `400 failed to parse tool name` |

The failure is a **parse** error, not "not found" — a hyphenated toolkit segment cannot form a
well-formed name at all. So the published example is wrong, not merely loose.

### Before you write a policy rule: read the toolkit name off the wire

The rule is now measured rather than asserted, but #12 and #13 should still confirm the value
rather than inherit it from here — the normalisation is undocumented, so it is not a contract
Arcade owes us and it can change. After registering `loan-mcp`, log one real `/pre` payload
and read `tool.toolkit` out of it:

```ts
// apps/hooks — temporary, delete once the value is pinned
app.post('/pre', async (c) => {
  const body = await c.req.json()
  console.log('PRE tool =', JSON.stringify(body.tool))   // the only authority
  return c.json({ code: 'OK' })
})
```

Pin the observed string in one shared constant and key every rule off it. **A policy rule
that matches nothing is indistinguishable from a rule that permits** — act 2 would fail open
silently, which is the precise failure the demo exists to disprove. Five minutes, and it
survives the normalisation changing under us.

## Timeouts

- default hook timeout **5s**, configurable per extension and overridable per hook — public,
  per [Build your own](https://docs.arcade.dev/en/guides/contextual-access/build-your-own).
- retry is optional and off unless enabled; only transient failures (5xx, timeout, connection
  error) are retried, 4xx is not — also public, same page.
- response caching was never exercised; the published docs describe it as off by default,
  **not verified here**.
- **`timeout_ms` exists at two levels and they are not the same field.** Creating the
  extension with `timeout_ms: 10000` on each webhook *endpoint* stored 10000 on the endpoint
  but left each *hook* at `5000`. If 5s is not what you want, set the hook-level value
  explicitly and read it back.
- **Endpoint-level bounds are 100 ms – 120 000 ms**, confirmed by probing the validator
  (`timeout_ms must be 100 or greater`; 120001 rejected).
- **Hooks are unique per `(hook_point, priority)`** — a second hook on the same point with the
  same priority is rejected with `choose a different priority`.

## Failure mode: there is no default — you must state it

Measured, and this corrects an earlier draft of this document that claimed the default was
fail-closed. It isn't fail-closed, and it isn't fail-open: creating a webhook extension
without `failure_mode` is **rejected**.

```
400 malformed_request
webhook_config.endpoints.access: failure_mode is a required field
```

Arcade's published docs are right to present it as a per-hook choice and to state no default.
There is nothing to inherit. **#13 must set `failure_mode` explicitly on all three hooks**, and
fail-closed is the setting this demo's thesis requires.

That carries a consequence worth designing for: a hook server that is down or slow blocks every
governed tool call, including `loan-app`'s read-only ones. It makes `apps/hooks` a hard
dependency of the stage demo rather than a side-car — it needs a real health check and a
rehearsal failure drill.

Two related defaults, both observed: retry is stored `enabled: false` (3 attempts, exponential
from 100ms, on 5xx / timeout / connection_error), and **a newly created extension is
`status: inactive`** — it must be activated before any hook fires. A hook that silently never
runs because the extension was left inactive is the same silent fail-open as a rule that
matches nothing.

## Confidence

Everything below was observed. Full transcript in
[`evidence/`](evidence/02-remote-mcp-hooks-transcript.md).

| Claim | |
|---|---|
| `/access`, `/pre`, `/post` all fire for a remote MCP server tool | ✅ SDK and MCP gateway paths |
| Pre-hook denial blocks before the backend; `/post` skipped | ✅ both paths |
| Access hook hides the tool from `tools/list`, and it is uncallable | ✅ act 1's mechanic |
| Namespacing algorithm — substring strip, multi-part join, `Tools` fallback, version normalisation | ✅ four inputs, all predicted exactly |
| The registered server ID is **not** an execution alias | ✅ `400 failed to parse tool name` |
| Payload identical to hosted toolkits, including `tool.metadata` | ✅ compared against a hosted tool that carries metadata in its definition |
| `tool.metadata` is never populated in hook payloads, for either kind | ✅ — see the #7 warning above |
| Requirement failures short-circuit before `/pre` | ✅ no hook fires |
| No default `failure_mode`; the field is required | ✅ |
| Extension created inactive; retry off by default | ✅ |
| Endpoint `timeout_ms` bounds 100 ms – 120 000 ms | ✅ probed |
| A denial over MCP carries no `execution_id` | ✅ see below |
| Response caching defaults | ⬜ **not exercised** — the one claim here taken from published docs rather than observed |

## Denials over MCP

<a id="denials-over-mcp"></a>

This is `DESIGN.md` risk 2, and #6 owns the decision. Measured on both paths, and they differ.

Over the **SDK execute path** a denial returns a structured error:

```json
{ "error": { "message": "Tool execution was denied by an extension policy: <error_message>",
             "kind": "CONTEXT_DENIED", "developer_message": "<error_message>" } }
```

Over an **MCP gateway** the same denial flattens to:

```json
{ "isError": true,
  "content": [{ "type": "text",
                "text": "Tool execution was denied by an extension policy: <error_message>" }] }
```

The hook saw `execution_id` on its own `/pre` payload. **The client sees no execution
identifier, no typed error kind, and no `structuredContent`.**

Two consequences:

- **Good for act 2.** The hook's `error_message` reaches the model verbatim behind a fixed
  prefix, so `DESIGN.md`'s "the hook writes the remediation instruction, not the system
  prompt" holds over MCP.
- **The panel cannot correlate exactly over MCP.** There is nothing to join on. Either the
  panel correlates heuristically, or `apps/hooks` embeds its own correlation token *into the
  `error_message` text* — which it controls — and the panel parses that back out. That second
  option is worth considering before #14 commits to a design.

## Operational findings worth carrying into #13

**The `/access` response shape is under-documented, and getting it wrong fails closed.**
`deny` and `only` take the same `Toolkits` shape as the request, so the innermost value is an
*array*:

```json
{ "deny": { "Loan": { "tools": { "ping_probe": [{ "version": "1.0.0" }] } } } }
```

Returning `{}` there instead produced, on every tool in the project:

```
-32603 Your organization's tool access policy service could not be reached
```

A malformed hook response is indistinguishable from a dead hook server. The published guide
types `only`/`deny` as "object" with no example; the canonical shape is in the public schema
repo at `ArcadeAI/schemas`, `logic_extensions/http/1.0/schema.yaml`. Validate hook responses
against that schema in CI.

**The access hook is called repeatedly, and at least once with the whole catalog.** One
`tools/list` produced four `/access` calls, one scoped to `Loan` and one enumerating every
toolkit in the project — roughly 1.6 MB. Against a 5s fail-closed timeout, `apps/hooks` must
answer that fast or every call in the project fails. No per-request I/O in the access hook
without caching.

## Incidental, outside this slice

Risk 2 got answered in passing — written up under
[Denials over MCP](#denials-over-mcp) rather than here, since it is now measured rather than a
guess. It remains #6's decision to make; pointer left on that issue.
