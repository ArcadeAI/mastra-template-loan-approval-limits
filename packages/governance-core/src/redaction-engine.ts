/**
 * RedactionEngine — what comes back (#8). Pure: no I/O, no clock, no
 * randomness, no imports from any app, no business-domain vocabulary.
 *
 *     (output, rules) → { output, redactions[] }
 *
 * The other three control points decide whether a call happens. This one
 * decides what the model is allowed to *read* once it has. A correctly
 * authorised call still returns a payload straight into the model's context,
 * carrying identifiers nobody meant to expose and free text that somebody
 * else wrote — and the model is the adversary, so the inspection cannot be
 * delegated to it.
 *
 * **No model is used to police model output.** Deliberately, per the PRD:
 * asking the adversary to guard the gate contradicts the thesis, and it would
 * add a model round-trip to every tool result. Everything here is declarative
 * and deterministic — named field paths, and regular expressions over free
 * text.
 *
 * ## Two mechanisms, one pass
 *
 * A rule carries `fields` and `patterns` and commonly wants both: pull the
 * things you can name, then sweep what is left for the shapes you can
 * recognise. Fields run first within a rule, so a value that has already been
 * pulled is not still sitting there for the sweep to find — and a sweep that
 * ran first would leave a partially-mangled value behind for the field rule to
 * replace, producing two redaction records for one secret.
 *
 * ## Every applicable rule fires
 *
 * Unlike the PolicyEngine, this is not first-match-wins. Redaction is
 * cumulative: a higher-priority rule that stopped evaluation would silently
 * cancel the protections of every rule below it, which is precisely the failure
 * this project is about. `priority` and `id` order the rules so the result is
 * deterministic, not so that one rule can suppress another.
 *
 * ## Idempotence, by construction
 *
 * Two rules, in this order.
 *
 * **The whole transformation runs to a fixed point** — field rules and pattern
 * sweeps together, not the sweep alone. Settling half of an operation says
 * nothing about applying the other half again, so the pair is iterated until a
 * pass leaves the payload alone, and what `redact` returns is by definition
 * something another `redact` does not change. If a *string* has not settled
 * within the sweep's bound the engine withholds it (`unsettled`) rather than
 * handing over whichever revision the loop stopped on.
 *
 * **Every string the engine can write is inert to every scanner.** A field's
 * marker, a pattern's replacement, and the withheld sentinel are all text the
 * engine puts into the payload; a pattern that can match one would rewrite it on
 * the next call. `checkMarkersAreInert` refuses that at compile time — three
 * rounds of review found three different strings in this set, so the check is
 * stated over the set rather than over the case in front of it.
 *
 * **A redaction is recorded by comparing the value, not by counting the steps.**
 * Patterns that rewrite a string and hand it back unchanged have collectively
 * done nothing, and `redactions[]` — which the panel renders and the audit log
 * keeps — says so. A removal that removed nothing is a lie in both places.
 *
 * This was learned the hard way, in review: the first version enforced "record
 * only what changed" per application and tried to catch cycles at compile time.
 * Lookaheads make a replacement a prefix of what another pattern matches without
 * matching it in isolation, so the check could always be walked around — and one
 * such policy did not merely mis-record, it returned a *different payload* on
 * every call. Recognising bad policies was the wrong shape of defence; not
 * depending on recognising them is the right one.
 *
 * ## Fail closed means redact *more*
 *
 * When the subject cannot be resolved, every subject-conditioned rule applies.
 * At `/pre` failing closed means denying; here it means withholding, so an
 * unrecognised caller receives the most redacted payload rather than the least.
 *
 * ## Loudness
 *
 * A rule that matches nothing is indistinguishable, at runtime, from a rule
 * that permits — and a redaction rule that matches nothing looks exactly like a
 * payload with nothing sensitive in it. So `compileOutputPolicy` refuses, up
 * front and with every problem listed, a rule naming a toolkit or tool the
 * catalogue does not list, a malformed field path, an unparseable regex, a
 * regex that can match the empty string, a subject matcher that can never
 * match, and a rule that would redact nothing at all.
 *
 * The marker check is the one exception to "diagnostic, not guarantee": nothing
 * at runtime can make a scanner stop matching the sentinel, so that one is load
 * bearing. The rest are early warnings — a policy they wave through is still
 * safe, because the runtime settles it either way; they exist so the obvious
 * mistakes are caught at seed time with a message rather than at `/post` with a
 * withheld field.
 */
