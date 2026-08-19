export const SUBAGENT_SESSION_PREFIX = "easyresearch:";
export const SUBAGENT_SESSION_LINK_ENTRY = "easyresearch:subagent_session";
const LEGACY_SUBAGENT_SESSION_PREFIX = "lazyresearch:";

export interface SubagentSessionLink {
  toolCallId: string;
  childSessionId: string;
  agent: string;
  ownerSessionId?: string;
  launchId?: string;
  agentId?: string;
  step?: number;
}

export function sessionNameFor(agentName: string): string {
  return `${SUBAGENT_SESSION_PREFIX}${agentName}`;
}

export function isSubagentSessionName(name: string | undefined): boolean {
  return typeof name === "string"
    && (name.startsWith(SUBAGENT_SESSION_PREFIX) || name.startsWith(LEGACY_SUBAGENT_SESSION_PREFIX));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function readSubagentSessionLinks(entries: readonly unknown[]): SubagentSessionLink[] {
  const links = new Map<string, SubagentSessionLink>();
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== "custom" || entry.customType !== SUBAGENT_SESSION_LINK_ENTRY) continue;
    const data = entry.data;
    if (!isObject(data)) continue;
    const { toolCallId, childSessionId, agent, ownerSessionId, launchId, agentId, step } = data;
    if (!isNonEmptyString(toolCallId) || !isNonEmptyString(childSessionId) || !isNonEmptyString(agent)) continue;
    if (ownerSessionId !== undefined && !isNonEmptyString(ownerSessionId)) continue;
    if (launchId !== undefined && !isNonEmptyString(launchId)) continue;
    if (agentId !== undefined && !isNonEmptyString(agentId)) continue;
    if (step !== undefined && (typeof step !== "number" || !Number.isFinite(step) || !Number.isInteger(step) || step <= 0)) continue;

    const legacyKey = `${toolCallId}:${step ?? "single"}`;
    const key = launchId === undefined ? legacyKey : `launch:${launchId}`;
    links.delete(key);
    links.set(key, {
      toolCallId,
      childSessionId,
      agent,
      ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
      ...(launchId === undefined ? {} : { launchId }),
      ...(agentId === undefined ? {} : { agentId }),
      ...(step === undefined ? {} : { step }),
    });
  }
  return [...links.values()];
}
