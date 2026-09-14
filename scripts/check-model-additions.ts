import { isDeepStrictEqual } from "node:util";
import type { Provider } from "@earendil-works/pi-ai";
import {
  BUNDLED_MODEL_ADDITIONS,
  BUNDLED_MODEL_REMOVALS,
  BUNDLED_MODEL_UPDATES,
  type BundledModelAddition,
  type BundledModelRemoval,
  type BundledModelUpdate,
} from "../src/runtime/bundled-model-additions";

export function validateBundledModelRegistry(
  providers: readonly Provider[],
  additions: readonly BundledModelAddition[],
  updates: readonly BundledModelUpdate[],
  removals: readonly BundledModelRemoval[] = [],
): string[] {
  const bases = new Map(providers.map((provider) => [provider.id, provider]));
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const entry of additions) {
    const key = `${entry.provider}/${entry.model.id}`;
    if (seen.has(key)) problems.push(`duplicate addition: ${key}`);
    seen.add(key);
    const base = bases.get(entry.provider);
    if (!base) {
      problems.push(`unknown provider: ${key}`);
      continue;
    }
    if (base.getModels().some((model) => model.id === entry.model.id)) {
      problems.push(`redundant addition (already in pinned Pi catalog): ${key}`);
    }
  }

  for (const entry of updates) {
    const key = `${entry.provider}/${entry.id}`;
    if (seen.has(key)) problems.push(`duplicate update: ${key}`);
    seen.add(key);
    const base = bases.get(entry.provider);
    const model = base?.getModels().find((candidate) => candidate.id === entry.id);
    if (!base) {
      problems.push(`unknown provider: ${key}`);
      continue;
    }
    if (!model) {
      problems.push(`unknown model for update: ${key}`);
      continue;
    }
    const equal = Object.entries(entry.patch).every(([field, value]) =>
      isDeepStrictEqual(model[field as keyof typeof model], value),
    );
    if (equal) problems.push(`no-op update (already equal upstream): ${key}`);
  }

  for (const entry of removals) {
    const key = `${entry.provider}/${entry.id}`;
    if (seen.has(key)) problems.push(`duplicate removal: ${key}`);
    seen.add(key);
    if (!bases.has(entry.provider)) problems.push(`unknown provider: ${key}`);
  }

  return problems;
}

if (import.meta.main) {
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const problems = validateBundledModelRegistry(
    builtinProviders(), BUNDLED_MODEL_ADDITIONS, BUNDLED_MODEL_UPDATES, BUNDLED_MODEL_REMOVALS,
  );
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(
    `bundled model registry ok: ${BUNDLED_MODEL_ADDITIONS.length} additions, ${BUNDLED_MODEL_UPDATES.length} updates, ${BUNDLED_MODEL_REMOVALS.length} removals`,
  );
}
