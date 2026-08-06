import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MODEL_ENTRY } from "../subagent/model-resolution";
import { ConfigFileService } from "./config-files";
import {
  AgentModelError,
  readAgentModels,
  readOrchestratorDefaults,
  readOverrideForAgent,
  readSessionOverrides,
  routeSetAgentModel,
  splitModelRef,
  writeAgentOverride,
  type EntryRow,
} from "./agent-models";

vi.mock("../runtime/pi-import", () => ({
  importPi: vi.fn(),
}));

import { importPi } from "../runtime/pi-import";

const entries = (rows: Array<{ type: string; customType?: string; data?: unknown }>) => rows;

describe("agent-models custom entries", () => {
  it("reads the latest override per agent; null resets", () => {
    const rows = entries([
      { type: "custom", customType: "lazyresearch:agent_model", data: { agent: "search", model: "a/1" } },
      { type: "custom", customType: "lazyresearch:agent_model", data: { agent: "search", model: null } },
      { type: "custom", customType: "lazyresearch:agent_model", data: { agent: "figures", model: "b/2" } },
    ]);
    expect(readOverrideForAgent(rows, "search")).toBeNull();
    expect(readOverrideForAgent(rows, "figures")).toBe("b/2");
    expect(readOverrideForAgent(rows, "writing")).toBeUndefined();
  });
});

describe("splitModelRef", () => {
  it("splits a provider/id string on the first slash", () => {
    expect(splitModelRef("openai/gpt-4o")).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(splitModelRef("deepseek/deepseek-chat-r1/lite")).toEqual({ provider: "deepseek", modelId: "deepseek-chat-r1/lite" });
  });

  it("rejects strings without a non-empty provider and model id", () => {
    for (const bad of ["noprovider", "/emptyprovider", "emptymodel/", "/"]) {
      expect(() => splitModelRef(bad)).toThrow(AgentModelError);
      try {
        splitModelRef(bad);
      } catch (error) {
        expect((error as AgentModelError).status).toBe(400);
      }
    }
  });
});

describe("agent-models session I/O", () => {
  const sessionPath = "/agent/sessions/--p--/a.jsonl";
  const getEntries = vi.fn();
  const appendCustomEntry = vi.fn();
  const open = vi.fn(() => ({ getEntries, appendCustomEntry }));

  beforeEach(() => {
    vi.mocked(importPi).mockResolvedValue({ SessionManager: { open } } as never);
    getEntries.mockReset();
    appendCustomEntry.mockReset();
    open.mockClear();
  });

  it("returns no overrides for a session without a session file", async () => {
    await expect(readSessionOverrides(undefined)).resolves.toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it("reads entries from the session file via SessionManager.open", async () => {
    getEntries.mockReturnValue([{ type: "custom", customType: AGENT_MODEL_ENTRY }]);
    await expect(readSessionOverrides(sessionPath)).resolves.toHaveLength(1);
    expect(open).toHaveBeenCalledWith(sessionPath);
  });

  it("appends a custom entry with the agent model payload", async () => {
    await writeAgentOverride(sessionPath, "search", "a/1");
    expect(appendCustomEntry).toHaveBeenCalledWith(AGENT_MODEL_ENTRY, { agent: "search", model: "a/1" });

    await writeAgentOverride(sessionPath, "search", null);
    expect(appendCustomEntry).toHaveBeenCalledWith(AGENT_MODEL_ENTRY, { agent: "search", model: null });
  });
});

describe("settings sources", () => {
  let agentDir: string;
  let cwd: string;
  let config: ConfigFileService;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "lazy-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "lazy-project-"));
    config = new ConfigFileService(agentDir);
  });

  it("reads lazyresearch.agentModels from settings.json", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lazyresearch: { agentModels: { search: "a/1" } } }));
    await expect(readAgentModels(config, { scope: "global" })).resolves.toEqual({ search: "a/1" });
  });

  it("treats a missing settings file or missing agentModels key as no config", async () => {
    await expect(readAgentModels(config, { scope: "global" })).resolves.toBeUndefined();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
    await expect(readAgentModels(config, { scope: "global" })).resolves.toBeUndefined();
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lazyresearch: {} }));
    await expect(readAgentModels(config, { scope: "global" })).resolves.toBeUndefined();
  });

  it("treats a project without a .lazyresearch dir as no config", async () => {
    await expect(readAgentModels(config, { scope: "project", cwd })).resolves.toBeUndefined();
  });

  it("reads project-scoped agentModels from <cwd>/.lazyresearch/settings.json", async () => {
    mkdirSync(join(cwd, ".lazyresearch"));
    writeFileSync(join(cwd, ".lazyresearch", "settings.json"), JSON.stringify({ lazyresearch: { agentModels: { writing: "b/2" } } }));
    await expect(readAgentModels(config, { scope: "project", cwd })).resolves.toEqual({ writing: "b/2" });
  });

  it("ignores non-string agent model values", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lazyresearch: { agentModels: { search: "a/1", writing: 42 } } }));
    await expect(readAgentModels(config, { scope: "global" })).resolves.toEqual({ search: "a/1" });
  });

  it("returns the global default model when no project settings exist", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }));
    await expect(readOrchestratorDefaults(config, cwd)).resolves.toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("lets the project default model win over the global one", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }));
    mkdirSync(join(cwd, ".lazyresearch"));
    writeFileSync(join(cwd, ".lazyresearch", "settings.json"), JSON.stringify({ defaultProvider: "deepseek", defaultModel: "ds-v3" }));
    await expect(readOrchestratorDefaults(config, cwd)).resolves.toEqual({ provider: "deepseek", modelId: "ds-v3" });
  });

  it("returns undefined when defaultProvider or defaultModel is unset", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "gpt-4o" }));
    await expect(readOrchestratorDefaults(config, cwd)).resolves.toBeUndefined();
  });
});

