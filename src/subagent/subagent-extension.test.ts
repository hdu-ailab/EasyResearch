import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentExtension } from "./subagent-extension";

vi.mock("../runtime/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../runtime/pi-event-logger", () => ({
  mountPiEventLogger: vi.fn(),
}));

afterEach(() => {
  delete process.env.EASYRESEARCH_AGENT_TOOLS;
});

async function loadExtension(toolMode: string | undefined) {
  if (toolMode === undefined) delete process.env.EASYRESEARCH_AGENT_TOOLS;
  else process.env.EASYRESEARCH_AGENT_TOOLS = toolMode;

  const handlers = new Map<string, (...args: never[]) => unknown>();
  const setActiveTools = vi.fn();
  const allTools = ["read", "bash", "custom-tool", "subagent", "web-search"].map((name) => ({ name }));
  const api = {
    appendEntry: vi.fn(),
    getAllTools: vi.fn(() => allTools),
    on: vi.fn((event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler)),
    registerTool: vi.fn(),
    setActiveTools,
  };

  await (createSubagentExtension() as ExtensionFactory)(api as never);
  return { handlers, setActiveTools };
}

describe("createSubagentExtension stage tool activation", () => {
  it("activates every Pi-configured tool only in exact all mode", async () => {
    const { handlers, setActiveTools } = await loadExtension("all");

    await handlers.get("session_start")?.();

    expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "custom-tool", "subagent", "web-search"]);
  });

  it.each([undefined, "read,bash", "ALL", ""])("does not widen selection for mode %s", async (mode) => {
    const { handlers, setActiveTools } = await loadExtension(mode);

    await handlers.get("session_start")?.();

    expect(setActiveTools).not.toHaveBeenCalled();
  });
});
