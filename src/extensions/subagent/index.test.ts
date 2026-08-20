import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import type { AgentConfig } from "../../subagent/agents";
import {
  SubagentCoordinator,
  type CoordinatorSessionManager,
  type ReservedDispatch,
} from "../../subagent/coordinator";
import type { SubagentSupervisor } from "../../subagent/supervisor";
import { createSubagentExtension } from "./index";

vi.mock("../../runtime/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../runtime/pi-event-logger", () => ({ mountPiEventLogger: vi.fn() }));

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: name,
    enabled: true,
    builtin: name !== "reviewer",
    source: name === "reviewer" ? "global" : "bundled",
    filePath: `/agents/${name}.md`,
    systemPrompt: `${name} prompt`,
    tools: ["read", "subagent"],
    effectiveTools: ["read", "subagent"],
    skills: [],
    effectiveSkills: [],
    missingSkills: [],
    ...overrides,
  };
}

class FakeLiveConfiguration {
  generation = 1;
  onResolve: (() => void) | undefined;

  constructor(private rows: AgentConfig[]) {}

  async synchronize(): Promise<void> {}
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
  async resolveAgents(): Promise<AgentConfig[]> {
    const rows = this.rows;
    this.onResolve?.();
    return rows;
  }
  publish(rows: AgentConfig[]): void {
    this.rows = rows;
    this.generation += 1;
  }
  subscribe(): () => void {
    return () => {};
  }
}

function mutableBinding(initial: AgentConfig): AgentRuntimeBinding & { set(agent: AgentConfig, generation: number): void } {
  let current = initial;
  let generation = 1;
  return {
    current: () => current,
    generation: () => generation,
    set: (next, nextGeneration) => {
      current = next;
      generation = nextGeneration;
    },
  } as AgentRuntimeBinding & { set(agent: AgentConfig, generation: number): void };
}

class MemorySessionManager implements CoordinatorSessionManager {
  readonly entries: unknown[] = [];

  constructor(private readonly id: string) {}
  getSessionId(): string {
    return this.id;
  }
  getSessionFile(): string {
    return `/sessions/${this.id}.jsonl`;
  }
  getEntries(): unknown[] {
    return this.entries;
  }
  appendCustomEntry(customType: string, data?: unknown): string {
    const id = `entry-${this.entries.length}`;
    this.entries.push({ type: "custom", id, customType, data });
    return id;
  }
}

function runtimeHarness() {
  const rootManager = new MemorySessionManager("root");
  const ownerManager = new MemorySessionManager("writing-child");
  const coordinator = new SubagentCoordinator(rootManager);
  const launches: ReservedDispatch[] = [];
  const launch = vi.fn(async (reservation: ReservedDispatch) => {
    launches.push(reservation);
    return {
      mode: "single" as const,
      background: true as const,
      job: {
        launchId: reservation.launchId,
        ownerSessionId: reservation.ownerSessionId,
        toolCallId: reservation.toolCallId,
        agent: reservation.agent,
        agentId: reservation.agentId,
        childSessionId: `child-${reservation.agentId}`,
        status: "working" as const,
      },
    };
  });
  return {
    rootManager,
    ownerManager,
    coordinator,
    launches,
    launch,
    supervisor: { launch } as unknown as SubagentSupervisor,
  };
}

async function loadExtension(options: Parameters<typeof createSubagentExtension>[0]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, { name: string; description: string; execute: (...args: any[]) => Promise<any> }>();
  let activeTools = ["read", "subagent"];
  const api = {
    getActiveTools: vi.fn(() => [...activeTools]),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    registerTool: vi.fn((tool: { name: string; description: string; execute: (...args: any[]) => Promise<any> }) => {
      tools.set(tool.name, tool);
    }),
    setActiveTools: vi.fn((names: string[]) => {
      activeTools = [...names];
    }),
  };
  await (createSubagentExtension(options) as ExtensionFactory)(api as never);
  return { api, handlers, tools, activeTools: () => activeTools };
}

