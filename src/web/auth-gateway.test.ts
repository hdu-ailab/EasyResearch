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

function fakeRuntime(
  providers: any[],
  loginImpl: any,
  opts: { refresh?: any; logout?: any; getAvailableSnapshot?: any; getError?: any } = {},
) {
  return {
    getProviders: () => providers,
    getProvider: (id: string) => providers.find((p) => p.id === id),
    getAvailableSnapshot: opts.getAvailableSnapshot ?? (() => []),
    getError: opts.getError ?? (() => undefined),
    getProviderAuthStatus: () => ({ configured: false }) as any,
    checkAuth: async () => undefined as any,
    login: loginImpl,
    logout: opts.logout ?? vi.fn(async () => {}),
    refresh: opts.refresh ?? vi.fn(async () => ({ aborted: false, errors: new Map() })),
  };
}

function credentialSynchronizationError(
  operation: "login" | "logout",
  credential: { type: "api_key"; key: string } | undefined,
): Error {
  return Object.assign(
    new Error(`Credential ${operation} committed for anthropic, but local synchronization failed`),
    {
      name: "CredentialSynchronizationError",
      providerId: "anthropic",
      operation,
      credential,
    },
  );
}

async function runPreflightedFlow(
  gateway: ReturnType<typeof createAuthGateway>,
  request: { flowId: string; providerId: string; type: "api_key" | "oauth" },
): Promise<void> {
  await gateway.preflight(request);
  return gateway.runFlow(request);
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

  it("refreshes providers locally and rereads models.json pinning on every list", async () => {
    const providers = [{ id: "old-provider", name: "Old", auth: {} }];
    let pendingProviders: any[] | undefined;
    let modelsJsonProviderIds = new Set(["old-provider"]);
    const readProviderIds = Object.assign(
      async () => modelsJsonProviderIds,
      { has: (id: string) => modelsJsonProviderIds.has(id) },
    );
    const refresh = vi.fn(async (options: { allowNetwork?: boolean }) => {
      if (options.allowNetwork === false && pendingProviders) {
        providers.splice(0, providers.length, ...pendingProviders);
        pendingProviders = undefined;
      }
      return { aborted: false, errors: new Map() };
    });
    const gw = createAuthGateway(
      fakeRuntime(providers, vi.fn(), { refresh }),
      createAuthFlowStore(),
      { timeoutMs: 600_000, modelsJsonProviderIds: readProviderIds as never },
    );

    expect(await gw.listProviders()).toMatchObject([
      { id: "old-provider", modelsJson: true },
    ]);
    modelsJsonProviderIds = new Set(["new-provider"]);
    pendingProviders = [{ id: "new-provider", name: "New", auth: {} }];

    expect(await gw.listProviders()).toMatchObject([
      { id: "new-provider", modelsJson: true },
    ]);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, { allowNetwork: false });
    expect(refresh).toHaveBeenNthCalledWith(2, { allowNetwork: false });
  });
});

