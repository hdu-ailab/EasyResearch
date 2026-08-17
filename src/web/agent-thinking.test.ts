import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_THINKING_ENTRY } from "../subagent/thinking-resolution";
import { ConfigFileService } from "./config-files";
import {
  AgentThinkingError,
  readAgentThinking,
  readPaperAssistantThinkingDefault,
  readThinkingOverrideForAgent,
  resolveAgentThinkingService,
  routeSetAgentThinking,
  writeThinkingOverride,
  type EntryRow,
} from "./agent-thinking";

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
        return [key, value];
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

describe("agent-thinking custom entries", () => {
  it("reads the latest override per agent; null resets", () => {
    const rows = entries([
      { type: "custom", customType: AGENT_THINKING_ENTRY, data: { agent: "search", thinking: "high" } },
      { type: "custom", customType: AGENT_THINKING_ENTRY, data: { agent: "search", thinking: null } },
      { type: "custom", customType: AGENT_THINKING_ENTRY, data: { agent: "figures", thinking: "low" } },
    ]);
    expect(readThinkingOverrideForAgent(rows, "search")).toBeNull();
    expect(readThinkingOverrideForAgent(rows, "figures")).toBe("low");
    expect(readThinkingOverrideForAgent(rows, "writing")).toBeUndefined();
  });
});

describe("agent-thinking session I/O", () => {
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

  it("appends a custom entry with the agent thinking payload", async () => {
    await writeThinkingOverride(sessionPath, "search", "high");
    expect(appendCustomEntry).toHaveBeenCalledWith(AGENT_THINKING_ENTRY, { agent: "search", thinking: "high" });

    await writeThinkingOverride(sessionPath, "search", null);
    expect(appendCustomEntry).toHaveBeenCalledWith(AGENT_THINKING_ENTRY, { agent: "search", thinking: null });
  });

  it("rejects overrides without a session file", async () => {
    await expect(writeThinkingOverride(undefined, "search", "high")).rejects.toThrow();
  });
});

describe("agent-thinking settings sources", () => {
  let agentDir: string;
  let cwd: string;
  let config: ConfigFileService;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "lazy-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "lazy-project-"));
    config = new ConfigFileService(agentDir);
  });

  it("reads thinking defaults from global Markdown frontmatter", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "search.md"), "---\nname: search\ndescription: finds papers\nthinking: high\n---\nbody");
    await expect(readAgentThinking(config, { scope: "global" })).resolves.toEqual({ search: "high" });
  });

  it("treats a missing or invalid thinking value as no config", async () => {
    await expect(readAgentThinking(config, { scope: "global" })).resolves.toBeUndefined();
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "search.md"), "---\nname: search\ndescription: finds papers\nthinking: ultra\n---\nbody");
    await expect(readAgentThinking(config, { scope: "global" })).resolves.toBeUndefined();
  });

  it("reads only project-scoped thinking defaults", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "search.md"), "---\nname: search\ndescription: finds papers\nthinking: low\n---\nbody");
    mkdirSync(join(cwd, ".easyresearch", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".easyresearch", "agents", "writing.md"), "---\nname: writing\ndescription: writes papers\nthinking: high\n---\nbody");
    await expect(readAgentThinking(config, { scope: "project", cwd })).resolves.toEqual({ writing: "high" });
  });

  it("returns the project Paper Assistant default over the global one", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "paper-assistant.md"), "---\nname: paper-assistant\ndescription: Paper Assistant\nthinking: low\n---\nbody");
    mkdirSync(join(cwd, ".easyresearch", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".easyresearch", "agents", "paper-assistant.md"), "---\nname: paper-assistant\ndescription: Paper Assistant\nthinking: high\n---\nbody");
    await expect(readPaperAssistantThinkingDefault(config, cwd)).resolves.toBe("high");
  });

  it("returns undefined when the Paper Assistant thinking default is unset", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "paper-assistant.md"), "---\nname: paper-assistant\ndescription: Paper Assistant\n---\nbody");
    await expect(readPaperAssistantThinkingDefault(config, cwd)).resolves.toBeUndefined();
  });
});

