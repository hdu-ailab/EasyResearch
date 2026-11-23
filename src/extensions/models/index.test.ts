import type { AnyModel, Model } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createModelsExtension, createModelsTool, type ModelsCatalog, type ModelsInput } from "./index";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let temporaryHome: string;
beforeAll(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), "easyresearch-models-tool-"));
  vi.stubEnv("HOME", temporaryHome);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(temporaryHome, ".easyresearch", "agent"));
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(temporaryHome, { recursive: true, force: true });
});

function chat(provider: string, id: string, overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    provider, id, name: id, api: "openai-completions", baseUrl: "https://private.example/api",
    headers: { Authorization: "Bearer private-auth-value" },
    input: ["text"], reasoning: true, contextWindow: 32_768, maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function catalog(models: AnyModel[], available = models.map(({ provider, id }) => ({ provider, id }))): ModelsCatalog {
  return {
    getAvailableSnapshot: () => available,
    getModel: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
  };
}

async function discover(models: ModelsCatalog | undefined, input: ModelsInput = {}, provider?: string) {
  const tool = await createModelsTool({ modelRuntime: () => models, model: () => provider ? { provider } : undefined });
  return tool.execute("discover", input, undefined, undefined, {} as never);
}

describe("models discovery", () => {
  it("projects only available chat models and excludes missing and non-chat entries without exposing credentials", async () => {
    const ready = chat("test", "ready", { name: "Available chat" });
    const unavailable = chat("test", "unavailable");
    const image: AnyModel = {
      ...chat("test", "image"), type: "image", api: "openai-images", output: ["image"],
    } as AnyModel;
    const classifier: AnyModel = {
      ...chat("test", "classifier"), type: "classifier", api: "typesafe-system-one",
    } as AnyModel;
    const runtime = catalog([ready, unavailable, image, classifier], [ready, image, classifier, { provider: "test", id: "missing" }]);

    const result = await discover(runtime);

    expect(result.details.models.map((model) => model.id)).toEqual(["test/ready"]);
    expect(result.details.models[0]).toMatchObject({ provider: "test", modelID: "ready", name: "Available chat" });
    expect(result.details.total).toBe(1);
    expect(result.details.next).toBeNull();
    const text = result.content.find((part) => part.type === "text");
    expect(JSON.parse(text!.text)).toEqual(result.details);
    expect(JSON.stringify(result)).not.toMatch(/private\.example|private-auth-value|Authorization|baseUrl|headers/);
  });

  it("prefers the current root provider without hiding other providers and preserves exact model references", async () => {
    const result = await discover(catalog([
      chat("alpha", "Model/A"), chat("zeta", "other"), chat("zeta", "Model/A"),
    ]), {}, "zeta");

    expect(result.details.models.map((model) => model.id)).toEqual(["zeta/Model/A", "zeta/other", "alpha/Model/A"]);
    expect(result.details.total).toBe(3);
  });

  it("respects explicit case-insensitive provider filters and combines them with model-name or ID queries", async () => {
    const runtime = catalog([
      chat("alpha", "model-A", { name: "Useful Writer" }), chat("alpha", "model-B"),
      chat("zeta", "model-A", { name: "Useful Writer" }),
    ]);

    const byName = await discover(runtime, { provider: " ALPHA ", query: "wRiTeR" }, "zeta");
    const byID = await discover(runtime, { provider: "alpha", query: "MODEL-b" }, "zeta");
    const absent = await discover(runtime, { provider: "unknown" }, "zeta");

    expect(byName.details.models.map((model) => model.id)).toEqual(["alpha/model-A"]);
    expect(byID.details.models.map((model) => model.id)).toEqual(["alpha/model-B"]);
    expect(absent.details).toEqual({ models: [], total: 0, next: null });
  });

  it("paginates the filtered stable ordering without duplicate snapshot rows or hidden last-page results", async () => {
    const a = chat("alpha", "a");
    const runtime = catalog([a, chat("alpha", "b"), chat("alpha", "c"), chat("zeta", "d")], [
      { provider: "zeta", id: "d" }, { provider: "alpha", id: "c" }, a, a, { provider: "alpha", id: "b" },
    ]);
    const first = await discover(runtime, { provider: "alpha", limit: 2 });
    const second = await discover(runtime, { provider: "alpha", limit: 2, offset: first.details.next! });
    const beyond = await discover(runtime, { provider: "alpha", offset: 99 });

    expect(first.details.models.map((model) => model.id)).toEqual(["alpha/a", "alpha/b"]);
    expect(first.details.next).toBe(2);
    expect(second.details.models.map((model) => model.id)).toEqual(["alpha/c"]);
    expect(second.details.next).toBeNull();
    expect(second.details.total).toBe(first.details.total);
    expect(beyond.details).toEqual({ models: [], total: 3, next: null });
  });

  it("returns only native supported thinking variants rather than raw provider mapping values", async () => {
    const models = [
      chat("test", "plain", { reasoning: false, thinkingLevelMap: { max: "vendor-max" } }),
      chat("test", "reasoning"),
      chat("test", "limited", { thinkingLevelMap: {
        off: null, minimal: null, low: null, medium: null, high: "vendor-high", xhigh: null, max: "vendor-max",
      } }),
    ];
    const result = await discover(catalog(models));

    const variants = Object.fromEntries(result.details.models.map((model) => [model.modelID, model.variants]));
    expect(variants.plain).toEqual(["off"]);
    expect(variants.reasoning).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(variants.limited).toEqual(["high", "max"]);
    expect(JSON.stringify(result)).not.toContain("vendor-");
    const { clampThinkingLevel } = await import("@earendil-works/pi-ai");
    for (const entry of result.details.models) {
      const model = models.find((candidate) => candidate.id === entry.modelID)!;
      for (const variant of entry.variants) expect(clampThinkingLevel(model, variant)).toBe(variant);
    }
  });

  it("reads the accepted runtime and preferred provider at invocation time instead of capturing an old catalog", async () => {
    let runtime = catalog([chat("old", "a")]);
    let provider = "old";
    const tool = await createModelsTool({ modelRuntime: () => runtime, model: () => ({ provider }) });
    const first = await tool.execute("first", {}, undefined, undefined, {} as never);
    runtime = catalog([chat("alpha", "b"), chat("new", "c")]);
    provider = "new";
    const second = await tool.execute("second", {}, undefined, undefined, {} as never);

    expect(first.details.models.map((model) => model.id)).toEqual(["old/a"]);
    expect(second.details.models.map((model) => model.id)).toEqual(["new/c", "alpha/b"]);
  });

  it("distinguishes an empty accepted catalog from an unavailable runtime without leaking underlying errors", async () => {
    expect((await discover(catalog([]))).details).toEqual({ models: [], total: 0, next: null });
    await expect(discover(undefined)).rejects.toThrow("Model catalog is unavailable.");
    const tool = await createModelsTool({
      modelRuntime: () => { throw new Error("https://private.example/?token=secret"); }, model: () => undefined,
    });
    await expect(tool.execute("failed", {}, undefined, undefined, {} as never)).rejects.toThrow(/^Model catalog is unavailable\.$/);
  });

  it("bounds result pages and long display names without truncating usable IDs", async () => {
    const runtime = catalog(Array.from({ length: 250 }, (_, index) =>
      chat("test", `model-${String(index).padStart(3, "0")}`, { name: "long ".repeat(10_000) }),
    ));
    const result = await discover(runtime, { limit: 100 });

    expect(result.details.models.length).toBeGreaterThan(0);
    expect(result.details.models.length).toBeLessThanOrEqual(100);
    expect(result.details.models[0]!.id).toBe("test/model-000");
    expect(result.details.next).toBe(result.details.models.length);
    expect(result.details.total).toBe(250);
    const text = result.content.find((part) => part.type === "text");
    expect(Buffer.byteLength(text!.text)).toBeLessThanOrEqual(32_768);
    expect(result.details.models[0]!.name.length).toBeLessThan(1_000);
    const next = await discover(runtime, { limit: 100, offset: result.details.next! });
    expect(next.details.models[0]!.id).toBe(`test/model-${String(result.details.models.length).padStart(3, "0")}`);
  });

  it("registers a usable tool through the inline factory without reading the catalog until execution", async () => {
    let runtime: ModelsCatalog | undefined;
    let tool: Awaited<ReturnType<typeof createModelsTool>> | undefined;
    const extension = createModelsExtension({ modelRuntime: () => runtime, model: () => undefined });
    await extension({ registerTool: (registered: typeof tool) => { tool = registered; } } as unknown as ExtensionAPI);
    runtime = catalog([chat("test", "fresh")]);
    const result = await tool!.execute("factory", {}, undefined, undefined, {} as never);
    expect(result.details.models.map((model) => model.id)).toEqual(["test/fresh"]);
  });

  it("honors an explicit provider even when the default root provider cannot be read", async () => {
    const tool = await createModelsTool({
      modelRuntime: () => catalog([chat("test", "a")]),
      model: () => { throw new Error("Root runtime not available"); },
    });
    const result = await tool.execute("explicit", { provider: "test" }, undefined, undefined, {} as never);
    expect(result.details.models.map((model) => model.id)).toEqual(["test/a"]);
  });

  it("rejects an unrepresentably large model reference instead of emitting a truncated dispatch ID", async () => {
    await expect(discover(catalog([chat("test", "x".repeat(40_000))]))).rejects.toThrow(/reference.*output limit/i);
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: 0.5 }])(
    "rejects invalid pagination rather than letting it bypass output limits: %j", async (input) => {
      await expect(discover(catalog([chat("test", "a")]), input)).rejects.toThrow(/limit|offset/i);
    },
  );
});
