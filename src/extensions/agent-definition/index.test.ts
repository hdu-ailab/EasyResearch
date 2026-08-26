import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import { createAgentDefinitionExtension } from "./index";

function binding(tools: string[] | undefined): AgentRuntimeBinding {
  return {
    current: () => ({ tools }) as ReturnType<AgentRuntimeBinding["current"]>,
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
  const api = {
    getAllTools: vi.fn(() => ["read", "powershell", "ssh-bash"].map((name) => ({ name }))),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
    setActiveTools,
  };
  await (createAgentDefinitionExtension(runtimeBinding, platform) as ExtensionFactory)(api as never);
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

    expect(setActiveTools).toHaveBeenCalledWith(["read", "powershell", "ssh-bash"]);
  });

  it("normalizes strict shell names to powershell on Windows", async () => {
    const { handlers, setActiveTools } = await loadExtension(
      binding(["read", "bash", "powershell", "ssh-bash"]),
      "win32",
    );

    await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });

    expect(setActiveTools).toHaveBeenCalledWith(["read", "powershell", "ssh-bash"]);
  });

  it("uses Pi's already-filtered registry for all-tools", async () => {
    const { handlers, setActiveTools } = await loadExtension(binding(undefined), "win32");

    await handlers.get("session_start")?.({ reason: "reload" }, { cwd: "/paper" });

    expect(setActiveTools).toHaveBeenCalledWith(["read", "powershell", "ssh-bash"]);
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

  it("applies active configuration before Pi's post-run threshold check", async () => {
    const runtimeBinding = binding(["read"]);
    const { handlers } = await loadExtension(runtimeBinding);

    await handlers.get("agent_end")?.({}, { cwd: "/paper" });

    expect(runtimeBinding.ensureCurrent).toHaveBeenCalledWith({ activeBoundary: true });
  });

  it("reapplies model-aware compaction before model selection settles", async () => {
    const runtimeBinding = binding(["read"]);
    const { handlers } = await loadExtension(runtimeBinding);

    await handlers.get("model_select")?.({ model: { contextWindow: 8_192 } }, { cwd: "/paper" });

    expect(runtimeBinding.reapplyCompaction).toHaveBeenCalledOnce();
    expect(runtimeBinding.ensureCurrent).not.toHaveBeenCalled();
  });
});
