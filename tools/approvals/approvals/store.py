"""The approvals store: the control plane, over HTTP.

This toolkit holds no state, exactly as `tools/loan` holds none. A deployed
`arcade deploy` worker is an ephemeral container, and — the reason that matters
here — the approval page in #19 runs in `apps/web` and has to read the record
the tool wrote. A record living inside the worker would be a record nobody can
open. So the request is persisted where `DESIGN.md` says approvals live:
`governance.db`, owned by `apps/hooks`, reached over the public internet the
same way Arcade reaches the hooks themselves.

`apps/hooks` does not serve these four endpoints yet — #12 is the service and
#19 is the approval flow. What lands here is the client and the contract.

**The contract is written down in Markdown, not here.** See "The approvals
store contract" in `tools/approvals/README.md`: request and response bodies,
the one record shape every endpoint returns, and the authorization rule. A #19
implementer works in TypeScript and should not have to read Python to build
against it, and one copy cannot drift from the other. `tests/conftest.py`
implements that contract and `tests/test_store_contract.py` drives every
endpoint of it over real HTTP, so the prose has an executable counterpart.

The four endpoints, in one line each:

    GET  /approvals/roster        every subject the control plane knows, for routing
    POST /approvals               create; the store mints the id and the clock
    GET  /approvals/{id}          read one by opaque id — #19's page, not this toolkit
    POST /approvals/{id}/decision record an outcome

Three of them have a client below. `GET /approvals/{id}` deliberately does not:
nothing in this toolkit reads a request back, #19 reads it from TypeScript, and
a Python client nobody calls is dead code in a deployed worker. It is covered
by `test_store_contract.py` instead, which drives it with a plain HTTP client —
the contract is exercised without inventing a caller for it.

`decided_by` and `requester_id` travel in the body, and that is worth being
explicit about because `apps/loan-app` deliberately does the opposite. There,
the actor comes from the OAuth token and never from a parameter, because the
model chooses the arguments. Here the value is `context.user_id` — Arcade's
identity for the caller, read server-side inside the tool, not a tool argument
the model can write. The model cannot reach it. What stops an unrelated caller
reaching the endpoints is `APPROVALS_STORE_TOKEN`, required on **all four**:
without it, anyone on the internet could manufacture the approval request a
human then acts on, or read one.
"""

from __future__ import annotations

from typing import Any

import httpx
from arcade_core.errors import ToolExecutionError

from approvals.routing import Subject

__all__ = [
    "APPROVALS_STORE_TOKEN_SECRET",
    "HOOKS_HOST_SECRET",
    "WEB_HOST_SECRET",
    "base_url",
    "create_request",
    "fetch_roster",
    "record_decision",
]

#: HOST-form, like every service address in this repo. Delivered to the
#: deployed toolkit as Arcade secrets, uploaded by `arcade deploy` from `.env`,
#: because that is the one configuration channel a deployed toolkit has.
HOOKS_HOST_SECRET = "HOOKS_PUBLIC_HOST"
WEB_HOST_SECRET = "WEB_PUBLIC_HOST"
#: Shared bearer the control plane requires on the approvals endpoints.
APPROVALS_STORE_TOKEN_SECRET = "APPROVALS_STORE_TOKEN"


def base_url(host: str) -> str:
    """HOST-form to URL. http for localhost, https everywhere else."""
    local = host.startswith("localhost") or host.startswith("127.0.0.1")
    return f"{'http' if local else 'https'}://{host}"


async def _call(
    host: str,
    token: str,
    method: str,
    path: str,
    *,
    json: dict[str, Any] | None = None,
) -> Any:
    url = base_url(host) + path
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.request(method, url, json=json, headers=headers)
        except httpx.HTTPError as exc:
            raise ToolExecutionError(
                "The approvals service could not be reached, so no approval was requested.",
                developer_message=f"{method} {url}: {exc!r}",
            ) from exc

    if response.is_success:
        return response.json()

    try:
        detail = response.json().get("error", response.text)
    except ValueError:
        detail = response.text
    raise ToolExecutionError(
        str(detail),
        developer_message=f"{method} {url} -> {response.status_code}: {response.text}",
    )


async def fetch_roster(host: str, token: str) -> list[Subject]:
    """Everyone the control plane knows about, for routing to choose among."""
    body = await _call(host, token, "GET", "/approvals/roster")
    return [Subject.from_dict(raw) for raw in body.get("subjects", [])]


async def create_request(host: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Persist the routed request. Returns `{"request": …, "rule": … | None}`."""
    return await _call(host, token, "POST", "/approvals", json=payload)


async def record_decision(
    host: str, token: str, request_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    """Record an outcome against an existing request. Returns `{"request": …}`."""
    return await _call(host, token, "POST", f"/approvals/{request_id}/decision", json=payload)
