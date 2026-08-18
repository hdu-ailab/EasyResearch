import { describe, expect, it } from "vitest";
import { assistantExtensions } from "./index";

describe("bundled extension registry invariants", () => {
  it("exposes a named in-process factory for every assistant extension", () => {
    expect(assistantExtensions.length).toBeGreaterThan(0);
    for (const extension of assistantExtensions) {
      expect(extension.name.length).toBeGreaterThan(0);
      expect(typeof extension.factory).toBe("function");
    }
  });

  it("mounts the agent-status extension in the assistant runtime", () => {
    expect(assistantExtensions.map((entry) => entry.name)).toContain("agent-status");
  });
});