import type {
  OutputRule,
  RedactionRecord,
  RedactionStrategy,
  Subject,
  ToolMatcher,
} from "@cg/policy-schema";

import { deepEqual } from "./inputs.ts";
import { checkSubjectMatcher, matchesSubject } from "./subjects.ts";
import type { SubjectOrUnknown, ToolCatalogue, ToolRef } from "./policy-engine.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The output policy as loaded from the output-rule table plus configuration. */
export type OutputPolicy = {
  /**
   * The same catalogue the PolicyEngine compiles against — the `ARCADE_*_TOOLKIT`
   * values from config, never hardcoded. Only the tool *names* are read here;
   * the argument lists belong to the pre-hook. Sharing the object is the point:
   * one place to be wrong about what a tool is called, rather than two.
   */
  readonly catalogue: ToolCatalogue;
  readonly rules: readonly OutputRule[];
};

/** An `OutputPolicy` that `compileOutputPolicy` has validated and prepared. */
export type CompiledOutputPolicy = {
  readonly rules: readonly CompiledOutputRule[];
  /** Brand: only `compileOutputPolicy` produces one of these. */
  readonly [COMPILED]: true;
};

/** What `redact` is asked about. */
export type RedactionInput = {
  /**
   * The tool's output, exactly as it came back. Never mutated: the caller still
   * holds the original afterwards, which is what lets the audit row carry a
   * `before` alongside the `after`.
   */
  readonly output: unknown;
  /** The subject the payload is destined for, or `null` when nobody matched. */
  readonly subject: SubjectOrUnknown;
  readonly tool: ToolRef;
  readonly policy: CompiledOutputPolicy;
};

/**
 * What came back, and an account of what was taken out of it.
 *
 * `redactions` is empty exactly when `output` is the untouched input — and in
 * that case `output` is the very same reference, so a caller can tell "nothing
 * to redact" from "redacted to something identical" without a deep compare.
 */
export type RedactionResult = {
  readonly output: unknown;
  readonly redactions: readonly RedactionRecord[];
};

