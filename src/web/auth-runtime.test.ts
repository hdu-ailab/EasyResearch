import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
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
import { createLiveConfiguration, type ConfigurationWatchImplementation } from "../runtime/live-configuration";

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
    getAvailable: vi.fn(async () => models),
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
  it("refreshes saved credentials without composing unaccepted models.json bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-availability-generation-"));
    const agentDir = join(root, "agent");
    const homeDir = join(root, "home");
    mkdirSync(agentDir);
    mkdirSync(homeDir);
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);
    vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubGlobal("fetch", async () => { throw new Error("Unexpected network request"); });
    const modelsPath = join(agentDir, "models.json");
    const modelConfig = (provider: string) => JSON.stringify({
      providers: {
        [provider]: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "fixture" }] },
      },
    });
    writeFileSync(modelsPath, modelConfig("accepted-provider"));
    const { importPi } = await import("../runtime/pi-import");
    const { ModelRuntime } = await importPi();
    const accepted = createAcceptedModelRuntime(
      () => ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath, refreshOnCreate: false }),
      () => readModelsJsonProviderIds(modelsPath),
    );
    const watch = (() => {
      const watcher = {
        on(event: string, listener: () => void) {
          if (event === "ready") queueMicrotask(listener);
          return watcher;
        },
        add() { return watcher; },
        async close() {},
      };
      return watcher;
    }) as ConfigurationWatchImplementation;
    const live = createLiveConfiguration({ agentDir, catalogOptions: { homeDir }, watch, modelValidator: accepted });
    const config = new ConfigFileService(agentDir, { onAuthoritativeWrite: (change) => live.notify(change) });
    const gateway = createAuthGateway(accepted.runtime, undefined, {
      timeoutMs: 1_000,
      synchronizeCatalog: async () => { await live.synchronize(); },
      acceptedModelsJsonProviderIds: () => accepted.getModelsJsonProviderIds(),
    });
    try {
      await live.start();
      const generation = live.generation;
      const epoch = live.availabilityEpoch;
      const models = [...accepted.runtime.getModels()];
      const selected = models.find((model) => model.provider === "accepted-provider")!;
      expect(selected).toBeDefined();
      expect(accepted.runtime.getAvailableSnapshot()).not.toContainEqual(selected);

      writeFileSync(modelsPath, modelConfig("unaccepted-provider"));
      await config.write({
        scope: "global", path: "auth.json",
        content: JSON.stringify({ "accepted-provider": { type: "api_key", key: "synthetic-key" } }),
      });

      expect([...accepted.runtime.getModels()]).toEqual(models);
      expect(accepted.runtime.getAvailableSnapshot()).toContainEqual(selected);
      expect([...accepted.getModelsJsonProviderIds()]).toEqual(["accepted-provider"]);
      expect(live.generation).toBe(generation);
      expect(live.availabilityEpoch).toBeGreaterThan(epoch);

      writeFileSync(modelsPath, modelConfig("accepted-provider"));
      expect(await gateway.listModels()).toContainEqual(expect.objectContaining({
        provider: "accepted-provider", id: "fixture", available: true,
      }));
      expect(live.generation).toBe(generation);
      await config.write({ scope: "global", path: "auth.json", content: "{}" });
      expect(accepted.runtime.getAvailableSnapshot()).not.toContainEqual(selected);
      expect([...accepted.runtime.getModels()]).toEqual(models);

      writeFileSync(modelsPath, modelConfig("unaccepted-provider"));
      expect(await gateway.listModels()).toContainEqual(expect.objectContaining({
        provider: "unaccepted-provider", id: "fixture",
      }));
      expect(live.generation).toBeGreaterThan(generation);
      expect([...accepted.getModelsJsonProviderIds()]).toEqual(["unaccepted-provider"]);
    } finally {
      await gateway.shutdown();
      await live.close();
      await accepted.dispose();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
  it.each([
    { operation: "login", providerId: "openai", malformedAtStart: false },
    { operation: "logout", providerId: "openai", malformedAtStart: false },
    { operation: "login", providerId: "custom-auth", malformedAtStart: false },
    { operation: "login", providerId: "openai", malformedAtStart: true },
  ] as const)("isolates native $operation for $providerId from cached metadata (malformed start: $malformedAtStart)", async ({ operation, providerId, malformedAtStart }) => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-native-auth-catalog-"));
    const homeDir = join(root, "home");
    const agentDir = join(root, "agent");
    mkdirSync(homeDir);
    mkdirSync(agentDir);
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);
    vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.stubEnv("EASYRESEARCH_TEST_CUSTOM_AUTH_KEY", undefined);
    vi.stubGlobal("fetch", async () => { throw new Error("Unexpected network request"); });
    const authPath = join(agentDir, "auth.json");
    const modelsPath = join(agentDir, "models.json");
    const modelSource = malformedAtStart ? "{malformed startup configuration" : JSON.stringify({ providers: { "custom-auth": {
      api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "$EASYRESEARCH_TEST_CUSTOM_AUTH_KEY",
      models: [{ id: "custom-model", contextWindow: 8192 }],
    } } });
    writeFileSync(modelsPath, modelSource);
    if (operation === "logout") writeFileSync(authPath, JSON.stringify({ [providerId]: { type: "api_key", key: "synthetic-before" } }));
    const { importPi } = await import("../runtime/pi-import");
    const { ModelRuntime } = await importPi();
    let live: ReturnType<typeof createLiveConfiguration> | undefined;
    const createModelRuntime = vi.fn(() => ModelRuntime.create({
      authPath, modelsPath, refreshOnCreate: false,
    }));
    const daemon = await createDaemonAuthRuntime({
      config: new ConfigFileService(agentDir),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      createModelRuntime,
      synchronizeCatalog: async () => { await live?.synchronize(); },
      onModelsChanged: async () => { await live?.notify({ availabilityChanged: true }); },
    });
    live = createLiveConfiguration({
      agentDir, catalogOptions: { homeDir }, modelValidator: daemon.modelValidator,
      watch: (() => {
        const watcher = {
          on(event: string, listener: () => void) { if (event === "ready") queueMicrotask(listener); return watcher; },
          add() { return watcher; }, async close() {},
        };
        return watcher;
      }) as ConfigurationWatchImplementation,
    });
    try {
      await live.start();
      const runtime = daemon.modelRuntime as Awaited<ReturnType<typeof ModelRuntime.create>>;
      const models = structuredClone(runtime.getModels());
      const selected = models.find((model) => model.provider === providerId)!;
      expect(selected).toBeDefined();
      const generation = live.generation;
      const epoch = live.availabilityEpoch;
      const candidateCount = createModelRuntime.mock.calls.length;
      const request = { flowId: "cache-login", providerId, type: "api_key" as const };
      if (operation === "login") await daemon.auth.preflight(request);
      const changeCache = () => writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ [providerId]: {
        models: [
          { ...selected, contextWindow: selected.contextWindow + 123 },
          { ...selected, id: "unaccepted-cache-model", name: "Unaccepted Cache Model" },
        ],
        lastModified: Date.now() + 365 * 24 * 3600_000,
      } }));
      if (operation === "login") {
        const prompted = Promise.withResolvers<void>();
        const unsubscribe = daemon.auth.store().subscribe(request.flowId, (event) => {
          if (event.type === "prompt") prompted.resolve();
        });
        const flow = daemon.auth.runFlow(request);
        await prompted.promise;
        changeCache();
        writeFileSync(modelsPath, "{malformed current model configuration");
        daemon.auth.store().resolveRespond(request.flowId, "synthetic-after");
        await flow;
        unsubscribe();
        expect(daemon.auth.store().get(request.flowId)?.terminalEvent).toMatchObject({ type: "done", warning: undefined });
        writeFileSync(modelsPath, modelSource);
      } else {
        changeCache();
        await daemon.auth.logout(providerId);
      }

      expect(runtime.getModels()).toEqual(models);
      expect(runtime.getModel(providerId, selected.id)).toEqual(selected);
      expect(runtime.getModel(providerId, "unaccepted-cache-model")).toBeUndefined();
      expect(runtime.getAvailableSnapshot().filter((model) => model.provider === providerId))
        .toEqual(operation === "login" ? models.filter((model) => model.provider === providerId) : []);
      expect(runtime.getProviderAuthStatus(providerId).configured).toBe(operation === "login");
      expect(JSON.parse(readFileSync(authPath, "utf8"))[providerId]).toEqual(operation === "login"
        ? { type: "api_key", key: "synthetic-after" } : undefined);
      expect(live.generation).toBe(generation);
      expect(live.availabilityEpoch).toBeGreaterThan(epoch);
      await expect(live.synchronize()).resolves.toMatchObject({ status: "unchanged", generation });
      expect((await daemon.auth.listModels()).some((model) => model.id === "unaccepted-cache-model")).toBe(false);
      expect(createModelRuntime).toHaveBeenCalledTimes(candidateCount);
    } finally {
      await daemon.dispose();
      await live.close();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains the accepted provider owner until a pending auth operation finishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-auth-provider-owner-"));
    const entered = Promise.withResolvers<void>();
    let retired = false;
    const provider = {
      id: "custom-owner", name: "Custom Owner",
      auth: { apiKey: { name: "API key", async login(interaction: { prompt(input: { type: "secret"; message: string }): Promise<string> }) {
        entered.resolve();
        const key = await interaction.prompt({ type: "secret", message: "Accepted provider prompt" });
        if (retired) throw new Error("Provider owner was disposed during authentication");
        return { type: "api_key" as const, key };
      } } },
    };
    const original = {
      ...transactionRuntime("original", { providers: [provider] }),
      login: async (_id: string, _type: "api_key" | "oauth", interaction: AuthInteraction) => provider.auth.apiKey.login(interaction),
    };
    original.dispose.mockImplementation(() => { retired = true; });
    const replacement = transactionRuntime("replacement");
    const candidates = [original, replacement];
    const daemon = await createDaemonAuthRuntime({
      config: new ConfigFileService(root),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      createModelRuntime: async () => candidates.shift()!,
      synchronizeCatalog: async () => {}, onModelsChanged: async () => {},
    });
    const request = { flowId: "retained-provider", providerId: provider.id, type: "api_key" as const };
    let flow: Promise<void> | undefined;
    try {
      await daemon.auth.preflight(request);
      flow = daemon.auth.runFlow(request);
      await entered.promise;
      (await daemon.modelValidator.prepareModelCatalog()).commit();
      expect(retired).toBe(false);
      daemon.auth.store().resolveRespond(request.flowId, "synthetic-key");
      await flow;
      expect(daemon.auth.store().get(request.flowId)?.terminalEvent).toMatchObject({ type: "done" });
      expect(retired).toBe(true);
    } finally {
      await daemon.auth.shutdown();
      await daemon.dispose();
      await flow;
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    candidate.getProvider.mockReturnValue({
      ...anthropicProvider,
      auth: { apiKey: { name: "API key", login: (interaction: AuthInteraction) => candidate.login("anthropic", "api_key", interaction) } },
    });
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
