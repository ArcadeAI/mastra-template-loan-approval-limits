/**
 * Who a rule applies to — the one definition, shared.
 *
 * Both engines ask this question. The PolicyEngine (#7) asks it about a
 * `PolicyRule` at `/access` and `/pre`; the RedactionEngine (#8) asks it about
 * an `OutputRule` at `/post`. If the two ever answered it differently, the same
 * `SubjectMatcher` written by the same hand would govern one person at the pre
 * hook and a different person at the post hook, and every test in both suites
 * would still pass. So the predicate and its compile-time check live here and
 * are imported, rather than being written twice and kept in step by hope.
 *
 * Nothing here decides what an *unmatched* subject means. That is the caller's
 * question and the two hooks answer it in opposite directions: a `/pre` rule
 * that cannot resolve its subject fails closed by denying, while a `/post` rule
 * that cannot resolve its subject fails closed by redacting *more*. Both are
 * "fail closed"; they point opposite ways because one gates an action and the
 * other gates what comes back.
 */
import type { SubjectMatcher, Subject } from "@cg/policy-schema";

/**
 * Does `matcher` apply to `subject`? Every field is a narrowing filter and
 * `null` means "do not narrow on this", so a matcher that narrows on nothing —
 * or a rule with no matcher at all — applies to everyone.
 */
export function matchesSubject(matcher: SubjectMatcher | null, subject: Subject): boolean {
  if (matcher === null) return true;
  if (matcher.user_ids !== null && !matcher.user_ids.includes(subject.user_id)) return false;
  if (matcher.roles !== null && !matcher.roles.includes(subject.role)) return false;
  if (matcher.clearance_below !== null && !(subject.clearance < matcher.clearance_below)) {
    return false;
  }
  if (
    matcher.clearance_at_least !== null &&
    !(subject.clearance >= matcher.clearance_at_least)
  ) {
    return false;
  }
  return true;
}

/**
 * A subject matcher that can never match is a rule that silently does nothing.
 * The engines hold no roster, so a misspelled role or user id cannot be caught
 * here — that is the one loudness gap both READMEs state — but the parts that
 * are provable from the schema alone are refused.
 */
export function checkSubjectMatcher(m: SubjectMatcher): string[] {
  const problems: string[] = [];
  if (m.roles !== null && m.roles.length === 0) {
    problems.push(`subjects.roles is an empty list, which matches nobody; use null to mean "any role"`);
  }
  if (m.user_ids !== null && m.user_ids.length === 0) {
    problems.push(`subjects.user_ids is an empty list, which matches nobody; use null to mean "anyone"`);
  }
  if (m.clearance_below !== null && m.clearance_below <= 0) {
    problems.push(
      `subjects.clearance_below is ${m.clearance_below}, but clearance is never negative, ` +
        `so no subject can be below it`,
    );
  }
  if (
    m.clearance_below !== null &&
    m.clearance_at_least !== null &&
    m.clearance_below <= m.clearance_at_least
  ) {
    problems.push(
      `subjects.clearance_at_least (${m.clearance_at_least}) is not below subjects.clearance_below ` +
        `(${m.clearance_below}), so the band is empty and matches nobody`,
    );
  }
  return problems;
}
