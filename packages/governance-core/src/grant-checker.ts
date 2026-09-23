/**
 * GrantChecker — does this grant authorise *this* call (#10).
 *
 *     (grants, request) → Validity
 *
 * Pure: no I/O, no clock, no randomness, no store. `now` is an argument.
 *
 * This is the security-critical module of the four. The approval link the
 * requester receives deliberately carries **no authority** — they can see the
 * message they sent, so they hold the link too. Possession is not permission:
 * authorization happens when the button is pressed, and it happens here.
 *
 * A grant is not a general permission. It authorises one action, on one
 * resource, up to one amount, once, for a limited time. Every one of those
 * five words is a check below, and each one that failed to fire would turn the
 * grant into the standing permission it is supposed not to be.
 *
 * ## Checking is not consuming
 *
 * `checkGrant` has no side effects and never decrements anything. `consumeGrant`
 * is the only function in this package that spends a use, and it does no
 * checking. They are two functions on purpose: a checker that quietly consumed
 * would make "check twice, act once" corrupt state, and a consumer that quietly
 * re-checked would hide a failure inside a write. The caller (#12's `/pre`
 * handler) checks, acts, then consumes and persists — and because `consumeGrant`
 * returns a plain `Grant` rather than a `ValidatedGrant`, a consumed grant
 * cannot be handed to `evaluatePermission` without going through the checker
 * again.
 *
 * ## What "valid" is worth
 *
 * The happy path ends at `attestGrantValidated`, called exactly once, which is
 * the only producer of `ValidatedGrant` and the only type `evaluatePermission`
 * accepts. The engine reads nothing of a grant beyond `subject_id`, `match` and
 * `id`; everything else a grant says — expiry, uses, approver, resource, pinned
 * inputs, ceiling — is checked here or nowhere. So this module must be run
 * against *the inputs of the call being made*, never once per grant against the
 * grant's own fields: a grant validated in the abstract and then applied to a
 * different resource at any amount is precisely the replay it exists to stop.
 *
 * ## Rejections explain themselves
 *
 * Every rejection carries a `GrantRejectionReason` — a discriminated union in
 * `@cg/policy-schema`, so the audit log and the control-plane panel can both
 * render it — plus a `message` written for a compliance reviewer. These are not
 * the strings the model reads: a blocked call's remediation instruction comes
 * from the policy rule's `reason` (see `renderReason`). A grant that fails to
 * lift a denial leaves that denial, and its instruction, in place.
 *
 * ## Time
 *
 * The window is `[issued_at, expires_at)`. A grant good "until 12:15" is not
 * good *at* 12:15.000 — expiry is the moment authority ends, not the last
 * moment it holds. Presented before `issued_at` it is `not_yet_valid`, which is
 * a mis-stamped or forged record rather than an ordinary outcome. A non-null
 * `revoked_at` is revocation, full stop, without comparing it to `now`: the
 * cautious reading of an odd record is the one that denies.
 */
import {
  Grant as GrantSchema,
  type Grant,
  type GrantRejectionReason,
  type Inputs,
  type Subject,
} from "@cg/policy-schema";

import { deepEqual, readPath } from "./inputs.ts";
import { attestGrantValidated, type ToolRef, type ValidatedGrant } from "./policy-engine.ts";

/** One grant, one call. Everything the decision depends on, nothing ambient. */
export type GrantCheck = {
  readonly grant: Grant;
  /**
   * Whoever is making the call, as the control plane resolved them. Not
   * `Subject | null`: `evaluatePermission` fails closed on an unknown subject
   * before grants are consulted, so there is no call for a grant to authorise.
   */
  readonly subject: Subject;
  readonly tool: ToolRef;
  /** The arguments of *this* call, not the ones the approval recorded. */
  readonly inputs: Inputs;
  /** Injected clock. Never read from the ambient one. */
  readonly now: Date;
};