/** Raised by `compileOutputPolicy`. `problems` has one line per offending rule. */
export class OutputPolicyCompileError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Output policy failed to compile:\n  - ${problems.join("\n  - ")}`);
    this.name = "OutputPolicyCompileError";
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const COMPILED: unique symbol = Symbol("compiled-output-policy");

const WILDCARD = "*";

/**
 * One step of a field path.
 *
 * `all` is the `[]` wildcard — every element of the array at that position. It
 * is what makes a rule reach into a list of records without knowing how long
 * the list is, which is the difference between redacting a history and
 * redacting the first row of one.
 */
type Segment =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "all" };

type CompiledField = {
  readonly segments: readonly Segment[];
  readonly strategy: RedactionStrategy;
  readonly replacement: string;
  /** As written in the rule, for error messages. */
  readonly source: string;
};

type CompiledPattern = {
  readonly id: string;
  readonly strategy: RedactionStrategy;
  readonly replacement: string;
  /**
   * Two regexes from one source, because one cannot do both jobs safely. The
   * global form drives `String.replace`; the probe answers "does this match?"
   * without a `g` flag, whose `lastIndex` would carry state between calls and
   * make the engine's answer depend on what it was asked previously.
   */
  readonly global: RegExp;
  readonly probe: RegExp;
};

type CompiledOutputRule = {
  readonly id: string;
  readonly priority: number;
  readonly match: ToolMatcher;
  readonly subjects: OutputRule["subjects"];
  readonly fields: readonly CompiledField[];
  readonly patterns: readonly CompiledPattern[];
};

/**
 * Where a transform reports what it did. Candidates rather than records — the
 * caller decides which survive, by comparing the payload it got back with the
 * one it passed in.
 */
type Note = (record: RedactionRecord) => void;

/** One pattern, and the rule that contributed it to this call's sweep. */
type Scanner = {
  readonly ruleId: string;
  readonly pattern: CompiledPattern;
};

/**
 * What the model gets instead of a string whose redaction would not settle.
 * Deliberately says which of the two it is — a value withheld because the policy
 * is broken, not a secret that was found.
 */
const WITHHELD = "[withheld: unsettled redaction]";

/**
 * How many times the whole transformation may be re-applied before the engine
 * gives up on it settling. Two is what a well-formed policy needs — one pass
 * that changes the payload, one that confirms nothing more applies — and the
 * rest is slack for a policy the marker check did not catch.
 */
const TRANSFORM_PASS_LIMIT = 8;

/** Returned by an edit that deletes rather than substitutes. */
const DROP: unique symbol = Symbol("drop");

/**
 * A field path: optional `$` root, then `.key` steps and `[n]` / `[]`
 * subscripts. Anchored, so `a..b`, `a.`, `a[b]` and `` are all refused rather
 * than half-parsed into a path that addresses something the author did not mean.
 */
const PATH_STEP = /^(?:\.?([A-Za-z_][A-Za-z0-9_-]*)|\[(\d*)\])/;

/** Regex flags we accept. `g` is added by the engine; `y` is refused below. */
const FLAG = /^[dgimsuvy]*$/;

// ---------------------------------------------------------------------------
// Compilation — the loud part
// ---------------------------------------------------------------------------

/**
 * Validates an output policy against its configuration and prepares it for
 * evaluation. Throws `OutputPolicyCompileError` listing *every* problem, so a
 * seed file with three typos is fixed in one round.
 *
 * Rules are ordered by ascending `priority`, ties broken by `id`, so the
 * resulting `redactions[]` is in the same order whatever order the table
 * returned rows in. Disabled rules are dropped here rather than skipped on
 * every call.
 */
export function compileOutputPolicy(policy: OutputPolicy): CompiledOutputPolicy {
  const problems: string[] = [];
  const catalogue = readCatalogue(policy.catalogue, problems);

  const seenIds = new Set<string>();
  const compiled: CompiledOutputRule[] = [];

  for (const rule of policy.rules) {
    const say = (message: string): void => {
      problems.push(`rule "${rule.id}" ${message}`);
    };

    if (seenIds.has(rule.id)) {
      say(`is declared more than once; ids must be unique or the audit trail is ambiguous`);
    }
    seenIds.add(rule.id);

    checkMatch(rule.match, catalogue, say);

    if (rule.subjects !== null) {
      for (const problem of checkSubjectMatcher(rule.subjects)) say(problem);
    }

    if (rule.reason.trim() === "") {
      say(`has an empty reason, so the panel would show a redaction that explains nothing`);
    }

    if (rule.fields.length === 0 && rule.patterns.length === 0) {
      say(`declares no fields and no patterns, so it can never redact anything`);
    }

    const fields = compileFields(rule, say);
    const patterns = compilePatterns(rule, say);

    if (!rule.enabled) continue;
    compiled.push({
      id: rule.id,
      priority: rule.priority,
      match: rule.match,
      subjects: rule.subjects,
      fields,
      patterns,
    });
  }

  checkMarkersAreInert(compiled, problems);

  if (problems.length > 0) throw new OutputPolicyCompileError(problems);

  compiled.sort(byPriorityThenId);
  return { rules: compiled, [COMPILED]: true };
}

/** The catalogue as a lookup, with the same emptiness check the PolicyEngine makes. */
function readCatalogue(
  catalogue: ToolCatalogue,
  problems: string[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [toolkit, tools] of Object.entries(catalogue)) {
    const names = Object.keys(tools);
    if (names.length === 0) {
      problems.push(
        `catalogue: toolkit "${toolkit}" lists no tools, so nothing in it can be governed`,
      );
    }
    out.set(toolkit, new Set(names));
  }
  return out;
}

/**
 * A rule keyed on a tool the catalogue does not list matches nothing, and a
 * redaction that matches nothing is indistinguishable from a payload with
 * nothing sensitive in it. Tool identifiers are case-sensitive strings from
 * config, so this is where a wrong one is caught.
 */
function checkMatch(
  match: ToolMatcher,
  catalogue: ReadonlyMap<string, ReadonlySet<string>>,
  say: (message: string) => void,
): void {
  if (match.toolkit === WILDCARD) {
    if (match.tool !== WILDCARD && ![...catalogue.values()].some((t) => t.has(match.tool))) {
      say(`matches tool "${match.tool}", which no catalogued toolkit serves`);
    }
    return;
  }
  const tools = catalogue.get(match.toolkit);
  if (tools === undefined) {
    say(
      `matches toolkit "${match.toolkit}", which the catalogue does not list; ` +
        `toolkit names are case-sensitive and come from configuration`,
    );
    return;
  }
  if (match.tool !== WILDCARD && !tools.has(match.tool)) {
    say(
      `matches tool "${match.toolkit}.${match.tool}", which that toolkit does not serve; ` +
        `tool names are case-sensitive and come from configuration`,
    );
  }
}

function compileFields(rule: OutputRule, say: (message: string) => void): CompiledField[] {
  const out: CompiledField[] = [];
  const seen = new Set<string>();
  for (const field of rule.fields) {
    if (seen.has(field.path)) {
      say(`redacts field path "${field.path}" twice; the second is dead`);
      continue;
    }
    seen.add(field.path);

    const segments = parsePath(field.path);
    if (segments === null) {
      say(
        `has an unparseable field path "${field.path}"; write it as ` +
          `"a.b", "a[0].b" or "a[].b", optionally rooted at "$"`,
      );
      continue;
    }
    const last = segments.at(-1);
    if (field.strategy === "remove" && last?.kind === "index") {
      // The path names a *position*, and removing one renumbers everything
      // after it: the rule means something different on its second run, and on
      // a payload where the tool returned one fewer row it removes a different
      // record entirely. Neither is what anyone writing "history[1]" intended.
      say(
        `removes "${field.path}", an array element addressed by index; removing it renumbers ` +
          `the elements after it, so the rule would not mean the same thing twice — ` +
          `use "[]" to remove every element, or name a key inside the element`,
      );
      continue;
    }

    out.push({
      segments,
      strategy: field.strategy,
      replacement: field.replacement,
      source: field.path,
    });
  }
  return out;
}

function compilePatterns(rule: OutputRule, say: (message: string) => void): CompiledPattern[] {
  const out: CompiledPattern[] = [];
  const seen = new Set<string>();
  for (const pattern of rule.patterns) {
    if (seen.has(pattern.id)) {
      say(`declares pattern "${pattern.id}" twice; ids must be unique within a rule`);
      continue;
    }
    seen.add(pattern.id);

    if (!FLAG.test(pattern.flags)) {
      say(`gives pattern "${pattern.id}" the unrecognised flags "${pattern.flags}"`);
      continue;
    }
    if (pattern.flags.includes("y")) {
      // Sticky anchors every attempt at `lastIndex`, so a scan finds a match at
      // the start of a field and nothing anywhere else in it. That is a scanner
      // that appears to work on the one fixture it was written against.
      say(`gives pattern "${pattern.id}" the sticky flag, which would scan only from position 0`);
      continue;
    }

    const declared = pattern.flags.replace(/g/g, "");
    let global: RegExp;
    let probe: RegExp;
    try {
      global = new RegExp(pattern.regex, `${declared}g`);
      probe = new RegExp(pattern.regex, declared);
    } catch (error) {
      say(
        `has an invalid regular expression for pattern "${pattern.id}": ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (probe.test("")) {
      // `"abc".replace(/x*/g, "[R]")` is `"[R]a[R]b[R]c[R]"`. A pattern that can
      // match nothing rewrites every string it is pointed at, everywhere, and
      // the result still looks like redaction.
      say(`has a pattern "${pattern.id}" that matches the empty string, so it would match everywhere`);
      continue;
    }

    out.push({
      id: pattern.id,
      strategy: pattern.strategy,
      replacement: pattern.replacement,
      global,
      probe,
    });
  }
  return out;
}

