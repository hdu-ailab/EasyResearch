import type { AgentConfig } from "./agents";

export function resolveConfiguredModel(
  agent: Pick<AgentConfig, "model">,
  researchAssistantModel: string | undefined,
): string | undefined {
  return agent.model ?? researchAssistantModel;
}
