import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createAuthGateway } from "./auth-gateway";
import { createAuthFlowStore } from "./auth-flow-store";
import {
  createAcceptedModelRuntime,
  createConfiguredModelRuntime,
  createDaemonAuthRuntime,
  configureNoAuthModelRuntime,
  readModelsJsonProviderIds,
  resolveAuthFlowTimeout,
} from "./auth-runtime";
import { ConfigFileService } from "./config-files";

const anthropicProvider = {
  id: "anthropic",
  name: "Anthropic",
  auth: { apiKey: { name: "Anthropic API key", login: vi.fn() } },
};

function transactionRuntime(
  name: string,
  options: {
    models?: Array<{ provider: string; id: string; reasoning: boolean }>;
    registeredModels?: Array<{ provider: string; id: string; reasoning: boolean }>;
    providers?: Array<{ id: string; name: string; auth?: Record<string, unknown> }>;
    refresh?: { aborted: boolean; errors: ReadonlyMap<string, Error> };
    semanticError?: string;
  } = {},
) {
  const models = options.models ?? [{ provider: "provider", id: name, reasoning: false }];
  const providers = options.providers ?? [];
  return {
    name,
    dispose: vi.fn(),
    refresh: vi.fn(async () => options.refresh ?? { aborted: false, errors: new Map() }),
    getError: vi.fn(() => options.semanticError),
    getModels: vi.fn(() => options.registeredModels ?? models),
    getAvailableSnapshot: vi.fn(() => models),
    getProviders: vi.fn(() => providers),
    getProvider: vi.fn((providerId: string) => providers.find((provider) => provider.id === providerId)),
    getProviderAuthStatus: vi.fn(() => ({ configured: false })),
    setRuntimeApiKey: vi.fn(async () => {}),
    checkAuth: vi.fn(async () => undefined),
    login: vi.fn(async () => ({ type: "api_key" as const, key: "secret" })),
    logout: vi.fn(async () => {}),
  };
}

