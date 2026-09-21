import { describe, expect, it } from "vitest";
import { assertActivationAllowed, parseRequest } from "./policy.js";
import { entry, verification } from "./test-fixture.js";

describe("promotion policy", () => {
  it("accepts project methods but requires an additional transfer for shared methods", () => {
    expect(() => assertActivationAllowed("project", entry(), verification())).not.toThrow();
    expect(() => assertActivationAllowed("shared", entry(), verification())).toThrow(/transfer/i);
    const result = verification();
    result.checks.push({ name: "held-out transfer", kind: "transfer", outcome: "pass", details: "Independent held-out task passed." });
    expect(() => assertActivationAllowed("shared", entry(), result)).not.toThrow();
  });

  it.each(["fail", "inconclusive"] as const)("does not accept %s attestations or checks", outcome => {
    expect(() => assertActivationAllowed("project", entry(), verification({ outcome }))).toThrow();
    const result = verification();
    result.checks[0]!.outcome = outcome;
    expect(() => assertActivationAllowed("project", entry(), result)).toThrow();
  });

  it("requires strategy mechanism evidence and a strictly favorable matched-budget comparison", () => {
    const strategy = entry({ kind: "strategy" });
    const result = verification();
    expect(() => assertActivationAllowed("project", strategy, result)).toThrow(/mechanism/i);
    result.checks.push({ name: "attribution", kind: "mechanism", outcome: "pass", details: "Frozen strategy governed the next round." });
    expect(() => assertActivationAllowed("project", strategy, result)).toThrow(/comparison/i);
    result.comparison = { baseline: 3, candidate: 4, direction: "maximize", baselineBudget: 10, candidateBudget: 10, budgetUnit: "calls", protocol: "Frozen evaluator and model", heldOutTask: "new citation task" };
    expect(() => assertActivationAllowed("project", strategy, result)).not.toThrow();
    result.comparison.candidateBudget = 11;
    expect(() => assertActivationAllowed("project", strategy, result)).toThrow(/budget/i);
    result.comparison.candidateBudget = 10;
    result.comparison.candidate = 3;
    expect(() => assertActivationAllowed("project", strategy, result)).toThrow(/improv|favorable/i);
    result.comparison.direction = "minimize";
    result.comparison.candidate = 2;
    expect(() => assertActivationAllowed("project", strategy, result)).not.toThrow();
  });

  it("rejects forged, irrelevant, missing, duplicate and unbounded inputs", () => {
    for (const request of [
      { action: "recall", sessionId: "forged" }, { action: "recall", entry: entry() },
      { action: "get", id: "../private" }, { action: "propose", entry: entry(), expectedRevision: 1 },
      { action: "retire", id: "5fae3770-580e-4c87-9f64-e70fa4fba5d3", expectedRevision: 1 },
      { action: "recall", limit: -1 }, { action: "recall", query: "x".repeat(100_000) },
      { action: "propose", entry: entry({ procedure: "x".repeat(100_000) }) },
    ]) expect(() => parseRequest(request)).toThrow();
    const result = verification();
    result.checks.push({ ...result.checks[0]! });
    expect(() => parseRequest({ action: "verify", id: "5fae3770-580e-4c87-9f64-e70fa4fba5d3", expectedRevision: 1, verification: result })).toThrow();
    result.checks.pop();
    result.comparison = { baseline: Infinity, candidate: 4, direction: "maximize", baselineBudget: 1, candidateBudget: 1, budgetUnit: "calls", protocol: "fixed", heldOutTask: "new" };
    expect(() => parseRequest({ action: "verify", id: "5fae3770-580e-4c87-9f64-e70fa4fba5d3", expectedRevision: 1, verification: result })).toThrow();
  });
});
