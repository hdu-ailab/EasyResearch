import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ModelsStore, Provider } from "@earendil-works/pi-ai";
import { builtinProviders, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as registry from "./bundled-model-additions";
import type { BundledModelMetadata } from "./bundled-model-additions";
import { applyBundledModelCatalogOverlay, buildBundledProvider } from "./model-catalog-overlay";
import { importPi } from "./pi-import";
import { captureInheritedProxyEnvironment, parseNetworkProxySettings, resolveNetworkPolicy } from "./network-policy";
import { installNetworkRouter } from "./network-routing";

const addition = registry.BUNDLED_MODEL_ADDITIONS.find((entry) => entry.provider === "deepseek")!;
const metadata: BundledModelMetadata = {
  id: "synthetic-addition", name: "Synthetic addition", api: "openai-completions",
  baseUrl: "https://addition.invalid/v1", reasoning: false, input: ["text"],
  contextWindow: 8192, maxTokens: 512,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
let root: string;
let agentDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-model-overlay-"));
  agentDir = join(root, "agent");
  mkdirSync(agentDir);
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request"); }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function builtin(id: string): Provider {
  const provider = builtinProviders().find((provider) => provider.id === id);
  if (!provider) throw new Error(`Missing builtin provider: ${id}`);
  return provider;
}

async function memoryRuntime(modelsStore?: ModelsStore, modelsPath: string | null = null) {
  const { ModelRuntime } = await importPi();
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  return ModelRuntime.create({
    modelsPath, modelsStore, credentials: new InMemoryCredentialStore(), refreshOnCreate: false,
  });
}

function cached(models: readonly Model<Api>[]) {
  return { models, lastModified: getBuiltinModelDataGeneratedAt()! + 1, checkedAt: 1, etag: "synthetic" };
}

function completionResponse(modelId: string): Response {
  return new Response(`data: ${JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", created: 1, model: modelId,
    choices: [{ index: 0, delta: { role: "assistant", content: "recorded" }, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

describe("buildBundledProvider", () => {
  it("adds the registry metadata without changing existing model objects", () => {
    const base = builtin(addition.provider);
    const original = base.getModels();
    const provider = buildBundledProvider(base, [addition]);
    for (const model of original) {
      expect(provider.getModels().find((entry) => entry.id === model.id)).toBe(model);
    }
    expect(provider.getModels().find((model) => model.id === addition.model.id))
      .toEqual({ ...addition.model, provider: base.id });
    expect(base.getModels()).toEqual(original);
  });

  it("reads the current base on every call and defers additions only while their ids exist", () => {
    const cachedAddition = { ...metadata, provider: "fixture", name: "Native cache" };
    let current: readonly Model<Api>[] = [cachedAddition];
    const base = { ...builtin("deepseek"), id: "fixture", getModels: () => current };
    const provider = buildBundledProvider(base, [{ provider: base.id, model: metadata }]);
    expect(provider.getModels()).toEqual([cachedAddition]);
    expect(provider.getModels()[0]).toBe(cachedAddition);

    current = [];
    expect(provider.getModels()).toEqual([{ ...metadata, provider: base.id }]);
    const replacement = { ...cachedAddition, name: "Replacement cache" };
    current = [replacement];
    expect(provider.getModels()).toEqual([replacement]);
    expect(provider.getModels()[0]).toBe(replacement);
  });

  it("replaces whole named patch fields while retaining unnamed fields and unpatched identities", () => {
    const untouched = { ...metadata, provider: "fixture", id: "untouched" };
    const original: Model<Api> = {
      ...metadata, provider: "fixture", id: "patched", headers: { "x-keep": "yes" },
      cost: { ...metadata.cost, tiers: [{ ...metadata.cost, inputTokensAbove: 100 }] },
      compat: { supportsStore: false, supportsDeveloperRole: false },
    };
    let current = [untouched, original];
    const base = { ...builtin("deepseek"), id: "fixture", getModels: () => current };
    const provider = buildBundledProvider(base, [], [{
      provider: base.id, id: original.id,
      patch: { contextWindow: 123, cost: metadata.cost, compat: { supportsStore: true } },
    }]);
    const patched = provider.getModels()[1]!;
    expect(patched).toMatchObject({ contextWindow: 123, name: original.name, maxTokens: original.maxTokens });
    expect(patched.cost).toEqual(metadata.cost);
    expect(patched.cost).not.toHaveProperty("tiers");
    expect(patched.compat).toEqual({ supportsStore: true });
    expect(patched.headers).toBe(original.headers);
    expect(provider.getModels()[0]).toBe(untouched);
    expect(original.contextWindow).toBe(metadata.contextWindow);
    current = [untouched, { ...original, name: "New cache name" }];
    expect(provider.getModels()[1]).toMatchObject({ name: "New cache name", contextWindow: 123 });
  });

  it("returns the base by identity for an empty provider-specific registry", () => {
    const base = builtin("deepseek");
    expect(buildBundledProvider(base)).toBe(base);
    expect(buildBundledProvider(base, [], [], [])).toBe(base);
    expect(buildBundledProvider(base, [{ provider: "other", model: metadata }], [
      { provider: "other", id: base.getModels()[0]!.id, patch: { name: "Not this provider" } },
    ], [{ provider: "other", id: base.getModels()[0]!.id }])).toBe(base);
  });

  it("filters removal-only ids on every read without changing base records or retained identities", () => {
    const retained = { ...metadata, provider: "fixture", id: "retained" };
    const retired = { ...retained, id: "retired" };
    let current = [retained, retired];
    const base = { ...builtin("deepseek"), id: "fixture", getModels: () => current };
    const provider = buildBundledProvider(base, [], [], [
      { provider: base.id, id: retired.id },
      { provider: base.id, id: "cache-only-retired" },
      { provider: "other", id: retained.id },
    ]);
    expect(provider.getModels()).toEqual([retained]);
    expect(provider.getModels()[0]).toBe(retained);
    expect(base.getModels()).toEqual([retained, retired]);
    for (const key of ["auth", "filterModels", "refreshModels", "stream", "streamSimple", "fetchDeferred", "cancelDeferred"] as const) {
      expect(provider[key]).toBe(base[key]);
    }

    const cachedRetired = { ...retired, id: "cache-only-retired" };
    current = [retired, retained, cachedRetired];
    expect(provider.getModels()).toEqual([retained]);
    expect(provider.getModels()[0]).toBe(retained);
    expect(base.getModels()).toEqual([retired, retained, cachedRetired]);
    current = [retained];
    expect(provider.getModels()).toEqual([retained]);
  });

  it("gives removals priority inside the merged product base", () => {
    const original = { ...metadata, provider: "fixture", id: "existing" };
    const base = { ...builtin("deepseek"), id: "fixture", getModels: () => [original] };
    const provider = buildBundledProvider(base, [{ provider: base.id, model: metadata }], [
      { provider: base.id, id: original.id, patch: { name: "Patched" } },
    ], [
      { provider: base.id, id: original.id },
      { provider: base.id, id: metadata.id },
    ]);
    expect(provider.getModels()).toEqual([]);
    expect(base.getModels()).toEqual([original]);
  });

  it("dispatches an explicit addition through a native mixed-API provider without sample metadata", async () => {
    const native = builtin("github-copilot");
    const base = { ...native, getModels: (): readonly Model<Api>[] => [{
      ...metadata, provider: native.id, id: "first", api: "anthropic-messages",
      baseUrl: "https://first.invalid", headers: { "x-unrelated": "sample" },
      samplingParams: { unrelated_sample_parameter: true },
    }] };
    const provider = buildBundledProvider(base, [{ provider: base.id, model: metadata }]);
    const model = provider.getModels().find((entry) => entry.id === metadata.id)!;
    const requests: Request[] = [];
    const recordingFetch = (async (input, init) => {
      requests.push(new Request(input, init));
      return completionResponse(metadata.id);
    }) as typeof fetch;

    const result = await provider.streamSimple(model, {
      messages: [{ role: "user", content: "test", timestamp: 1 }],
    }, { apiKey: "synthetic-token", fetch: recordingFetch, maxRetries: 0 }).result();

    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://addition.invalid/v1/chat/completions");
    expect(requests[0]!.headers.has("x-unrelated")).toBe(false);
    const body = await requests[0]!.json();
    expect(body.model).toBe(metadata.id);
    expect(body).not.toHaveProperty("unrelated_sample_parameter");
    expect(model).toEqual({ ...metadata, provider: base.id });
  });

  it("preserves native auth, filtering, refresh and stream callbacks", async () => {
    const base = (await memoryRuntime()).getProvider("github-copilot")!;
    const provider = buildBundledProvider(base, [{ provider: base.id, model: metadata }]);
    for (const key of ["auth", "filterModels", "refreshModels", "stream", "streamSimple", "fetchDeferred", "cancelDeferred"] as const) {
      expect(provider[key]).toBe(base[key]);
    }
    expect(provider.refreshModels).toBeTypeOf("function");
    const allowed = base.getModels()[0]!;
    expect(provider.filterModels!(provider.getModels(), {
      type: "oauth", access: "synthetic", refresh: "synthetic", expires: Date.now() + 60_000,
      availableModelIds: [allowed.id],
    })).toEqual([allowed]);
  });
});

describe("applyBundledModelCatalogOverlay", () => {
  it("removes retired native Flash ids while keeping canonical Flash and Pro", async () => {
    const runtime = await memoryRuntime();
    const native = runtime.getProvider("deepseek")!;
    const original = [...native.getModels()];
    await applyBundledModelCatalogOverlay(runtime);
    for (const id of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
      expect(original.find((model) => model.id === id)).toBeDefined();
      expect(runtime.getModel("deepseek", id)).toBeUndefined();
      expect(runtime.getProvider("deepseek")!.getModels().some((model) => model.id === id)).toBe(false);
    }
    expect(runtime.getModel("deepseek", "deepseek-flash")).toEqual({ ...addition.model, provider: "deepseek" });
    expect(runtime.getModel("deepseek", "deepseek-v4-pro")).toMatchObject({
      name: "DeepSeek V4 Pro 0813", input: ["text"], reasoning: true,
    });
    expect(native.getModels()).toEqual(original);
  });

  it.each(["before", "after"])("excludes retired ids when cache is restored %s overlay registration", async (when) => {
    const { InMemoryModelsStore } = await import("@earendil-works/pi-ai");
    const store = new InMemoryModelsStore();
    const retired = ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].map((id) => ({
      ...addition.model, provider: addition.provider, id, name: `Cached ${id}`,
    }));
    const pro = builtin("deepseek").getModels().find((model) => model.id === "deepseek-v4-pro")!;
    const cacheOnly = { ...addition.model, provider: addition.provider, id: "cache-only" };
    const snapshot = cached([pro, ...retired, cacheOnly]);
    const runtime = await memoryRuntime(store);
    if (when === "after") await applyBundledModelCatalogOverlay(runtime);
    await store.write(addition.provider, snapshot);
    if (when === "before") await applyBundledModelCatalogOverlay(runtime);
    else await runtime.refresh({ allowNetwork: false });

    expect(runtime.getModel(addition.provider, cacheOnly.id)).toEqual(cacheOnly);
    for (const { id } of retired) {
      expect(runtime.getModel(addition.provider, id)).toBeUndefined();
      expect(runtime.getProvider(addition.provider)!.getModels().some((model) => model.id === id)).toBe(false);
    }
    expect(runtime.getModel(addition.provider, addition.model.id)).toEqual({ ...addition.model, provider: addition.provider });
    expect(runtime.getModel(addition.provider, pro.id)).toMatchObject({ id: pro.id, name: "DeepSeek V4 Pro 0813" });
    expect(await store.read(addition.provider)).toEqual(snapshot);
    await store.delete(addition.provider);
    await runtime.refresh({ allowNetwork: false });
    for (const { id } of retired) expect(runtime.getModel(addition.provider, id)).toBeUndefined();
    expect(runtime.getModel(addition.provider, addition.model.id)).toBeDefined();
    expect(runtime.getModel(addition.provider, pro.id)).toBeDefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { id: "deepseek-flash", inputCost: 0.00015, outputCost: 0.0006, cacheCost: 0.000003 },
    { id: "deepseek-v4-pro", inputCost: 0.00066, outputCost: 0.00198, cacheCost: 0.000022 },
  ])("sends low effort for $id and prices native usage at official off-peak USD rates", async ({ id, inputCost, outputCost, cacheCost }) => {
    const runtime = await memoryRuntime();
    await applyBundledModelCatalogOverlay(runtime);
    await runtime.setRuntimeApiKey("deepseek", "synthetic-pricing-key");
    const model = runtime.getModel("deepseek", id)!;
    const requests: Request[] = [];
    const recordingFetch = (async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(`data: ${JSON.stringify({
        id: "pricing-fixture", object: "chat.completion.chunk", created: 1, model: id,
        choices: [{ index: 0, delta: { role: "assistant", content: "recorded" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 1000,
          total_tokens: 3000,
          prompt_tokens_details: { cached_tokens: 1000 },
        },
      })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const result = await runtime.completeSimple(model, {
      messages: [{ role: "user", content: "test", timestamp: 1 }],
    }, { reasoning: "low", fetch: recordingFetch, maxRetries: 0 });
    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(await requests[0]!.json()).toMatchObject({
      model: id,
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
    expect(result.usage).toMatchObject({ input: 1000, output: 1000, cacheRead: 1000 });
    expect(result.usage.cost.input).toBeCloseTo(inputCost, 12);
    expect(result.usage.cost.output).toBeCloseTo(outputCost, 12);
    expect(result.usage.cost.cacheRead).toBeCloseTo(cacheCost, 12);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("restores cache-only ids and metadata through the target's store across refreshes", async () => {
    const { InMemoryModelsStore } = await import("@earendil-works/pi-ai");
    const store = new InMemoryModelsStore();
    const builtinModel = builtin(addition.provider).getModels().find((model) => model.id === "deepseek-v4-pro")!;
    const cacheOnly = { ...builtinModel, id: "cache-only", name: "Cached model" };
    const corrected = { ...builtinModel, contextWindow: builtinModel.contextWindow + 123 };
    await store.write(addition.provider, cached([cacheOnly, corrected]));
    const runtime = await memoryRuntime(store);
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel(addition.provider, cacheOnly.id)).toEqual(cacheOnly);

    await applyBundledModelCatalogOverlay(runtime);
    expect(runtime.getModel(addition.provider, cacheOnly.id)).toEqual(cacheOnly);
    expect(runtime.getModel(addition.provider, builtinModel.id)?.contextWindow).toBe(corrected.contextWindow);
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel(addition.provider, cacheOnly.id)).toEqual(cacheOnly);
    expect(runtime.getModel(addition.provider, builtinModel.id)?.contextWindow).toBe(corrected.contextWindow);
    expect(await store.read(addition.provider)).toEqual(cached([cacheOnly, corrected]));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("tracks cache replacement and deletion, defers cached additions, and rejects old cache", async () => {
    const { InMemoryModelsStore } = await import("@earendil-works/pi-ai");
    const store = new InMemoryModelsStore();
    const runtime = await memoryRuntime(store);
    await applyBundledModelCatalogOverlay(runtime);
    const stock = { ...addition.model, provider: addition.provider };
    const cachedAddition = { ...stock, name: "Cached release", contextWindow: 456 };
    const cacheOnly = { ...stock, id: "cache-only" };
    await store.write(addition.provider, cached([cachedAddition, cacheOnly]));
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel(addition.provider, stock.id)).toEqual(cachedAddition);
    expect(runtime.getModels(addition.provider).filter((model) => model.id === stock.id)).toHaveLength(1);

    const replacement = { ...cachedAddition, name: "Replacement" };
    await store.write(addition.provider, cached([replacement]));
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel(addition.provider, stock.id)).toEqual(replacement);
    expect(runtime.getModel(addition.provider, cacheOnly.id)).toBeUndefined();
    await store.delete(addition.provider);
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel(addition.provider, stock.id)).toEqual(stock);

    for (const lastModified of [undefined, getBuiltinModelDataGeneratedAt()! - 1, getBuiltinModelDataGeneratedAt()]) {
      await store.write(addition.provider, { models: [cachedAddition, cacheOnly], lastModified });
      await runtime.refresh({ allowNetwork: false });
      expect(runtime.getModel(addition.provider, stock.id)).toEqual(stock);
      expect(runtime.getModel(addition.provider, cacheOnly.id)).toBeUndefined();
    }
  });

  it("keeps accepted runtime provider closures isolated from later candidates and their refreshes", async () => {
    const { InMemoryModelsStore } = await import("@earendil-works/pi-ai");
    const stores = [new InMemoryModelsStore(), new InMemoryModelsStore()];
    const cacheOnly = { ...addition.model, provider: addition.provider, id: "cache-only" };
    await stores[0]!.write(addition.provider, cached([{ ...cacheOnly, name: "Candidate A" }]));
    await stores[1]!.write(addition.provider, cached([{ ...cacheOnly, name: "Candidate B" }]));
    const first = await memoryRuntime(stores[0]);
    await applyBundledModelCatalogOverlay(first);
    const acceptedProvider = first.getProvider(addition.provider)!;
    const acceptedModels = structuredClone(acceptedProvider.getModels());
    const second = await memoryRuntime(stores[1]);
    await applyBundledModelCatalogOverlay(second);
    expect(first.getModel(addition.provider, cacheOnly.id)?.name).toBe("Candidate A");
    expect(second.getModel(addition.provider, cacheOnly.id)?.name).toBe("Candidate B");
    await stores[1]!.delete(addition.provider);
    await second.refresh({ allowNetwork: false });
    expect(second.getModel(addition.provider, cacheOnly.id)).toBeUndefined();
    expect(acceptedProvider.getModels()).toEqual(acceptedModels);
    expect(first.getModels(addition.provider)).toEqual(acceptedModels);
    const secondProvider = second.getProvider(addition.provider)!;
    const secondModels = structuredClone(secondProvider.getModels());
    await stores[0]!.write(addition.provider, cached([{ ...cacheOnly, name: "Refreshed A" }]));
    await first.refresh({ allowNetwork: false });
    expect(first.getModel(addition.provider, cacheOnly.id)?.name).toBe("Refreshed A");
    expect(secondProvider.getModels()).toEqual(secondModels);
    expect(second.getModels(addition.provider)).toEqual(secondModels);
  });

  it("suppresses registration refreshes and awaits one refresh even through the real network decorator", async () => {
    const { InMemoryModelsStore } = await import("@earendil-works/pi-ai");
    const store = new InMemoryModelsStore();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const cacheOnly = { ...addition.model, provider: addition.provider, id: "delayed-cache" };
    await store.write(addition.provider, cached([cacheOnly]));
    const read = store.read.bind(store);
    vi.spyOn(store, "read").mockImplementation(async (id, options) => {
      if (id === "anthropic") { entered.resolve(); await gate.promise; }
      return read(id, options);
    });
    const raw = await memoryRuntime(store);
    const unaffected = raw.getProvider("anthropic");
    const refresh = vi.spyOn(raw, "refresh");
    const requests: Array<{ request: Request; proxy?: string }> = [];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      requests.push({ request: new Request(input, init), proxy: (init as RequestInit & { proxy?: string })?.proxy });
      return completionResponse(addition.model.id);
    });
    const router = installNetworkRouter(resolveNetworkPolicy(
      parseNetworkProxySettings({ easyresearch: { network: { llmProxy: "http://llm.invalid:8001" } } }),
      captureInheritedProxyEnvironment({}),
    ));
    const runtime = router.decorateModelRuntime(raw);
    let settled = false;
    const pending = applyBundledModelCatalogOverlay(runtime).then(() => { settled = true; });
    try {
      await entered.promise;
      expect(settled).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
      gate.resolve();
      await pending;
      expect(runtime.getModel(addition.provider, cacheOnly.id)).toEqual(cacheOnly);
      expect(runtime.getProvider("anthropic")).toBe(unaffected);
      await runtime.refresh({ allowNetwork: false });
      expect(refresh).toHaveBeenCalledTimes(2);
      await runtime.setRuntimeApiKey(addition.provider, "synthetic-route-key");
      const result = await runtime.completeSimple(runtime.getModel(addition.provider, addition.model.id)!, {
        messages: [{ role: "user", content: "test", timestamp: 1 }],
      }, { maxRetries: 0 });
      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("stop");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.proxy).toBe("http://llm.invalid:8001");
      expect(requests[0]!.request.url).toBe(`${addition.model.baseUrl}/chat/completions`);
    } finally {
      gate.resolve();
      try { await pending; } finally { router.restore(); }
    }
  });

  it("restores the exact refresh method after synchronous registration failure", async () => {
    const refresh = vi.fn(async () => undefined);
    const failure = new Error("Registration failed");
    const runtime = {
      refresh,
      registerNativeProvider() { void runtime.refresh(); throw failure; },
    };
    await expect(applyBundledModelCatalogOverlay(runtime)).rejects.toBe(failure);
    expect(runtime.refresh).toBe(refresh);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("leaves the target untouched when every provider is excluded or the registry is empty", async () => {
    const runtime = { refresh: vi.fn(async () => undefined), registerNativeProvider: vi.fn() };
    const refresh = runtime.refresh;
    const excluded = new Set([
      ...registry.BUNDLED_MODEL_ADDITIONS, ...registry.BUNDLED_MODEL_UPDATES, ...registry.BUNDLED_MODEL_REMOVALS,
    ].map((entry) => entry.provider));
    await applyBundledModelCatalogOverlay(runtime, excluded);
    expect(runtime.registerNativeProvider).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(runtime.refresh).toBe(refresh);

    vi.spyOn(registry, "BUNDLED_MODEL_ADDITIONS", "get").mockReturnValue([]);
    vi.spyOn(registry, "BUNDLED_MODEL_UPDATES", "get").mockReturnValue([]);
    vi.spyOn(registry, "BUNDLED_MODEL_REMOVALS", "get").mockReturnValue([]);
    await applyBundledModelCatalogOverlay(runtime);
    expect(runtime.registerNativeProvider).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["addition", "update", "removal"])("validates an unknown %s provider before any registration even if excluded", async (kind) => {
    vi.spyOn(registry, "BUNDLED_MODEL_ADDITIONS", "get").mockReturnValue([
      addition, ...(kind === "addition" ? [{ provider: "unknown-provider", model: metadata }] : []),
    ]);
    vi.spyOn(registry, "BUNDLED_MODEL_UPDATES", "get").mockReturnValue(kind === "update" ? [
      { provider: "unknown-provider", id: metadata.id, patch: { name: "Unknown model" } },
    ] : []);
    vi.spyOn(registry, "BUNDLED_MODEL_REMOVALS", "get").mockReturnValue(kind === "removal" ? [
      { provider: "unknown-provider", id: metadata.id },
    ] : []);
    const runtime = { refresh: vi.fn(async () => undefined), registerNativeProvider: vi.fn() };
    await expect(applyBundledModelCatalogOverlay(runtime, new Set(["unknown-provider"])))
      .rejects.toThrow(/unknown provider: unknown-provider/);
    expect(runtime.registerNativeProvider).not.toHaveBeenCalled();
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it("registers a removal-only provider and filters native and cache-only ids through the real runtime", async () => {
    const { InMemoryModelsStore } = await import("@earendil-works/pi-ai");
    const store = new InMemoryModelsStore();
    const native = builtin("anthropic").getModels()[0]!;
    const retiredCacheOnly = { ...native, id: "retired-cache-only" };
    const retained = { ...native, id: "retained-cache-only" };
    const snapshot = cached([native, retiredCacheOnly, retained]);
    await store.write(native.provider, snapshot);
    vi.spyOn(registry, "BUNDLED_MODEL_ADDITIONS", "get").mockReturnValue([]);
    vi.spyOn(registry, "BUNDLED_MODEL_UPDATES", "get").mockReturnValue([]);
    vi.spyOn(registry, "BUNDLED_MODEL_REMOVALS", "get").mockReturnValue([
      { provider: native.provider, id: native.id },
      { provider: native.provider, id: retiredCacheOnly.id },
    ]);
    const runtime = await memoryRuntime(store);
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel(native.provider, retiredCacheOnly.id)).toEqual(retiredCacheOnly);
    const original = runtime.getModels(native.provider);
    const expected = original.filter((model) => model.id !== native.id && model.id !== retiredCacheOnly.id);
    const register = vi.spyOn(runtime, "registerNativeProvider");
    const refresh = vi.spyOn(runtime, "refresh");
    await applyBundledModelCatalogOverlay(runtime);
    expect(register.mock.calls.map(([provider]) => provider.id)).toEqual([native.provider]);
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ allowNetwork: false });
    expect(runtime.getModel(native.provider, native.id)).toBeUndefined();
    expect(runtime.getModel(native.provider, retiredCacheOnly.id)).toBeUndefined();
    expect(runtime.getModel(native.provider, retained.id)).toEqual(retained);
    expect(runtime.getModels(native.provider)).toEqual(expected);
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModels(native.provider)).toEqual(expected);
    expect(await store.read(native.provider)).toEqual(snapshot);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not read donor disk config, credentials or cache, and never refreshes the donor", async () => {
    const runtime = await memoryRuntime();
    const { ModelRuntime } = await importPi();
    const create = ModelRuntime.create.bind(ModelRuntime);
    const donorRefreshes: ReturnType<typeof vi.spyOn>[] = [];
    const createDonor = vi.spyOn(ModelRuntime, "create").mockImplementation(async (options) => {
      const donor = await create(options);
      donorRefreshes.push(vi.spyOn(donor, "refresh"));
      return donor;
    });
    const files = readdirSync(agentDir);
    await applyBundledModelCatalogOverlay(runtime);
    const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    expect(createDonor).toHaveBeenCalledWith({
      modelsPath: null, credentials: expect.any(InMemoryCredentialStore), refreshOnCreate: false,
    });
    expect(donorRefreshes).toHaveLength(1);
    expect(donorRefreshes[0]).not.toHaveBeenCalled();
    expect(readdirSync(agentDir)).toEqual(files);
    expect(runtime.getModel(addition.provider, addition.model.id)).toBeDefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps user upserts and modelOverrides above fresh native bases without freezing prior config", async () => {
    const modelsPath = join(agentDir, "models.json");
    const baseline = await memoryRuntime();
    await applyBundledModelCatalogOverlay(baseline);
    const native = baseline.getModel(addition.provider, "deepseek-v4-pro")!;
    const userRetired = { ...addition.model, id: "deepseek-v4-flash", name: "Explicit user upsert" };
    const config = {
      providers: { [addition.provider]: {
        models: [
          { id: addition.model.id, name: "User upsert", contextWindow: 123, maxTokens: 321 },
          userRetired,
        ],
        modelOverrides: { [addition.model.id]: { name: "User override" }, [native.id]: { name: "Native override" } },
      } },
    };
    writeFileSync(modelsPath, JSON.stringify(config));
    const before = readFileSync(modelsPath);
    const runtime = await memoryRuntime(undefined, modelsPath);
    await applyBundledModelCatalogOverlay(runtime);
    expect(runtime.getModel(addition.provider, addition.model.id)).toMatchObject({
      name: "User override", contextWindow: 123, maxTokens: 321,
    });
    expect(runtime.getModel(addition.provider, native.id)?.name).toBe("Native override");
    expect(runtime.getModel(addition.provider, userRetired.id)).toEqual({ ...userRetired, provider: addition.provider });
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel(addition.provider, userRetired.id)).toEqual({ ...userRetired, provider: addition.provider });
    expect(readFileSync(modelsPath)).toEqual(before);

    writeFileSync(modelsPath, '{"providers":{}}');
    await applyBundledModelCatalogOverlay(runtime);
    expect(runtime.getModel(addition.provider, addition.model.id)).toEqual({ ...addition.model, provider: addition.provider });
    expect(runtime.getModel(addition.provider, native.id)).toEqual(native);
    expect(runtime.getModel(addition.provider, userRetired.id)).toBeUndefined();
  });

  it("groups multiple providers and applies explicit patches below user overrides in one refresh", async () => {
    const native = builtin(addition.provider).getModels()[0]!;
    const otherAddition = { provider: "openai", model: { ...metadata, api: "openai-responses" } };
    const removed = builtin("anthropic").getModels()[0]!;
    vi.spyOn(registry, "BUNDLED_MODEL_ADDITIONS", "get").mockReturnValue([
      addition, otherAddition, { provider: addition.provider, model: metadata },
    ]);
    vi.spyOn(registry, "BUNDLED_MODEL_UPDATES", "get").mockReturnValue([{
      provider: addition.provider, id: native.id, patch: { name: "Bundled correction", contextWindow: 456 },
    }]);
    vi.spyOn(registry, "BUNDLED_MODEL_REMOVALS", "get").mockReturnValue([
      { provider: removed.provider, id: removed.id },
    ]);
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { [addition.provider]: {
      modelOverrides: { [native.id]: { contextWindow: 789 } },
    } } }));
    const runtime = await memoryRuntime(undefined, modelsPath);
    const refresh = vi.spyOn(runtime, "refresh");
    const register = vi.spyOn(runtime, "registerNativeProvider");
    await applyBundledModelCatalogOverlay(runtime);

    expect(register.mock.calls.map(([provider]) => provider.id).sort())
      .toEqual([addition.provider, otherAddition.provider, removed.provider].sort());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(runtime.getModel(addition.provider, native.id)).toMatchObject({
      name: "Bundled correction", contextWindow: 789, maxTokens: native.maxTokens,
    });
    expect(runtime.getModel(addition.provider, metadata.id)).toEqual({ ...metadata, provider: addition.provider });
    expect(runtime.getModel(otherAddition.provider, metadata.id)).toEqual({ ...otherAddition.model, provider: otherAddition.provider });
    expect(runtime.getModel(removed.provider, removed.id)).toBeUndefined();
  });

  it("keeps missing credentials unavailable and runtime keys transient without changing files", async () => {
    const { ModelRuntime } = await importPi();
    const authPath = join(agentDir, "auth.json");
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(authPath, '{"unrelated":{"type":"api_key","key":"synthetic-existing"}}\n');
    writeFileSync(modelsPath, '{"providers":{}}\n');
    const authBefore = readFileSync(authPath);
    const modelsBefore = readFileSync(modelsPath);
    const runtime = await ModelRuntime.create({ authPath, modelsPath, refreshOnCreate: false });
    await applyBundledModelCatalogOverlay(runtime);
    const model = runtime.getModel(addition.provider, addition.model.id)!;
    expect(model).toBeDefined();
    expect(runtime.getAvailableSnapshot()).not.toContainEqual(model);
    expect(await runtime.getAuth(model)).toBeUndefined();
    await runtime.setRuntimeApiKey(addition.provider, "synthetic-runtime-key");
    expect(runtime.getAvailableSnapshot()).toContainEqual(model);
    expect(await runtime.getAuth(model)).toMatchObject({ auth: { apiKey: "synthetic-runtime-key" } });
    await runtime.removeRuntimeApiKey(addition.provider);
    expect(runtime.getAvailableSnapshot()).not.toContainEqual(model);
    expect(readFileSync(authPath)).toEqual(authBefore);
    expect(readFileSync(modelsPath)).toEqual(modelsBefore);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