describe("resolveAgentThinkingService.effective", () => {
  const roster = () => [
    { name: "paper-assistant" },
    { name: "search" },
    { name: "experiment" },
    { name: "writing" },
    { name: "figures" },
  ];

  it("resolves the live Paper Assistant level and Markdown defaults per agent", async () => {
    const service = resolveAgentThinkingService({
      listAgents: async () => roster(),
      getSessionPath: async () => "/sessions/o.jsonl",
      readEntries: async () => [
        { type: "custom", customType: AGENT_THINKING_ENTRY, data: { agent: "search", thinking: "high" } },
        { type: "custom", customType: AGENT_THINKING_ENTRY, data: { agent: "figures", thinking: null } },
      ],
      projectAgentThinking: async () => ({ experiment: "medium", figures: "low" }),
      globalAgentThinking: async () => ({ figures: "medium", writing: "low" }),
      paperAssistantThinking: async () => "high",
      getCwd: async () => "/tmp/proj",
    });
    await expect(service.effective("s1")).resolves.toEqual([
      { name: "paper-assistant", thinking: "high", source: "override" },
      { name: "search", thinking: "high", source: "override" },
      { name: "experiment", thinking: "medium", source: "default" },
      { name: "writing", thinking: "low", source: "default" },
      { name: "figures", thinking: "low", source: "default" },
    ]);
  });

  it("falls back to the Paper Assistant live level and reports inherit", async () => {
    const service = resolveAgentThinkingService({
      listAgents: async () => roster(),
      getSessionPath: async () => undefined,
      readEntries: async () => [] as EntryRow[],
      projectAgentThinking: async () => undefined,
      globalAgentThinking: async () => undefined,
      paperAssistantThinking: async () => "medium",
      getCwd: async () => "/tmp/proj",
    });
    const effective = await service.effective("s1");
    expect(effective).toEqual(
      roster().map((a) => ({
        name: a.name,
        thinking: a.name === "paper-assistant" ? "medium" : "medium",
        source: a.name === "paper-assistant" ? "override" : "inherit",
      })),
    );
  });

  it("reports thinking null with source inherit when nothing resolves", async () => {
    const service = resolveAgentThinkingService({
      listAgents: async () => roster(),
      getSessionPath: async () => undefined,
      readEntries: async () => [] as EntryRow[],
      projectAgentThinking: async () => undefined,
      globalAgentThinking: async () => undefined,
      paperAssistantThinking: async () => undefined,
      getCwd: async () => "/tmp/proj",
    });
    const effective = await service.effective("s1");
    expect(effective).toEqual(roster().map((a) => ({ name: a.name, thinking: null, source: "inherit" })));
  });

  it("resolves the Paper Assistant from the global default while follow-global is flagged", async () => {
    const service = resolveAgentThinkingService({
      listAgents: async () => roster(),
      getSessionPath: async () => "/sessions/o.jsonl",
      readEntries: async () => [
        { type: "custom", customType: "easyresearch:follow_global_settings", data: { follow: true } },
      ],
      projectAgentThinking: async () => ({ "paper-assistant": "high" }),
      globalAgentThinking: async () => ({ "paper-assistant": "low", writing: "off" }),
      paperAssistantThinking: async () => "medium",
      getCwd: async () => "/tmp/proj",
    });
    await expect(service.effective("s1")).resolves.toEqual([
      { name: "paper-assistant", thinking: "high", source: "default" },
      { name: "search", thinking: "high", source: "inherit" },
      { name: "experiment", thinking: "high", source: "inherit" },
      { name: "writing", thinking: "off", source: "default" },
      { name: "figures", thinking: "high", source: "inherit" },
    ]);
  });

  it("falls back to the live session level when follow-global has no default thinking", async () => {
    const service = resolveAgentThinkingService({
      listAgents: async () => roster(),
      getSessionPath: async () => "/sessions/o.jsonl",
      readEntries: async () => [
        { type: "custom", customType: "easyresearch:follow_global_settings", data: { follow: true } },
      ],
      projectAgentThinking: async () => undefined,
      globalAgentThinking: async () => undefined,
      paperAssistantThinking: async () => "medium",
      getCwd: async () => "/tmp/proj",
    });
    const effective = await service.effective("s1");
    expect(effective[0]).toEqual({ name: "paper-assistant", thinking: "medium", source: "inherit" });
  });
});

describe("routeSetAgentThinking", () => {
  const setPaperAssistant = vi.fn();
  const writeOverride = vi.fn();
  const defaultLevel = vi.fn<() => Promise<string | undefined>>();
  const known = new Set(["paper-assistant", "search", "figures"]);

  function router() {
    return {
      isPaperAssistant: (name: string) => name === "paper-assistant",
      isKnownAgent: (name: string) => known.has(name),
      setPaperAssistant,
      writeOverride,
      paperAssistantDefault: defaultLevel,
    };
  }

  beforeEach(() => {
    setPaperAssistant.mockReset();
    writeOverride.mockReset();
    defaultLevel.mockReset();
  });

  it("rejects unknown agents with 404", async () => {
    await expect(routeSetAgentThinking(router(), "ghost", "high")).rejects.toThrow(AgentThinkingError);
    try {
      await routeSetAgentThinking(router(), "ghost", "high");
    } catch (error) {
      expect((error as AgentThinkingError).status).toBe(404);
    }
    expect(writeOverride).not.toHaveBeenCalled();
  });

  it("routes a Paper Assistant level through RPC setThinkingLevel", async () => {
    await routeSetAgentThinking(router(), "paper-assistant", "high");
    expect(setPaperAssistant).toHaveBeenCalledWith("high");
    expect(writeOverride).not.toHaveBeenCalled();
  });

  it("resets the Paper Assistant to its Markdown default, or off when unset", async () => {
    defaultLevel.mockResolvedValue("medium");
    await routeSetAgentThinking(router(), "paper-assistant", null);
    expect(setPaperAssistant).toHaveBeenCalledWith("medium");

    setPaperAssistant.mockClear();
    defaultLevel.mockResolvedValue(undefined);
    await routeSetAgentThinking(router(), "paper-assistant", null);
    expect(setPaperAssistant).toHaveBeenCalledWith("off");
  });

  it("writes a session override for stage agents", async () => {
    await routeSetAgentThinking(router(), "search", "high");
    expect(writeOverride).toHaveBeenCalledWith("search", "high");
    expect(setPaperAssistant).not.toHaveBeenCalled();

    await routeSetAgentThinking(router(), "figures", null);
    expect(writeOverride).toHaveBeenCalledWith("figures", null);
  });
});
