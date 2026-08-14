import { describe, it, expect, vi } from "vitest";
import { createAuthGateway } from "./auth-gateway";
import { createAuthFlowStore } from "./auth-flow-store";
import { resolveAuthFlowTimeout } from "./auth-runtime";

const anthropicProvider = {
  id: "anthropic",
  name: "Anthropic",
  auth: { apiKey: { name: "Anthropic API key", login: vi.fn() } },
};

describe("resolveAuthFlowTimeout", () => {
  it("defaults to 10 minutes", () => {
    expect(resolveAuthFlowTimeout(undefined)).toBe(600_000);
    expect(resolveAuthFlowTimeout({})).toBe(600_000);
    expect(resolveAuthFlowTimeout({ easyresearch: {} })).toBe(600_000);
  });

  it("respects positive, 0, and -1 values", () => {
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: 30_000 } } })).toBe(30_000);
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: 0 } } })).toBe(0);
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: -1 } } })).toBe(-1);
  });

  it("falls back for non-integer or non-positive values", () => {
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: -5 } } })).toBe(600_000);
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: "1000" } } })).toBe(600_000);
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: 1.5 } } })).toBe(600_000);
  });
});

describe("auth gateway shutdown aborts active flows", () => {
  it("aborts pending prompt after shutdown() so the flow terminates", async () => {
    const loginImpl = vi.fn(async (_id: string, _type: string, interaction: any) => {
      try {
        await interaction.prompt({ type: "secret", message: "API key" });
      } catch (e) {
        throw e;
      }
      return { type: "api_key", key: "sk" };
    });
    const store = createAuthFlowStore();
    const gw = createAuthGateway(
      {
        getProviders: () => [anthropicProvider],
        getProvider: (id: string) => (id === "anthropic" ? anthropicProvider : undefined),
        getProviderAuthStatus: () => ({ configured: false } as any),
        checkAuth: async () => undefined,
        login: loginImpl as any,
        logout: async () => {},
        refresh: async () => ({ aborted: false, errors: new Map() }),
      } as any,
      store,
      { timeoutMs: 600_000 },
    );
    const flow = gw.runFlow({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
    gw.shutdown();
    await expect(flow).resolves.toBeUndefined();
    expect(store.get("f1")?.terminated).toBe(true);
  });
});