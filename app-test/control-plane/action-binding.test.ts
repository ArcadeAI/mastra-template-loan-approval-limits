/**
 * Resolving a bare action name, and refusing to guess.
 *
 * Each of these refusals exists because the alternative is a grant that
 * constrains less than the approver read — pinned to the wrong argument,
 * bounded on nothing, or aimed at a tool nobody governs. A grant like that is
 * indistinguishable from a standing permission, and it looks like a working
 * approval flow right up until someone audits it.
 */
import { describe, expect, test } from "bun:test";

import { compilePolicy, type ToolCatalogue } from "@cg/governance-core";
import { PolicyRule, type PolicyRuleInput } from "@cg/policy-schema";

import { pascalCase, resolveAction } from "../src/action-binding.ts";

const rule = (input: PolicyRuleInput) => PolicyRule.parse(input);

const clearanceRule = (toolkit: string, tool: string, input: string) =>
  rule({
    id: `pre.${tool}-${input}`,
    description: "",
    hook: "pre",
    match: { toolkit, tool },
    conditions: [{ input, operator: "exceeds_clearance" }],
    effect: "deny",
    reason: `DENIED: over your limit of {{subject.clearance}}. Do not retry; ask a human.`,
    priority: 100,
  });

const policyOf = (catalogue: ToolCatalogue, rules = [clearanceRule("Loan", "ApproveLoan", "amount")]) =>
  compilePolicy({ catalogue, rules });

const LOAN: ToolCatalogue = {
  Loan: {
    ApproveLoan: ["loan_id", "amount"],
    DenyLoan: ["loan_id", "reason"],
    SearchLoans: ["status?"],
  },
};

describe("naming the tool", () => {
  test("applies the PascalCase rule arcade-mcp applies to every tool it deploys", () => {
    // A binding keyed on `approve_loan` would match nothing, and a binding
    // that matches nothing issues a grant that authorises nothing.
    expect(pascalCase("approve_loan")).toBe("ApproveLoan");
    expect(pascalCase("get_loan")).toBe("GetLoan");
    expect(pascalCase("decide")).toBe("Decide");
  });

  test("resolves the action the demo escalates", () => {
    const resolved = resolveAction("approve_loan", LOAN, policyOf(LOAN));
    expect(resolved).toEqual({
      outcome: "resolved",
      binding: {
        toolkit: "Loan",
        tool: "ApproveLoan",
        resourceInput: "loan_id",
        amountInput: "amount",
      },
    });
  });

  test("refuses an action no governed toolkit serves", () => {
    const resolved = resolveAction("wire_funds", LOAN, policyOf(LOAN));
    expect(resolved.outcome).toBe("unresolvable");
    expect(resolved).toHaveProperty("problem", expect.stringContaining("WireFunds"));
  });

  test("refuses an action two toolkits both serve", () => {
    const ambiguous: ToolCatalogue = { ...LOAN, Legacy: { ApproveLoan: ["loan_id", "amount"] } };
    const resolved = resolveAction("approve_loan", ambiguous, policyOf(ambiguous));
    expect(resolved).toHaveProperty("problem", expect.stringContaining("2 governed"));
  });
});

describe("naming the bounded input", () => {
  test("takes it from the rule that bounds it, not from a convention", () => {
    // A forker who bounds `quantity` gets a ceiling on `quantity`, with
    // nothing to configure.
    const widgets: ToolCatalogue = { Widgets: { ShipOrder: ["order_id", "quantity"] } };
    const resolved = resolveAction("ship_order", widgets, policyOf(widgets, [
      clearanceRule("Widgets", "ShipOrder", "quantity"),
    ]));
    expect(resolved).toEqual({
      outcome: "resolved",
      binding: {
        toolkit: "Widgets",
        tool: "ShipOrder",
        resourceInput: "order_id",
        amountInput: "quantity",
      },
    });
  });

  test("an action nothing bounds gets no ceiling, and that is not an error", () => {
    const resolved = resolveAction("deny_loan", LOAN, policyOf(LOAN));
    // DenyLoan takes loan_id and reason and nothing bounds either, so there
    // are two candidates for the resource and the control plane will not pick.
    expect(resolved).toHaveProperty("problem", expect.stringContaining("2 required arguments"));
  });

  test("refuses when two rules bound two different inputs of the same tool", () => {
    const resolved = resolveAction("approve_loan", LOAN, policyOf(LOAN, [
      clearanceRule("Loan", "ApproveLoan", "amount"),
      clearanceRule("Loan", "ApproveLoan", "loan_id"),
    ]));
    expect(resolved).toHaveProperty("problem", expect.stringContaining("2 inputs bounded by clearance"));
  });
});

describe("naming the resource", () => {
  test("refuses a tool whose only required argument is the bounded one", () => {
    const bare: ToolCatalogue = { Ledger: { PostEntry: ["amount"] } };
    const resolved = resolveAction("post_entry", bare, policyOf(bare, [
      clearanceRule("Ledger", "PostEntry", "amount"),
    ]));
    // Without a pinned resource the grant would authorise the same action
    // against anything at all.
    expect(resolved).toHaveProperty("problem", expect.stringContaining("no required argument"));
  });

  test("refuses a tool with two arguments that could each be the resource", () => {
    const transfers: ToolCatalogue = {
      Ledger: { TransferFunds: ["from_account", "to_account", "amount"] },
    };
    const resolved = resolveAction("transfer_funds", transfers, policyOf(transfers, [
      clearanceRule("Ledger", "TransferFunds", "amount"),
    ]));
    expect(resolved).toHaveProperty("problem", expect.stringContaining("will not guess"));
  });
});