/**
 * **Every string the engine can write must be inert to every scanner.**
 *
 * That is the whole invariant, and it covers three kinds of string: a field's
 * `mask`/`replace` marker, a pattern's replacement, and the sentinel the engine
 * substitutes for a value whose redaction would not settle. Each of them is
 * text the engine puts into the payload; if a pattern can match one, the next
 * call rewrites it, and the payload the model got is not the payload it gets
 * next time.
 *
 * Learned in three rounds of review of #8, each finding a different string that
 * was not covered: a pattern's own replacement, then another rule's, then the
 * withheld sentinel itself. So the check is stated over the *set* of strings the
 * engine can write rather than over the case in front of it.
 *
 * The test is `regex.test(marker)` — a partial match anywhere in the string, not
 * an anchored one — because a pattern that matches part of a marker rewrites
 * part of it, which is enough.
 *
 * Two scoping rules, and they differ on purpose:
 *
 * - A **rule's marker** is only ever swept by the patterns that run on the same
 *   call, so it is checked against rules whose tool matchers overlap. Unrelated
 *   toolkits can reuse a marker string.
 * - The **sentinel** is checked against every pattern in the policy, with no
 *   overlap test. Any rule is applicable on some call, and on that call some
 *   value may fail to settle — so there is no pattern anywhere in the policy
 *   that is safe to let match it.
 *
 * This is a compile-time diagnostic and the runtime does not depend on it being
 * complete: `redact` runs the whole transformation to a fixed point regardless.
 * The check is what turns "your policy is broken" into a message at seed time
 * instead of a withheld field on stage.
 */