describe("routeSetAgentModel", () => {
  const setOrchestrator = vi.fn();
  const writeOverride = vi.fn();
  const defaults = vi.fn<() => Promise<{ provider: string; modelId: string } | undefined>>();
  const known = new Set(["orchestrator", "search", "figures"]);

  function router() {
    return {
      isOrchestrator: (name: string) => name === "orchestrator",
      isKnownAgent: (name: string) => known.has(name),
      setOrchestrator,
      writeOverride,
      orchestratorDefaults: defaults,
    };
  }

  beforeEach(() => {
    setOrchestrator.mockReset();
    writeOverride.mockReset();
    defaults.mockReset();
  });

  it("rejects unknown agents with 404", async () => {
    await expect(routeSetAgentModel(router(), "ghost", "a/1")).rejects.toThrow(AgentModelError);
    try {
      await routeSetAgentModel(router(), "ghost", "a/1");
    } catch (error) {
      expect((error as AgentModelError).status).toBe(404);
    }
    expect(writeOverride).not.toHaveBeenCalled();
  });

  it("routes the orchestrator model string through RPC setModel", async () => {
    await routeSetAgentModel(router(), "orchestrator", "openai/gpt-4o");
    expect(setOrchestrator).toHaveBeenCalledWith("openai", "gpt-4o");
    expect(writeOverride).not.toHaveBeenCalled();
  });

  it("resets the orchestrator to the configured default model", async () => {
    defaults.mockResolvedValue({ provider: "openai", modelId: "gpt-4o" });
    await routeSetAgentModel(router(), "orchestrator", null);
    expect(setOrchestrator).toHaveBeenCalledWith("openai", "gpt-4o");
  });

  it("rejects an orchestrator reset with 409 when no default model is configured", async () => {
    defaults.mockResolvedValue(undefined);
    await expect(routeSetAgentModel(router(), "orchestrator", null)).rejects.toThrow(AgentModelError);
    try {
      await routeSetAgentModel(router(), "orchestrator", null);
    } catch (error) {
      expect((error as AgentModelError).status).toBe(409);
    }
    expect(setOrchestrator).not.toHaveBeenCalled();
  });

  it("rejects a malformed orchestrator model string with 400", async () => {
    await expect(routeSetAgentModel(router(), "orchestrator", "garbage")).rejects.toThrow(AgentModelError);
    try {
      await routeSetAgentModel(router(), "orchestrator", "garbage");
    } catch (error) {
      expect((error as AgentModelError).status).toBe(400);
    }
    expect(setOrchestrator).not.toHaveBeenCalled();
  });

  it("writes a session override for stage agents", async () => {
    await routeSetAgentModel(router(), "search", "a/1");
    expect(writeOverride).toHaveBeenCalledWith("search", "a/1");
    expect(setOrchestrator).not.toHaveBeenCalled();

    await routeSetAgentModel(router(), "figures", null);
    expect(writeOverride).toHaveBeenCalledWith("figures", null);
  });
});
