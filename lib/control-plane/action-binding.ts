/**
 * Resolving a bare action name to the call a grant will authorise.
 *
 * `POST /approvals` carries `action: "approve_loan"`, and deliberately not a
 * fully-qualified tool: `tools/approvals` has no catalogue, so it cannot know
 * that the action is served by `Loan.ApproveLoan`, that `loan_id` is the
 * argument naming the resource, or that `amount` is the one the approver's
 * clearance bounds. The control plane has all three, and this module is where
 * it works them out.
 *
 * Three questions, each answered from data the control plane already holds,
 * and each refusing rather than guessing:
 *
 * 1. **Which tool?** `arcade-mcp` PascalCases tool names unconditionally
 *    (measured on #35: `get_loan` deploys as `Loan.GetLoan`), so the action
 *    `approve_loan` is the tool `ApproveLoan`. Exactly one catalogued toolkit
 *    must serve it. None, or more than one, is unresolvable.
 * 2. **Which argument carries the amount?** The one a `pre` rule already
 *    bounds with `exceeds_clearance`. That is the definition of "the input
 *    this subject's authority applies to", and it lives in the policy table
 *    rather than in a convention here — so a forker who bounds `quantity`
 *    gets a grant whose ceiling is on `quantity`, with nothing to configure.
 *    More than one such input across the matching rules is unresolvable.
 * 3. **Which argument names the resource?** The one required argument left
 *    once the bounded one is set aside. Two candidates is unresolvable: the
 *    control plane has no way to tell which of `from_account` and
 *    `to_account` the approval was about, and a grant pinned to the wrong one
 *    would authorise the call it was meant to constrain.
 *
 * Every failure is `unresolvable` with a sentence naming what was missing.
 * None of them is a quiet fallback, because the thing a fallback would
 * produce is a grant that constrains less than the approver thought — which
 * is the failure mode this whole repo is organised against.
 */
import type { CompiledPolicy, ToolCatalogue } from "@cg/governance-core";

/** What a grant issued for an action is scoped to. */
export interface ActionBinding {
  readonly toolkit: string;
  readonly tool: string;
  /** The argument whose value is the resource. A grant pins it. */
  readonly resourceInput: string;
  /**
   * The argument the approver's clearance bounds. A grant sets its ceiling
   * here. `null` for an action with no numeric dimension at all.
   */
  readonly amountInput: string | null;
}

export type ActionResolution =
  | { readonly outcome: "resolved"; readonly binding: ActionBinding }
  | { readonly outcome: "unresolvable"; readonly problem: string };

/**
 * `approve_loan` → `ApproveLoan`. The rule `arcade-mcp` applies to every tool
 * it deploys, applied here so the action name a refused call escalated under
 * lands on the tool Arcade will actually call on the retry.
 */
export function pascalCase(action: string): string {
  return action
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
}

export function resolveAction(
  action: string,
  catalogue: ToolCatalogue,
  policy: CompiledPolicy,
): ActionResolution {
  const tool = pascalCase(action);
  const unresolvable = (problem: string): ActionResolution => ({ outcome: "unresolvable", problem });

  const serving = Object.entries(catalogue)
    .filter(([, tools]) => Object.hasOwn(tools, tool))
    .map(([toolkit]) => toolkit);

  const toolkit = serving[0];
  if (toolkit === undefined) {
    const governed = Object.entries(catalogue)
      .flatMap(([kit, tools]) => Object.keys(tools).map((t) => `${kit}.${t}`))
      .join(", ");
    return unresolvable(
      `action "${action}" resolves to the tool "${tool}", which no governed toolkit serves ` +
        `(governed: ${governed || "none"})`,
    );
  }
  if (serving.length > 1) {
    return unresolvable(
      `action "${action}" resolves to the tool "${tool}", which ${serving.length} governed ` +
        `toolkits serve (${serving.join(", ")}); the control plane cannot tell which one was refused`,
    );
  }

  const declared = catalogue[toolkit]?.[tool] ?? [];
  const required = declared.filter((arg) => !arg.endsWith("?"));

  const bounded = new Set<string>();
  for (const rule of policy.rules) {
    if (rule.hook !== "pre") continue;
    if (rule.match.toolkit !== "*" && rule.match.toolkit !== toolkit) continue;
    if (rule.match.tool !== "*" && rule.match.tool !== tool) continue;
    for (const condition of rule.conditions) {
      if (condition.operator === "exceeds_clearance") bounded.add(condition.input);
    }
  }
  if (bounded.size > 1) {
    return unresolvable(
      `${toolkit}.${tool} has ${bounded.size} inputs bounded by clearance ` +
        `(${[...bounded].sort().join(", ")}), so the control plane cannot tell which one the ` +
        `approver cleared`,
    );
  }
  const amountInput = [...bounded][0] ?? null;

  const resourceCandidates = required.filter((arg) => arg !== amountInput);
  const resourceInput = resourceCandidates[0];
  if (resourceInput === undefined) {
    return unresolvable(
      `${toolkit}.${tool} takes no required argument that could name the resource ` +
        `(required: ${required.join(", ") || "none"}), so a grant for it would hold the retry ` +
        `to no resource at all`,
    );
  }
  if (resourceCandidates.length > 1) {
    return unresolvable(
      `${toolkit}.${tool} has ${resourceCandidates.length} required arguments that could name ` +
        `the resource (${resourceCandidates.join(", ")}); the control plane will not guess which ` +
        `one the approval was about`,
    );
  }

  return { outcome: "resolved", binding: { toolkit, tool, resourceInput, amountInput } };
}
