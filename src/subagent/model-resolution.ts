import type { AgentConfig } from "./agents";

export function resolveConfiguredModel(
  agent: Pick<AgentConfig, "model">,
  paperAssistantModel: string | undefined,
): string | undefined {
  return agent.model ?? paperAssistantModel;
}
