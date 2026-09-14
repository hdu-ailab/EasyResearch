import type { Provider } from "@earendil-works/pi-ai";
import { importPi } from "./pi-import";
import {
  BUNDLED_MODEL_ADDITIONS,
  BUNDLED_MODEL_REMOVALS,
  BUNDLED_MODEL_UPDATES,
  type BundledModelAddition,
  type BundledModelRemoval,
  type BundledModelUpdate,
} from "./bundled-model-additions";

export interface BundledOverlayRuntime {
  registerNativeProvider(provider: Provider): void;
  refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
}

export function buildBundledProvider(
  base: Provider,
  additions: readonly BundledModelAddition[] = [],
  updates: readonly BundledModelUpdate[] = [],
  removals: readonly BundledModelRemoval[] = [],
): Provider {
  const providerAdditions = additions.filter((entry) => entry.provider === base.id);
  const providerUpdates = updates.filter((entry) => entry.provider === base.id);
  const removedIds = new Set(removals.filter((entry) => entry.provider === base.id).map((entry) => entry.id));
  if (providerAdditions.length === 0 && providerUpdates.length === 0 && removedIds.size === 0) return base;
  return {
    ...base,
    getModels: () => {
      const models = [...base.getModels()];
      for (const addition of providerAdditions) {
        if (models.some((model) => model.id === addition.model.id)) continue;
        models.push({ ...addition.model, provider: base.id });
      }
      for (const update of providerUpdates) {
        const index = models.findIndex((model) => model.id === update.id);
        if (index >= 0) models[index] = { ...models[index]!, ...update.patch };
      }
      return models.filter((model) => !removedIds.has(model.id));
    },
  };
}

export async function applyBundledModelCatalogOverlay(
  runtime: BundledOverlayRuntime,
  excludedProviders?: ReadonlySet<string>,
): Promise<void> {
  const additionsByProvider = new Map<string, BundledModelAddition[]>();
  for (const addition of BUNDLED_MODEL_ADDITIONS) {
    const list = additionsByProvider.get(addition.provider) ?? [];
    list.push(addition);
    additionsByProvider.set(addition.provider, list);
  }
  const updatesByProvider = new Map<string, BundledModelUpdate[]>();
  for (const update of BUNDLED_MODEL_UPDATES) {
    const list = updatesByProvider.get(update.provider) ?? [];
    list.push(update);
    updatesByProvider.set(update.provider, list);
  }
  const removalsByProvider = new Map<string, BundledModelRemoval[]>();
  for (const removal of BUNDLED_MODEL_REMOVALS) {
    const list = removalsByProvider.get(removal.provider) ?? [];
    list.push(removal);
    removalsByProvider.set(removal.provider, list);
  }
  const providerIds = [...new Set([
    ...additionsByProvider.keys(), ...updatesByProvider.keys(), ...removalsByProvider.keys(),
  ])];
  if (providerIds.length === 0) return;

  const { ModelRuntime } = await importPi();
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  // Fresh, unrefreshed native closures receive only the target's cache/publisher.
  const donor = await ModelRuntime.create({
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
  });
  const providers = providerIds.map((providerId) => {
    const base = donor.getProvider(providerId);
    if (!base) throw new Error(`Bundled model catalog references unknown provider: ${providerId}`);
    return buildBundledProvider(
      base, additionsByProvider.get(providerId), updatesByProvider.get(providerId), removalsByProvider.get(providerId),
    );
  }).filter((provider) => !excludedProviders?.has(provider.id));
  if (providers.length === 0) return;

  const originalRefresh = runtime.refresh;
  // Pi registration starts an unowned refresh; replace it with one awaited pass.
  runtime.refresh = () => Promise.resolve(undefined);
  try {
    for (const provider of providers) runtime.registerNativeProvider(provider);
  } finally {
    runtime.refresh = originalRefresh;
  }
  await runtime.refresh({ allowNetwork: false });
}
