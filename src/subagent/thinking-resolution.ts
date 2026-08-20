import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  EXTENDED_THINKING_LEVELS,
  getSupportedThinkingLevels,
  isThinkingLevel,
  type ThinkingAwareModel,
} from "../thinking-levels";
import type { AgentConfig } from "./agents";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "max";

export function resolveConfiguredThinking(
  agent: Pick<AgentConfig, "thinking">,
  inherited: ThinkingLevel | undefined = undefined,
  model: ThinkingAwareModel | undefined = undefined,
): ThinkingLevel {
  const requested = isThinkingLevel(agent.thinking)
    ? agent.thinking
    : isThinkingLevel(inherited)
      ? inherited
      : DEFAULT_THINKING_LEVEL;
  if (!model) return requested;
  const supported = new Set(getSupportedThinkingLevels(model));
  for (let index = EXTENDED_THINKING_LEVELS.indexOf(requested); index >= 0; index -= 1) {
    const candidate = EXTENDED_THINKING_LEVELS[index]!;
    if (supported.has(candidate)) return candidate;
  }
  return "off";
}
