import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MODEL_ENTRY } from "../subagent/model-resolution";
import { ConfigFileService } from "./config-files";
import {
  AgentModelError,
  readAgentModels,
  readPaperAssistantDefaults,
  readOverrideForAgent,
  readSessionOverrides,
  resolveAgentModelsService,
  routeSetAgentModel,
  splitModelRef,
  writeAgentOverride,
  type EntryRow,
} from "./agent-models";

const sessionManager = vi.hoisted(() => ({
  open: vi.fn(),
}));
const parseFrontmatter = vi.hoisted(() => (content: string) => {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  const frontmatter = Object.fromEntries(
    (match?.[1] ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf(":");
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        return [key, key === "model" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value];
      }),
  );
  return { frontmatter, body: match?.[2] ?? content };
});

vi.mock("../runtime/pi-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/pi-import")>();
  return {
    ...actual,
    importPi: vi.fn(async () => ({ ...(await actual.importPi()), SessionManager: sessionManager })),
  };
});

import { importPi } from "../runtime/pi-import";

const entries = (rows: Array<{ type: string; customType?: string; data?: unknown }>) => rows;

describe("agent-models custom entries", () => {
  it("reads the latest override per agent; null resets", () => {
    const rows = entries([
      { type: "custom", customType: "easyresearch:agent_model", data: { agent: "search", model: "a/1" } },
      { type: "custom", customType: "easyresearch:agent_model", data: { agent: "search", model: null } },
      { type: "custom", customType: "easyresearch:agent_model", data: { agent: "figures", model: "b/2" } },
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
  const open = sessionManager.open;

  beforeEach(() => {
    vi.mocked(importPi).mockResolvedValue({ parseFrontmatter, SessionManager: { open } } as never);
    getEntries.mockReset();
    appendCustomEntry.mockReset();
    open.mockClear();
    open.mockImplementation(() => ({ getEntries, appendCustomEntry }));
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

  it("reads agent models from global Markdown frontmatter", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "search.md"), "---\nname: search\ndescription: finds papers\nmodel: a/1\n---\nbody");
    await expect(readAgentModels(config, { scope: "global" })).resolves.toEqual({ search: "a/1" });
  });

  it("treats a missing Markdown model or an agent without one as no config", async () => {
    await expect(readAgentModels(config, { scope: "global" })).resolves.toBeUndefined();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "search.md"), "---\nname: search\ndescription: finds papers\n---\nbody");
    await expect(readAgentModels(config, { scope: "global" })).resolves.toBeUndefined();
  });

  it("treats a project without a .easyresearch dir as no config", async () => {
    await expect(readAgentModels(config, { scope: "project", cwd })).resolves.toBeUndefined();
  });

  it("reads only project-scoped agent Markdown models", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "search.md"), "---\nname: search\ndescription: finds papers\nmodel: a/1\n---\nbody");
    mkdirSync(join(cwd, ".easyresearch", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".easyresearch", "agents", "writing.md"), "---\nname: writing\ndescription: writes papers\nmodel: b/2\n---\nbody");
    await expect(readAgentModels(config, { scope: "project", cwd })).resolves.toEqual({ writing: "b/2" });
  });

  it("ignores non-string agent model values", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "search.md"), "---\nname: search\ndescription: finds papers\nmodel: a/1\n---\nbody");
    writeFileSync(join(agentDir, "agents", "writing.md"), "---\nname: writing\ndescription: writes papers\nmodel: 42\n---\nbody");
    await expect(readAgentModels(config, { scope: "global" })).resolves.toEqual({ search: "a/1" });
  });

  it("returns the global default model when no project settings exist", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "paper-assistant.md"), "---\nname: paper-assistant\ndescription: Paper Assistant\nmodel: openai/gpt-4o\n---\nbody");
    await expect(readPaperAssistantDefaults(config, cwd)).resolves.toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("lets the project Paper Assistant model win over the global one", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "paper-assistant.md"), "---\nname: paper-assistant\ndescription: Paper Assistant\nmodel: openai/gpt-4o\n---\nbody");
    mkdirSync(join(cwd, ".easyresearch", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".easyresearch", "agents", "paper-assistant.md"), "---\nname: paper-assistant\ndescription: Paper Assistant\nmodel: deepseek/ds-v3\n---\nbody");
    await expect(readPaperAssistantDefaults(config, cwd)).resolves.toEqual({ provider: "deepseek", modelId: "ds-v3" });
  });

  it("returns undefined when the Paper Assistant Markdown model is unset", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "paper-assistant.md"), "---\nname: paper-assistant\ndescription: Paper Assistant\n---\nbody");
    await expect(readPaperAssistantDefaults(config, cwd)).resolves.toBeUndefined();
  });
});

