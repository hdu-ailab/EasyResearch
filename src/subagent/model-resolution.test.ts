import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MODEL_ENTRY, extractAgentModels, resolveEffectiveModel, resolveModelForSpawn, type ModelSource } from "./model-resolution";

vi.mock("../runtime/pi-import", () => ({
  importPi: vi.fn(),
  getAgentDir: vi.fn(() => "/fake/agent"),
}));

import { getAgentDir, importPi } from "../runtime/pi-import";

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

describe("extractAgentModels", () => {
  it("returns the agentModels map from valid settings", () => {
    expect(extractAgentModels({ lazyresearch: { agentModels: { search: "a/1", writing: "b/2" } } })).toEqual({
      search: "a/1",
      writing: "b/2",
    });
  });
  it("returns undefined when lazyresearch or agentModels is missing", () => {
    expect(extractAgentModels(undefined)).toBeUndefined();
    expect(extractAgentModels({})).toBeUndefined();
    expect(extractAgentModels({ theme: "dark" })).toBeUndefined();
    expect(extractAgentModels({ lazyresearch: {} })).toBeUndefined();
  });
  it("returns undefined when agentModels is not an object", () => {
    for (const bad of [null, 42, "a/1", ["a/1"]]) {
      expect(extractAgentModels({ lazyresearch: { agentModels: bad } })).toBeUndefined();
    }
  });
  it("skips non-string model values", () => {
    expect(
      extractAgentModels({ lazyresearch: { agentModels: { search: "a/1", writing: 42, figures: null, orchestrator: true } } }),
    ).toEqual({ search: "a/1" });
  });
});

describe("resolveModelForSpawn", () => {
  let fakeManager: { getProjectSettings: () => unknown; getGlobalSettings: () => unknown };
  let create: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeManager = { getProjectSettings: () => undefined, getGlobalSettings: () => undefined };
    create = vi.fn(() => fakeManager);
    vi.mocked(importPi).mockResolvedValue({ SettingsManager: { create } } as never);
  });

  const ctx = (rows: Array<{ type: string; customType?: string; data?: unknown }>) => ({
    cwd: "/tmp/project",
    sessionManager: { getEntries: () => rows },
  });

  const project = (models: Record<string, string>) => ({ lazyresearch: { agentModels: models } });
  const global = (models: Record<string, string>) => ({ lazyresearch: { agentModels: models } });
  const override = (model: string | null) => [{ type: "custom", customType: AGENT_MODEL_ENTRY, data: { agent: "search", model } }];

  it("sources project and global settings via SettingsManager.create(cwd, agentDir)", async () => {
    await resolveModelForSpawn(ctx([]), "search", "o/1");
    expect(vi.mocked(importPi)).toHaveBeenCalled();
    expect(getAgentDir).toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith("/tmp/project", "/fake/agent");
  });

  it("uses the project model when no override exists", async () => {
    fakeManager = { getProjectSettings: () => project({ search: "a/1" }), getGlobalSettings: () => undefined };
    await expect(resolveModelForSpawn(ctx([]), "search", "o/1")).resolves.toBe("a/1");
  });

  it("lets the project model win over the global one", async () => {
    fakeManager = { getProjectSettings: () => project({ search: "a/1" }), getGlobalSettings: () => global({ search: "b/2" }) };
    await expect(resolveModelForSpawn(ctx([]), "search", "o/1")).resolves.toBe("a/1");
  });

  it("falls back to the global model when the project has none", async () => {
    fakeManager = { getProjectSettings: () => project({}), getGlobalSettings: () => global({ search: "b/2" }) };
    await expect(resolveModelForSpawn(ctx([]), "search", "o/1")).resolves.toBe("b/2");
  });

  it("lets the session override win over project and global config", async () => {
    fakeManager = { getProjectSettings: () => project({ search: "a/1" }), getGlobalSettings: () => global({ search: "b/2" }) };
    await expect(resolveModelForSpawn(ctx(override("x/9")), "search", "o/1")).resolves.toBe("x/9");
  });

  it("falls through to config levels when the session carries only other agents' overrides (nested stage dispatch)", async () => {
    fakeManager = { getProjectSettings: () => project({ search: "a/1" }), getGlobalSettings: () => global({ search: "b/2" }) };
    const rows = [
      { type: "custom", customType: AGENT_MODEL_ENTRY, data: { agent: "writing", model: "w/9" } },
    ];
    await expect(resolveModelForSpawn(ctx(rows), "search", "o/1")).resolves.toBe("a/1");
  });

  it("treats a null override as a reset and falls through to project/global", async () => {
    fakeManager = { getProjectSettings: () => project({ search: "a/1" }), getGlobalSettings: () => global({ search: "b/2" }) };
    await expect(resolveModelForSpawn(ctx(override(null)), "search", "o/1")).resolves.toBe("a/1");
  });

  it("inherits the orchestrator model when nothing is configured anywhere", async () => {
    await expect(resolveModelForSpawn(ctx([]), "search", "o/1")).resolves.toBe("o/1");
  });

  it("returns undefined when nothing is configured and no orchestrator model", async () => {
    await expect(resolveModelForSpawn(ctx([]), "search", undefined)).resolves.toBeUndefined();
  });
});
