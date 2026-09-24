/**
 * The bank's system of record. Owns `loans.db` and serves the loan book over
 * plain HTTP:
 *
 *     GET  /loans?status=&min_amount=&max_amount=
 *     GET  /loans/:loan_id
 *     POST /loans/:loan_id/approve   { amount }
 *     POST /loans/:loan_id/deny      { reason }
 *     GET  /health
 *     POST /admin/reset              the seeded book back (bearer RESET_TOKEN)
 *
 * Those are the module's own paths. The app mounts them under {@link MOUNT}
 * since #5, because the board page is `/loans` too: `GET /bank/loans`,
 * `GET /bank/loans/:loan_id`, `POST /bank/loans/:loan_id/approve`,
 * `POST /bank/loans/:loan_id/deny`, `GET /bank/health`,
 * `POST /bank/admin/reset`. {@link mountedFetch} is the one place the prefix
 * is known, and both the app's route (`app/bank/[...path]/route.ts`) and the
 * runner (`scripts/loans.ts`) answer through it, so a client pointed at either
 * uses the same paths.
 *
 * It looks like a bank's internal loan origination API and knows nothing
 * about governance: it does not check authority, withhold fields, or consult
 * anything before applying a write. That is the whole point — the controls
 * live outside it, in a control plane it cannot influence, and the tools that
 * call it (`tools/loan`) are stateless clients that hold no state of their
 * own. Anything that would check a caller belongs in the control plane.
 *
 * Every route under `/loans` requires a bearer token, and the actor recorded
 * on a decision is read off that token — never off the request body. See
 * `actor.ts`.
 *
 * This module depends on nothing else in the app and nothing under
 * `packages/` on purpose: it is the part a forker throws away and replaces
 * with their own domain.
 */
import type { Database } from "bun:sqlite";
import { z } from "zod";

import { ActorError, actorFromRequest } from "./actor.ts";
import { countLoans, getLoan, recordDecision, searchLoans } from "./db.ts";
import { bearerIs, handleReset, RESET_PATH } from "./reset.ts";

export const SERVICE = "loan-app";

/** Where the app serves this module's paths. See the note at the top. */
export const MOUNT = "/bank";

export interface LoanModuleOptions {
  /** The open loan book. See `openLoanBook`. */
  db: Database;
  /** HOST-form. Where bearers are presented, at `/oauth2/userinfo`. */
  idpHost: string;
  /**
   * Blank is a state, not a default: with no value the reset route does not
   * exist at all and `/health` says so. There is no development fallback,
   * because a published one would be the same as no bearer. See `reset.ts`.
   */
  resetToken: string;
}

/** What the module's own `/health` says about itself. */
export interface LoanModuleHealth {
  status: "ok";
  service: typeof SERVICE;
  loans: number;
  reset: "enabled" | "disabled";
}

export interface LoanModule {
  /** Every one of the module's own paths, unprefixed. */
  fetch(request: Request): Promise<Response>;
  health(): LoanModuleHealth;
  db: Database;
  idpHost: string;
}

const searchQuery = z.object({
  status: z.enum(["pending", "approved", "denied"]).optional(),
  min_amount: z.coerce.number().nonnegative().optional(),
  max_amount: z.coerce.number().nonnegative().optional(),
});

// `.strict()` on both: an unknown field is a 400, not something quietly
// ignored. In particular a body that tries to name its own actor is refused.
const approveBody = z.object({ amount: z.number().positive() }).strict();
const denyBody = z.object({ reason: z.string().min(1) }).strict();

const LOAN_PATH = /^\/loans\/([^/]+)(?:\/(approve|deny))?$/;

function error(status: number, message: string, issues?: unknown): Response {
  return Response.json(issues === undefined ? { error: message } : { error: message, issues }, {
    status,
  });
}