function checkMarkersAreInert(rules: readonly CompiledOutputRule[], problems: string[]): void {
  const markers = rules.flatMap((rule) => [
    ...rule.fields
      .filter((field) => field.strategy !== "remove")
      .map((field) => ({ rule, what: `field "${field.source}"`, text: field.replacement })),
    ...rule.patterns
      .filter((pattern) => pattern.strategy !== "remove")
      .map((pattern) => ({ rule, what: `pattern "${pattern.id}"`, text: pattern.replacement })),
  ]);

  for (const marker of markers) {
    for (const rule of rules) {
      if (!toolMatchersOverlap(marker.rule.match, rule.match)) continue;
      for (const pattern of rule.patterns) {
        if (!pattern.probe.test(marker.text)) continue;
        const scanner =
          rule.id === marker.rule.id
            ? `pattern "${pattern.id}"`
            : `pattern "${pattern.id}" of rule "${rule.id}"`;
        problems.push(
          `rule "${marker.rule.id}" leaves a replacement for ${marker.what} that ${scanner} ` +
            `matches, so the payload would not settle: each pass would redact the last pass's ` +
            `marker and record a removal that removed nothing`,
        );
      }
    }
  }

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (!pattern.probe.test(WITHHELD)) continue;
      problems.push(
        `rule "${rule.id}" has a pattern "${pattern.id}" that matches the engine's withheld ` +
          `sentinel ${JSON.stringify(WITHHELD)}; that is the value the engine substitutes when a ` +
          `redaction will not settle, so a pattern that rewrites it would make the withheld ` +
          `payload itself unstable`,
      );
    }
  }
}

/** Could these two matchers ever select the same tool? */
function toolMatchersOverlap(a: ToolMatcher, b: ToolMatcher): boolean {
  const segment = (x: string, y: string): boolean =>
    x === WILDCARD || y === WILDCARD || x === y;
  return segment(a.toolkit, b.toolkit) && segment(a.tool, b.tool);
}

/**
 * `a.b`, `a[0].b`, `a[].b`, `$.a`, `$[]`, `$`. Returns `null` for anything it
 * cannot consume completely — a path half-understood would address a field the
 * author did not name.
 */
function parsePath(source: string): Segment[] | null {
  if (source.trim() === "") return null;
  const rooted = source.startsWith("$");
  let rest = rooted ? source.slice(1) : source;
  if (rest === "") return rooted ? [] : null;
  // `$a` is a typo for `$.a`, not a third spelling of it.
  if (rooted && !rest.startsWith(".") && !rest.startsWith("[")) return null;

  const segments: Segment[] = [];
  let first = true;
  while (rest.length > 0) {
    const step = PATH_STEP.exec(rest);
    if (step === null) return null;
    const [whole, key, index] = step;
    if (key !== undefined) {
      // Only a subscript may open a path without a dot: `.a` and `a` both name
      // a key, but `a.b` must not be reachable as `ab`.
      if (!first && !whole.startsWith(".")) return null;
      segments.push({ kind: "key", key });
    } else if (index === "") {
      segments.push({ kind: "all" });
    } else {
      segments.push({ kind: "index", index: Number(index) });
    }
    rest = rest.slice(whole.length);
    first = false;
  }
  return segments;
}

