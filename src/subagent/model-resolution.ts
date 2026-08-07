import { getAgentDir, importPi } from "../runtime/pi-import";
import { extractRegistryModels, parseAgentRegistry } from "./registry";

export const AGENT_MODEL_ENTRY = "lazyresearch:agent_model";

export interface ModelSource {
  model: string;
  source: "override" | "project" | "global" | "inherit";
}

/**
 * Parse each agent's `model` out of the `lazyresearch.agents` registry. Absent
 * or malformed config means "no config" (undefined); non-string or empty
 * models are skipped.
 */
export function extractAgentModels(settings: unknown): Record<string, string> | undefined {
  return extractRegistryModels(parseAgentRegistry(settings));
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
 * Project/global config models are sourced from settings.json via Pi's
 * SettingsManager; `resolveEffectiveModel` applies the per-agent chain
 * override → project → global → inherit.
 */
export async function resolveModelForSpawn(
  ctx: {
    cwd: string;
    sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
  },
  agentName: string,
  orchestratorModel: string | undefined,
): Promise<string | undefined> {
  let override: string | null | undefined;
  // Nested stage→stage dispatch runs in the stage's own session context, which
  // never carries `lazyresearch:agent_model` entries — session overrides apply
  // only when the orchestrator dispatches directly; config levels always apply.
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== AGENT_MODEL_ENTRY) continue;
    const data = entry.data as { agent?: unknown; model?: unknown } | undefined;
    if (!data || typeof data.agent !== "string" || data.agent !== agentName) continue;
    // A malformed newer entry (non-string, non-null model) is skipped so the
    // last valid entry still wins; a corrupt write must not wipe a working override.
    if (typeof data.model !== "string" && data.model !== null) continue;
    override = data.model;
  }
  const { SettingsManager } = await importPi();
  const manager = SettingsManager.create(ctx.cwd, getAgentDir());
  const project = extractAgentModels(manager.getProjectSettings());
  const global = extractAgentModels(manager.getGlobalSettings());
  const resolved = resolveEffectiveModel(override, project, global, orchestratorModel, agentName);
  return resolved?.model;
}