/** Why one grant did not authorise one call. */
export type GrantRejection = {
  readonly outcome: "rejected";
  readonly grant_id: string;
  /** Structured, for the audit log and the panel. */
  readonly reason: GrantRejectionReason;
  /** One sentence of the same thing, for a human reading the audit row. */
  readonly message: string;
};

/** `checkGrant`'s two outcomes. Discriminate with `isGrantRejection`. */
export type GrantCheckResult = ValidatedGrant | GrantRejection;

/** What `selectGrant` found in a set of grants. */
export type GrantSelection = {
  /** The first grant that authorises the call, or `null` if none does. */
  readonly grant: ValidatedGrant | null;
  /**
   * Every grant that did not, with its reason — including the ones examined
   * after a valid one was found. The audit log gets the whole picture rather
   * than "the first thing that worked", which is what lets a reviewer see that
   * a stale grant was present and ignored.
   */
  readonly rejected: readonly GrantRejection[];
};

/**
 * Does `grant` authorise this exact call?
 *
 * @returns a `ValidatedGrant` — the only type `evaluatePermission` accepts — or
 *          a `GrantRejection` saying why not.
 * @throws RangeError when `now` is an invalid `Date`. That is a programming
 *         error upstream, not a governance outcome, and must not be reported as
 *         "the grant does not apply".
 */
export function checkGrant(check: GrantCheck): GrantCheckResult {
  if (Number.isNaN(check.now.getTime())) {
    throw new RangeError("checkGrant: `now` must be a valid Date");
  }

  for (const test of CHECKS) {
    const reason = test(check);
    if (reason !== null) {
      return {
        outcome: "rejected",
        grant_id: check.grant.id,
        reason,
        message: describeGrantRejection(reason),
      };
    }
  }

  // The single door into `ValidatedGrant`, and the last line of the happy path.
  return attestGrantValidated(check.grant);
}

/** Narrow `checkGrant`'s result. A `Grant` carries no `outcome` field. */
export function isGrantRejection(result: GrantCheckResult): result is GrantRejection {
  return "outcome" in result && result.outcome === "rejected";
}

/**
 * `checkGrant` over a set of grants: the first that authorises the call wins,
 * and every rejection is reported.
 *
 * Order is the caller's — for #12 that is whatever the `grants` table returns —
 * and the result does not depend on it beyond which of several *valid* grants is
 * picked. Handing this an empty set is an ordinary outcome, not an error: it is
 * what a first attempt looks like.
 */
export function selectGrant(
  check: Omit<GrantCheck, "grant"> & { readonly grants: readonly Grant[] },
): GrantSelection {
  const { grants, ...rest } = check;
  let valid: ValidatedGrant | null = null;
  const rejected: GrantRejection[] = [];

  for (const grant of grants) {
    const result = checkGrant({ ...rest, grant });
    if (isGrantRejection(result)) rejected.push(result);
    else if (valid === null) valid = result;
  }

  return { grant: valid, rejected };
}

/**
 * Spend one use of a grant. The *only* thing in this package that does.
 *
 * Pure: it returns the next state of the record and writes nothing. Persisting
 * it is the caller's job (#12 owns the `grants` table), and a grant that is not
 * persisted is not consumed — single use is enforced by the row, not by this
 * function's return value.
 *
 * The return type is `Grant`, not `ValidatedGrant`, and the returned record
 * carries no attestation: whatever was validated was validated for the call
 * that just happened. `null` uses stay `null` — unlimited within the expiry
 * window — and a grant already at zero stays at zero rather than going
 * negative, because it is `checkGrant`'s job to refuse it, not this one's to
 * count how far past its allowance it was replayed.
 */
export function consumeGrant(grant: Grant): Grant {
  const remaining = grant.uses_remaining;
  // Re-parsing rebuilds the record from the schema's own fields, which is also
  // what strips the `ValidatedGrant` attestation if one was on it.
  return GrantSchema.parse({
    ...grant,
    uses_remaining: remaining === null ? null : Math.max(0, remaining - 1),
  });
}

// ---------------------------------------------------------------------------
// The checks, in order
// ---------------------------------------------------------------------------

