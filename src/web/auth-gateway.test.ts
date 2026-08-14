import { describe, it, expect, vi } from "vitest";
import { createAuthGateway, AuthGatewayError } from "./auth-gateway";
import { createAuthFlowStore } from "./auth-flow-store";
import type { AuthFlowEventDto } from "./contracts";

const anthropicProvider = {
  id: "anthropic",
  name: "Anthropic",
  auth: { apiKey: { name: "Anthropic API key", login: vi.fn() } },
};
const vertexProvider = {
  id: "google-vertex",
  name: "Vertex",
  auth: { apiKey: { name: "ADC", resolve: vi.fn() } },
};
const xaiProvider = {
  id: "xai",
  name: "xAI",
  auth: { apiKey: { name: "xAI API key", login: vi.fn() }, oauth: { name: "xAI subscription", login: vi.fn() } },
};

function fakeRuntime(providers: any[], loginImpl: any, opts: { refresh?: any; logout?: any } = {}) {
  return {
    getProviders: () => providers,
    getProvider: (id: string) => providers.find((p) => p.id === id),
    getProviderAuthStatus: () => ({ configured: false }) as any,
    checkAuth: async () => undefined as any,
    login: loginImpl,
    logout: opts.logout ?? vi.fn(async () => {}),
    refresh: opts.refresh,
  };
}

describe("AuthGateway.listProviders", () => {
  it("assembles provider infos with connectable mapping", async () => {
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider, vertexProvider] as any, vi.fn()),
      createAuthFlowStore(),
      { timeoutMs: 600_000 },
    );
    const list = await gw.listProviders();
    expect(list.find((p) => p.id === "anthropic")?.connectable).toBe(true);
    expect(list.find((p) => p.id === "google-vertex")?.connectable).toBe(false);
  });
});

describe("AuthGateway.preflight", () => {
  it("throws 404 for an unknown provider", () => {
    const gw = createAuthGateway(fakeRuntime([], vi.fn()), createAuthFlowStore(), { timeoutMs: 600_000 });
    expect(() => gw.preflight({ providerId: "nope", type: "api_key" })).toThrowError(AuthGatewayError);
    expect(() => gw.preflight({ providerId: "nope", type: "api_key" })).toThrow(/404|unknown/);
  });

  it("throws 400 when the provider has no auth method of that type", () => {
    const gw = createAuthGateway(
      fakeRuntime([vertexProvider] as any, vi.fn()),
      createAuthFlowStore(),
      { timeoutMs: 600_000 },
    );
    expect(() => gw.preflight({ providerId: "google-vertex", type: "oauth" })).toThrow(/400|oauth/);
  });

  it("throws 409 when another flow is active", () => {
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, vi.fn()), createAuthFlowStore(), {
      timeoutMs: 600_000,
    });
    const ctrl = new AbortController();
    gw.markExternalControl("f-active", ctrl);
    expect(() => gw.preflight({ providerId: "anthropic", type: "api_key" })).toThrow(/409|active/);
  });

  it("passes for a connectable provider with the right method", () => {
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, vi.fn()), createAuthFlowStore(), {
      timeoutMs: 600_000,
    });
    expect(() => gw.preflight({ providerId: "anthropic", type: "api_key" })).not.toThrow();
  });
});

