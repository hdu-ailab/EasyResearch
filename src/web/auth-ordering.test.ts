import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthOperationOptions, MutableModels, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createLiveConfiguration, type ConfigurationWatchImplementation } from "../runtime/live-configuration";
import { importPi, importPiAuthStorage } from "../runtime/pi-import";
import { createDaemonAuthRuntime } from "./auth-runtime";
import { ConfigFileService, ConfigServiceError, type AuthoritativeConfigChange } from "./config-files";
import { createProviderDeletionService } from "./provider-deletion";
import { createRouteHandler, type RouteServices } from "./routes";

const customModels = (id = "accepted-custom", providerId = "custom") => JSON.stringify({
  providers: {
    [providerId]: {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions",
      apiKey: "${EASYRESEARCH_AUTH_ORDERING_KEY}", models: [{ id }],
    },
  },
});

async function fixture(
  onLogout?: (providerId: string, options?: AuthOperationOptions) => void | Promise<void>,
  options: {
    onConfigWrite?: (change: AuthoritativeConfigChange) => Promise<void>;
    onLoginSettled?: () => Promise<void>;
    beforeCatalogSync?: () => Promise<void>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-auth-ordering-"));
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  mkdirSync(homeDir);
  mkdirSync(agentDir);
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("USERPROFILE", homeDir);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  vi.stubEnv("EASYRESEARCH_AUTH_ORDERING_KEY", undefined);
  vi.stubGlobal("fetch", async () => { throw new Error("Unexpected outbound request"); });
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    openai: { type: "api_key", key: "synthetic-before" },
    anthropic: { type: "api_key", key: "synthetic-other" },
    custom: { type: "api_key", key: "synthetic-custom-before" },
  }));
  const modelsPath = join(agentDir, "models.json");
  const cachePath = join(agentDir, "models-store.json");
  writeFileSync(modelsPath, customModels());
  writeFileSync(cachePath, JSON.stringify({
    custom: { models: [] }, retained: { models: [] },
  }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    easyresearch: { web: { authFlowTimeoutMs: 0 } },
  }));
  const { ModelRuntime } = await importPi();
  let live: ReturnType<typeof createLiveConfiguration> | undefined;
  const config = new ConfigFileService(agentDir, {
    onAuthoritativeWrite: async (change) => {
      const outcome = await live?.notify(change);
      if (outcome?.status === "closed" || outcome?.status === "rejected") {
        throw new ConfigServiceError(409, "Configuration was not accepted", "CONFIG_REJECTED");
      }
      await options.onConfigWrite?.(change);
      return outcome;
    },
  });
  const collections: MutableModels[] = [];
  const logoutStarts: string[] = [];
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const daemon = await createDaemonAuthRuntime({
    config,
    logger,
    createModelRuntime: () => ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false }),
    decorateAuthRuntime: (runtime) => {
      collections.push(runtime as unknown as MutableModels);
      return new Proxy(runtime, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "login" && typeof value === "function" && options.onLoginSettled) return async (...args: Parameters<MutableModels["login"]>) => {
            try { return await Reflect.apply(value, target, args); }
            finally { await options.onLoginSettled!(); }
          };
          if (property === "logout" && typeof value === "function") return async (providerId: string, options?: AuthOperationOptions) => {
            logoutStarts.push(providerId);
            await onLogout?.(providerId, options);
            return Reflect.apply(value, target, [providerId, options]);
          };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    synchronizeCatalog: async () => {
      await options.beforeCatalogSync?.();
      await live?.synchronize();
    },
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
  await live.start();
  const models = structuredClone([...daemon.modelRuntime.getModels()]);
  const deletion = createProviderDeletionService(config, daemon.auth);
  const handler = createRouteHandler({ auth: daemon.auth, providerDeletion: deletion, config, logger } as unknown as RouteServices);
  return {
    daemon, live, collections, logoutStarts, models, config, modelsPath, authPath, cachePath,
    deletion,
    request(path: string, method = "POST", body?: unknown) {
      return handler(new Request(`http://127.0.0.1${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      }));
    },
    credentials: () => JSON.parse(readFileSync(authPath, "utf8")),
    async login(flowId: string, providerId = "openai") {
      const request = { flowId, providerId, type: "api_key" as const };
      await daemon.auth.preflight(request);
      const prompted = Promise.withResolvers<void>();
      const unsubscribe = daemon.auth.store().subscribe(flowId, (event) => {
        if (event.type === "prompt") prompted.resolve();
      });
      const done = daemon.auth.runFlow(request).finally(unsubscribe);
      return { done, prompted: prompted.promise };
    },
    async close() {
      try {
        await daemon.dispose();
        await live!.close();
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

describe("native auth operation ordering", () => {
  it.each(["openai", "anthropic", "custom"])("does not admit an older %s login after deleting its override during preflight catalog sync", async (providerId) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = true;
    const state = await fixture(undefined, { beforeCatalogSync: async () => {
      if (!hold) return;
      entered.resolve();
      await release.promise;
    } });
    let first: Promise<Response> | undefined;
    try {
      await state.config.write({ scope: "global", path: "models.json", content: customModels("override", providerId) });
      first = state.request("/api/auth/login", "POST", { providerId, type: "api_key" });
      await entered.promise;
      const deleted = await state.request(`/api/auth/providers/${providerId}`, "DELETE");
      expect(deleted.status).toBe(200);
      await expect(deleted.json()).resolves.toMatchObject({ credentialsRemoved: true, warnings: [] });
      expect(state.credentials()[providerId]).toBeUndefined();
      const generation = state.live.generation;

      hold = false;
      release.resolve();
      const oldResponse = await first;
      // Drive the buggy 202 response all the way to native credential persistence.
      if (oldResponse.status === 202) {
        const { flowId } = await oldResponse.json();
        await vi.waitFor(() => expect(state.daemon.auth.store().pendingKind(flowId)).toBe("secret"));
        const answered = await state.request(`/api/auth/flows/${flowId}/respond`, "POST", { value: "synthetic-preflight-late" });
        expect(answered.status).toBe(200);
        await vi.waitFor(() => expect(state.daemon.auth.store().get(flowId)?.terminated).toBe(true));
      }
      expect(state.credentials()[providerId]).toBeUndefined();
      expect(oldResponse.status).toBe(providerId === "custom" ? 404 : 409);
      expect(state.daemon.auth.activeFlow()).toBeNull();
      expect(state.daemon.auth.store().list()).toEqual([]);
      expect(state.collections).toHaveLength(0);

      const next = await state.request("/api/auth/login", "POST", { providerId, type: "api_key" });
      if (providerId === "custom") {
        expect(next.status).toBe(404);
        expect(state.daemon.modelRuntime.getProvider(providerId)).toBeUndefined();
      } else {
        expect(next.status).toBe(202);
        const { flowId } = await next.json();
        await vi.waitFor(() => expect(state.daemon.auth.store().pendingKind(flowId)).toBe("secret"));
        expect((await state.request(`/api/auth/flows/${flowId}/respond`, "POST", { value: "synthetic-fresh-login" })).status).toBe(200);
        await vi.waitFor(() => expect(state.daemon.auth.store().get(flowId)?.terminalEvent).toMatchObject({ type: "done" }));
        expect(state.credentials()[providerId]).toEqual({ type: "api_key", key: "synthetic-fresh-login" });
        expect(state.daemon.modelRuntime.getProvider(providerId)).toBeDefined();
      }
      expect(state.live.generation).toBe(generation);
      expect(JSON.parse(readFileSync(state.modelsPath, "utf8")).providers).not.toHaveProperty(providerId);
    } finally {
      release.resolve();
      await first;
      await state.close();
    }
  });

  it.each(["catalog", "provider", "method"])("releases preflight ownership after a %s rejection so the next route login can succeed", async (failure) => {
    let rejectCatalog = failure === "catalog";
    const state = await fixture(undefined, { beforeCatalogSync: async () => {
      if (!rejectCatalog) return;
      rejectCatalog = false;
      throw new Error("Synthetic catalog synchronization failure");
    } });
    try {
      const failed = await state.request("/api/auth/login", "POST", {
        providerId: failure === "provider" ? "missing-provider" : "custom",
        type: failure === "method" ? "oauth" : "api_key",
      });
      expect(failed.status).toBe(failure === "catalog" ? 500 : failure === "provider" ? 404 : 400);
      expect(state.daemon.auth.activeFlow()).toBeNull();
      expect(state.daemon.auth.store().list()).toEqual([]);
      expect(state.collections).toHaveLength(0);
      const next = await state.request("/api/auth/login", "POST", { providerId: "custom", type: "api_key" });
      expect(next.status).toBe(202);
      const { flowId } = await next.json();
      await vi.waitFor(() => expect(state.daemon.auth.store().pendingKind(flowId)).toBe("secret"));
      await state.request(`/api/auth/flows/${flowId}/respond`, "POST", { value: "synthetic-retry" });
      await vi.waitFor(() => expect(state.daemon.auth.store().get(flowId)?.terminalEvent).toMatchObject({ type: "done" }));
      expect(state.credentials().custom).toEqual({ type: "api_key", key: "synthetic-retry" });
    } finally {
      await state.close();
    }
  });

  it("cancels an earlier pending login before explicit deletion completes and rejects its late answer", async () => {
    const state = await fixture();
    try {
      const generation = state.live.generation;
      const first = await state.login("first", "custom");
      await first.prompted;
      const result = await state.deletion.delete("custom");
      const terminalAtDeletion = state.daemon.auth.store().get("first")?.terminalEvent;
      const lateAnswerAccepted = state.daemon.auth.store().resolveRespond("first", "synthetic-late");
      await first.done;

      expect(result).toMatchObject({ credentialsRemoved: true, cacheRemoved: true, warnings: [] });
      expect(state.credentials().custom).toBeUndefined();
      expect(terminalAtDeletion).toMatchObject({ type: "error", reason: "aborted" });
      expect(lateAnswerAccepted).toBe(false);
      expect(state.credentials().anthropic).toEqual({ type: "api_key", key: "synthetic-other" });
      expect(JSON.parse(readFileSync(state.cachePath, "utf8"))).toEqual({ retained: { models: [] } });
      expect(result.configuration).toMatchObject({ generation: state.live.generation });
      expect(state.live.generation).toBeGreaterThan(generation);
      expect(state.daemon.modelRuntime.getProvider("custom")).toBeUndefined();
      expect(state.collections.every((runtime) => runtime.getProviders().length === 0)).toBe(true);

      await state.config.write({ scope: "global", path: "models.json", content: customModels("readded") });
      expect(state.credentials().custom).toBeUndefined();
      const nextGeneration = state.live.generation;
      const next = await state.login("next", "custom");
      await next.prompted;
      state.daemon.auth.store().resolveRespond("next", "synthetic-new-login");
      await next.done;
      expect(state.credentials().custom).toEqual({ type: "api_key", key: "synthetic-new-login" });
      expect(state.live.generation).toBe(nextGeneration);
      expect([...state.daemon.modelRuntime.getModels()].filter((model) => model.provider === "custom"))
        .toMatchObject([{ id: "readded" }]);
    } finally {
      await state.close();
    }
  });

  it("cancels an admitted login whose run starts only after deletion and provider readdition", async () => {
    const state = await fixture();
    try {
      const request = { flowId: "delayed", providerId: "custom", type: "api_key" as const };
      await state.daemon.auth.preflight(request);
      await state.deletion.delete("custom");
      await state.config.write({ scope: "global", path: "models.json", content: customModels("replacement") });
      const done = state.daemon.auth.runFlow(request);
      // A delayed run must not acquire the replacement provider or prompt again.
      await vi.waitFor(() => expect(state.daemon.auth.store().get("delayed")?.terminalEvent)
        .toMatchObject({ type: "error", reason: "aborted" }));
      await done;
      expect(state.collections).toHaveLength(0);
      expect(state.credentials().custom).toBeUndefined();
    } finally {
      await state.close();
    }
  });

  it.each(["complete", "reject"])("keeps a later login behind deletion through catalog replacement and %s", async (outcome) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let holdDeletion = true;
    const state = await fixture(undefined, { onConfigWrite: async (change) => {
      if (!change.modelsChanged || !holdDeletion) return;
      holdDeletion = false;
      entered.resolve();
      await release.promise;
      if (outcome === "reject") throw new ConfigServiceError(409, "Synthetic acceptance failure");
    } });
    let deleting: Promise<unknown> | undefined;
    try {
      const first = await state.login("first", "custom");
      await first.prompted;
      deleting = Promise.allSettled([state.deletion.delete("custom")]);
      await entered.promise;
      await vi.waitFor(() => expect(state.daemon.auth.store().get("first")?.terminalEvent)
        .toMatchObject({ type: "error", reason: "aborted" }));
      await first.done;
      expect(state.credentials().custom).toEqual({ type: "api_key", key: "synthetic-custom-before" });

      await state.config.write({ scope: "global", path: "models.json", content: customModels("replacement") });
      const generation = state.live.generation;
      const later = await state.login("later", "custom");
      await state.daemon.auth.logout("anthropic");
      expect(state.daemon.auth.store().pendingKind("later")).toBeNull();
      expect(state.credentials().anthropic).toBeUndefined();
      release.resolve();
      expect(await deleting).toMatchObject(outcome === "complete"
        ? [{ status: "fulfilled", value: { credentialsRemoved: true, warnings: [] } }]
        : [{ status: "rejected", reason: { status: 409 } }]);
      await later.prompted;
      expect(state.credentials().custom).toEqual(outcome === "complete"
        ? undefined : { type: "api_key", key: "synthetic-custom-before" });
      state.daemon.auth.store().resolveRespond("later", "synthetic-later");
      await later.done;
      expect(state.credentials().custom).toEqual({ type: "api_key", key: "synthetic-later" });
      expect(state.live.generation).toBe(generation);
      expect([...state.daemon.modelRuntime.getModels()].filter((model) => model.provider === "custom"))
        .toMatchObject([{ id: "replacement" }]);
      expect(state.collections.every((runtime) => runtime.getProviders().length === 0)).toBe(true);
    } finally {
      release.resolve();
      await state.close();
      await deleting;
    }
  });

  it("preserves orphan authentication when external models-file removal overlaps login", async () => {
    const state = await fixture();
    try {
      const first = await state.login("first", "custom");
      await first.prompted;
      writeFileSync(state.modelsPath, JSON.stringify({ providers: {} }));
      await state.live.synchronize();
      const generation = state.live.generation;
      expect(state.daemon.modelRuntime.getProvider("custom")).toBeUndefined();
      expect(state.collections[0]!.getProvider("custom")).toBeDefined();
      state.daemon.auth.store().resolveRespond("first", "synthetic-orphan");
      await first.done;
      expect(state.daemon.auth.store().get("first")?.terminalEvent).toMatchObject({ type: "done" });
      expect(state.credentials().custom).toEqual({ type: "api_key", key: "synthetic-orphan" });
      expect(state.live.generation).toBe(generation);
      expect(state.daemon.modelRuntime.getProvider("custom")).toBeUndefined();
      expect(JSON.parse(readFileSync(state.cachePath, "utf8"))).toHaveProperty("custom");
      expect(state.collections.every((runtime) => runtime.getProviders().length === 0)).toBe(true);
    } finally {
      await state.close();
    }
  });

  it.each(["complete", "shutdown"])("retains login cleanup ownership before deletion can %s", async (outcome) => {
    const release = Promise.withResolvers<void>();
    let loginSettled = false;
    const state = await fixture(undefined, { onLoginSettled: async () => {
      loginSettled = true;
      await release.promise;
    } });
    let deleting: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      const first = await state.login("first", "custom");
      await first.prompted;
      const before = readFileSync(state.modelsPath);
      deleting = Promise.allSettled([state.deletion.delete("custom")]);
      await vi.waitFor(() => expect(loginSettled).toBe(true));
      await state.daemon.auth.logout("anthropic");
      expect(readFileSync(state.modelsPath)).toEqual(before);
      expect(state.credentials().custom).toEqual({ type: "api_key", key: "synthetic-custom-before" });
      expect(state.collections[0]!.getProvider("custom")).toBeDefined();

      if (outcome === "shutdown") {
        let closed = false;
        closing = state.daemon.dispose().then(() => { closed = true; });
        await expect(deleting).resolves.toMatchObject([{ status: "rejected", reason: { name: "AbortError" } }]);
        expect(closed).toBe(false);
        await expect(state.deletion.delete("custom")).rejects.toMatchObject({ status: 503 });
      }
      release.resolve();
      await first.done;
      if (outcome === "complete") {
        await expect(deleting).resolves.toMatchObject([{ status: "fulfilled", value: { credentialsRemoved: true, warnings: [] } }]);
        expect(state.credentials().custom).toBeUndefined();
      } else {
        await closing;
        expect(readFileSync(state.modelsPath)).toEqual(before);
        expect(state.credentials().custom).toEqual({ type: "api_key", key: "synthetic-custom-before" });
      }
      expect(state.collections.every((runtime) => runtime.getProviders().length === 0)).toBe(true);
      expect(state.daemon.auth.activeFlow()).toBeNull();
    } finally {
      release.resolve();
      await state.close();
      await deleting;
      await closing;
    }
  });

  it.each(["malformed", "missing"])("preserves credentials when the deletion target is %s and leaves authentication retryable", async (source) => {
    const state = await fixture();
    try {
      const first = await state.login("first", "custom");
      await first.prompted;
      const invalid = source === "malformed" ? "{" : JSON.stringify({ providers: {} });
      writeFileSync(state.modelsPath, invalid);
      const credentials = readFileSync(state.authPath);
      const cache = readFileSync(state.cachePath);

      await expect(state.deletion.delete("custom")).rejects.toMatchObject({ status: source === "malformed" ? 409 : 404 });
      await first.done;
      expect(readFileSync(state.authPath)).toEqual(credentials);
      expect(readFileSync(state.cachePath)).toEqual(cache);
      expect(readFileSync(state.modelsPath, "utf8")).toBe(invalid);
      await state.config.write({ scope: "global", path: "models.json", content: customModels() });
      const next = await state.login("next", "custom");
      await next.prompted;
      state.daemon.auth.store().resolveRespond("next", "synthetic-retry");
      await next.done;
      expect(state.credentials().custom).toEqual({ type: "api_key", key: "synthetic-retry" });
      expect(state.collections.every((runtime) => runtime.getProviders().length === 0)).toBe(true);
    } finally {
      await state.close();
    }
  });

  it("does not cancel an unrelated provider's pending login", async () => {
    const state = await fixture();
    try {
      const first = await state.login("first", "openai");
      await first.prompted;
      await state.deletion.delete("custom");
      expect(state.daemon.auth.store().pendingKind("first")).toBe("secret");
      expect(state.daemon.auth.store().get("first")?.abortController.signal.aborted).toBe(false);
      state.daemon.auth.store().resolveRespond("first", "synthetic-retained");
      await first.done;
      expect(state.credentials().openai).toEqual({ type: "api_key", key: "synthetic-retained" });
      expect(state.credentials().custom).toBeUndefined();
      expect(state.daemon.auth.store().get("first")?.terminalEvent).toMatchObject({ type: "done" });
    } finally {
      await state.close();
    }
  });

  it("drains a native OAuth credential refresh under the shared file lock before deletion completes", async () => {
    const state = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let refreshing: Promise<unknown> | undefined;
    let deleting: Promise<unknown> | undefined;
    try {
      const { AuthStorage } = await importPiAuthStorage();
      const { createModels } = await import("@earendil-works/pi-ai");
      const storage = AuthStorage.create(state.authPath);
      await storage.modify("custom", async () => ({
        type: "oauth", access: "synthetic-expired", refresh: "synthetic-refresh", expires: 0,
      }));
      const models = createModels({ credentials: storage });
      models.setProvider({
        ...state.daemon.modelRuntime.getProvider("custom") as Provider,
        auth: { oauth: {
          name: "Controlled refresh",
          login: async () => { throw new Error("Unexpected OAuth login"); },
          refresh: async (credential, signal) => {
            entered.resolve();
            await release.promise;
            signal.throwIfAborted();
            return { ...credential, access: "synthetic-rotated", expires: Date.now() + 3_600_000 };
          },
          toAuth: async (credential) => ({ apiKey: credential.access }),
        } },
      });
      refreshing = models.getAuth("custom");
      await entered.promise;
      deleting = state.deletion.delete("custom");
      await vi.waitFor(() => expect(JSON.parse(readFileSync(state.modelsPath, "utf8")).providers).not.toHaveProperty("custom"));
      expect(state.credentials().custom.access).toBe("synthetic-expired");
      release.resolve();
      await expect(refreshing).resolves.toMatchObject({ auth: { apiKey: "synthetic-rotated" } });
      await expect(deleting).resolves.toMatchObject({ credentialsRemoved: true, warnings: [] });
      expect(state.credentials().custom).toBeUndefined();
      await expect(models.getAuth("custom")).resolves.toBeUndefined();
      expect(state.credentials().custom).toBeUndefined();
      models.clearProviders();
    } finally {
      release.resolve();
      await Promise.allSettled([refreshing, deleting]);
      await state.close();
    }
  });

  it("keeps a later same-provider logout pending during login without blocking another provider", async () => {
    const state = await fixture();
    let pending: Promise<unknown> | undefined;
    try {
      const generation = state.live.generation;
      const first = await state.login("first");
      await first.prompted;
      pending = Promise.allSettled([state.daemon.auth.logout("openai")]);
      await state.daemon.auth.logout("anthropic");

      expect(state.logoutStarts).toEqual(["anthropic"]);
      expect(state.credentials().anthropic).toBeUndefined();
      expect(state.credentials().openai.key).toBe("synthetic-before");
      state.daemon.auth.store().resolveRespond("first", "synthetic-first");
      await first.done;
      expect(await pending).toEqual([{ status: "fulfilled", value: undefined }]);
      expect(state.credentials().openai).toBeUndefined();
      expect(state.logoutStarts).toEqual(["anthropic", "openai"]);
      expect([...state.daemon.modelRuntime.getModels()]).toEqual(state.models);
      expect(state.live.generation).toBe(generation);
      expect(state.collections.every((runtime) => runtime.getProviders().length === 0)).toBe(true);
    } finally {
      await state.close();
      await pending;
    }
  });

  it.each(["complete", "reject"])("does not let a third login overtake the queued logout after the first login %s", async (outcome) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const state = await fixture(async (providerId) => {
      if (providerId === "openai") { entered.resolve(); await release.promise; }
    });
    let pending: Promise<unknown> | undefined;
    try {
      const first = await state.login("first");
      await first.prompted;
      pending = Promise.allSettled([state.daemon.auth.logout("openai")]);
      if (outcome === "complete") state.daemon.auth.store().resolveRespond("first", "synthetic-first");
      else state.daemon.auth.store().rejectRespond("first", new Error("Synthetic authentication rejection"));
      await first.done;
      await entered.promise;
      const third = await state.login("third");
      await state.daemon.auth.logout("anthropic");

      expect(state.daemon.auth.store().pendingKind("third")).toBeNull();
      release.resolve();
      expect(await pending).toEqual([{ status: "fulfilled", value: undefined }]);
      await third.prompted;
      expect(state.credentials().openai).toBeUndefined();
      state.daemon.auth.store().resolveRespond("third", "synthetic-last");
      await third.done;
      expect(state.credentials().openai).toEqual({ type: "api_key", key: "synthetic-last" });
      expect(state.daemon.auth.store().get("third")?.terminalEvent).toMatchObject({ type: "done" });
      expect(state.collections.every((runtime) => runtime.getProviders().length === 0)).toBe(true);
    } finally {
      release.resolve();
      await state.close();
      await pending;
    }
  });

  it("aborts queued login and active logout on shutdown, then waits for owned runtime cleanup", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let logoutSignal: AbortSignal | undefined;
    const state = await fixture(async (providerId, options) => {
      if (providerId === "openai") {
        logoutSignal = options?.signal;
        entered.resolve();
        await release.promise;
      }
    });
    const logout = Promise.allSettled([state.daemon.auth.logout("openai")]);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      const queued = await state.login("queued");
      let disposed = false;
      closing = state.daemon.dispose().then(() => { disposed = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(logoutSignal?.aborted).toBe(true);
      expect(disposed).toBe(false);
      expect(state.collections.some((runtime) => runtime.getProviders().length > 0)).toBe(true);
      release.resolve();
      await closing;
      await queued.done;
      expect(await logout).toMatchObject([{ status: "rejected", reason: { name: "AbortError" } }]);
      expect(state.credentials().openai).toEqual({ type: "api_key", key: "synthetic-before" });
      expect(state.daemon.auth.store().get("queued")?.terminalEvent).toMatchObject({ type: "error", reason: "aborted" });
      expect(state.daemon.auth.activeFlow()).toBeNull();
      expect(state.collections.every((runtime) => runtime.getProviders().length === 0)).toBe(true);
    } finally {
      release.resolve();
      await state.close();
      await closing;
      await logout;
    }
  });

  it("does not release an older logout's slot when a queued login is cancelled", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const state = await fixture(async (providerId) => {
      if (providerId === "openai") { entered.resolve(); await release.promise; }
    });
    const logout = Promise.allSettled([state.daemon.auth.logout("openai")]);
    try {
      await entered.promise;
      const acquiredBeforeWaiter = state.collections.length;
      const cancelled = await state.login("cancelled");
      state.daemon.auth.store().cancel("cancelled");
      await cancelled.done;
      expect(state.daemon.auth.store().get("cancelled")?.terminalEvent).toMatchObject({ type: "error", reason: "aborted" });
      expect(state.collections).toHaveLength(acquiredBeforeWaiter);
      const later = await state.login("later");
      await state.daemon.auth.logout("anthropic");

      expect(state.daemon.auth.store().pendingKind("later")).toBeNull();
      release.resolve();
      expect(await logout).toEqual([{ status: "fulfilled", value: undefined }]);
      await later.prompted;
      expect(state.credentials().openai).toBeUndefined();
      state.daemon.auth.store().resolveRespond("later", "synthetic-later");
      await later.done;
      expect(state.credentials().openai).toEqual({ type: "api_key", key: "synthetic-later" });
      expect(state.collections.every((runtime) => runtime.getProviders().length === 0)).toBe(true);
    } finally {
      release.resolve();
      await state.close();
      await logout;
    }
  });

  it("releases a rejected logout's slot and runtime so the next login can succeed", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const state = await fixture(async (providerId) => {
      if (providerId === "openai") {
        entered.resolve();
        await release.promise;
        throw new Error("Synthetic logout failure");
      }
    });
    const logout = Promise.allSettled([state.daemon.auth.logout("openai")]);
    try {
      await entered.promise;
      const next = await state.login("next");
      await state.daemon.auth.logout("anthropic");
      expect(state.daemon.auth.store().pendingKind("next")).toBeNull();
      release.resolve();
      expect(await logout).toMatchObject([{ status: "rejected", reason: { message: "Synthetic logout failure" } }]);
      await next.prompted;
      state.daemon.auth.store().resolveRespond("next", "synthetic-recovered");
      await next.done;
      expect(state.credentials().openai).toEqual({ type: "api_key", key: "synthetic-recovered" });
      expect(state.daemon.auth.store().get("next")?.terminalEvent).toMatchObject({ type: "done" });
      expect(state.collections.every((runtime) => runtime.getProviders().length === 0)).toBe(true);
    } finally {
      release.resolve();
      await state.close();
      await logout;
    }
  });
});