/**
 * Well-formedness first, then who, when, how many, what, how much.
 *
 * The order decides which reason a grant that fails several checks is reported
 * with, so it is fixed and it is this: the reason a reviewer most needs to see
 * comes first. A malformed grant is reported as malformed rather than as a
 * scope mismatch, because the fix is different — one is a bug in whatever
 * issued it, the other is the control working.
 */
type Check = (check: GrantCheck) => GrantRejectionReason | null;

const CHECKS: readonly Check[] = [
  enforceable,
  notSelfApproved,
  issuedToThisSubject,
  notRevoked,
  withinWindow,
  usesRemaining,
  scopedToThisTool,
  pinnedInputsMatch,
  withinCeiling,
];

/**
 * Is this grant capable of constraining anything at all?
 *
 * A grant that constrains nothing is worse than no grant: it is
 * indistinguishable from a grant that permits, and it looks like a working
 * control. Each of these is a way to write one down.
 */
function enforceable({ grant }: GrantCheck): GrantRejectionReason | null {
  const { match, ceiling, resource_id, pinned_inputs } = grant;

  if (match.toolkit === WILDCARD || match.tool === WILDCARD) {
    return unenforceable(
      `scoped to "${qualify(match.toolkit, match.tool)}", and a wildcard in a grant's ` +
        `match is a standing permission across every tool it covers`,
    );
  }

  for (const [field, value] of [
    ["issued_at", grant.issued_at],
    ["expires_at", grant.expires_at],
    ["revoked_at", grant.revoked_at],
  ] as const) {
    if (value !== null && Number.isNaN(Date.parse(value))) {
      return unenforceable(`its ${field} ("${value}") is not an ISO 8601 instant`);
    }
  }

  if (ceiling !== null) {
    if (!Number.isFinite(ceiling.max)) {
      return unenforceable(
        `its ceiling on "${ceiling.input}" is ${String(ceiling.max)}, which bounds nothing`,
      );
    }
    if (readPath(pinned_inputs, ceiling.input) !== undefined) {
      // A pin is equality and a ceiling is an upper bound. Pinning the input the
      // ceiling names silently replaces "up to the approved amount" with
      // "exactly the approved amount" — narrower than the approver chose, and
      // not a decision this module gets to make for them.
      return unenforceable(
        `it both pins "${ceiling.input}" and sets a ceiling on it; a pin is an equality ` +
          `and a ceiling is an upper bound, so the two contradict`,
      );
    }
  }

  if (resource_id !== null && resourceCarryingInputs(grant).length === 0) {
    // Without this, `resource_id` would be decorative: the checker has no other
    // way to know which argument names the resource, so a grant that says
    // "resource WID-1" and pins nothing would authorise the same action against
    // any resource at all.
    return unenforceable(
      `it names resource "${resource_id}" but pins no input carrying it, so nothing ` +
        `holds the call to that resource`,
    );
  }

  return null;
}

/**
 * Requester ≠ approver, checked against the grant's own fields.
 *
 * Before the subject check, and deliberately: a self-approved grant is invalid
 * whoever presents it and whatever the approval record says. This is the
 * control that makes the no-authority approval link safe — a requester who
 * clicks their own link gets a grant that cannot validate (PRD story 18).
 */
function notSelfApproved({ grant }: GrantCheck): GrantRejectionReason | null {
  return grant.granted_by === grant.subject_id
    ? { kind: "self_approved", subject_id: grant.subject_id, granted_by: grant.granted_by }
    : null;
}

function issuedToThisSubject({ grant, subject }: GrantCheck): GrantRejectionReason | null {
  return grant.subject_id === subject.user_id
    ? null
    : {
        kind: "subject_mismatch",
        granted_to: grant.subject_id,
        presented_by: subject.user_id,
      };
}

function notRevoked({ grant, now }: GrantCheck): GrantRejectionReason | null {
  return grant.revoked_at === null
    ? null
    : { kind: "revoked", revoked_at: grant.revoked_at, checked_at: iso(now) };
}