describe("AuthGateway.listModels", () => {
  it("returns the snapshot published by a local refresh", async () => {
    let available = [{ provider: "old", id: "stale", reasoning: false }];
    const refresh = vi.fn(async (options: { allowNetwork?: boolean }) => {
      if (options.allowNetwork === false) {
        available = [{ provider: "anthropic", id: "claude", reasoning: true }];
      }
      return { aborted: false, errors: new Map() };
    });
    const gw = createAuthGateway(
      fakeRuntime([], vi.fn(), { refresh, getAvailableSnapshot: () => available }),
      createAuthFlowStore(),
      { timeoutMs: 600_000 },
    );

    expect(await gw.listModels()).toEqual([
      { provider: "anthropic", id: "claude", reasoning: true, thinkingLevelMap: undefined },
    ]);
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
  });

  it.each(["listModels", "listProviders"] as const)(
    "%s propagates a semantic local-refresh error instead of returning an empty catalog",
    async (operation) => {
      const semanticError = new Error("Invalid models.json provider configuration");
      const gw = createAuthGateway(
        fakeRuntime([], vi.fn(), {
          refresh: async () => ({
            aborted: false,
            errors: new Map([["custom", semanticError]]),
          }),
        }),
        createAuthFlowStore(),
        { timeoutMs: 600_000 },
      );

      await expect(gw[operation]()).rejects.toBe(semanticError);
    },
  );

  it("does not read provider pinning after Pi reports a semantic refresh failure", async () => {
    const readProviderIds = vi.fn(async () => {
      throw new Error("pinning reader should not run");
    });
    const gw = createAuthGateway(
      fakeRuntime([], vi.fn(), {
        getError: () => "Invalid models.json schema",
      }),
      createAuthFlowStore(),
      { timeoutMs: 600_000, modelsJsonProviderIds: readProviderIds },
    );

    await expect(gw.listModels()).rejects.toThrow("Model catalog refresh failed");
    expect(readProviderIds).not.toHaveBeenCalled();
  });

  it.each(["listModels", "listProviders"] as const)(
    "%s rejects Pi's post-refresh semantic error channel instead of returning fallback data",
    async (operation) => {
      const getAvailableSnapshot = vi.fn(() => [{ provider: "old", id: "stale", reasoning: false }]);
      const gw = createAuthGateway(
        fakeRuntime([anthropicProvider] as any, vi.fn(), {
          getAvailableSnapshot,
          getError: () => "Invalid models.json schema: providers.custom.models is invalid",
        }),
        createAuthFlowStore(),
        { timeoutMs: 600_000 },
      );

      await expect(gw[operation]()).rejects.toThrow("Model catalog refresh failed");
      expect(getAvailableSnapshot).not.toHaveBeenCalled();
    },
  );

  it("propagates a rejected local refresh without reading a stale snapshot", async () => {
    const refreshError = new Error("models.json could not be read");
    const getAvailableSnapshot = vi.fn(() => [{ provider: "old", id: "stale", reasoning: false }]);
    const gw = createAuthGateway(
      fakeRuntime([], vi.fn(), {
        refresh: async () => Promise.reject(refreshError),
        getAvailableSnapshot,
      }),
      createAuthFlowStore(),
      { timeoutMs: 600_000 },
    );

    await expect(gw.listModels()).rejects.toBe(refreshError);
    expect(getAvailableSnapshot).not.toHaveBeenCalled();
  });

  it("rejects an aborted local refresh", async () => {
    const gw = createAuthGateway(
      fakeRuntime([], vi.fn(), {
        refresh: async () => ({ aborted: true, errors: new Map() }),
      }),
      createAuthFlowStore(),
      { timeoutMs: 600_000 },
    );

    await expect(gw.refreshCatalog()).rejects.toThrow(/aborted/i);
  });

  it("recomputes models.json provider pinning at the shared local-refresh boundary", async () => {
    let pinningReads = 0;
    const gw = createAuthGateway(
      fakeRuntime([], vi.fn()),
      createAuthFlowStore(),
      {
        timeoutMs: 600_000,
        modelsJsonProviderIds: async () => {
          pinningReads++;
          return new Set(["custom"]);
        },
      },
    );

    await gw.refreshCatalog();
    expect(pinningReads).toBe(1);
  });

  it("coalesces concurrent catalog consumers onto one local refresh", async () => {
    let resolveRefresh!: (result: { aborted: boolean; errors: Map<string, Error> }) => void;
    const refresh = vi.fn(
      () => new Promise<{ aborted: boolean; errors: Map<string, Error> }>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, vi.fn(), {
        refresh,
        getAvailableSnapshot: () => [{ provider: "anthropic", id: "claude", reasoning: true }],
      }),
      createAuthFlowStore(),
      { timeoutMs: 600_000 },
    );

    const models = gw.listModels();
    const providers = gw.listProviders();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    resolveRefresh({ aborted: false, errors: new Map() });

    await expect(models).resolves.toMatchObject([{ provider: "anthropic", id: "claude" }]);
    await expect(providers).resolves.toMatchObject([{ id: "anthropic" }]);
  });
});

