import { describe, expect, it, vi } from "vitest";
import { resolvePiDefaultModel, type PiDefaultModelApi } from "./pi-default-model";

function piWithModel(model: { provider: string; id: string } | undefined) {
  const dispose = vi.fn();
  class Loader {
    async reload() {}
  }
  return {
    pi: {
      DefaultResourceLoader: Loader,
      SessionManager: { inMemory: () => ({}) },
      createAgentSession: async () => ({ session: { model, dispose } }),
    } as unknown as PiDefaultModelApi,
    dispose,
  };
}

describe("resolvePiDefaultModel", () => {
  it("rejects Pi's internal unknown model sentinel when no model is available", async () => {
    const { pi, dispose } = piWithModel({ provider: "unknown", id: "unknown" });

    await expect(resolvePiDefaultModel({
      pi,
      cwd: "/paper",
      agentDir: "/agent",
      modelRuntime: { getAvailableSnapshot: () => [] },
      settingsManager: {},
    })).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("returns only a model present in the available snapshot", async () => {
    const model = { provider: "local", id: "model" };
    const { pi } = piWithModel(model);

    await expect(resolvePiDefaultModel({
      pi,
      cwd: "/paper",
      agentDir: "/agent",
      modelRuntime: { getAvailableSnapshot: () => [model] },
      settingsManager: {},
    })).resolves.toBe(model);
  });
});
