import { describe, expect, it } from "vitest";
import type { SubagentCoordinator } from "../subagent/coordinator";
import type { SubagentSupervisor } from "../subagent/supervisor";
import { createAssistantExtensions } from "./index";

function runtime(label: string) {
  return {
    coordinator: { label } as unknown as SubagentCoordinator,
    supervisor: { label } as unknown as SubagentSupervisor,
  };
}

describe("bundled extension runtime builder", () => {
  it("returns named in-process factories without the legacy agent-status extension", () => {
    const extensions = createAssistantExtensions(runtime("root-a"));

    expect(extensions.length).toBeGreaterThan(0);
    expect(extensions.map(({ name }) => name)).not.toContain("agent-status");
    for (const extension of extensions) {
      expect(extension.name.length).toBeGreaterThan(0);
      expect(typeof extension.factory).toBe("function");
    }
  });

  it("builds fresh runtime-bound extension instances for separate roots", () => {
    const first = createAssistantExtensions(runtime("root-a"));
    const second = createAssistantExtensions(runtime("root-b"));
    const firstDispatch = first.find(({ name }) => name === "subagent-dispatch");
    const secondDispatch = second.find(({ name }) => name === "subagent-dispatch");

    expect(first).not.toBe(second);
    expect(firstDispatch?.factory).not.toBe(secondDispatch?.factory);
  });
});
