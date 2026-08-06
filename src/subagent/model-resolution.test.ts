import { describe, expect, it } from "vitest";
import { resolveEffectiveModel, type ModelSource } from "./model-resolution";

describe("resolveEffectiveModel", () => {
  it("prefers the session override", () => {
    const r = resolveEffectiveModel("openai/gpt-4o", { search: "anthropic/claude" }, { search: "x/y" }, "o/1", "search");
    expect(r).toEqual({ model: "openai/gpt-4o", source: "override" });
  });
  it("null override falls through to project config", () => {
    const r = resolveEffectiveModel(null, { search: "anthropic/claude" }, { search: "x/y" }, "o/1", "search");
    expect(r).toEqual({ model: "anthropic/claude", source: "project" });
  });
  it("project wins over global", () => {
    const r = resolveEffectiveModel(undefined, { search: "anthropic/claude" }, { search: "x/y" }, "o/1", "search");
    expect(r).toEqual({ model: "anthropic/claude", source: "project" });
  });
  it("falls back to global, then orchestrator inherit", () => {
    expect(resolveEffectiveModel(undefined, undefined, { search: "x/y" }, "o/1", "search")).toEqual({ model: "x/y", source: "global" });
    expect(resolveEffectiveModel(undefined, undefined, undefined, "o/1", "search")).toEqual({ model: "o/1", source: "inherit" });
    expect(resolveEffectiveModel(undefined, undefined, undefined, undefined, "search")).toBeNull();
  });
});