describe("AuthGateway.preflight", () => {
  it("throws 404 for an unknown provider", async () => {
    const gw = createAuthGateway(fakeRuntime([], vi.fn()), createAuthFlowStore(), { timeoutMs: 600_000 });
    await expect(Promise.resolve().then(() => gw.preflight({ flowId: "f1", providerId: "nope", type: "api_key" }))).rejects.toThrowError(AuthGatewayError);
    await expect(Promise.resolve().then(() => gw.preflight({ flowId: "f1", providerId: "nope", type: "api_key" }))).rejects.toThrow(/404|unknown/);
  });

  it("throws 400 when the provider has no auth method of that type", async () => {
    const gw = createAuthGateway(
      fakeRuntime([vertexProvider] as any, vi.fn()),
      createAuthFlowStore(),
      { timeoutMs: 600_000 },
    );
    await expect(Promise.resolve().then(() => gw.preflight({ flowId: "f1", providerId: "google-vertex", type: "oauth" }))).rejects.toThrow(/400|oauth/);
  });

  it("throws 409 when another flow is active", async () => {
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, vi.fn()), createAuthFlowStore(), {
      timeoutMs: 600_000,
    });
    const ctrl = new AbortController();
    gw.markExternalControl("f-active", ctrl);
    await expect(Promise.resolve().then(() => gw.preflight({ flowId: "f-next", providerId: "anthropic", type: "api_key" }))).rejects.toThrow(/409|active/);
  });

  it("passes for a connectable provider with the right method", async () => {
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, vi.fn()), createAuthFlowStore(), {
      timeoutMs: 600_000,
    });
    await expect(Promise.resolve().then(() => gw.preflight({ flowId: "f1", providerId: "anthropic", type: "api_key" }))).resolves.toBeUndefined();
  });

  it("accepts a provider added by the local refresh", async () => {
    const providers: any[] = [];
    const refresh = vi.fn(async () => {
      providers.push(anthropicProvider);
      return { aborted: false, errors: new Map() };
    });
    const gw = createAuthGateway(
      fakeRuntime(providers, vi.fn(), { refresh }),
      createAuthFlowStore(),
      { timeoutMs: 600_000 },
    );

    await expect(gw.preflight({ flowId: "f1", providerId: "anthropic", type: "api_key" })).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
  });
});