function context(manager: MemorySessionManager): ExtensionContext {
  return { cwd: "/paper", sessionManager: manager } as unknown as ExtensionContext;
}

describe("createSubagentExtension nested supervised dispatch", () => {
  it("does not register or activate subagent for an explicit leaf policy", async () => {
    const leaf = agent("search", { subagents: [] });
    const live = new FakeLiveConfiguration([agent("paper-assistant"), leaf]);
    const runtime = runtimeHarness();
    const loaded = await loadExtension({
      binding: mutableBinding(leaf),
      liveConfiguration: live,
      coordinator: runtime.coordinator,
      supervisor: runtime.supervisor,
    });

    await loaded.handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });

    expect(loaded.tools.has("subagent")).toBe(false);
    expect(loaded.activeTools()).toEqual(["read"]);
  });

  it("uses the stage's own supervisor while reserving ids in the root coordinator", async () => {
    const writing = agent("writing", { subagents: ["search"] });
    const live = new FakeLiveConfiguration([agent("paper-assistant"), writing, agent("search")]);
    const runtime = runtimeHarness();
    const loaded = await loadExtension({
      binding: mutableBinding(writing),
      liveConfiguration: live,
      coordinator: runtime.coordinator,
      supervisor: runtime.supervisor,
    });
    await loaded.handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });

    const result = await loaded.tools.get("subagent")!.execute(
      "tool-0",
      { agent: "search", task: "collect" },
      undefined,
      undefined,
      context(runtime.ownerManager),
    );

    expect(result.content).toEqual([{ type: "text", text: "search_0 is working." }]);
    expect(runtime.launches[0]).toMatchObject({
      ownerSessionId: "writing-child",
      agent: "search",
      agentId: "search_0",
    });
    expect(runtime.launch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callerAgent: "writing", liveConfiguration: live }),
    );
  });

  it("keeps caller names in the collision catalog without making them dispatchable", async () => {
    const caller = agent("search_0", { subagents: ["search"] });
    const live = new FakeLiveConfiguration([agent("paper-assistant"), caller, agent("search")]);
    const runtime = runtimeHarness();
    const loaded = await loadExtension({
      binding: mutableBinding(caller),
      liveConfiguration: live,
      coordinator: runtime.coordinator,
      supervisor: runtime.supervisor,
    });
    await loaded.handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });

    const result = await loaded.tools.get("subagent")!.execute(
      "tool-0", { agent: "search", task: "collect" }, undefined, undefined, context(runtime.ownerManager),
    );

    expect(result.content).toEqual([{ type: "text", text: "search_1 is working." }]);
    await expect(loaded.tools.get("subagent")!.execute(
      "tool-1", { agent: "search_0", task: "recurse" }, undefined, undefined, context(runtime.ownerManager),
    )).rejects.toThrow(/ambiguous|disabled|unavailable/i);
  });

  it("replaces the description only after the binding reaches the new generation", async () => {
    const writingV1 = agent("writing", { subagents: ["search"] });
    const writingV2 = agent("writing", { subagents: ["reviewer"] });
    const binding = mutableBinding(writingV1);
    const live = new FakeLiveConfiguration([agent("paper-assistant"), writingV1, agent("search")]);
    const runtime = runtimeHarness();
    const loaded = await loadExtension({
      binding,
      liveConfiguration: live,
      coordinator: runtime.coordinator,
      supervisor: runtime.supervisor,
    });
    await loaded.handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });

    live.publish([agent("paper-assistant"), writingV2, agent("reviewer")]);
    await loaded.handlers.get("session_start")?.({ reason: "reload" }, { cwd: "/paper" });
    expect(loaded.activeTools()).toEqual(["read"]);
    expect(loaded.tools.get("subagent")?.description).toContain("Available subagents: search.");

    binding.set(writingV2, live.generation);
    await loaded.handlers.get("session_start")?.({ reason: "reload" }, { cwd: "/paper" });
    expect(loaded.activeTools()).toEqual(["read", "subagent"]);
    expect(loaded.tools.get("subagent")?.description).toContain("Available subagents: reviewer.");
  });
});
