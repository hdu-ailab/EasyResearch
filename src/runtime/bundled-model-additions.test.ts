import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { validateBundledModelRegistry } from "../../scripts/check-model-additions";
import {
  BUNDLED_MODEL_ADDITIONS,
  BUNDLED_MODEL_REMOVALS,
  BUNDLED_MODEL_UPDATES,
  type BundledModelAddition,
  type BundledModelUpdate,
} from "./bundled-model-additions";
import { buildBundledProvider } from "./model-catalog-overlay";

const model: Model<Api> = {
  provider: "synthetic",
  id: "existing",
  name: "Existing model",
  api: "openai-completions",
  baseUrl: "https://provider.invalid",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 8_000,
  maxTokens: 2_000,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
  compat: { openRouterRouting: { order: ["primary", "fallback"] } },
};

const provider: Provider = {
  id: model.provider,
  name: "Synthetic provider",
  auth: {
    apiKey: {
      name: "Unused test auth",
      async resolve() { throw new Error("Validation must not resolve credentials"); },
    },
  },
  getModels: () => [model],
  stream() { throw new Error("Validation must not make model requests"); },
  streamSimple() { throw new Error("Validation must not make model requests"); },
};

const { provider: providerId, ...metadata } = model;
const addition: BundledModelAddition = {
  provider: providerId,
  model: { ...metadata, id: "new-model" },
};
const update: BundledModelUpdate = {
  provider: providerId,
  id: model.id,
  patch: { contextWindow: 16_000 },
};

describe("validateBundledModelRegistry", () => {
  it("does not execute the CLI gate when imported", () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-registry-import-"));
    try {
      const scriptUrl = new URL("../../scripts/check-model-additions.ts", import.meta.url).href;
      const result = spawnSync("bun", ["--eval", `await import(${JSON.stringify(scriptUrl)})`], {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          EASYRESEARCH_CODING_AGENT_DIR: join(root, "agent"),
          PI_OFFLINE: "1",
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts an empty registry", () => {
    expect(validateBundledModelRegistry([], [], [], [])).toEqual([]);
  });

  it("accepts a new id and a meaningful patch to an upstream model", () => {
    expect(validateBundledModelRegistry([provider], [addition], [update])).toEqual([]);
  });

  it("scopes uniqueness to the provider rather than the model id alone", () => {
    const otherProvider: Provider = {
      ...provider,
      id: "other",
      getModels: () => [{ ...model, provider: "other" }],
    };
    expect(validateBundledModelRegistry(
      [provider, otherProvider],
      [addition, { ...addition, provider: otherProvider.id }],
      [update, { ...update, provider: otherProvider.id }],
    )).toEqual([]);
  });

  it("rejects unknown providers for both additions and updates", () => {
    const problems = validateBundledModelRegistry(
      [],
      [addition],
      [update],
    );
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/unknown provider: synthetic\/new-model/),
      expect.stringMatching(/unknown provider: synthetic\/existing/),
    ]));
  });

  it("rejects an update target absent from that provider's upstream catalog", () => {
    const problems = validateBundledModelRegistry(
      [provider],
      [],
      [{ ...update, id: "missing" }],
    );
    expect(problems).toContainEqual(expect.stringMatching(/unknown model.*synthetic\/missing/));
  });

  it("rejects duplicate additions even when their metadata differs", () => {
    const problems = validateBundledModelRegistry([provider], [
      addition,
      { ...addition, model: { ...addition.model, name: "Conflicting addition" } },
    ], []);
    expect(problems).toContainEqual(expect.stringMatching(/duplicate.*synthetic\/new-model/));
  });

  it("rejects duplicate updates even when both context patches are meaningful", () => {
    const problems = validateBundledModelRegistry([provider], [], [
      update,
      { ...update, patch: { contextWindow: 32_000 } },
    ]);
    expect(problems).toContainEqual(expect.stringMatching(/duplicate.*synthetic\/existing/));
  });

  it("rejects keys shared by additions and updates", () => {
    const problems = validateBundledModelRegistry(
      [provider],
      [addition],
      [{ ...update, id: addition.model.id }],
    );
    expect(problems).toContainEqual(expect.stringMatching(/duplicate.*synthetic\/new-model/));
  });

  it("accepts removal-only registries for native and cache-only ids", () => {
    expect(validateBundledModelRegistry([provider], [], [], [
      { provider: providerId, id: model.id },
      { provider: providerId, id: "cache-only" },
    ])).toEqual([]);
  });

  it("rejects an unknown removal provider even when the id is cache-only", () => {
    expect(validateBundledModelRegistry([provider], [], [], [
      { provider: "unknown", id: "cache-only" },
    ])).toContainEqual(expect.stringMatching(/unknown provider: unknown\/cache-only/));
  });

  it("rejects duplicate removal keys", () => {
    const removal = { provider: providerId, id: "cache-only" };
    expect(validateBundledModelRegistry([provider], [], [], [removal, removal]))
      .toContainEqual(expect.stringMatching(/duplicate.*synthetic\/cache-only/));
  });

  it.each([
    { label: "addition", additions: [addition], updates: [], id: addition.model.id },
    { label: "update", additions: [], updates: [update], id: update.id },
  ])("rejects a removal key shared with an $label", ({ additions, updates, id }) => {
    expect(validateBundledModelRegistry([provider], additions, updates, [{ provider: providerId, id }]))
      .toContainEqual(expect.stringContaining(`duplicate removal: ${providerId}/${id}`));
  });

  it("scopes removal conflicts by provider across all three collections", () => {
    const otherProvider: Provider = { ...provider, id: "other", getModels: () => [] };
    expect(validateBundledModelRegistry([provider, otherProvider], [addition], [update], [
      { provider: otherProvider.id, id: addition.model.id },
      { provider: otherProvider.id, id: update.id },
      { provider: otherProvider.id, id: "cache-only" },
      { provider: providerId, id: "cache-only" },
    ])).toEqual([]);
  });

  it("rejects additions already upstream even when the bundled metadata differs", () => {
    const problems = validateBundledModelRegistry(
      [provider],
      [{ ...addition, model: { ...addition.model, id: model.id } }],
      [],
    );
    expect(problems).toContainEqual(expect.stringMatching(/redundant addition.*synthetic\/existing/));
  });

  it.each([
    { label: "empty", patch: {} },
    { label: "scalar", patch: { contextWindow: 8_000 } },
    { label: "equal array", patch: { input: ["text", "image"] } },
  ] satisfies { label: string; patch: BundledModelUpdate["patch"] }[])(
    "rejects a $label no-op patch",
    ({ patch }) => {
      const problems = validateBundledModelRegistry([provider], [], [{ ...update, patch }]);
      expect(problems).toContainEqual(expect.stringMatching(/no-op update.*synthetic\/existing/));
    },
  );

  it("rejects a reordered nested-object no-op patch", () => {
    const patch = { cost: Object.fromEntries(Object.entries(model.cost).reverse()) as Model<Api>["cost"] };
    const problems = validateBundledModelRegistry([provider], [], [{ ...update, patch }]);
    expect(problems).toContainEqual(expect.stringMatching(/no-op update.*synthetic\/existing/));
  });

  it("accepts a patch when any named field changes", () => {
    expect(validateBundledModelRegistry([provider], [], [{
      ...update,
      patch: { name: model.name, cost: { ...model.cost, output: 3 } },
    }])).toEqual([]);
  });

  it("preserves array-order semantics for ordered routing changes", () => {
    expect(validateBundledModelRegistry([provider], [], [{
      ...update,
      patch: { compat: { openRouterRouting: { order: ["fallback", "primary"] } } },
    }])).toEqual([]);
  });

  it("does not retain validation state or mutate supplied metadata", () => {
    const removal = { provider: providerId, id: "cache-only" };
    const before = structuredClone({ model, addition, update, removal });
    validateBundledModelRegistry([provider], [addition, addition], [update, update], [removal, removal]);
    expect(validateBundledModelRegistry([provider], [addition], [update], [removal])).toEqual([]);
    expect({ model, addition, update, removal }).toEqual(before);
  });
});