describe("AuthGateway.runFlow single-flight", () => {
  it("registers a preflighted flow before returning its run promise", async () => {
    const loginImpl = vi.fn(async (_id: string, _type: string, interaction: any) => {
      await interaction.prompt({ type: "secret", message: "API key" });
      return { type: "api_key", key: "sk" };
    });
    const store = createAuthFlowStore();
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, loginImpl as any), store, {
      timeoutMs: 600_000,
    });
    await gw.preflight({ flowId: "f1", providerId: "anthropic", type: "api_key" });

    const flow = gw.runFlow({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    expect(store.get("f1")).toBeDefined();
    await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
    store.cancel("f1");
    await flow;
  });

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
    const flow = runPreflightedFlow(gw, { flowId: "f1", providerId: "anthropic", type: "api_key" });
    await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
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

  it("forces a model notification after a successful credential commit", async () => {
    const onModelsChanged = vi.fn(async () => {});
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, vi.fn(async () => ({ type: "api_key", key: "sk" }))),
      createAuthFlowStore(),
      { timeoutMs: 600_000, onModelsChanged },
    );

    await runPreflightedFlow(gw, { flowId: "f1", providerId: "anthropic", type: "api_key" });

    expect(onModelsChanged).toHaveBeenCalledTimes(1);
  });

  it("does not notify models after rejected or cancelled authentication", async () => {
    const rejectedNotification = vi.fn(async () => {});
    const rejected = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, vi.fn(async () => {
        throw new Error("rejected");
      })),
      createAuthFlowStore(),
      { timeoutMs: 600_000, onModelsChanged: rejectedNotification },
    );
    await runPreflightedFlow(rejected, { flowId: "rejected", providerId: "anthropic", type: "api_key" });
    expect(rejectedNotification).not.toHaveBeenCalled();

    const cancelledNotification = vi.fn(async () => {});
    const store = createAuthFlowStore();
    const cancelled = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, vi.fn(async (_id: string, _type: string, interaction: any) => {
        await interaction.prompt({ type: "secret", message: "API key" });
        return { type: "api_key", key: "sk" };
      })),
      store,
      { timeoutMs: 600_000, onModelsChanged: cancelledNotification },
    );
    const flow = runPreflightedFlow(cancelled, {
      flowId: "cancelled",
      providerId: "anthropic",
      type: "api_key",
    });
    await vi.waitFor(() => expect(store.pendingKind("cancelled")).toBe("secret"));
    store.cancel("cancelled");
    await flow;
    expect(cancelledNotification).not.toHaveBeenCalled();
  });

  it("emits done with warning when refresh fails", async () => {
    const loginImpl = vi.fn(async () => ({ type: "api_key", key: "sk" }));
    const refresh = vi.fn(async (options: { allowNetwork?: boolean }) =>
      options.allowNetwork === false
        ? { aborted: false, errors: new Map() }
        : { aborted: false, errors: new Map([["anthropic", new Error("boom")]]) },
    );
    const store = createAuthFlowStore();
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, loginImpl as any, { refresh } as any),
      store,
      { timeoutMs: 600_000 },
    );
    const flow = runPreflightedFlow(gw, { flowId: "f1", providerId: "anthropic", type: "api_key" });
    await flow;
    const done = store.get("f1")?.terminalEvent as any;
    expect(done).toBeTruthy();
    expect(done.warning).toBeTruthy();
  });

  it("emits done with warning when refresh is aborted", async () => {
    const loginImpl = vi.fn(async () => ({ type: "api_key", key: "sk" }));
    const refresh = vi.fn(async (options: { allowNetwork?: boolean }) =>
      options.allowNetwork === false
        ? { aborted: false, errors: new Map() }
        : { aborted: true, errors: new Map() },
    );
    const store = createAuthFlowStore();
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, loginImpl as any, { refresh } as any),
      store,
      { timeoutMs: 600_000 },
    );
    const flow = runPreflightedFlow(gw, { flowId: "f1", providerId: "anthropic", type: "api_key" });
    await flow;
    const done = store.get("f1")?.terminalEvent as any;
    expect(done.warning).toMatch(/timeout|restart/);
  });

  it("emits error with reason reject when login throws", async () => {
    const loginImpl = vi.fn(async () => {
      throw new Error("provider rejected");
    });
    const store = createAuthFlowStore();
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, loginImpl as any), store, {
      timeoutMs: 600_000,
    });
    const flow = runPreflightedFlow(gw, { flowId: "f1", providerId: "anthropic", type: "api_key" });
    await flow;
    const err = store.get("f1")?.terminalEvent as any;
    expect(err).toBeTruthy();
    expect(err.reason).toBe("reject");
    expect(err.message).toContain("provider rejected");
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
    const flow = runPreflightedFlow(gw, { flowId: "f1", providerId: "anthropic", type: "api_key" });
    await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
    const unsub = store.subscribe("f1", (e) => seen.push(e));
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
    const onModelsChanged = vi.fn(async () => {});
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, vi.fn(), { logout } as any), createAuthFlowStore(), {
      timeoutMs: 600_000,
      onModelsChanged,
    });
    await gw.logout("anthropic");
    expect(logout).toHaveBeenCalledWith("anthropic");
    expect(onModelsChanged).toHaveBeenCalledTimes(1);
  });

  it("does not notify when logout fails", async () => {
    const onModelsChanged = vi.fn(async () => {});
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, vi.fn(), {
        logout: vi.fn(async () => {
          throw new Error("logout failed");
        }),
      }),
      createAuthFlowStore(),
      { timeoutMs: 600_000, onModelsChanged },
    );

    await expect(gw.logout("anthropic")).rejects.toThrow("logout failed");
    expect(onModelsChanged).not.toHaveBeenCalled();
  });

  it("forces a model notification when logout committed before Pi synchronization failed", async () => {
    const order: string[] = [];
    const onModelsChanged = vi.fn(async () => {
      order.push("models-changed");
    });
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, vi.fn(), {
        logout: vi.fn(async () => {
          order.push("logout-committed");
          throw credentialSynchronizationError("logout", undefined);
        }),
      }),
      createAuthFlowStore(),
      { timeoutMs: 600_000, onModelsChanged },
    );

    await expect(gw.logout("anthropic")).rejects.toMatchObject({
      status: 500,
      message: "Credential removal was saved, but local model state could not be synchronized.",
    });
    expect(order).toEqual(["logout-committed", "models-changed"]);
  });

  it("does not notify when logout is cancelled before credential removal commits", async () => {
    const onModelsChanged = vi.fn(async () => {});
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, vi.fn(), {
        logout: vi.fn(async () => {
          throw new DOMException("cancelled", "AbortError");
        }),
      }),
      createAuthFlowStore(),
      { timeoutMs: 600_000, onModelsChanged },
    );

    await expect(gw.logout("anthropic")).rejects.toMatchObject({ name: "AbortError" });
    expect(onModelsChanged).not.toHaveBeenCalled();
  });

  it("logs out a provider added by the local refresh", async () => {
    const providers: any[] = [];
    let loggedOut: string | undefined;
    const refresh = vi.fn(async () => {
      providers.push(anthropicProvider);
      return { aborted: false, errors: new Map() };
    });
    const gw = createAuthGateway(
      fakeRuntime(providers, vi.fn(), {
        refresh,
        logout: async (providerId: string) => {
          loggedOut = providerId;
        },
      }),
      createAuthFlowStore(),
      { timeoutMs: 600_000 },
    );

    await gw.logout("anthropic");
    expect(loggedOut).toBe("anthropic");
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
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
    const flow = runPreflightedFlow(gw, { flowId: "f1", providerId: "anthropic", type: "api_key" });
    await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
    gw.shutdown();
    await expect(flow).resolves.toBeUndefined();
    expect(gw.activeFlow()).toBeNull();
  });

  it("waits for every aborted auth flow to settle before releasing runtime ownership", async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const store = createAuthFlowStore();
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, vi.fn(async (_id: string, _type: string, interaction: any) => {
        try {
          await interaction.prompt({ type: "secret", message: "API key" });
        } catch (error) {
          await cleanup;
          throw error;
        }
        return { type: "api_key", key: "sk" };
      })),
      store,
      { timeoutMs: 600_000 },
    );
    const flow = runPreflightedFlow(gw, {
      flowId: "f1",
      providerId: "anthropic",
      type: "api_key",
    });
    await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
    let shutdownSettled = false;

    const shutdown = Promise.resolve(gw.shutdown()).finally(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    releaseCleanup();
    await shutdown;
    await flow;
    expect(gw.activeFlow()).toBeNull();
  });

  it("waits for active catalog work and prevents a preflight reservation after shutdown starts", async () => {
    let releaseSynchronization!: () => void;
    const synchronization = new Promise<void>((resolve) => {
      releaseSynchronization = resolve;
    });
    const synchronizeCatalog = vi.fn(() => synchronization);
    const gw = createAuthGateway(
      fakeRuntime([anthropicProvider] as any, vi.fn()),
      createAuthFlowStore(),
      { timeoutMs: 600_000, synchronizeCatalog },
    );
    const preflight = gw.preflight({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    await vi.waitFor(() => expect(synchronizeCatalog).toHaveBeenCalledTimes(1));
    let shutdownSettled = false;
    const shutdown = gw.shutdown().finally(() => {
      shutdownSettled = true;
    });

    await Promise.resolve();
    const settledBeforeSynchronization = shutdownSettled;
    releaseSynchronization();

    await expect(preflight).rejects.toMatchObject({ status: 503 });
    await shutdown;
    expect(settledBeforeSynchronization).toBe(false);
    expect(gw.activeFlow()).toBeNull();
    await expect(gw.listModels()).rejects.toMatchObject({ status: 503 });
  });
});

