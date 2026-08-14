import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assistantExtensions } from "./index";
import { stageExtensionPaths, stageExtensionPath } from "../subagent/tool";

describe("bundled extension registry invariants", () => {
  it("exposes an in-process factory and an existing --extension path for every assistant extension", () => {
    expect(assistantExtensions.length).toBeGreaterThan(0);
    for (const extension of assistantExtensions) {
      expect(extension.name.length).toBeGreaterThan(0);
      expect(typeof extension.factory).toBe("function");
      expect(existsSync(extension.path)).toBe(true);
    }
  });

  it("mounts the subagent extension plus every shared web tool extension in stage runtimes (ADR-062/068)", () => {
    expect(stageExtensionPaths.length).toBeGreaterThan(0);
    for (const extensionPath of stageExtensionPaths) {
      expect(existsSync(extensionPath)).toBe(true);
    }
    const stageNames = stageExtensionPaths.map((extensionPath) => extensionPath.split("/").at(-2));
    expect(stageNames).toEqual(expect.arrayContaining(["subagent", "web-search", "webfetch"]));
  });

  it("points the stage-agent extension at an existing loadable file", () => {
    expect(existsSync(stageExtensionPath)).toBe(true);
  });
});