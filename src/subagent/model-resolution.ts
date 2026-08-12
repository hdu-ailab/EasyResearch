import { getAgentDir, importPi } from "../runtime/pi-import";
import { discoverAgents } from "./agents";

export const AGENT_MODEL_ENTRY = "easyresearch:agent_model";

export interface ModelSource {
  model: string;
  source: "override" | "project" | "global" | "inherit";
}

export function resolveEffectiveModel(
  override: string | null | undefined,
  projectAgentModels: Record<string, string> | undefined,
  globalAgentModels: Record<string, string> | undefined,
  assistantModel: string | undefined,
  agentName: string,
): ModelSource | null {
  if (typeof override === "string") return { model: override, source: "override" };
  const project = projectAgentModels?.[agentName];
  if (project) return { model: project, source: "project" };
  const global = globalAgentModels?.[agentName];
  if (global) return { model: global, source: "global" };
  if (assistantModel) return { model: assistantModel, source: "inherit" };
  return null;
}

export async function extractAgentModels(
  cwd: string,
  agentDir = getAgentDir(),
  includeProject = true,
  layer: "effective" | "project" | "global" = "effective",
): Promise<Record<string, string> | undefined> {
  const { agents } = await discoverAgents({
    cwd,
    agentDir,
    includeProject: layer === "global" ? false : includeProject,
    includeGlobal: layer === "project" ? false : true,
    includeBundled: layer === "project" || layer === "global" ? false : true,
  });
  const models = Object.fromEntries(agents.flatMap((agent) => (agent.model ? [[agent.name, agent.model]] : [])));
  return Object.keys(models).length > 0 ? models : undefined;
}

export async function resolveModelForSpawn(
  ctx: {
    cwd: string;
    sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
  },
  agentName: string,
  assistantModel: string | undefined,
): Promise<string | undefined> {
  let override: string | null | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== AGENT_MODEL_ENTRY) continue;
    const data = entry.data as { agent?: unknown; model?: unknown } | undefined;
    if (!data || typeof data.agent !== "string" || data.agent !== agentName) continue;
    if (typeof data.model !== "string" && data.model !== null) continue;
    override = data.model;
  }
  const project = await extractAgentModels(ctx.cwd);
  const global = await extractAgentModels(ctx.cwd, getAgentDir(), false);
  return resolveEffectiveModel(override, project, global, assistantModel, agentName)?.model;
}
