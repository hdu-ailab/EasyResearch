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

// https://api-docs.deepseek.com/zh-cn/quick_start/pricing (CNY)
// https://api-docs.deepseek.com/quick_start/pricing (USD)
// Official off-peak USD per 1M tokens; peak rates are twice these references.
const deepseekFlashCost: BundledModelMetadata["cost"] = {
  input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0,
};
// https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
// Expose canonical efforts rather than their duplicate API aliases.
const deepseekThinkingLevelMap: BundledModelMetadata["thinkingLevelMap"] = {
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  max: "max",
};

export const BUNDLED_MODEL_ADDITIONS: readonly BundledModelAddition[] = [
  // Release: https://api-docs.deepseek.com/news/news260910
  {
    provider: "deepseek",
    model: {
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: deepseekThinkingLevelMap,
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      cost: deepseekFlashCost,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
    },
  },
];

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
