export const AGENT_MODEL_ENTRY = "lazyresearch:agent_model";

export interface ModelSource {
  model: string;
  source: "override" | "project" | "global" | "inherit";
}

export function resolveEffectiveModel(
  override: string | null | undefined,
  projectAgentModels: Record<string, string> | undefined,
  globalAgentModels: Record<string, string> | undefined,
  orchestratorModel: string | undefined,
  agentName: string,
): ModelSource | null {
  if (typeof override === "string") return { model: override, source: "override" };
  const project = projectAgentModels?.[agentName];
  if (project) return { model: project, source: "project" };
  const global = globalAgentModels?.[agentName];
  if (global) return { model: global, source: "global" };
  if (orchestratorModel) return { model: orchestratorModel, source: "inherit" };
  return null;
}

/**
 * Resolve the model a subagent should be spawned with. Session overrides are
 * `lazyresearch:agent_model` custom entries on the orchestrator session line;
 * the latest entry per agent wins, and `model: null` is a reset marker.
 * Project/global config models are not yet sourced (wired in a later task).
 */
export async function resolveModelForSpawn(
  ctx: { sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> } },
  agentName: string,
  orchestratorModel: string | undefined,
): Promise<string | undefined> {
  let override: string | null | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== AGENT_MODEL_ENTRY) continue;
    const data = entry.data as { agent?: unknown; model?: unknown } | undefined;
    if (!data || typeof data.agent !== "string" || data.agent !== agentName) continue;
    if (typeof data.model !== "string" && data.model !== null) continue;
    override = data.model;
  }
  const resolved = resolveEffectiveModel(override, undefined, undefined, orchestratorModel, agentName);
  return resolved?.model;
}