/**
 * Ascending `priority`, ties broken by `id` as raw code-unit strings — never
 * `localeCompare`, whose rules vary by runtime and would make the order of
 * `redactions[]` depend on where the hook server happens to be deployed.
 */
function byPriorityThenId(a: CompiledOutputRule, b: CompiledOutputRule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Redact `output` for `subject`. Returns the payload the model may see and an
 * account of what was taken out of it.
 *
 * Pure and total: the input is never mutated, nothing is read from outside the
 * arguments, and the same arguments always give the same answer.
 */
export function redact(input: RedactionInput): RedactionResult {
  const { policy, subject, tool } = input;

  const applicable = policy.rules.filter(
    (rule) => matchesTool(rule.match, tool) && appliesToSubject(rule, subject),
  );
  const scanners = applicable.flatMap((rule) =>
    rule.patterns.map((pattern) => ({ ruleId: rule.id, pattern })),
  );

  // Candidates, not yet records: keyed so that the same removal seen on two
  // passes is one redaction, and pruned below to those that actually changed
  // something.
  const candidates = new Map<string, RedactionRecord>();
  const note = (record: RedactionRecord): void => {
    candidates.set(
      `${record.path}\u0000${record.rule_id ?? ""}\u0000${record.pattern_id ?? ""}\u0000${record.kind}`,
      record,
    );
  };

  let current = input.output;

  // The *whole* transformation runs to a fixed point, fields and patterns
  // together. Settling the pattern sweep alone is not enough: the fields and the
  // sweep are two halves of one operation, and a guarantee about half of it says
  // nothing about applying the other half again. Iterating the pair means the
  // value this returns is by definition one that another `redact` leaves alone.
  //
  // Reference equality is the convergence test, and it is exact rather than an
  // approximation: every transform below returns its input by reference when it
  // changes nothing, so a pass that produces a new object produced a difference.
  let converged = false;
  for (let pass = 0; pass < TRANSFORM_PASS_LIMIT; pass += 1) {
    const before = current;

    // Fields first: what a rule can name, it names, so a value already pulled is
    // not still there for the sweep to find and record a second time.
    for (const rule of applicable) {
      for (const field of rule.fields) {
        current = editField(current, field.segments, "$", field, rule.id, note);
      }
    }

    // Then one sweep carrying every applicable rule's patterns. Sweeping rule by
    // rule would let two rules chase each other across the payload — one
    // rewriting what the other just wrote — with each sweep looking settled.
    if (scanners.length > 0) current = sweep(current, "$", scanners, note);

    if (current === before) {
      converged = true;
      break;
    }
  }

  if (!converged) {
    // Unreachable for any policy that compiles — `checkMarkersAreInert` refuses
    // the patterns that could rewrite what a pass writes — and kept anyway,
    // because the guarantee should not rest on that check being complete.
    // Withholding everything is the fail-closed direction at /post.
    return {
      output: WITHHELD,
      redactions: [{ path: "$", rule_id: null, pattern_id: null, kind: "unsettled" }],
    };
  }

  // Records follow from input versus output. Whatever the rules did on the way,
  // a payload that came back as it arrived had nothing removed from it, and
  // `redactions[]` is rendered on the panel and kept in the audit log — a
  // removal that removed nothing is a lie in both.
  if (current === input.output || deepEqual(current, input.output)) {
    return { output: input.output, redactions: [] };
  }

  return { output: current, redactions: [...candidates.values()] };
}

function matchesTool(match: ToolMatcher, tool: ToolRef): boolean {
  return (
    (match.toolkit === WILDCARD || match.toolkit === tool.toolkit) &&
    (match.tool === WILDCARD || match.tool === tool.name)
  );
}

/**
 * An unresolved subject matches every subject-conditioned rule. Failing closed
 * at `/post` means withholding more, not less: a caller the control plane
 * cannot identify is the last one who should receive the unredacted payload.
 */
function appliesToSubject(rule: CompiledOutputRule, subject: SubjectOrUnknown): boolean {
  if (subject === null) return true;
  return matchesSubject(rule.subjects, subject as Subject);
}

// ---------------------------------------------------------------------------
// Field redaction
// ---------------------------------------------------------------------------

/**
 * Walk `segments` into `node` and apply `field` wherever they land, returning
 * the rewritten node. Returns `node` itself, unchanged and by reference, when
 * nothing matched — so an absent field costs nothing and records nothing.
 *
 * A path that runs into the wrong shape — a key on an array, an index on an
 * object, an element past the end — simply does not match. That is deliberate:
 * tool outputs are heterogeneous (a list endpoint returns an array where a
 * detail endpoint returns an object) and a rule written for both should redact
 * whichever it finds rather than throwing on the other.
 */
function editField(
  node: unknown,
  segments: readonly Segment[],
  at: string,
  field: CompiledField,
  ruleId: string,
  note: Note,
): unknown {
  if (segments.length === 0) {
    const next = applyToValue(node, field);
    if (next === DROP || next === node) {
      // The root cannot be dropped, and an unchanged value is not a redaction.
      return node;
    }
    note({ path: at, rule_id: ruleId, pattern_id: null, kind: field.strategy });
    return next;
  }

  const [head, ...tail] = segments as [Segment, ...Segment[]];

  if (head.kind === "key") {
    if (!isPlainObject(node) || !Object.hasOwn(node, head.key)) return node;
    const childPath = `${at}.${head.key}`;
    if (tail.length === 0 && field.strategy === "remove") {
      note({ path: childPath, rule_id: ruleId, pattern_id: null, kind: "remove" });
      const { [head.key]: _dropped, ...rest } = node;
      return rest;
    }
    const child = editField(node[head.key], tail, childPath, field, ruleId, note);
    if (child === node[head.key]) return node;
    return { ...node, [head.key]: child };
  }

  if (!Array.isArray(node)) return node;

  const indices =
    head.kind === "all"
      ? node.map((_, i) => i)
      : head.index < node.length
        ? [head.index]
        : [];
  if (indices.length === 0) return node;
  const targeted = new Set(indices);

  // `remove` on an array element splices it out, so the elements are collected
  // and dropped in one pass rather than one at a time under shifting indices.
  if (tail.length === 0 && field.strategy === "remove") {
    for (const index of indices) {
      note({ path: `${at}[${index}]`, rule_id: ruleId, pattern_id: null, kind: "remove" });
    }
    return node.filter((_, i) => !targeted.has(i));
  }

  let changed = false;
  const next = node.map((element, i) => {
    if (!targeted.has(i)) return element;
    const child = editField(element, tail, `${at}[${i}]`, field, ruleId, note);
    if (child !== element) changed = true;
    return child;
  });
  return changed ? next : node;
}

/**
 * A field rule's match is the whole value, so `mask` and `replace` coincide
 * here — there is nothing around the match to preserve. `remove` is handled by
 * the caller, which is the only place that holds the parent the key must be
 * deleted from.
 */
function applyToValue(value: unknown, field: CompiledField): unknown | typeof DROP {
  switch (field.strategy) {
    case "remove":
      return DROP;
    case "mask":
    case "replace":
      return field.replacement;
  }
}

// ---------------------------------------------------------------------------
// Pattern sweeping
// ---------------------------------------------------------------------------

/**
 * Apply the scanners to every string reachable from `node`. Object *keys* are
 * left alone: a key is structure, and rewriting it would hand the model a
 * payload whose shape no longer matches the tool's own contract.
 */
function sweep(
  node: unknown,
  at: string,
  scanners: readonly Scanner[],
  note: Note,
): unknown {
  if (typeof node === "string") {
    const settled = settle(node, scanners);

    if (!settled.converged) {
      note({ path: at, rule_id: null, pattern_id: null, kind: "unsettled" });
      return WITHHELD;
    }

    // The record follows from the *value*, not from the steps taken to reach it.
    // Scanners that rewrote the string and then put it back did nothing, and
    // saying otherwise would put a removal that removed nothing on the panel and
    // in the audit log.
    if (settled.text === node) return node;

    for (const scanner of settled.fired) {
      note({
        path: at,
        rule_id: scanner.ruleId,
        pattern_id: scanner.pattern.id,
        kind: scanner.pattern.strategy,
      });
    }
    return settled.text;
  }

  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((element, i) => {
      const child = sweep(element, `${at}[${i}]`, scanners, note);
      if (child !== element) changed = true;
      return child;
    });
    return changed ? next : node;
  }

  if (isPlainObject(node)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const child = sweep(value, `${at}.${key}`, scanners, note);
      if (child !== value) changed = true;
      next[key] = child;
    }
    return changed ? next : node;
  }

  return node;
}

