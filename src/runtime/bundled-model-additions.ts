import type { Api, Model } from "@earendil-works/pi-ai";

export type BundledModelMetadata = Omit<Model<Api>, "provider">;

export interface BundledModelAddition {
  provider: string;
  model: BundledModelMetadata;
}

export interface BundledModelUpdate {
  provider: string;
  id: string;
  patch: Partial<Omit<BundledModelMetadata, "id">>;
}

export interface BundledModelRemoval {
  provider: string;
  id: string;
}

// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// Expose canonical efforts rather than their duplicate API aliases.
const deepseekThinkingLevelMap: BundledModelMetadata["thinkingLevelMap"] = {
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  max: "max",
};

// Pi now supplies deepseek-flash and GPT-6.2 through its native catalog.
export const BUNDLED_MODEL_ADDITIONS: readonly BundledModelAddition[] = [];

export const BUNDLED_MODEL_UPDATES: readonly BundledModelUpdate[] = [
  {
    provider: "deepseek",
    id: "deepseek-v4-pro",
    patch: {
      name: "DeepSeek V4 Pro 0813",
      thinkingLevelMap: deepseekThinkingLevelMap,
      cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
    },
  },
];

export const BUNDLED_MODEL_REMOVALS: readonly BundledModelRemoval[] = [
  { provider: "deepseek", id: "deepseek-v4-flash" },
  { provider: "deepseek", id: "deepseek-v4-flash-vision-exp" },
];
