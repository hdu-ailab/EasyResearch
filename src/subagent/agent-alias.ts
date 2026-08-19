export const AGENT_ALIAS_ENTRY = "easyresearch:subagent_session_alias";

export interface SubagentAlias {
  /** `<agent>_<seq>` id, unique within one main (coordinator) session. */
  id: string;
  agent: string;
  sessionId: string;
  sessionPath: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** ADR-084: id-shaped `session` values (e.g. `search_0`) that alias a child
 * session within this main session. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+\d+$/;

export function isAgentId(value: string): boolean {
  return AGENT_ID_PATTERN.test(value.trim());
}

export function formatAgentId(agent: string, index: number): string {
  return `${agent}_${index}`;
}

/** Latest entry per id, in append order, from the coordinator session's custom
 * `easyresearch:subagent_session_alias` entries (ADR-084). */
export function readAgentAliases(entries: readonly unknown[]): SubagentAlias[] {
  const byId = new Map<string, SubagentAlias>();
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== "custom" || entry.customType !== AGENT_ALIAS_ENTRY) continue;
    const data = entry.data;
    if (!isObject(data)) continue;
    const { id, agent, sessionId, sessionPath } = data;
    if (!isNonEmptyString(id) || !isNonEmptyString(agent) || !isNonEmptyString(sessionId) || !isNonEmptyString(sessionPath)) {
      continue;
    }
    byId.set(id, { id, agent, sessionId, sessionPath });
  }
  return [...byId.values()];
}

export function resolveAgentAlias(aliases: readonly SubagentAlias[], id: string): SubagentAlias | undefined {
  return aliases.find((alias) => alias.id === id);
}

/** Sequence index for the next fresh dispatch of `agent` within this main
 * session; equal to the number of persisted aliases for that agent. */
export function nextAgentIndex(aliases: readonly SubagentAlias[], agent: string): number {
  return aliases.reduce((count, alias) => (alias.agent === agent ? count + 1 : count), 0);
}
