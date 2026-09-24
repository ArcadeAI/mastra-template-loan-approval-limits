/**
 * Same shape as the `/health` endpoints on `hooks` and `loan-app`, so the
 * Render blueprint can point all three services at one path.
 *
 * **Five fields, and they arrived from three different slices.** Each is a
 * thing a human configures by hand, each fails on its own, and each fails at a
 * point where nothing else on screen would say so.
 *
 * Since #82: `signin`, `gateway` and `verifier` — sign-in, the gateway hop and
 * the custom verifier depend on variables set by hand in the Render dashboard
 * and in the Arcade dashboard, and two of the three fail at a step no hook
 * observes, so an unset one is otherwise discovered mid-rehearsal as "the demo
 * does nothing". They say `configured` or `missing` and never which value is
 * wrong, because the value is a credential in two cases out of three.
 *
 * Since #14: `agent`. A cg-web with no `ANTHROPIC_API_KEY` signs Alice in, holds
 * a gateway token and answers the verifier — and then `/chat` answers 503 the
 * first time somebody presses Send.
 *
 * Since #81: `panel_stream` — `live`, `fixture` or `unconfigured`. The odd one
 * out, because it has three answers rather than two: a panel can be watching
 * the live control plane, replaying the fixture on purpose, or watching
 * nothing. Only the last is a fault; `fixture` is a mode somebody chose and the
 * panel says so on screen. It failed quietly for every production deploy
 * between #21 and #81 — the panel replayed a fixture and nothing, here or on
 * screen, said the live control plane was never being watched.
 *
 * It still does not read `APPROVALS_STORE_TOKEN`'s production guard, and it
 * answers `200` whatever it finds — a health check that fails on a
 * misconfiguration would take the service out of rotation instead of telling
 * anyone what to fix, and Render would abandon the deploy before anybody could
 * read this. The refusal lives in the body (`"status":"degraded"`), on the home
 * page, and in the 503 every identity route and the chat route answer.
 * That is what `readIdentitySurface` is for: the same environment, read without
 * the guard that belongs to a credential this endpoint does not use. *
 * **Since #4 this is the control plane's `/health` too**, because the control
 * plane is a module of this app and `/health` is the path its hook contract
 * names (`HOOK_ENDPOINT_PATHS.healthCheck`). One response, per DESIGN.md
 * §Readiness: `policy`, `fixture_drift`, `injection_detection` and `warnings`
 * are the control plane's own fields, lifted to the top level as `cg-hooks`
 * reported them, and they count towards `status` — a policy that will not
 * compile, or a disk whose policy is not the shipped fixture, is `degraded`
 * exactly as it was on `cg-hooks`. `reset` is one value now, because one
 * process holds one `RESET_TOKEN`. Everything else `cg-hooks` said about
 * itself (row counts, the migration report, stream clients, the contract
 * version) is under `control_plane`, with its own roll-up in
 * `control_plane.status`, which is what the panel's strip reads.
 *
 * **Since #5 it is the loan book's `/health` too**, because the loan module is
 * part of this app (`lib/loans/`). `loans` is `{ status: "ok", count }`, or
 * `{ status: "failed", count: null, error }` when `loans.db` did not open, and
 * a failed loan book is `degraded`. Never a bare count: `cg-loan-app` answered
 * `loans: <n>`, and `0` read the same whether the book was empty or the
 * database never opened. The module's own answer, with the count as a number,
 * is still at `/bank/health`. `reset` covers `POST /bank/admin/reset` too: the
 * same `RESET_TOKEN` decides it.
 */
import { deploymentReadiness, readIdentitySurface } from "../../lib/config.ts";
import { bootedControlPlane, controlPlaneFailure } from "../../lib/control-plane/instance.ts";
import { panelStreamHealth } from "../../lib/governance/stream-url.ts";
import { loanBookHealth } from "../../lib/loans/instance.ts";

export const dynamic = "force-dynamic";

export function GET() {
  // `deploymentReadiness` owns the four `configured`/`missing` capabilities and
  // its own roll-up; `panel_stream` is read separately because it is not one of
  // them — see the note above about it having three answers.
  const { status: deployment, ...capabilities } = deploymentReadiness(readIdentitySurface());
  const panel_stream = panelStreamHealth(process.env);
  // Read in-process: this process's `loans.db` (#5).
  const loans = loanBookHealth();

  // The control plane's own report (#4). Read in-process: it is this process's
  // policy cache and this process's `governance.db`.
  const {
    status: controlPlaneStatus,
    policy,
    injection_detection,
    fixture_drift,
    reset,
    warnings,
    ...controlPlane
  } = controlPlaneReport();

  // `status` first, because it is the field anybody actually reads. `ok` only
  // when every capability is configured, the panel is watching something, and
  // the control plane is `healthy` (a compiled policy that matches the shipped
  // fixture) — and still HTTP 200, so Render brings the instance up and a
  // human can read the fields that say which one. #86, #88, #4 and #5 each
  // added a term to this expression; a deployment that satisfies some and not
  // all is `degraded`.
  const status =
    deployment === "ok" &&
    panel_stream !== "unconfigured" &&
    controlPlaneStatus === "healthy" &&
    loans.status === "ok"
      ? "ok"
      : "degraded";

  // Since #106: whether the panel's Reset control is drawn at all, and since #4
  // whether `POST /admin/reset` exists — the same `RESET_TOKEN` decides both.
  // Reported and deliberately NOT folded into `status`: a deployment nobody is
  // presenting from is right to leave `RESET_TOKEN` unset, and calling that
  // degraded would teach a reader to ignore the word. It is here because the
  // alternative is the one thing this project keeps refusing: a control that
  // is absent, and no surface that says so.
  return Response.json({
    status,
    service: "web",
    ...capabilities,
    panel_stream,
    policy,
    fixture_drift,
    injection_detection,
    loans,
    reset,
    warnings,
    control_plane: { status: controlPlaneStatus, ...controlPlane },
  });
}

/**
 * The control plane's `/health` fields, or — when it did not boot — the same
 * fields saying so. Never throws: this endpoint answers 200 whatever it finds,
 * and a boot failure is exactly the thing a human opens it to read.
 */
function controlPlaneReport() {
  const failure = controlPlaneFailure();
  if (failure === null) return bootedControlPlane().plane.health();
  return {
    status: "degraded" as const,
    policy: { status: "failed", revision: null, error: failure },
    injection_detection: null,
    fixture_drift: null,
    reset: "disabled" as const,
    warnings: [`the control plane did not boot and every /access, /pre and /post call is being refused: ${failure}`],
    error: failure,
  };
}
