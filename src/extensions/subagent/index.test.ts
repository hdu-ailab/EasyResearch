import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentCoordinator, type CoordinatorSessionManager, type ReservedDispatch } from "../../subagent/coordinator";
import type { SubagentSupervisor } from "../../subagent/supervisor";
import { createSubagentExtension } from "./index";

vi.mock("../../runtime/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../runtime/pi-event-logger", () => ({ mountPiEventLogger: vi.fn() }));
vi.mock("../../subagent/model-resolution", () => ({ resolveModelForSpawn: async () => undefined }));
vi.mock("../../subagent/thinking-resolution", () => ({ resolveThinkingForSpawn: async () => "off" }));

const tempDirs: string[] = [];

function makeProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "easyresearch-nested-extension-"));
  tempDirs.push(cwd);
  return cwd;
}

function writeAgent(cwd: string, name: string, fields: string[] = []): void {
  const directory = join(cwd, ".easyresearch", "agents");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), [
    "---",
    `name: ${name}`,
    `description: ${name}`,
    ...fields,
    "---",
    `${name} prompt`,
    "",
  ].join("\n"), "utf8");
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
    supervisor: { launch } as unknown as SubagentSupervisor,
  };
}

async function loadExtension(options: Parameters<typeof createSubagentExtension>[0]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const registeredTools: Array<{
    name: string;
    description: string;
    execute: (...args: any[]) => Promise<any>;
  }> = [];
  const api = {
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    registerTool: vi.fn((tool) => registeredTools.push(tool)),
  };
  await (createSubagentExtension(options) as ExtensionFactory)(api as never);
  return { handlers, registeredTools };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createSubagentExtension nested dispatch", () => {
  it("does not register a subagent tool for an explicit leaf policy", async () => {
    const runtime = runtimeHarness();
    const { handlers, registeredTools } = await loadExtension({
      callerAgent: "search",
      allowedSubagents: [],
      coordinator: runtime.coordinator,
      supervisor: runtime.supervisor,
      agentDir: "/isolated/agent",
    });

    expect(handlers.has("session_start")).toBe(false);
    expect(registeredTools).toEqual([]);
  });

  it("registers the enabled/allowed catalog with the stage's own supervisor", async () => {
    const cwd = makeProject();
    writeAgent(cwd, "search");
    writeAgent(cwd, "figures", ["enable: false"]);
    writeAgent(cwd, "writing");
    const runtime = runtimeHarness();
    const { handlers, registeredTools } = await loadExtension({
      callerAgent: "writing",
      allowedSubagents: ["search", "figures"],
      coordinator: runtime.coordinator,
      supervisor: runtime.supervisor,
      agentDir: join(cwd, "global"),
    });

    expect(registeredTools).toEqual([]);
    await handlers.get("session_start")?.({ reason: "startup" }, { cwd });
    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]?.description).toContain("Available subagents: search.");
    expect(registeredTools[0]?.description).not.toContain("figures");

    const result = await registeredTools[0]!.execute(
      "tool-0",
      { agent: "search", task: "collect" },
      undefined,
      undefined,
      { cwd, sessionManager: runtime.ownerManager },
    );
    expect(result.content).toEqual([{ type: "text", text: "search_0 is working." }]);
    expect(runtime.launches[0]).toMatchObject({ ownerSessionId: "writing-child", agent: "search" });
  });

  it("keeps the caller in the allocation collision catalog without making it dispatchable", async () => {
    const cwd = makeProject();
    writeAgent(cwd, "search");
    writeAgent(cwd, "search_0");
    const runtime = runtimeHarness();
    const { handlers, registeredTools } = await loadExtension({
      callerAgent: "search_0",
      allowedSubagents: ["search"],
      coordinator: runtime.coordinator,
      supervisor: runtime.supervisor,
      agentDir: join(cwd, "global"),
    });
    await handlers.get("session_start")?.({ reason: "startup" }, { cwd });

    const result = await registeredTools[0]!.execute(
      "tool-0",
      { agent: "search", task: "collect" },
      undefined,
      undefined,
      { cwd, sessionManager: runtime.ownerManager },
    );

    expect(result.content).toEqual([{ type: "text", text: "search_1 is working." }]);
    await expect(registeredTools[0]!.execute(
      "tool-1",
      { agent: "search_0", task: "recurse" },
      undefined,
      undefined,
      { cwd, sessionManager: runtime.ownerManager },
    )).rejects.toThrow(/disabled|unavailable/i);
  });
});