/** `[issued_at, expires_at)`. See the module note on time. */
function withinWindow({ grant, now }: GrantCheck): GrantRejectionReason | null {
  const at = now.getTime();
  if (at < Date.parse(grant.issued_at)) {
    return { kind: "not_yet_valid", issued_at: grant.issued_at, checked_at: iso(now) };
  }
  if (at >= Date.parse(grant.expires_at)) {
    return { kind: "expired", expires_at: grant.expires_at, checked_at: iso(now) };
  }
  return null;
}

function usesRemaining({ grant }: GrantCheck): GrantRejectionReason | null {
  const remaining = grant.uses_remaining;
  if (remaining === null) return null; // Unlimited within the expiry window.
  return remaining > 0 ? null : { kind: "consumed", uses_remaining: remaining };
}

/** Exact `toolkit` and `tool`. Wildcards were refused as unenforceable above. */
function scopedToThisTool({ grant, tool }: GrantCheck): GrantRejectionReason | null {
  const granted = grant.match;
  return granted.toolkit === tool.toolkit && granted.tool === tool.name
    ? null
    : {
        kind: "tool_mismatch",
        granted_for: qualify(granted.toolkit, granted.tool),
        called: qualify(tool.toolkit, tool.name),
      };
}

/**
 * Every pinned input must appear on the call with exactly the approved value.
 *
 * The inputs carrying `resource_id` are compared first so that a replay against
 * a different resource is reported as `resource_mismatch` — the reason a
 * compliance reviewer is looking for — even when another pinned input differs
 * too. Within each group, keys are compared in sorted order, so the reported
 * reason does not depend on JSON key order.
 *
 * Keys are read as dot paths, the same way a rule's condition reads `input`, so
 * a nested argument can be pinned.
 */
function pinnedInputsMatch({ grant, inputs }: GrantCheck): GrantRejectionReason | null {
  const carrying = new Set(resourceCarryingInputs(grant));
  const keys = Object.keys(grant.pinned_inputs).sort();
  const ordered = [...keys.filter((k) => carrying.has(k)), ...keys.filter((k) => !carrying.has(k))];

  for (const key of ordered) {
    const expected = grant.pinned_inputs[key];
    const actual = readPath(inputs, key);
    if (deepEqual(actual, expected)) continue;

    if (carrying.has(key) && grant.resource_id !== null) {
      return {
        kind: "resource_mismatch",
        input: key,
        granted_resource_id: grant.resource_id,
        actual: jsonSafe(actual),
      };
    }
    return {
      kind: "pinned_input_mismatch",
      input: key,
      expected: jsonSafe(expected),
      actual: jsonSafe(actual),
    };
  }

  return null;
}

/**
 * The call's own value on the bounded input must be at or below the ceiling.
 *
 * Inclusive at the bound, matching `exceeds_clearance`: an approval for 95,000
 * authorises 95,000. Above it is the replay this module exists to stop.
 *
 * A ceiling naming an input the call did not carry, or carried as something
 * other than a finite number, bounds nothing — so it is a rejection rather than
 * a pass. `"95000"` is not ninety-five thousand: numbers are never coerced, here
 * or in the PolicyEngine.
 */
function withinCeiling({ grant, inputs }: GrantCheck): GrantRejectionReason | null {
  const ceiling = grant.ceiling;
  if (ceiling === null) return null; // No numeric dimension at all.

  const actual = readPath(inputs, ceiling.input);
  if (actual === undefined || actual === null) {
    return { kind: "ceiling_input_missing", input: ceiling.input };
  }
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    return {
      kind: "ceiling_input_not_numeric",
      input: ceiling.input,
      actual: jsonSafe(actual),
    };
  }
  return actual > ceiling.max
    ? { kind: "ceiling_exceeded", input: ceiling.input, max: ceiling.max, actual }
    : null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * One sentence explaining a rejection, for the audit row and the panel.
 *
 * Written for a compliance reviewer, not for the model: it names the values
 * that produced the outcome, because "the grant was for WID-1 and the call
 * named WID-9" is an explanation and "invalid" is not (PRD stories 19–22).
 * Total over the union, so a new `kind` is a type error here rather than a
 * blank line on the panel.
 */
