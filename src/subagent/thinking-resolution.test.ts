import { describe, expect, it } from "vitest";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingAwareModel } from "../thinking-levels";
import { resolveConfiguredThinking } from "./thinking-resolution";

const resolve = resolveConfiguredThinking as unknown as (
  agent: { thinking?: string },
  inherited: ThinkingLevel | undefined,
  model: ThinkingAwareModel | undefined,
) => ThinkingLevel;

describe("resolveConfiguredThinking", () => {
  it("uses an explicit setting when the model supports it", () => {
    expect(resolve({ thinking: "high" }, undefined, { reasoning: true })).toBe("high");
  });

  it("uses the effective model's highest supported level for an unset Paper Assistant", () => {
    expect(resolve({}, undefined, { reasoning: true, thinkingLevelMap: { max: "max" } })).toBe("max");
    expect(resolve({}, undefined, { reasoning: true })).toBe("high");
    expect(resolve({}, undefined, { reasoning: false })).toBe("off");
  });

  it("inherits and constrains a Paper Assistant level for a different stage model", () => {
    expect(resolve({}, "xhigh", { reasoning: true, thinkingLevelMap: { xhigh: null } })).toBe("high");
    expect(resolve({ thinking: "max" }, "low", { reasoning: true })).toBe("high");
  });
});