describe("createAcceptedModelRuntime", () => {
  it("publishes a degraded first catalog when no last-good runtime exists", async () => {
    const runtime = transactionRuntime("builtin-fallback", {
      semanticError: "private malformed models.json detail",
    });
    const accepted = createAcceptedModelRuntime(async () => runtime);

    const prepared = await accepted.prepareModelCatalog();

    expect(prepared.diagnostic).toContain("models.json");
    expect(prepared.registeredModels).toEqual([{ provider: "provider", id: "builtin-fallback" }]);
    prepared.commit();
    expect(accepted.runtime.getModels()).toHaveLength(1);
    await accepted.dispose();
  });

  it("publishes fresh locally refreshed candidates only at synchronous commit", async () => {
    const first = transactionRuntime("v1");
    const discarded = transactionRuntime("discarded");
    const second = transactionRuntime("v2");
    const runtimes = [first, discarded, second];
    const accepted = createAcceptedModelRuntime(async () => runtimes.shift()!);

    const preparedFirst = await accepted.prepareModelCatalog();
    expect(first.refresh).toHaveBeenCalledWith({ allowNetwork: false });
    expect(preparedFirst.registeredModels).toEqual([{ provider: "provider", id: "v1" }]);
    expect(preparedFirst.availableModels).toEqual([{ provider: "provider", id: "v1" }]);
    expect(Object.isFrozen(preparedFirst.registeredModels)).toBe(true);
    expect(Object.isFrozen(preparedFirst.registeredModels[0])).toBe(true);
    expect(() => accepted.runtime.getAvailableSnapshot()).toThrow(/active/i);

    expect(preparedFirst.commit()).toBeUndefined();
    expect(accepted.runtime.getAvailableSnapshot()).toEqual([
      { provider: "provider", id: "v1", reasoning: false },
    ]);

    const rejected = await accepted.prepareModelCatalog();
    expect(accepted.runtime.getAvailableSnapshot()[0]?.id).toBe("v1");
    await rejected.rollback();
    expect(discarded.dispose).toHaveBeenCalledTimes(1);
    expect(accepted.runtime.getAvailableSnapshot()[0]?.id).toBe("v1");

    const preparedSecond = await accepted.prepareModelCatalog();
    expect(accepted.runtime.getAvailableSnapshot()[0]?.id).toBe("v1");
    preparedSecond.commit();
    expect(accepted.runtime.getAvailableSnapshot()[0]?.id).toBe("v2");

    await accepted.dispose();
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });

  it("validates configured references against registered models without exposing unauthenticated choices", async () => {
    const unauthenticated = { provider: "deepseek", id: "deepseek-v4-flash", reasoning: true };
    const runtime = transactionRuntime("ready", {
      models: [],
      registeredModels: [unauthenticated],
    });
    const accepted = createAcceptedModelRuntime(async () => runtime);

    const prepared = await accepted.prepareModelCatalog();

    expect(prepared.registeredModels).toEqual([
      { provider: "deepseek", id: "deepseek-v4-flash" },
    ]);
    expect(prepared.availableModels).toEqual([]);
    prepared.commit();
    const gateway = createAuthGateway(accepted.runtime, createAuthFlowStore(), {
      timeoutMs: 600_000,
      synchronizeCatalog: async () => {},
    });
    await expect(gateway.listModels()).resolves.toEqual([
      expect.objectContaining({
        provider: "deepseek",
        id: "deepseek-v4-flash",
        reasoning: true,
        available: false,
        authRequired: true,
      }),
    ]);

    await accepted.dispose();
  });

  it.each([
    {
      name: "provider refresh errors",
      runtime: () => transactionRuntime("bad-errors", {
        refresh: { aborted: false, errors: new Map([["provider", new Error("private path")]]) },
      }),
    },
    {
      name: "an aborted refresh",
      runtime: () => transactionRuntime("bad-abort", {
        refresh: { aborted: true, errors: new Map() },
      }),
    },
    {
      name: "Pi's semantic error channel",
      runtime: () => transactionRuntime("bad-semantic", { semanticError: "private models.json detail" }),
    },
  ])("publishes registered catalog state despite $name", async ({ runtime }) => {
    const first = transactionRuntime("accepted");
    const rejected = runtime();
    const runtimes = [first, rejected];
    const accepted = createAcceptedModelRuntime(async () => runtimes.shift()!);
    (await accepted.prepareModelCatalog()).commit();

    const degraded = await accepted.prepareModelCatalog();
    expect(degraded.diagnostic).toContain("models.json");
    expect(degraded.registeredModels).toEqual([{ provider: "provider", id: expect.stringMatching(/^bad-/) }]);
    degraded.commit();
    expect(accepted.runtime.getModels()[0]?.id).toMatch(/^bad-/);
    await accepted.dispose();
  });

  it("lets AuthGateway consume the stable accepted proxy without refreshing uncommitted state", async () => {
    const first = transactionRuntime("v1");
    const second = transactionRuntime("v2");
    const runtimes = [first, second];
    const accepted = createAcceptedModelRuntime(async () => runtimes.shift()!);
    (await accepted.prepareModelCatalog()).commit();
    const synchronizeCatalog = vi.fn(async () => {});
    const gateway = createAuthGateway(accepted.runtime, createAuthFlowStore(), {
      timeoutMs: 600_000,
      synchronizeCatalog,
    });

    expect(await gateway.listModels()).toMatchObject([{ provider: "provider", id: "v1" }]);
    const pending = await accepted.prepareModelCatalog();
    expect(await gateway.listModels()).toMatchObject([{ provider: "provider", id: "v1" }]);
    pending.commit();
    expect(await gateway.listModels()).toMatchObject([{ provider: "provider", id: "v2" }]);

    expect(synchronizeCatalog).toHaveBeenCalledTimes(3);
    expect(first.refresh).toHaveBeenCalledTimes(1);
    expect(second.refresh).toHaveBeenCalledTimes(1);
    await accepted.dispose();
  });

  it("commits models.json provider pinning atomically with the matching runtime candidate", async () => {
    const first = transactionRuntime("v1");
    const discarded = transactionRuntime("discarded");
    const second = transactionRuntime("v2");
    const runtimes = [first, discarded, second];
    let providerIds: ReadonlySet<string> = new Set(["provider-v1"]);
    const accepted = createAcceptedModelRuntime(
      async () => runtimes.shift()!,
      async () => providerIds,
    );

    (await accepted.prepareModelCatalog()).commit();
    expect([...accepted.getModelsJsonProviderIds()]).toEqual(["provider-v1"]);

    providerIds = new Set(["discarded-provider"]);
    const rejected = await accepted.prepareModelCatalog();
    expect([...accepted.getModelsJsonProviderIds()]).toEqual(["provider-v1"]);
    await rejected.rollback();
    expect([...accepted.getModelsJsonProviderIds()]).toEqual(["provider-v1"]);

    providerIds = new Set(["provider-v2"]);
    const prepared = await accepted.prepareModelCatalog();
    expect([...accepted.getModelsJsonProviderIds()]).toEqual(["provider-v1"]);
    prepared.commit();
    expect(accepted.runtime.getAvailableSnapshot()[0]?.id).toBe("v2");
    expect([...accepted.getModelsJsonProviderIds()]).toEqual(["provider-v2"]);

    await accepted.dispose();
  });

  it("captures the native no-history fallback from the same prepared runtime", async () => {
    const fallback = { provider: "openai", id: "fallback", reasoning: false };
    const runtime = transactionRuntime("fallback", { models: [fallback] });
    const resolveFallbackModel = vi.fn(async (candidate: typeof runtime) => candidate.getModels()[0]);
    const accepted = createAcceptedModelRuntime(
      async () => runtime,
      async () => new Set(),
      resolveFallbackModel,
    );

    const prepared = await accepted.prepareModelCatalog();

    expect(resolveFallbackModel).toHaveBeenCalledWith(runtime);
    expect(prepared.fallbackModel).toEqual({ provider: "openai", id: "fallback" });
    await prepared.rollback();
    await accepted.dispose();
  });
});

