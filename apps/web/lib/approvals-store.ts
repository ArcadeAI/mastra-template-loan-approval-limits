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

export type ApprovalLookup =
  | { found: true; request: ApprovalRecord }
  | { found: false; reason: string };

export interface RosterEntry {
  user_id: string;
  display_name: string;
  role: string;
  clearance: number;
}

export async function fetchApproval(id: string, config: WebConfig): Promise<ApprovalLookup> {
  const response = await get(`/approvals/${encodeURIComponent(id)}`, config);

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

export async function fetchRoster(config: WebConfig): Promise<RosterEntry[]> {
  const response = await get("/approvals/roster", config);
  if (!response.ok) return [];
  const body = (await response.json()) as { subjects?: RosterEntry[] };
  return body.subjects ?? [];
}

function get(path: string, config: WebConfig): Promise<Response> {
  return fetch(`${baseUrl(config.hooksHost)}${path}`, {
    headers: { authorization: `Bearer ${config.approvalsStoreToken}` },
    // The page must show what the store holds now, not what it held when the
    // route was last rendered: a decision made thirty seconds ago has to be
    // visible on a refresh.
    cache: "no-store",
  });
}