describe("AuthGateway.runFlow single-flight", () => {
  it("drives notify events, prompt, respond, done", async () => {
    const loginImpl = vi.fn(async (_id: string, _type: string, interaction: any) => {
      interaction.notify({ type: "info", message: "hello", links: [] });
      interaction.notify({ type: "progress", message: "halfway" });
      interaction.notify({
        type: "device_code",
        userCode: "ABCD",
        verificationUri: "https://x",
        expiresInSeconds: 60,
      });
      await interaction.prompt({ type: "secret", message: "API key" });
      return { type: "api_key", key: "sk-abc" };
    });
    const store = createAuthFlowStore();
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, loginImpl as any), store, {
      timeoutMs: 600_000,
    });
    const seen: AuthFlowEventDto[] = [];
    // runFlow's synchronous body fires the 3 notifies + emits the prompt before its first await.
    const flow = gw.runFlow({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    const unsub = store.subscribe("f1", (e) => seen.push(e));
    expect(store.pendingKind("f1")).toBe("secret");
    expect(seen.filter((e) => e.type === "notify")).toHaveLength(3);
    expect(store.resolveRespond("f1", "sk-abc")).toBe(true);
    await expect(flow).resolves.toBeUndefined();
    const done = seen.find((e: any) => e.type === "done") as any;
    expect(done).toBeTruthy();
    expect(done.credential.type).toBe("api_key");
    unsub();
  });

  it("emits done with warning when refresh fails", async () => {
    const loginImpl = vi.fn(async () => ({ type: "api_key", key: "sk" }));
    const refresh = vi.fn(async () => ({
      aborted: false,
      errors: new Map([["anthropic", new Error("boom")]]),
    }));
    const store = createAuthFlowStore();
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, loginImpl as any, { refresh } as any),
      store,
      { timeoutMs: 600_000 },
    );
    const seen: AuthFlowEventDto[] = [];
    const flow = gw.runFlow({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    const unsub = store.subscribe("f1", (e) => seen.push(e));
    await flow;
    const done = seen.find((e: any) => e.type === "done") as any;
    expect(done).toBeTruthy();
    expect(done.warning).toBeTruthy();
    unsub();
  });

  it("emits done with warning when refresh is aborted", async () => {
    const loginImpl = vi.fn(async () => ({ type: "api_key", key: "sk" }));
    const refresh = vi.fn(async () => ({ aborted: true, errors: new Map() }));
    const store = createAuthFlowStore();
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, loginImpl as any, { refresh } as any),
      store,
      { timeoutMs: 600_000 },
    );
    const seen: AuthFlowEventDto[] = [];
    const flow = gw.runFlow({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    const unsub = store.subscribe("f1", (e) => seen.push(e));
    await flow;
    const done = seen.find((e: any) => e.type === "done") as any;
    expect(done.warning).toMatch(/timeout|restart/);
    unsub();
  });

  it("emits error with reason reject when login throws", async () => {
    const loginImpl = vi.fn(async () => {
      throw new Error("provider rejected");
    });
    const store = createAuthFlowStore();
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, loginImpl as any), store, {
      timeoutMs: 600_000,
    });
    const seen: AuthFlowEventDto[] = [];
    const flow = gw.runFlow({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    const unsub = store.subscribe("f1", (e) => seen.push(e));
    await flow;
    const err = seen.find((e: any) => e.type === "error") as any;
    expect(err).toBeTruthy();
    expect(err.reason).toBe("reject");
    expect(err.message).toContain("provider rejected");
    unsub();
  });

  it("emits error with reason aborted when prompt rejects via abort", async () => {
    const loginImpl = vi.fn(async (_id: string, _type: string, interaction: any) => {
      await interaction.prompt({ type: "secret", message: "API key" });
      return { type: "api_key", key: "sk" };
    });
    const store = createAuthFlowStore();
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, loginImpl as any), store, {
      timeoutMs: 600_000,
    });
    const seen: AuthFlowEventDto[] = [];
    const flow = gw.runFlow({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    const unsub = store.subscribe("f1", (e) => seen.push(e));
    await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
    store.cancel("f1");
    await flow;
    const err = seen.find((e: any) => e.type === "error") as any;
    expect(err).toBeTruthy();
    expect(err.reason).toBe("aborted");
    unsub();
  });
});

describe("AuthGateway.logout", () => {
  it("calls runtime logout for known provider", async () => {
    const logout = vi.fn(async () => {});
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, vi.fn(), { logout } as any), createAuthFlowStore(), {
      timeoutMs: 600_000,
    });
    await gw.logout("anthropic");
    expect(logout).toHaveBeenCalledWith("anthropic");
  });

  it("throws 404 for unknown provider", async () => {
    const gw = createAuthGateway(fakeRuntime([], vi.fn()), createAuthFlowStore(), { timeoutMs: 600_000 });
    await expect(gw.logout("nope")).rejects.toThrowError(AuthGatewayError);
  });
});

describe("AuthGateway.shutdown", () => {
  it("aborts active flows so runFlow resolves", async () => {
    const loginImpl = vi.fn(async (_id: string, _type: string, interaction: any) => {
      try {
        await interaction.prompt({ type: "secret", message: "API key" });
      } catch (e) {
        throw e;
      }
      return { type: "api_key", key: "sk" };
    });
    const store = createAuthFlowStore();
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, loginImpl as any), store, {
      timeoutMs: 600_000,
    });
    const flow = gw.runFlow({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
    gw.shutdown();
    await expect(flow).resolves.toBeUndefined();
    expect(gw.activeFlow()).toBeNull();
  });
});

describe("dual-method providers", () => {
  it("preflight passes for both api_key and oauth", () => {
    const gw = createAuthGateway(fakeRuntime([xaiProvider] as any, vi.fn()), createAuthFlowStore(), {
      timeoutMs: 600_000,
    });
    expect(() => gw.preflight({ providerId: "xai", type: "api_key" })).not.toThrow();
    expect(() => gw.preflight({ providerId: "xai", type: "oauth" })).not.toThrow();
  });
});