/**
 * Apply the scanners to `original` until the text stops changing, and report
 * whether it got there.
 *
 * **This is where idempotence comes from, and it is a runtime guarantee rather
 * than a compile-time one on purpose.** Whether a set of regexes can rewrite
 * each other's output forever is a question about regex interplay — lookaheads
 * make a replacement a *prefix* of what some other pattern matches without ever
 * matching it in isolation — and any check that reasons about replacements one
 * at a time will keep missing cases. Two policies from review of #8 make the
 * point: one where three patterns cycle a value back to itself, and one where
 * they walk it a step further on every call, so a second `redact` returned a
 * different payload than the first. Running to a fixed point answers both
 * without having to recognise either.
 *
 * After this returns `converged`, applying the same scanners again changes
 * nothing — that is what a fixed point *is* — so `redact` over its own output is
 * a no-op and records nothing. The guarantee holds for any policy that compiles,
 * not for the subset a checker was clever enough to admit.
 *
 * The bound is generous rather than tight. There is no cheap upper bound on the
 * passes a legitimate policy needs — an adversarially ordered chain of `n`
 * patterns takes `n` — so the limit is set well clear of anything a sane policy
 * reaches, and hitting it is read as a defect in the policy rather than a
 * problem with the payload. Well-formed policies settle on the second pass: one
 * that changes the text, one that confirms nothing more applies.
 */
