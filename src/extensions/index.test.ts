import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assistantExtensions } from "./index";
import { stageExtensionPath } from "../subagent/tool";

describe("bundled extension registry invariants", () => {
  it("exposes an in-process factory and an existing --extension path for every assistant extension", () => {
    expect(assistantExtensions.length).toBeGreaterThan(0);
    for (const extension of assistantExtensions) {
      expect(extension.name.length).toBeGreaterThan(0);
      expect(typeof extension.factory).toBe("function");
      expect(existsSync(extension.path)).toBe(true);
    }
  });

  it("points the stage-agent extension at an existing loadable file", () => {
    expect(existsSync(stageExtensionPath)).toBe(true);
  });
});