function noSuchLoan(loanId: string): Response {
  return error(404, `No loan application found with ID ${loanId}.`);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function handleLoans(
  { db, idpHost }: LoanModuleOptions,
  request: Request,
  url: URL,
): Promise<Response> {
  // Resolve the route and check the method before asking who is calling, so
  // that a wrong verb is a 405 whether or not a token came with it.
  const match = url.pathname === "/loans" ? null : LOAN_PATH.exec(url.pathname);
  if (url.pathname !== "/loans" && match === null) return error(404, "Not found");

  const action = match?.[2];
  const expected = action === undefined ? "GET" : "POST";
  if (request.method !== expected) return error(405, "Method not allowed");

  const actor = await actorFromRequest(request, idpHost);

  if (match === null) {
    const query = searchQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return error(400, "Invalid query", query.error.issues);

    const { status, min_amount, max_amount } = query.data;
    const results = searchLoans(db, {
      ...(status !== undefined && { status }),
      ...(min_amount !== undefined && { min_amount }),
      ...(max_amount !== undefined && { max_amount }),
    });
    return Response.json({ count: results.length, loans: results });
  }

  const loanId = decodeURIComponent(match[1]!);

  if (action === undefined) {
    const loan = getLoan(db, loanId);
    return loan === null ? noSuchLoan(loanId) : Response.json(loan);
  }

  const raw = await readJson(request);
  if (action === "approve") {
    const body = approveBody.safeParse(raw);
    if (!body.success) return error(400, "Invalid body", body.error.issues);

    const loan = recordDecision(db, {
      loan_id: loanId,
      decision: "approved",
      amount: body.data.amount,
      reason: null,
      decided_by: actor,
    });
    return loan === null ? noSuchLoan(loanId) : Response.json(loan);
  }

  const body = denyBody.safeParse(raw);
  if (!body.success) return error(400, "Invalid body", body.error.issues);

  const loan = recordDecision(db, {
    loan_id: loanId,
    decision: "denied",
    amount: null,
    reason: body.data.reason,
    decided_by: actor,
  });
  return loan === null ? noSuchLoan(loanId) : Response.json(loan);
}

/** The module over an open loan book. Opening it is the caller's; see `instance.ts`. */
export function createLoanModule(options: LoanModuleOptions): LoanModule {
  const { db, resetToken } = options;

  function health(): LoanModuleHealth {
    return {
      status: "ok",
      service: SERVICE,
      loans: countLoans(db),
      // Named even when it is off, so a 404 from POST /admin/reset has
      // somewhere to be explained rather than looking like a typo.
      reset: resetToken.length > 0 ? "enabled" : "disabled",
    };
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") return Response.json(health());

    if (url.pathname === RESET_PATH) {
      // A 404 and not a 403 when unset, so a deployment that never configured
      // this is indistinguishable from one that never had the route.
      if (resetToken.length === 0) return error(404, "Not found");
      if (!bearerIs(request, resetToken)) return error(401, "Unauthorized");
      return handleReset(request, db);
    }

    if (url.pathname === "/loans" || url.pathname.startsWith("/loans/")) {
      try {
        return await handleLoans(options, request, url);
      } catch (cause) {
        if (cause instanceof ActorError) return error(cause.status, cause.message);
        throw cause;
      }
    }

    return error(404, "Not found");
  }

  return { fetch, health, db, idpHost: options.idpHost };
}

/**
 * The module as the app lays it out: its paths under {@link MOUNT}, nothing
 * anywhere else. The prefix is taken off and the request handed on otherwise
 * untouched — same method, same headers, same body, same query.
 */
export function mountedFetch(handle: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const rest = url.pathname.startsWith(`${MOUNT}/`) ? url.pathname.slice(MOUNT.length) : null;
    if (rest === null) return error(404, "Not found");
    url.pathname = rest;
    // The body is read and handed over rather than streamed, so this works
    // the same under Next's request wrapper as under `Bun.serve`.
    const bodyless = request.method === "GET" || request.method === "HEAD";
    return handle(
      new Request(url, {
        method: request.method,
        headers: request.headers,
        ...(bodyless ? {} : { body: await request.arrayBuffer() }),
      }),
    );
  };
}
