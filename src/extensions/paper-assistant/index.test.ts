import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeBinding } from "../../runtime/agent-runtime-binding";
import { createPaperAssistantExtension } from "./index";

describe("createPaperAssistantExtension", () => {
  it("binds tools, Skills, and safe-turn refresh to the supplied runtime binding", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const setActiveTools = vi.fn();
    const ensureCurrent = vi.fn(async () => {});
    const binding = {
      current: () => ({ tools: ["read", "subagent"] }),
      skillPaths: () => ["/skills/research-project-workflow"],
      ensureCurrent,
    } as unknown as AgentRuntimeBinding;
    const api = {
      getAllTools: vi.fn(() => ["read", "bash", "subagent"].map((name) => ({ name }))),
      on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
      setActiveTools,
    };
    await (createPaperAssistantExtension(binding) as ExtensionFactory)(api as never);

    await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });
    const resources = await handlers.get("resources_discover")?.(
      { cwd: "/paper", reason: "startup" },
      { cwd: "/paper" },
    );
    await handlers.get("turn_end")?.({ turnIndex: 0 }, { cwd: "/paper", abort: vi.fn() });

    expect(setActiveTools).toHaveBeenCalledWith(["read", "subagent"]);
    expect(resources).toEqual({ skillPaths: ["/skills/research-project-workflow"] });
    expect(ensureCurrent).toHaveBeenCalledWith({ activeBoundary: true });
    expect(handlers.has("before_agent_start")).toBe(false);
  });
});
