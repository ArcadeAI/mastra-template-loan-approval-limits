/**
 * Reading the approvals store, from the server side of `apps/web`.
 *
 * The approval page is built on `GET /approvals/{id}` and nothing else: the
 * link in the Slack message carries an opaque id, with no token, no signature
 * and no query string, so that response has to be enough to render the whole
 * page. It is — see the record shape in `tools/approvals/README.md`.
 *
 * **A 200 here is not authorization.** The requester can read the DM she sent,
 * so she can open the link too, and this endpoint answers her exactly as it
 * answers the approver. Whether the person looking may *decide* is settled
 * when the button is pressed, by a `/pre` decision on `Approvals.Decide`.
 * Nothing in this module should ever grow a "may this viewer see it" branch;
 * that question has an answer, and it is not here.
 */
import { ApprovalRecord } from "@cg/policy-schema";

import { baseUrl, type WebConfig } from "./config.ts";

/** What reading the store takes: where this server reaches it, and its bearer. */
type StoreConfig = Pick<WebConfig, "controlPlaneHost" | "approvalsStoreToken">;

export type ApprovalLookup =
  | { found: true; request: ApprovalRecord }
  | { found: false; reason: string };

export interface RosterEntry {
  user_id: string;
  display_name: string;
  role: string;
  clearance: number;
}

export async function fetchApproval(id: string, config: StoreConfig): Promise<ApprovalLookup> {
  const response = await get(`/api/approvals/${encodeURIComponent(id)}`, config);

  if (response.status === 404) {
    return { found: false, reason: `No approval request ${id} exists.` };
  }
  if (!response.ok) {
    return {
      found: false,
      reason: `The control plane answered ${response.status} for ${id}.`,
    };
  }

  const body = (await response.json()) as { request?: unknown };
  // Parsed rather than trusted: a record the page could not render is better
  // caught here, with a field path, than as a blank on stage.
  return { found: true, request: ApprovalRecord.parse(body.request) };
}

export async function fetchRoster(config: StoreConfig): Promise<RosterEntry[]> {
  const read = await readRoster(config);
  return read.ok ? read.subjects : [];
}

/**
 * Every subject in `governance.db`, or why they could not be read.
 *
 * The same read as {@link fetchRoster}, for a caller that must not mistake
 * "the control plane did not answer" for "nobody is in the cast" (#32): the
 * sign-in card says *not in the cast* only when the roster came back and the
 * address is not in it.
 */
export type RosterRead = { ok: true; subjects: RosterEntry[] } | { ok: false; reason: string };

export async function readRoster(config: StoreConfig): Promise<RosterRead> {
  let response: Response;
  try {
    response = await get("/api/approvals/roster", config);
  } catch (cause) {
    return { ok: false, reason: `the control plane could not be reached: ${String(cause)}` };
  }
  if (!response.ok) return { ok: false, reason: `the control plane answered ${response.status}` };
  const body = (await response.json()) as { subjects?: unknown; policy?: unknown };
  if (body.policy !== undefined && body.policy !== "ready") {
    return { ok: false, reason: `the control plane's policy is ${String(body.policy)}, so it has no roster to give` };
  }
  if (!Array.isArray(body.subjects)) return { ok: false, reason: "the control plane's roster carried no subjects list" };
  return { ok: true, subjects: body.subjects as RosterEntry[] };
}

function get(path: string, config: StoreConfig): Promise<Response> {
  return fetch(`${baseUrl(config.controlPlaneHost)}${path}`, {
    headers: { authorization: `Bearer ${config.approvalsStoreToken}` },
    // The page must show what the store holds now, not what it held when the
    // route was last rendered: a decision made thirty seconds ago has to be
    // visible on a refresh.
    cache: "no-store",
  });
}
