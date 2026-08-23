import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeBinding } from "../runtime/agent-runtime-binding";
import type { LiveConfiguration } from "../runtime/live-configuration";
import type { SubagentCoordinator } from "../subagent/coordinator";
import type { SubagentSupervisor } from "../subagent/supervisor";
import { ManualCompactionController } from "../web/manual-compaction";
import { createResearchAssistantExtensions, type ResearchAssistantExtensionRuntime } from "./index";

function binding(tools: string[]): AgentRuntimeBinding {
  return {
    current: () => ({ tools }),
    skillPaths: () => [],
    ensureCurrent: vi.fn(async () => {}),
  } as unknown as AgentRuntimeBinding;
}

function runtime(label: string, tools = ["read"]): ResearchAssistantExtensionRuntime {
  return {
    binding: binding(tools),
    liveConfiguration: {} as LiveConfiguration,
    coordinator: { label } as unknown as SubagentCoordinator,
    supervisor: { label } as unknown as SubagentSupervisor,
    compaction: new ManualCompactionController(),
  };
}

describe("bundled extension runtime builder", () => {
  it("returns named in-process factories without the legacy agent-status extension", () => {
    const extensions = createResearchAssistantExtensions(runtime("root-a"));

    expect(extensions.length).toBeGreaterThan(0);
    expect(extensions.map(({ name }) => name)).not.toContain("agent-status");
    for (const extension of extensions) {
      expect(extension.name.length).toBeGreaterThan(0);
      expect(typeof extension.factory).toBe("function");
    }
  });

  it("builds fresh runtime-bound dispatch factories for separate roots", () => {
    const first = createResearchAssistantExtensions(runtime("root-a"));
    const second = createResearchAssistantExtensions(runtime("root-b"));

    expect(first).not.toBe(second);
    expect(first.find(({ name }) => name === "subagent-dispatch")?.factory)
      .not.toBe(second.find(({ name }) => name === "subagent-dispatch")?.factory);
  });

  it("applies the binding supplied to that registry instance", async () => {
    const extensions = createResearchAssistantExtensions(runtime("root-a", ["read", "subagent"]));
    const definition = extensions.find((entry) => entry.name === "research-assistant");
    const handlers = new Map<string, (...args: any[]) => any>();
    const setActiveTools = vi.fn();
    const api = {
      getAllTools: vi.fn(() => ["read", "bash", "subagent"].map((name) => ({ name }))),
      on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
      setActiveTools,
    };
    await (definition!.factory as ExtensionFactory)(api as never);

    await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });

    expect(setActiveTools).toHaveBeenCalledWith(["read", "subagent"]);
  });
});
