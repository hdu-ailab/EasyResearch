export const DEFAULT_COMPACTION_TRIGGER_PERCENT = 70;
export const MIN_COMPACTION_TRIGGER_PERCENT = 10;
export const MAX_COMPACTION_TRIGGER_PERCENT = 90;
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000;

export interface GlobalCompactionPolicy {
  triggerPercent: number;
  globalEnabled: boolean;
  globalKeepRecentTokens: number;
}

export const DEFAULT_GLOBAL_COMPACTION_POLICY: GlobalCompactionPolicy = {
  triggerPercent: DEFAULT_COMPACTION_TRIGGER_PERCENT,
  globalEnabled: true,
  globalKeepRecentTokens: DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
};

export interface DerivedCompactionSettings {
  triggerTokens: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface EffectiveCompactionPolicy {
  triggerPercent: number;
  enabled: boolean;
}

export interface CompactionPolicySettingsManager {
  getCompactionSettings(): {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
  applyOverrides(overrides: {
    compaction: {
      enabled: boolean;
      reserveTokens: number;
      keepRecentTokens: number;
    };
  }): void;
}

export interface CompactionPolicyBinding {
  apply(
    policy: GlobalCompactionPolicy,
    model: { contextWindow: number } | undefined,
    options?: { recaptureBase?: boolean },
  ): EffectiveCompactionPolicy;
  current(): EffectiveCompactionPolicy;
}

export class CompactionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionPolicyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidCompactionTriggerPercent(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= MIN_COMPACTION_TRIGGER_PERCENT
    && value <= MAX_COMPACTION_TRIGGER_PERCENT;
}

export function normalizeKeepRecentTokens(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_COMPACTION_KEEP_RECENT_TOKENS;
}

export function parseGlobalCompactionPolicy(settings: unknown): GlobalCompactionPolicy {
  if (!isRecord(settings)) throw new CompactionPolicyError("Global settings must contain an object");

  const rawEasyResearch = settings.easyresearch;
  if (rawEasyResearch !== undefined && !isRecord(rawEasyResearch)) {
    throw new CompactionPolicyError("easyresearch settings must contain an object");
  }
  const easyresearch = rawEasyResearch as Record<string, unknown> | undefined;
  const rawProductCompaction = easyresearch?.compaction;
  if (rawProductCompaction !== undefined && !isRecord(rawProductCompaction)) {
    throw new CompactionPolicyError("easyresearch.compaction must contain an object");
  }
  const productCompaction = rawProductCompaction as Record<string, unknown> | undefined;
  const configuredPercent = productCompaction?.triggerPercent;
  if (configuredPercent !== undefined && !isValidCompactionTriggerPercent(configuredPercent)) {
    throw new CompactionPolicyError("triggerPercent must be an integer from 10 through 90");
  }

  const nativeCompaction = isRecord(settings.compaction) ? settings.compaction : undefined;
  return {
    triggerPercent: configuredPercent ?? DEFAULT_GLOBAL_COMPACTION_POLICY.triggerPercent,
    globalEnabled: nativeCompaction?.enabled !== false,
    globalKeepRecentTokens: normalizeKeepRecentTokens(nativeCompaction?.keepRecentTokens),
  };
}

export function deriveCompactionSettings(
  contextWindow: number,
  triggerPercent: number,
  baseKeepRecentTokens: number,
): DerivedCompactionSettings {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new CompactionPolicyError("Model context window must be a positive integer");
  }
  if (!isValidCompactionTriggerPercent(triggerPercent)) {
    throw new CompactionPolicyError("triggerPercent must be an integer from 10 through 90");
  }

  const triggerTokens = Math.floor((contextWindow * triggerPercent) / 100);
  return {
    triggerTokens,
    reserveTokens: Math.max(1, contextWindow - triggerTokens),
    keepRecentTokens: Math.max(
      1,
      Math.min(normalizeKeepRecentTokens(baseKeepRecentTokens), Math.floor(triggerTokens / 2)),
    ),
  };
}

export function createCompactionPolicyBinding(
  settingsManager: CompactionPolicySettingsManager,
): CompactionPolicyBinding {
  let baseKeepRecentTokens: number | undefined;
  let currentPolicy: EffectiveCompactionPolicy = {
    triggerPercent: DEFAULT_COMPACTION_TRIGGER_PERCENT,
    enabled: settingsManager.getCompactionSettings().enabled !== false,
  };

  return {
    apply(policy, model, options = {}) {
      const currentSettings = settingsManager.getCompactionSettings();
      const enabled = currentSettings.enabled !== false;
      if (options.recaptureBase === true || baseKeepRecentTokens === undefined) {
        baseKeepRecentTokens = normalizeKeepRecentTokens(currentSettings.keepRecentTokens);
      }
      currentPolicy = {
        triggerPercent: policy.triggerPercent,
        enabled,
      };
      if (!model || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
        return { ...currentPolicy };
      }

      const derived = deriveCompactionSettings(
        model.contextWindow,
        policy.triggerPercent,
        baseKeepRecentTokens,
      );
      settingsManager.applyOverrides({
        compaction: {
          enabled,
          reserveTokens: derived.reserveTokens,
          keepRecentTokens: derived.keepRecentTokens,
        },
      });
      return { ...currentPolicy };
    },
    current() {
      return { ...currentPolicy };
    },
  };
}
