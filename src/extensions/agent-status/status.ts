export const AGENT_STATUS_TYPE = "easyresearch:agent_status";
export const SUBAGENT_COMPLETED_TYPE = "easyresearch:subagent_completed";
export const SUBAGENT_ERRORED_TYPE = "easyresearch:subagent_errored";

export interface SubagentStatusItem {
  /** Agent id (`<agent>_<seq>`, ADR-084) of the child. */
  name: string;
}

export interface AgentStatusSnapshot {
  time: string;
  working: SubagentStatusItem[];
  complete: SubagentStatusItem[];
  error: SubagentStatusItem[];
}

export interface SubagentDispatched {
  toolCallId: string;
  agent: string;
  childSessionId: string;
  step?: number;
}

export interface SubagentCompleted {
  toolCallId: string;
}

export interface SubagentErrored {
  toolCallId: string;
}

export type SubagentOutcome = "complete" | "error";

export interface AgentStatusContext {
  now: string;
  dispatched: SubagentDispatched[];
  outcomes: ReadonlyMap<string, SubagentOutcome>;
  previous?: AgentStatusSnapshot;
  resolveId: (childSessionId: string) => string | undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statusName(agent: string, index: number): string {
  return `${agent}_${index}`;
}

export async function buildAgentStatus(params: AgentStatusContext): Promise<AgentStatusSnapshot> {
  const previousCompleteNames = new Set((params.previous?.complete ?? []).map((item) => item.name));
  const previousErrorNames = new Set((params.previous?.error ?? []).map((item) => item.name));
  const perAgent = new Map<string, number>();
  const working: SubagentStatusItem[] = [];
  const complete: SubagentStatusItem[] = [];
  const error: SubagentStatusItem[] = [];

  const nextName = (agent: string, childSessionId: string): string => {
    const id = params.resolveId(childSessionId);
    if (id !== undefined) return id;
    const index = perAgent.get(agent) ?? 0;
    perAgent.set(agent, index + 1);
    return statusName(agent, index);
  };

  for (const dispatch of params.dispatched) {
    const outcome = params.outcomes.get(dispatch.toolCallId);
    if (outcome !== undefined) continue;
    working.push({ name: nextName(dispatch.agent, dispatch.childSessionId) });
  }

  for (const dispatch of params.dispatched) {
    if (params.outcomes.get(dispatch.toolCallId) !== "complete") continue;
    const name = nextName(dispatch.agent, dispatch.childSessionId);
    if (previousCompleteNames.has(name)) continue;
    complete.push({ name });
  }

  for (const dispatch of params.dispatched) {
    if (params.outcomes.get(dispatch.toolCallId) !== "error") continue;
    const name = nextName(dispatch.agent, dispatch.childSessionId);
    if (previousErrorNames.has(name)) continue;
    error.push({ name });
  }

  return { time: params.now, working, complete, error };
}

/** Matches both the legacy `{"name":"...","session_path":"..."}` item and the
 * current plain agent-id list (`search_0,search_1`) shapes (ADR-084). */
const ITEM_PATTERN = /\{"name":"([^"]*)"(?:,"session_path":"[^"]*")?\}|([A-Za-z0-9_-]+\d+)/g;

function parseItems(line: string | undefined): SubagentStatusItem[] {
  if (!line) return [];
  const items: SubagentStatusItem[] = [];
  let match: RegExpExecArray | null;
  ITEM_PATTERN.lastIndex = 0;
  while ((match = ITEM_PATTERN.exec(line))) {
    const name = match[1] ?? match[2];
    if (name) items.push({ name });
  }
  return items;
}

export function parseAgentStatus(text: string): AgentStatusSnapshot | undefined {
  const time = /^Current time: ([^\n]*)$/m.exec(text)?.[1];
  if (time === undefined) return undefined;
  return {
    time,
    working: parseItems(/^Working subagent:(.*)$/m.exec(text)?.[1]),
    complete: parseItems(/^Complete subagent:(.*)$/m.exec(text)?.[1]),
    error: parseItems(/^Error subagent:(.*)$/m.exec(text)?.[1]),
  };
}

export function formatAgentStatus(snapshot: AgentStatusSnapshot): string {
  const lines: Array<string | null> = ["<agent_status>", `Current time: ${snapshot.time}`];
  const formatLine = (label: string, items: SubagentStatusItem[]) =>
    items.length > 0 ? `${label}:${items.map((item) => item.name).join(",")}` : null;
  lines.push(formatLine("Working subagent", snapshot.working));
  lines.push(formatLine("Complete subagent", snapshot.complete));
  lines.push(formatLine("Error subagent", snapshot.error));
  lines.push("</agent_status>");
  return lines.filter((line): line is string => line !== null).join("\n");
}

export function readCompletedMarkers(entries: readonly unknown[]): SubagentCompleted[] {
  const markers: SubagentCompleted[] = [];
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== "custom" || entry.customType !== SUBAGENT_COMPLETED_TYPE) continue;
    const data = entry.data;
    if (!isObject(data)) continue;
    if (typeof data.toolCallId === "string" && data.toolCallId.length > 0) {
      markers.push({ toolCallId: data.toolCallId });
    }
  }
  return markers;
}

export function readSubagentOutcomes(entries: readonly unknown[]): ReadonlyMap<string, SubagentOutcome> {
  const outcomes = new Map<string, SubagentOutcome>();
  for (const marker of readCompletedMarkers(entries)) {
    outcomes.set(marker.toolCallId, "complete");
  }
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== "custom" || entry.customType !== SUBAGENT_ERRORED_TYPE) continue;
    const data = entry.data;
    if (!isObject(data)) continue;
    if (typeof data.toolCallId === "string" && data.toolCallId.length > 0) {
      outcomes.set(data.toolCallId, "error");
    }
  }
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isObject(message) || message.role !== "toolResult") continue;
    if (message.toolName !== "subagent") continue;
    if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) continue;
    if (outcomes.has(message.toolCallId)) continue;
    outcomes.set(message.toolCallId, message.isError === true ? "error" : "complete");
  }
  return outcomes;
}

export function lastAgentStatusText(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isObject(entry) || entry.type !== "custom_message" || entry.customType !== AGENT_STATUS_TYPE) continue;
    if (typeof entry.content === "string") return entry.content;
    return undefined;
  }
  return undefined;
}