function settle(
  original: string,
  scanners: readonly Scanner[],
): { text: string; fired: readonly Scanner[]; converged: boolean } {
  const limit = 2 * scanners.length + 8;
  // Which scanners contributed, deduplicated — one that fires on three passes of
  // the same value is one redaction of it, not three — and reported in policy
  // order rather than the order the loop happened to reach them.
  const fired = new Set<number>();
  const contributors = (): Scanner[] =>
    [...fired].sort((a, b) => a - b).map((index) => scanners[index] as Scanner);
  let text = original;

  for (let pass = 0; pass < limit; pass += 1) {
    const before = text;
    scanners.forEach((scanner, index) => {
      const next = applyPattern(text, scanner.pattern);
      if (next === text) return;
      text = next;
      fired.add(index);
    });
    // The *pass* is what has to settle, not each scanner within it. Scanners
    // that rewrite a value and hand it back unchanged have collectively done
    // nothing, and that is a converged pass — the caller then compares the text
    // to what it started as and records nothing at all.
    if (text === before) return { text, fired: contributors(), converged: true };
  }

  return { text, fired: contributors(), converged: false };
}

/**
 * The three strategies, and the only place they differ. `mask` takes the match
 * and leaves the prose around it; `replace` takes the whole string because none
 * of it is trusted; `remove` deletes the match and lets the text close up.
 */
function applyPattern(text: string, pattern: CompiledPattern): string {
  switch (pattern.strategy) {
    case "mask":
      // `replaceAll` with a string, not a function: a `$&` in the replacement
      // would otherwise re-insert the matched text the rule just removed.
      return text.replace(pattern.global, () => pattern.replacement);
    case "remove":
      // Deleting a match can join what was on either side of it into a new one —
      // remove `ab` from `aabb` and `ab` is what is left. One application here;
      // `settle` runs the whole set until nothing changes, which covers it.
      return text.replace(pattern.global, () => "");
    case "replace":
      return pattern.probe.test(text) ? pattern.replacement : text;
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * A plain object — something a JSON payload can hold. Class instances, `Date`s
 * and `null` are not walked into: a hook payload is `JSON.parse` output, and
 * anything else arrived from a caller that is not following the contract.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
