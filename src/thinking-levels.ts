/** Mirrors the pinned Pi @earendil-works/pi-ai extended thinking level list. */
export const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const THINKING_LEVELS: readonly string[] = EXTENDED_THINKING_LEVELS;

export function isThinkingLevel(value: unknown): value is (typeof EXTENDED_THINKING_LEVELS)[number] {
  return typeof value === "string" && (EXTENDED_THINKING_LEVELS as readonly string[]).includes(value);
}

export interface ThinkingAwareModel {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>> | null | undefined;
}

/**
 * Mirrors getSupportedThinkingLevels from the pinned Pi @earendil-works/pi-ai:
 * non-reasoning models (or unknown models) only offer "off"; reasoning models
 * offer the extended levels minus any explicitly nulled map entries, where
 * "xhigh" and "max" are offered only when explicitly mapped to a non-null value.
 */
export function getSupportedThinkingLevels(model?: ThinkingAwareModel | null): readonly string[] {
  if (!model?.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}