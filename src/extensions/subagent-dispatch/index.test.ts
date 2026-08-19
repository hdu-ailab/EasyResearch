import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentCoordinator, type CoordinatorSessionManager, type ReservedDispatch } from "../../subagent/coordinator";
import type { SubagentSupervisor } from "../../subagent/supervisor";
import { createSubagentDispatchExtension } from "./index";

vi.mock("../../subagent/model-resolution", () => ({ resolveModelForSpawn: async () => undefined }));
vi.mock("../../subagent/thinking-resolution", () => ({ resolveThinkingForSpawn: async () => "off" }));

const tempDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "easyresearch-subagent-dispatch-"));
  tempDirs.push(dir);
  return dir;
}

function definition(name: string, body: string, fields: string[] = []): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name}`,
    ...fields,
    "---",
    body,
    "",
  ].join("\n");
}

function writeAgent(directory: string, name: string, content: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.md`), content, "utf8");
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
  const dispose = vi.fn();
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
  const supervisor = { launch, dispose } as unknown as SubagentSupervisor;
  return { manager, coordinator, supervisor, launches, launch, dispose };
}

async function loadExtension(options: Parameters<typeof createSubagentDispatchExtension>[0]) {
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
  await (createSubagentDispatchExtension(options) as ExtensionFactory)(api as never);
  return { handlers, registeredTools };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createSubagentDispatchExtension runtime wiring", () => {
  it("registers a fixed enabled/allowed catalog at session_start", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "paper-assistant", definition(
      "paper-assistant",
      "Bundled Paper Assistant",
      ["subagents: [search, writing]"],
    ));
    writeAgent(join(bundledAgentsDir, "agents"), "search", definition("search", "Search"));
    writeAgent(join(bundledAgentsDir, "agents"), "writing", definition("writing", "Writing", ["enable: false"]));
    const runtime = runtimeHarness();
    const { handlers, registeredTools } = await loadExtension({
      coordinator: runtime.coordinator,
      supervisor: runtime.supervisor,
      agentDir,
      bundledAgentsDir,
    });

    expect(registeredTools).toEqual([]);
    await handlers.get("session_start")?.({ reason: "startup" }, { cwd });

    expect(registeredTools).toHaveLength(1);
    expect(registeredTools[0]?.description).toBe([
      "Delegate tasks to specialized subagents with isolated context.",
      "Sub agents run in the exact project directory.",
      "Available subagents: search.",
    ].join("\n"));
    const result = await registeredTools[0]!.execute(
      "tool-0",
      { agent: "search", task: "collect" },
      undefined,
      undefined,
      { cwd, sessionManager: runtime.manager },
    );
    expect(result.content).toEqual([{ type: "text", text: "search_0 is working." }]);
    expect(runtime.launch).toHaveBeenCalledOnce();
    await expect(registeredTools[0]!.execute(
      "tool-1",
      { agent: "writing", task: "draft" },
      undefined,
      undefined,
      { cwd, sessionManager: runtime.manager },
    )).rejects.toThrow(/disabled|unavailable/i);
  });

  it("re-registers on reload against the same runtime-owned supervisor", async () => {
    const root = makeRoot();
    const cwd = join(root, "project");
    const agentDir = join(root, "global");
    const bundledAgentsDir = join(root, "bundled");
    writeAgent(join(bundledAgentsDir, "agents"), "paper-assistant", definition("paper-assistant", "Assistant", ["subagents: [search]"]));
    writeAgent(join(bundledAgentsDir, "agents"), "search", definition("search", "Search"));
    const runtime = runtimeHarness();
    const options = {
      coordinator: runtime.coordinator,
      supervisor: runtime.supervisor,
      agentDir,
      bundledAgentsDir,
    };

    const firstLoad = await loadExtension(options);
    await firstLoad.handlers.get("session_start")?.({ reason: "startup" }, { cwd });
    const reloaded = await loadExtension(options);
    await reloaded.handlers.get("session_start")?.({ reason: "reload" }, { cwd });

    await firstLoad.registeredTools[0]!.execute(
      "tool-0",
      { agent: "search", task: "one" },
      undefined,
      undefined,
      { cwd, sessionManager: runtime.manager },
    );
    await reloaded.registeredTools[0]!.execute(
      "tool-1",
      { agent: "search", task: "two" },
      undefined,
      undefined,
      { cwd, sessionManager: runtime.manager },
    );

    expect(runtime.launch).toHaveBeenCalledTimes(2);
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(runtime.launches.map(({ agentId }) => agentId)).toEqual(["search_0", "search_1"]);
  });
});
