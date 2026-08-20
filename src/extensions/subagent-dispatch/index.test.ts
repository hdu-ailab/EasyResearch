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
import { createSubagentDispatchExtension } from "./index";

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

  getSessionId(): string {
    return "root";
  }
  getSessionFile(): string {
    return "/sessions/root.jsonl";
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
  const manager = new MemorySessionManager();
  const coordinator = new SubagentCoordinator(manager);
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
    manager,
    coordinator,
    launches,
    launch,
    supervisor: { launch } as unknown as SubagentSupervisor,
  };
}

async function loadExtension(options: Parameters<typeof createSubagentDispatchExtension>[0]) {
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
  await (createSubagentDispatchExtension(options) as ExtensionFactory)(api as never);
  return { handlers, tools, activeTools: () => activeTools };
}

function context(manager: MemorySessionManager): ExtensionContext {
  return { cwd: "/paper", sessionManager: manager } as unknown as ExtensionContext;
}

describe("createSubagentDispatchExtension live supervised dispatch", () => {
  it("leaves dispatch inactive on catalog churn until binding and catalog share a generation", async () => {
    const search = agent("search");
    const reviewer = agent("reviewer");
    const paperV1 = agent("paper-assistant", { subagents: ["search"] });
    const paperV2 = agent("paper-assistant", { subagents: ["reviewer"] });
    const binding = mutableBinding(paperV1);
    const live = new FakeLiveConfiguration([paperV1, search]);
    const runtime = runtimeHarness();
    const loaded = await loadExtension({ ...runtime, binding, liveConfiguration: live });
    await loaded.handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });
    expect(loaded.tools.get("subagent")?.description).toContain("Available subagents: search.");

    live.onResolve = () => {
      live.onResolve = undefined;
      live.publish([paperV2, reviewer]);
    };
    await loaded.handlers.get("session_start")?.({ reason: "reload" }, { cwd: "/paper" });
    expect(loaded.activeTools()).toEqual(["read"]);
    expect(loaded.tools.get("subagent")?.description).toContain("Available subagents: search.");

    binding.set(paperV2, live.generation);
    await loaded.handlers.get("session_start")?.({ reason: "reload" }, { cwd: "/paper" });
    expect(loaded.activeTools()).toEqual(["read", "subagent"]);
    expect(loaded.tools.get("subagent")?.description).toContain("Available subagents: reviewer.");
  });

  it("authorizes and atomically reserves from the latest caller policy at execution", async () => {
    const search = agent("search");
    const reviewer = agent("reviewer");
    const paperV1 = agent("paper-assistant", { subagents: ["search"] });
    const paperV2 = agent("paper-assistant", { subagents: ["reviewer"] });
    const binding = mutableBinding(paperV1);
    const live = new FakeLiveConfiguration([paperV1, search]);
    const runtime = runtimeHarness();
    const loaded = await loadExtension({ ...runtime, binding, liveConfiguration: live });
    await loaded.handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });

    live.publish([paperV2, search, reviewer]);
    binding.set(paperV2, live.generation);
    await loaded.handlers.get("session_start")?.({ reason: "reload" }, { cwd: "/paper" });
    const result = await loaded.tools.get("subagent")!.execute(
      "call-reviewer",
      { agent: "reviewer", task: "review" },
      undefined,
      undefined,
      context(runtime.manager),
    );

    expect(result.content).toEqual([{ type: "text", text: "reviewer_0 is working." }]);
    expect(runtime.launch).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "reviewer", agentId: "reviewer_0" }),
      expect.objectContaining({
        agent: expect.objectContaining({ name: "reviewer", source: "global" }),
        callerAgent: "paper-assistant",
        liveConfiguration: live,
      }),
    );
  });

  it("keeps one coordinator and supervisor across extension reloads", async () => {
    const paper = agent("paper-assistant", { subagents: ["search"] });
    const live = new FakeLiveConfiguration([paper, agent("search")]);
    const binding = mutableBinding(paper);
    const runtime = runtimeHarness();
    const first = await loadExtension({ ...runtime, binding, liveConfiguration: live });
    const second = await loadExtension({ ...runtime, binding, liveConfiguration: live });
    await first.handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });
    await second.handlers.get("session_start")?.({ reason: "reload" }, { cwd: "/paper" });

    await first.tools.get("subagent")!.execute(
      "call-1", { agent: "search", task: "one" }, undefined, undefined, context(runtime.manager),
    );
    await second.tools.get("subagent")!.execute(
      "call-2", { agent: "search", task: "two" }, undefined, undefined, context(runtime.manager),
    );

    expect(runtime.launches.map(({ agentId }) => agentId)).toEqual(["search_0", "search_1"]);
  });

  it("deactivates a leaf policy and makes the previously registered tool reject", async () => {
    const reviewer = agent("reviewer");
    const dispatching = agent("paper-assistant", { subagents: ["reviewer"] });
    const leaf = agent("paper-assistant", { subagents: [] });
    const binding = mutableBinding(dispatching);
    const live = new FakeLiveConfiguration([dispatching, reviewer]);
    const runtime = runtimeHarness();
    const loaded = await loadExtension({ ...runtime, binding, liveConfiguration: live });
    await loaded.handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });
    const oldTool = loaded.tools.get("subagent")!;

    live.publish([leaf, reviewer]);
    binding.set(leaf, live.generation);
    await loaded.handlers.get("session_start")?.({ reason: "reload" }, { cwd: "/paper" });

    expect(loaded.activeTools()).toEqual(["read"]);
    await expect(oldTool.execute(
      "call-leaf", { agent: "reviewer", task: "review" }, undefined, undefined, context(runtime.manager),
    )).rejects.toThrow(/disabled|unavailable/i);
    expect(runtime.launch).not.toHaveBeenCalled();
  });
});
