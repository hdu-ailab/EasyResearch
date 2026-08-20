import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import { createAgentDefinitionExtension } from "./index";

function binding(tools: string[] | undefined): AgentRuntimeBinding {
  return {
    current: () => ({ tools }) as ReturnType<AgentRuntimeBinding["current"]>,
    skillPaths: () => ["/skills/workflow"],
    ensureCurrent: vi.fn(async () => {}),
  } as unknown as AgentRuntimeBinding;
}

async function loadExtension(runtimeBinding: AgentRuntimeBinding) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const setActiveTools = vi.fn();
  const api = {
    getAllTools: vi.fn(() => ["read", "bash", "subagent"].map((name) => ({ name }))),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    setActiveTools,
  };
  await (createAgentDefinitionExtension(runtimeBinding) as ExtensionFactory)(api as never);
  return { handlers, setActiveTools };
}

describe("createAgentDefinitionExtension", () => {
  it("applies the current definition's tools and contributes its exact Skill paths", async () => {
    const runtimeBinding = binding(["read", "subagent"]);
    const { handlers, setActiveTools } = await loadExtension(runtimeBinding);

    await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });
    const resources = await handlers.get("resources_discover")?.(
      { cwd: "/paper", reason: "startup" },
      { cwd: "/paper" },
    );

    expect(setActiveTools).toHaveBeenCalledWith(["read", "subagent"]);
    expect(resources).toEqual({ skillPaths: ["/skills/workflow"] });
  });

  it("activates every registered tool when the definition has no strict allowlist", async () => {
    const { handlers, setActiveTools } = await loadExtension(binding(undefined));

    await handlers.get("session_start")?.({ reason: "reload" }, { cwd: "/paper" });

    expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "subagent"]);
  });

  it("awaits active-generation application from turn_end", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const ensureCurrent = vi.fn(async () => gate);
    const runtimeBinding = {
      ...binding(["read"]),
      ensureCurrent,
    } as AgentRuntimeBinding;
    const { handlers } = await loadExtension(runtimeBinding);

    const turnEnd = handlers.get("turn_end")?.({ turnIndex: 0 }, { cwd: "/paper" }).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(ensureCurrent).toHaveBeenCalledWith({ activeBoundary: true });
    release();
    await turnEnd;
    expect(settled).toBe(true);
  });
});