describe("createDaemonAuthRuntime", () => {
  it("boots a recovery model authority before LiveConfiguration accepts an Agent snapshot", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "easyresearch-daemon-recovery-auth-"));
    const candidate = transactionRuntime("recovery-model");
    const daemon = await createDaemonAuthRuntime({
      config: new ConfigFileService(agentDir),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      createModelRuntime: async () => candidate,
      synchronizeCatalog: async () => {},
      onModelsChanged: async () => {},
    });

    try {
      await expect(daemon.auth.listModels()).resolves.toEqual([
        expect.objectContaining({ provider: "provider", id: "recovery-model" }),
      ]);
    } finally {
      await daemon.dispose();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("shares one accepted transaction between LiveConfiguration validation and AuthGateway", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "easyresearch-daemon-auth-"));
    const bootCandidate = transactionRuntime("accepted");
    const liveCandidate = transactionRuntime("accepted");
    const candidates = [bootCandidate, liveCandidate];
    const createModelRuntime = vi.fn(async () => candidates.shift()!);
    const synchronizeCatalog = vi.fn(async () => {});
    const onModelsChanged = vi.fn(async () => {});
    const daemon = await createDaemonAuthRuntime({
      config: new ConfigFileService(agentDir),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      createModelRuntime,
      synchronizeCatalog,
      onModelsChanged,
    });

    const prepared = await daemon.modelValidator.prepareModelCatalog();
    expect(createModelRuntime).toHaveBeenCalledTimes(2);
    prepared.commit();
    await expect(daemon.auth.listModels()).resolves.toMatchObject([
      { provider: "provider", id: "accepted" },
    ]);
    expect(synchronizeCatalog).toHaveBeenCalledTimes(1);

    await daemon.dispose();
    expect(bootCandidate.dispose).toHaveBeenCalledTimes(1);
    expect(liveCandidate.dispose).toHaveBeenCalledTimes(1);
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("applies an auth-flow timeout from BOM-prefixed settings accepted by Pi", async () => {
    vi.useFakeTimers();
    const agentDir = mkdtempSync(join(tmpdir(), "easyresearch-daemon-auth-timeout-"));
    writeFileSync(
      join(agentDir, "settings.json"),
      `\uFEFF${JSON.stringify({ easyresearch: { web: { authFlowTimeoutMs: 25 } } })}`,
      "utf8",
    );
    const candidate = {
      ...transactionRuntime("timeout", { providers: [anthropicProvider] }),
      login: vi.fn(async (
        _providerId: string,
        _type: "api_key" | "oauth",
        interaction: { signal?: AbortSignal },
      ) => {
        const signal = interaction.signal;
        if (!signal) throw new Error("auth interaction signal is required");
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      }),
    };
    const daemon = await createDaemonAuthRuntime({
      config: new ConfigFileService(agentDir),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      createModelRuntime: async () => candidate,
      synchronizeCatalog: async () => {},
      onModelsChanged: async () => {},
    });
    const request = { flowId: "bom-timeout", providerId: "anthropic", type: "api_key" as const };
    let running: Promise<void> | undefined;

    try {
      await daemon.auth.preflight(request);
      running = daemon.auth.runFlow(request);
      await vi.advanceTimersByTimeAsync(25);

      expect(daemon.auth.store().get(request.flowId)?.terminalEvent).toMatchObject({
        type: "error",
        reason: "timeout",
      });
      await expect(running).resolves.toBeUndefined();
    } finally {
      await daemon.auth.shutdown();
      await running;
      await daemon.dispose();
      rmSync(agentDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("adapts keyless models.json providers before publishing a daemon candidate", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "easyresearch-daemon-no-auth-"));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:1234/v1",
          api: "openai-completions",
          models: [{ id: "local-model" }],
        },
        modelScoped: {
          models: [{
            id: "model-scoped",
            baseUrl: "http://127.0.0.1:3456/v1",
            api: "openai-completions",
          }],
        },
      },
    }));
    const candidate = transactionRuntime("local-model", {
      models: [{ provider: "local", id: "local-model", reasoning: false }],
      providers: [{ id: "local", name: "Local" }],
    });
    const daemon = await createDaemonAuthRuntime({
      config: new ConfigFileService(agentDir),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      createModelRuntime: async () => candidate,
      synchronizeCatalog: async () => {},
      onModelsChanged: async () => {},
    });

    try {
      (await daemon.modelValidator.prepareModelCatalog()).commit();
      expect(candidate.setRuntimeApiKey).toHaveBeenCalledWith("local", expect.any(String));
      expect(candidate.setRuntimeApiKey).toHaveBeenCalledWith("modelScoped", expect.any(String));
      expect([...daemon.noAuthProviderIds()]).toEqual(["local", "modelScoped"]);
    } finally {
      await daemon.dispose();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps provider rows and pinning on the accepted candidate while current models.json is rejected", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "easyresearch-daemon-auth-"));
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(modelsPath, '{"providers":{"accepted-provider":{}}}');
    const acceptedRuntime = transactionRuntime("accepted-model", {
      models: [{ provider: "accepted-provider", id: "accepted-model", reasoning: false }],
      providers: [{ id: "accepted-provider", name: "Accepted" }],
    });
    const recoveredRuntime = transactionRuntime("recovered-model", {
      models: [{ provider: "recovered-provider", id: "recovered-model", reasoning: false }],
      providers: [{ id: "recovered-provider", name: "Recovered" }],
    });
    const runtimes = [acceptedRuntime, recoveredRuntime];
    const daemon = await createDaemonAuthRuntime({
      config: new ConfigFileService(agentDir),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      createModelRuntime: async () => runtimes.shift()!,
      synchronizeCatalog: async () => {},
      onModelsChanged: async () => {},
    });

    writeFileSync(modelsPath, '{"providers":');

    await expect(daemon.auth.listModels()).resolves.toMatchObject([
      { provider: "accepted-provider", id: "accepted-model" },
    ]);
    await expect(daemon.auth.listProviders()).resolves.toMatchObject([
      { id: "accepted-provider", modelsJson: true },
    ]);
    expect(acceptedRuntime.refresh).toHaveBeenCalledTimes(1);

    writeFileSync(modelsPath, '{"providers":{"recovered-provider":{}}}');
    (await daemon.modelValidator.prepareModelCatalog()).commit();
    await expect(daemon.auth.listProviders()).resolves.toMatchObject([
      { id: "recovered-provider", modelsJson: true },
    ]);
    expect(recoveredRuntime.refresh).toHaveBeenCalledTimes(1);

    await daemon.dispose();
    rmSync(agentDir, { recursive: true, force: true });
  });
});

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