describe("resolveAgentModelsService.effective", () => {
  const roster = () => [
    { name: "paper-assistant" },
    { name: "search" },
    { name: "experiment" },
    { name: "writing" },
    { name: "figures" },
  ];

  it("resolves mixed sources per agent in roster order", async () => {
    const service = resolveAgentModelsService({
      listAgents: async () => roster(),
      getSessionPath: async () => "/sessions/o.jsonl",
      readEntries: async () => [
        { type: "custom", customType: AGENT_MODEL_ENTRY, data: { agent: "search", model: "s/9" } },
      ],
      projectAgentModels: async () => ({ experiment: "p/1", figures: "p/2" }),
      globalAgentModels: async () => ({ figures: "g/1", writing: "g/2" }),
      paperAssistantModel: async () => "o/7",
      getCwd: async () => "/tmp/proj",
    });
    await expect(service.effective("s1")).resolves.toEqual([
      { name: "paper-assistant", model: "o/7", source: "inherit" },
      { name: "search", model: "s/9", source: "override" },
      { name: "experiment", model: "p/1", source: "project" },
      { name: "writing", model: "g/2", source: "global" },
      { name: "figures", model: "p/2", source: "project" },
    ]);
  });

  it("reports model null with source inherit when nothing resolves", async () => {
    const service = resolveAgentModelsService({
      listAgents: async () => roster(),
      getSessionPath: async () => undefined,
      readEntries: async () => [] as EntryRow[],
      projectAgentModels: async () => undefined,
      globalAgentModels: async () => undefined,
      paperAssistantModel: async () => undefined,
      getCwd: async () => "/tmp/proj",
    });
    const effective = await service.effective("s1");
    expect(effective).toEqual(roster().map((a) => ({ name: a.name, model: null, source: "inherit" })));
  });
});

describe("routeSetAgentModel", () => {
  const setPaperAssistant = vi.fn();
  const writeOverride = vi.fn();
  const defaults = vi.fn<() => Promise<{ provider: string; modelId: string } | undefined>>();
  const known = new Set(["paper-assistant", "search", "figures"]);

  function router() {
    return {
      isPaperAssistant: (name: string) => name === "paper-assistant",
      isKnownAgent: (name: string) => known.has(name),
      setPaperAssistant,
      writeOverride,
      paperAssistantDefaults: defaults,
    };
  }

  beforeEach(() => {
    setPaperAssistant.mockReset();
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

  it("routes the Paper Assistant model string through RPC setModel", async () => {
    await routeSetAgentModel(router(), "paper-assistant", "openai/gpt-4o");
    expect(setPaperAssistant).toHaveBeenCalledWith("openai", "gpt-4o");
    expect(writeOverride).not.toHaveBeenCalled();
  });

  it("resets the Paper Assistant to the configured default model", async () => {
    defaults.mockResolvedValue({ provider: "openai", modelId: "gpt-4o" });
    await routeSetAgentModel(router(), "paper-assistant", null);
    expect(setPaperAssistant).toHaveBeenCalledWith("openai", "gpt-4o");
  });

  it("rejects a Paper Assistant reset with 409 when no default model is configured", async () => {
    defaults.mockResolvedValue(undefined);
    await expect(routeSetAgentModel(router(), "paper-assistant", null)).rejects.toThrow(AgentModelError);
    try {
      await routeSetAgentModel(router(), "paper-assistant", null);
    } catch (error) {
      expect((error as AgentModelError).status).toBe(409);
    }
    expect(setPaperAssistant).not.toHaveBeenCalled();
  });

  it("rejects a malformed Paper Assistant model string with 400", async () => {
    await expect(routeSetAgentModel(router(), "paper-assistant", "garbage")).rejects.toThrow(AgentModelError);
    try {
      await routeSetAgentModel(router(), "paper-assistant", "garbage");
    } catch (error) {
      expect((error as AgentModelError).status).toBe(400);
    }
    expect(setPaperAssistant).not.toHaveBeenCalled();
  });

  it("writes a session override for stage agents", async () => {
    await routeSetAgentModel(router(), "search", "a/1");
    expect(writeOverride).toHaveBeenCalledWith("search", "a/1");
    expect(setPaperAssistant).not.toHaveBeenCalled();

    await routeSetAgentModel(router(), "figures", null);
    expect(writeOverride).toHaveBeenCalledWith("figures", null);
  });
});
