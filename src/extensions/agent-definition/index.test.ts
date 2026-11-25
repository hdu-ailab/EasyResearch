import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import { createAgentDefinitionExtension } from "./index";

function binding(tools: string[] | undefined): AgentRuntimeBinding {
  return {
    current: () => ({ name: "research-assistant", tools }) as ReturnType<AgentRuntimeBinding["current"]>,
    skillPaths: () => ["/skills/workflow"],
    ensureCurrent: vi.fn(async () => {}),
    reapplyCompaction: vi.fn(async () => {}),
  } as unknown as AgentRuntimeBinding;
}

async function loadExtension(
  runtimeBinding: AgentRuntimeBinding,
  platform: NodeJS.Platform = "linux",
) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const setActiveTools = vi.fn();
  const registeredTools = ["read", "shell", "ssh-bash", "subagent", "models"];
  const api = {
    getAllTools: () => registeredTools.map((name) => ({ name })),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    setActiveTools,
  };
  await (createAgentDefinitionExtension(runtimeBinding, platform) as ExtensionFactory)(api as never);
  return { handlers, setActiveTools, registeredTools };
}

describe("createAgentDefinitionExtension", () => {
  it("applies the current definition's tools and contributes its exact Skill paths", async () => {
    const runtimeBinding = binding(["read", "subagent", "models"]);
    const { handlers, setActiveTools } = await loadExtension(runtimeBinding);

    await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });
    const resources = await handlers.get("resources_discover")?.(
      { cwd: "/paper", reason: "startup" },
      { cwd: "/paper" },
    );

    expect(setActiveTools).toHaveBeenCalledWith(runtimeBinding.current().tools);
    expect(resources).toEqual({ skillPaths: ["/skills/workflow"] });
  });

  it("activates every registered tool when the definition has no strict allowlist", async () => {
    const { handlers, setActiveTools, registeredTools } = await loadExtension(binding(undefined));

    await handlers.get("session_start")?.({ reason: "reload" }, { cwd: "/paper" });

    expect(setActiveTools).toHaveBeenCalledWith(registeredTools);
  });

  it.each(["win32", "linux", "darwin"] as const)("normalizes legacy strict local shells without changing SSH or dispatch capabilities on %s", async (platform) => {
    const preserved = ["read", "ssh-bash", "subagent", "models"];
    const { handlers, setActiveTools } = await loadExtension(
      binding([...preserved, "bash", "powershell", "shell"]),
      platform,
    );

    await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });

    const active = setActiveTools.mock.lastCall?.[0] as string[];
    expect(active.filter(tool => ["shell", "bash", "powershell"].includes(tool))).toEqual(["shell"]);
    expect(active.filter(tool => tool !== "shell")).toEqual(preserved);
    expect(new Set(active).size).toBe(active.length);
  });

  it.each(["win32", "linux", "darwin"] as const)("uses the current managed registry for all-tools on %s", async (platform) => {
    const { handlers, setActiveTools, registeredTools } = await loadExtension(binding(undefined), platform);
    registeredTools.push("custom-extension-tool");

    await handlers.get("session_start")?.({ reason: "reload" }, { cwd: "/paper" });

    expect(setActiveTools).toHaveBeenCalledWith(registeredTools);
  });

  it("awaits pending configuration application after the complete run settles", async () => {
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

    const turnEnd = handlers.get("agent_settled")?.({ aborted: false }, { cwd: "/paper" }).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(ensureCurrent).toHaveBeenCalledWith();
    release();
    await turnEnd;
    expect(settled).toBe(true);
  });

  it("leaves active tool follow-ups and post-run recovery on the accepted configuration", async () => {
    const runtimeBinding = binding(["read"]);
    const { handlers } = await loadExtension(runtimeBinding);

    await handlers.get("agent_end")?.({}, { cwd: "/paper" });
    await handlers.get("turn_end")?.({}, { cwd: "/paper" });

    expect(runtimeBinding.ensureCurrent).not.toHaveBeenCalled();
  });

  it("reapplies model-aware compaction before model selection settles", async () => {
    const runtimeBinding = binding(["read"]);
    const { handlers } = await loadExtension(runtimeBinding);

    await handlers.get("model_select")?.({ model: { contextWindow: 8_192 } }, { cwd: "/paper" });

    expect(runtimeBinding.reapplyCompaction).toHaveBeenCalledOnce();
    expect(runtimeBinding.ensureCurrent).not.toHaveBeenCalled();
  });
});
