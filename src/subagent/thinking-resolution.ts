import { getAgentDir } from "../runtime/pi-import";
import { discoverAgents } from "./agents";

export const AGENT_THINKING_ENTRY = "easyresearch:agent_thinking";

export const DEFAULT_THINKING_LEVEL = "off";

export interface ThinkingResolution {
  thinking: string;
  source: "override" | "default" | "inherit";
}

/**
 * Effective thinking level for an agent: a session override wins, then the
 * agent's Markdown frontmatter default (project over global), then the Paper
 * Assistant's live level, then off.
 */
export function resolveEffectiveThinking(
  override: string | null | undefined,
  projectDefaults: Record<string, string> | undefined,
  globalDefaults: Record<string, string> | undefined,
  paperAssistantThinking: string | undefined,
  agentName: string,
): ThinkingResolution | null {
  if (typeof override === "string") return { thinking: override, source: "override" };
  const project = projectDefaults?.[agentName];
  if (project) return { thinking: project, source: "default" };
  const global = globalDefaults?.[agentName];
  if (global) return { thinking: global, source: "default" };
  if (paperAssistantThinking) return { thinking: paperAssistantThinking, source: "inherit" };
  return null;
}

export async function extractAgentThinking(
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
  const levels = Object.fromEntries(agents.flatMap((agent) => (agent.thinking ? [[agent.name, agent.thinking]] : [])));
  return Object.keys(levels).length > 0 ? levels : undefined;
}

export async function resolveThinkingForSpawn(
  ctx: {
    cwd: string;
    sessionManager: { getEntries(): Array<{ type: string; customType?: string; data?: unknown }> };
  },
  agentName: string,
  paperAssistantThinking: string | undefined,
): Promise<string> {
  let override: string | null | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom" || entry.customType !== AGENT_THINKING_ENTRY) continue;
    const data = entry.data as { agent?: unknown; thinking?: unknown } | undefined;
    if (!data || typeof data.agent !== "string" || data.agent !== agentName) continue;
    if (typeof data.thinking !== "string" && data.thinking !== null) continue;
    override = data.thinking;
  }
  const project = await extractAgentThinking(ctx.cwd);
  const global = await extractAgentThinking(ctx.cwd, getAgentDir(), false);
  return (
    resolveEffectiveThinking(override, project, global, paperAssistantThinking, agentName)?.thinking ?? DEFAULT_THINKING_LEVEL
  );
}