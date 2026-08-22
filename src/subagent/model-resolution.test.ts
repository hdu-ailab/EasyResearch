import { describe, expect, it } from "vitest";
import { resolveConfiguredModel } from "./model-resolution";

describe("resolveConfiguredModel", () => {
  it("uses the Agent Markdown model when configured", () => {
    expect(resolveConfiguredModel({ model: "openai/gpt-4o" }, "anthropic/claude")).toBe("openai/gpt-4o");
  });

  it("inherits the Research Assistant model when the Agent omits one", () => {
    expect(resolveConfiguredModel({}, "anthropic/claude")).toBe("anthropic/claude");
    expect(resolveConfiguredModel({}, undefined)).toBeUndefined();
  });
});