describe("bundled model additions registry", () => {
  it("contains no stale or conflicting entries against pinned upstream data", async () => {
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    expect(validateBundledModelRegistry(
      builtinProviders(), BUNDLED_MODEL_ADDITIONS, BUNDLED_MODEL_UPDATES, BUNDLED_MODEL_REMOVALS,
    )).toEqual([]);
  });

  it("supplies explicit transport for every bundled addition", () => {
    for (const entry of BUNDLED_MODEL_ADDITIONS) {
      expect(entry.model).toHaveProperty("api", expect.any(String));
      expect(entry.model).toHaveProperty("baseUrl", expect.stringMatching(/^https?:\/\//));
      expect(entry.model).not.toHaveProperty("provider");
    }
  });

  it("preserves shipped registry metadata in the resulting provider models", async () => {
    const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
    for (const base of builtinProviders()) {
      const additions = BUNDLED_MODEL_ADDITIONS.filter((entry) => entry.provider === base.id);
      const updates = BUNDLED_MODEL_UPDATES.filter((entry) => entry.provider === base.id);
      const removals = BUNDLED_MODEL_REMOVALS.filter((entry) => entry.provider === base.id);
      const models = buildBundledProvider(base, additions, updates, removals).getModels();
      for (const entry of additions) {
        expect(models.find((candidate) => candidate.id === entry.model.id)).toMatchObject({
          ...entry.model,
          provider: entry.provider,
        });
      }
      for (const entry of updates) {
        expect(models.find((candidate) => candidate.id === entry.id)).toMatchObject({
          ...entry.patch,
          id: entry.id,
          provider: entry.provider,
        });
      }
      for (const entry of removals) {
        expect(models.some((candidate) => candidate.id === entry.id)).toBe(false);
      }
    }
  });
});