describe("dual-method providers", () => {
  it("preflight passes for both api_key and oauth", async () => {
    for (const type of ["api_key", "oauth"] as const) {
      const gw = createAuthGateway(fakeRuntime([xaiProvider] as any, vi.fn()), createAuthFlowStore(), {
        timeoutMs: 600_000,
      });
      await expect(Promise.resolve().then(() => gw.preflight({ flowId: `f-${type}`, providerId: "xai", type }))).resolves.toBeUndefined();
    }
  });
});

describe("AuthGateway timeout", () => {
  it("fires error reason:timeout when the flow exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const loginImpl = vi.fn(async (_id: string, _type: string, interaction: any) => {
        await interaction.prompt({ type: "secret", message: "API key" });
        return { type: "api_key", key: "sk" };
      });
      const store = createAuthFlowStore();
      const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, loginImpl as any), store, {
        timeoutMs: 10_000,
      });
      const seen: AuthFlowEventDto[] = [];
      const flow = runPreflightedFlow(gw, { flowId: "f1", providerId: "anthropic", type: "api_key" });
      await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
      const unsub = store.subscribe("f1", (e) => seen.push(e));
      await vi.advanceTimersByTimeAsync(10_000);
      await flow;
      const err = seen.find((e: any) => e.type === "error") as any;
      expect(err).toBeTruthy();
      expect(err.reason).toBe("timeout");
      expect(gw.activeFlow()).toBeNull();
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a flow when timeoutMs is 0", async () => {
    vi.useFakeTimers();
    try {
      const loginImpl = vi.fn(async (_id: string, _type: string, interaction: any) => {
        await interaction.prompt({ type: "secret", message: "API key" });
        return { type: "api_key", key: "sk" };
      });
      const store = createAuthFlowStore();
      const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, loginImpl as any), store, {
        timeoutMs: 0,
      });
      const flow = runPreflightedFlow(gw, { flowId: "f1", providerId: "anthropic", type: "api_key" });
      await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.get("f1")?.terminated).toBe(false);
      store.cancel("f1");
      await flow;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AuthGateway CredentialSynchronizationError", () => {
  it("emits done with a warning instead of error", async () => {
    const loginImpl = vi.fn(async () => {
      throw credentialSynchronizationError("login", { type: "api_key", key: "sk" });
    });
    const store = createAuthFlowStore();
    const onModelsChanged = vi.fn(async () => {});
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, loginImpl as any), store, {
      timeoutMs: 600_000,
      onModelsChanged,
    });
    const flow = runPreflightedFlow(gw, { flowId: "f1", providerId: "anthropic", type: "api_key" });
    await flow;
    const done = store.get("f1")?.terminalEvent as any;
    expect(done).toBeTruthy();
    expect(done.warning).toBeTruthy();
    expect(done.type).toBe("done");
    expect(onModelsChanged).toHaveBeenCalledTimes(1);
  });
});

describe("AuthGateway logging", () => {
  it("logs start, done, and logout without any secret payloads", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const loginImpl = vi.fn(async () => ({ type: "api_key", key: "sk" }));
    const store = createAuthFlowStore();
    const gw = createAuthGateway(fakeRuntime([anthropicProvider] as any, loginImpl as any), store, {
      timeoutMs: 600_000,
      logger: logger as any,
    });
    await runPreflightedFlow(gw, { flowId: "f1", providerId: "anthropic", type: "api_key" });
    await gw.logout("anthropic");
    expect(logger.info).toHaveBeenCalledWith("auth login start", expect.objectContaining({ provider: "anthropic" }));
    expect(logger.info).toHaveBeenCalledWith("auth login done", expect.objectContaining({ outcome: "ok" }));
    expect(logger.info).toHaveBeenCalledWith("auth logout", expect.objectContaining({ provider: "anthropic" }));
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).not.toContain("sk");
  });
});
