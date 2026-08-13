import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels, isThinkingLevel, THINKING_LEVELS } from "./thinking-levels";

describe("getSupportedThinkingLevels", () => {
  it("offers only off for non-reasoning or unknown models", () => {
    expect(getSupportedThinkingLevels({ reasoning: false })).toEqual(["off"]);
    expect(getSupportedThinkingLevels(undefined)).toEqual(["off"]);
  });

  it("offers the base set for a reasoning model without a map", () => {
    expect(getSupportedThinkingLevels({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("excludes levels explicitly nulled in the map", () => {
    expect(
      getSupportedThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
      }),
    ).toEqual(["off"]);
  });

  it("includes xhigh and max only when explicitly mapped non-null", () => {
    expect(
      getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: { high: "high", xhigh: "xhigh", max: "max" } }),
    ).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps base levels unless explicitly nulled, regardless of map presence", () => {
    expect(getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: "minimal" } })).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("isThinkingLevel", () => {
  it("accepts valid levels and rejects everything else", () => {
    for (const level of THINKING_LEVELS) expect(isThinkingLevel(level)).toBe(true);
    expect(isThinkingLevel("ultra")).toBe(false);
    expect(isThinkingLevel(42)).toBe(false);
    expect(isThinkingLevel(undefined)).toBe(false);
  });
});