export function describeGrantRejection(reason: GrantRejectionReason): string {
  switch (reason.kind) {
    case "unenforceable":
      return `The grant could not be enforced: ${reason.problem}.`;
    case "self_approved":
      return (
        `The grant was approved by the same person it empowers (${reason.granted_by}), ` +
        `so separation of duties does not hold.`
      );
    case "subject_mismatch":
      return (
        `The grant was issued to ${reason.granted_to}, but the call was made by ` +
        `${reason.presented_by}.`
      );
    case "revoked":
      return `The grant was revoked at ${reason.revoked_at}.`;
    case "not_yet_valid":
      return (
        `The grant is stamped as issued at ${reason.issued_at}, which is after the call ` +
        `at ${reason.checked_at}.`
      );
    case "expired":
      return `The grant expired at ${reason.expires_at}; the call was made at ${reason.checked_at}.`;
    case "consumed":
      return "The grant has already been used and a grant authorises one action.";
    case "tool_mismatch":
      return `The grant authorises ${reason.granted_for}, but the call was to ${reason.called}.`;
    case "resource_mismatch":
      return (
        `The grant authorises resource ${render(reason.granted_resource_id)}, but the call ` +
        `passed ${render(reason.actual)} as "${reason.input}".`
      );
    case "pinned_input_mismatch":
      return (
        `The grant pins "${reason.input}" to ${render(reason.expected)}, but the call ` +
        `passed ${render(reason.actual)}.`
      );
    case "ceiling_exceeded":
      return (
        `The grant authorises "${reason.input}" up to ${reason.max}, but the call ` +
        `passed ${reason.actual}.`
      );
    case "ceiling_input_missing":
      return (
        `The grant bounds "${reason.input}", which the call did not provide, so the ` +
        `bound could not be applied.`
      );
    case "ceiling_input_not_numeric":
      return (
        `The grant bounds "${reason.input}", but the call passed ${render(reason.actual)}, ` +
        `which is not a finite number.`
      );
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const WILDCARD = "*";

function qualify(toolkit: string, tool: string): string {
  return `${toolkit}.${tool}`;
}

function unenforceable(problem: string): GrantRejectionReason {
  return { kind: "unenforceable", problem };
}

/** `GovernanceEvent`'s timestamp format, from the injected clock only. */
function iso(now: Date): string {
  return now.toISOString();
}

/**
 * Which top-level pinned inputs carry the grant's `resource_id`, anywhere in
 * their structure. This is how `resource_id` becomes enforceable without the
 * schema having to name which argument holds it — the approval flow pins the
 * inputs it approved, and the resource is one of their values.
 */
function resourceCarryingInputs(grant: Grant): string[] {
  const target = grant.resource_id;
  if (target === null) return [];
  return Object.keys(grant.pinned_inputs)
    .filter((key) => containsValue(grant.pinned_inputs[key], target))
    .sort();
}

function containsValue(value: unknown, target: string): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((item) => containsValue(item, target));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => containsValue(item, target));
  }
  return false;
}

/**
 * A value that survives the trip to the audit log unchanged.
 *
 * These reasons round-trip through `bun:sqlite` and SSE as JSON, and JSON
 * carries neither `undefined` nor a non-finite number. An absent input becomes
 * `null`, the way the rest of the vocabulary spells a meaningful emptiness; a
 * `NaN` or an infinity becomes its own name, because `JSON.stringify` would
 * otherwise turn it into `null` too and the audit row could no longer tell
 * "the call passed NaN" from "the call passed nothing".
 */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

/** A short rendering of a value for a message. */
function render(value: unknown): string {
  return typeof value === "object" && value !== null
    ? Array.isArray(value)
      ? "an array"
      : "an object"
    : JSON.stringify(value) ?? "null";
}
