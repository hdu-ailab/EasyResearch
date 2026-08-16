import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSubagentExtension } from "./index";

vi.mock("../../runtime/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../../runtime/pi-event-logger", () => ({
  mountPiEventLogger: vi.fn(),
}));

async function loadExtension(
  options: Parameters<typeof createSubagentExtension>[0] = {},
) {
  const api = {
    appendEntry: vi.fn(),
    on: vi.fn(),
    registerTool: vi.fn(),
  };

  await (createSubagentExtension(options) as ExtensionFactory)(api as never);
  return { registerTool: api.registerTool };
}

describe("createSubagentExtension nested dispatch", () => {
  it("does not register subagent for an explicit leaf policy", async () => {
    const { registerTool } = await loadExtension({
      callerAgent: "search",
      allowedSubagents: [],
    });

    expect(registerTool).not.toHaveBeenCalled();
  });

  it("registers subagent when the caller can dispatch", async () => {
    const { registerTool } = await loadExtension({
      callerAgent: "writing",
      allowedSubagents: ["search"],
    });
    expect(registerTool).toHaveBeenCalledTimes(1);
  });
});
