export const AGENT_STATUS_TYPE = "easyresearch:agent_status";
export const SUBAGENT_COMPLETED_TYPE = "easyresearch:subagent_completed";
export const SUBAGENT_ERRORED_TYPE = "easyresearch:subagent_errored";

export interface SubagentStatusItem {
  name: string;
  sessionPath: string;
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
  resolvePath: (childSessionId: string) => Promise<string | undefined>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statusName(agent: string, index: number): string {
  return `${agent}_${index}`;
}

export async function buildAgentStatus(params: AgentStatusContext): Promise<AgentStatusSnapshot> {
  const previousCompletePaths = new Set((params.previous?.complete ?? []).map((item) => item.sessionPath));
  const previousErrorPaths = new Set((params.previous?.error ?? []).map((item) => item.sessionPath));
  const perAgent = new Map<string, number>();
  const working: SubagentStatusItem[] = [];
  const complete: SubagentStatusItem[] = [];
  const error: SubagentStatusItem[] = [];

  for (const dispatch of params.dispatched) {
    const outcome = params.outcomes.get(dispatch.toolCallId);
    if (outcome !== undefined) continue;
    const sessionPath = await params.resolvePath(dispatch.childSessionId);
    if (sessionPath === undefined) continue;
    const index = perAgent.get(dispatch.agent) ?? 0;
    perAgent.set(dispatch.agent, index + 1);
    working.push({ name: statusName(dispatch.agent, index), sessionPath });
  }

  for (const dispatch of params.dispatched) {
    if (params.outcomes.get(dispatch.toolCallId) !== "complete") continue;
    const sessionPath = await params.resolvePath(dispatch.childSessionId);
    if (sessionPath === undefined || previousCompletePaths.has(sessionPath)) continue;
    const index = perAgent.get(dispatch.agent) ?? 0;
    perAgent.set(dispatch.agent, index + 1);
    complete.push({ name: statusName(dispatch.agent, index), sessionPath });
  }

  for (const dispatch of params.dispatched) {
    if (params.outcomes.get(dispatch.toolCallId) !== "error") continue;
    const sessionPath = await params.resolvePath(dispatch.childSessionId);
    if (sessionPath === undefined || previousErrorPaths.has(sessionPath)) continue;
    const index = perAgent.get(dispatch.agent) ?? 0;
    perAgent.set(dispatch.agent, index + 1);
    error.push({ name: statusName(dispatch.agent, index), sessionPath });
  }

  return { time: params.now, working, complete, error };
}

const ITEM_PATTERN = /\{"name":"([^"]*)","session_path":"([^"]*)"\}/g;

function parseItems(line: string | undefined): SubagentStatusItem[] {
  if (!line) return [];
  const items: SubagentStatusItem[] = [];
  let match: RegExpExecArray | null;
  ITEM_PATTERN.lastIndex = 0;
  while ((match = ITEM_PATTERN.exec(line))) {
    items.push({ name: match[1]!, sessionPath: match[2]! });
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

function formatItem(item: SubagentStatusItem): string {
  return JSON.stringify({ name: item.name, session_path: item.sessionPath });
}

export function formatAgentStatus(snapshot: AgentStatusSnapshot): string {
  const lines = ["<agent_status>", `Current time: ${snapshot.time}`];
  if (snapshot.working.length > 0) {
    lines.push(`Working subagent:${snapshot.working.map(formatItem).join(",")}`);
  }
  if (snapshot.complete.length > 0) {
    lines.push(`Complete subagent:${snapshot.complete.map(formatItem).join(",")}`);
  }
  if (snapshot.error.length > 0) {
    lines.push(`Error subagent:${snapshot.error.map(formatItem).join(",")}`);
  }
  lines.push("</agent_status>");
  return lines.join("\n");
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