describe("readModelsJsonProviderIds", () => {
  it("reads provider ids from Pi-compatible commented JSON with trailing commas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-models-json-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(
      modelsPath,
      `{
        // Pi accepts line comments and trailing commas.
        "providers": {
          "commented-provider": { "models": [], },
        },
      }`,
    );

    try {
      expect([...await readModelsJsonProviderIds(modelsPath)]).toEqual(["commented-provider"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed models.json instead of silently clearing pinning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-models-json-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, '{ "providers": {');

    try {
      await expect(readModelsJsonProviderIds(modelsPath)).rejects.toThrow("Unable to parse models.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a semantically invalid providers value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-models-json-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, '{ "providers": [] }');

    try {
      await expect(readModelsJsonProviderIds(modelsPath)).rejects.toThrow("Invalid models.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a models.json read failure instead of silently clearing pinning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-models-json-"));
    const modelsPath = join(dir, "models.json");
    mkdirSync(modelsPath);

    try {
      await expect(readModelsJsonProviderIds(modelsPath)).rejects.toThrow("Unable to read models.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("configureNoAuthModelRuntime", () => {
  it("decorates each raw candidate before semantic checks and no-auth configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-routed-model-runtime-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:1234/v1",
          api: "openai-completions",
          models: [{ id: "local-model" }],
        },
      },
    }));
    const order: string[] = [];
    const raw = {
      getError() {
        order.push("raw:getError");
        return undefined;
      },
      async setRuntimeApiKey(providerId: string) {
        order.push(`raw:setRuntimeApiKey:${providerId}`);
      },
    };
    const createRuntime = vi.fn(async () => {
      order.push("create");
      return raw;
    });
    const decorate = vi.fn((runtime: typeof raw) => new Proxy(runtime, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          order.push(`decorated:${String(property)}`);
          return Reflect.apply(value, target, args);
        };
      },
    }));

    try {
      await expect(createConfiguredModelRuntime(createRuntime, modelsPath, decorate)).resolves.toBeDefined();

      expect(order).toEqual([
        "create",
        "decorated:getError",
        "raw:getError",
        "decorated:setRuntimeApiKey",
        "raw:setRuntimeApiKey:local",
        "decorated:getError",
        "raw:getError",
      ]);
      expect(decorate).toHaveBeenCalledOnce();
      expect(decorate).toHaveBeenCalledWith(raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to a custom-layer-free runtime when models.json is malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-model-runtime-fallback-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, "{ malformed\n");
    const malformed = {
      getError: () => "private models.json parse detail",
      setRuntimeApiKey: vi.fn(async () => {}),
    };
    const fallback = {
      getError: () => undefined,
      setRuntimeApiKey: vi.fn(async () => {}),
    };
    const createRuntime = vi.fn(async (path: string | null) => path === null ? fallback : malformed);

    try {
      await expect(createConfiguredModelRuntime(createRuntime, modelsPath, (runtime) => runtime)).resolves.toBe(fallback);
      expect(createRuntime.mock.calls.map(([path]) => path)).toEqual([modelsPath, null]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks only complete explicitly keyless custom providers with runtime auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-no-auth-models-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:1234/v1",
          api: "openai-completions",
          models: [{ id: "local-model" }],
        },
        modelScoped: {
          models: [{
            id: "model-scoped",
            baseUrl: "http://127.0.0.1:3456/v1",
            api: "openai-completions",
          }],
        },
        keyed: {
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          apiKey: "$KEYED_TOKEN",
          models: [{ id: "keyed-model" }],
        },
        oauth: {
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          oauth: "radius",
          models: [{ id: "oauth-model" }],
        },
        incomplete: {
          baseUrl: "http://127.0.0.1:2345/v1",
          models: [{ id: "incomplete-model" }],
        },
      },
    }));
    const setRuntimeApiKey = vi.fn<(providerId: string, apiKey: string) => Promise<void>>(async () => {});

    try {
      const providerIds = await configureNoAuthModelRuntime({ setRuntimeApiKey }, modelsPath);

      expect([...providerIds]).toEqual(["local", "modelScoped"]);
      expect(setRuntimeApiKey).toHaveBeenCalledTimes(2);
      expect(setRuntimeApiKey).toHaveBeenCalledWith("local", expect.any(String));
      expect(setRuntimeApiKey.mock.calls[0]?.[1]).not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makes a keyless custom model available to Pi requests without mutating auth.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-no-auth-runtime-"));
    const modelsPath = join(dir, "models.json");
    const authPath = join(dir, "auth.json");
    writeFileSync(authPath, '{"existing":{"type":"api_key","key":"keep"}}\n');
    const authBefore = readFileSync(authPath);
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:1234/v1",
          api: "openai-completions",
          models: [{ id: "local-model" }],
        },
      },
    }));

    try {
      const { importPi } = await import("../runtime/pi-import");
      const { ModelRuntime } = await importPi();
      const runtime = await ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });

      await configureNoAuthModelRuntime(runtime, modelsPath);
      const model = runtime.getModel("local", "local-model");

      expect(model).toBeDefined();
      expect(runtime.getAvailableSnapshot()).toContainEqual(model);
      await expect(runtime.getAuth(model!)).resolves.toMatchObject({
        auth: { apiKey: expect.any(String) },
      });
      expect(readFileSync(authPath)).toEqual(authBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
        getAvailableSnapshot: () => [],
        getError: () => undefined,
        getProviderAuthStatus: () => ({ configured: false } as any),
        checkAuth: async () => undefined,
        login: loginImpl as any,
        logout: async () => {},
        refresh: async () => ({ aborted: false, errors: new Map() }),
      } as any,
      store,
      { timeoutMs: 600_000 },
    );
    await gw.preflight({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    const flow = gw.runFlow({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
    gw.shutdown();
    await expect(flow).resolves.toBeUndefined();
    expect(store.get("f1")?.terminated).toBe(true);
  });
});
