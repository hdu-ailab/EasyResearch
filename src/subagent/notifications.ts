export const AGENT_STATUS_TYPE = "easyresearch:agent_status";

export interface TerminalNotificationOutcome {
  launchId: string;
  agentId: string;
  status: "complete" | "error";
  sessionPath: string;
  latestAssistantText?: string;
}

export interface SubagentCompletionOutcome {
  launchId: string;
  agentId: string;
  status: "complete" | "error";
  text?: string;
}

export interface SubagentCompletionEntry {
  kind: "subagent-completion";
  entryId: string;
  timestamp: string;
  batchId: string;
  outcomes: SubagentCompletionOutcome[];
}

export function completionOutcomes(outcomes: readonly TerminalNotificationOutcome[]): SubagentCompletionOutcome[] {
  return outcomes.map(({ launchId, agentId, status, latestAssistantText }) => ({
    launchId,
    agentId,
    status,
    ...(latestAssistantText?.trim() ? { text: latestAssistantText } : {}),
  }));
}

export function readCompletionOutcomes(value: unknown): SubagentCompletionOutcome[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const outcomes: SubagentCompletionOutcome[] = [];
  const launchIds = new Set<string>();
  for (const outcome of value) {
    if (
      !isObject(outcome)
      || typeof outcome.launchId !== "string" || !outcome.launchId.trim()
      || typeof outcome.agentId !== "string" || !outcome.agentId.trim()
      || (outcome.status !== "complete" && outcome.status !== "error")
      || (outcome.text !== undefined && typeof outcome.text !== "string")
      || launchIds.has(outcome.launchId)
    ) return undefined;
    launchIds.add(outcome.launchId);
    outcomes.push({
      launchId: outcome.launchId,
      agentId: outcome.agentId,
      status: outcome.status,
      ...(typeof outcome.text === "string" && outcome.text.trim() ? { text: outcome.text } : {}),
    });
  }
  return outcomes;
}

export function projectSubagentCompletionEntry(value: unknown): SubagentCompletionEntry | undefined {
  if (
    !isObject(value) || value.type !== "custom_message" || value.display !== false
    || typeof value.id !== "string" || !value.id.trim()
    || typeof value.timestamp !== "string" || !value.timestamp.trim()
  ) return undefined;
  const batchId = notificationBatchId(value);
  const outcomes = isObject(value.details) ? readCompletionOutcomes(value.details.outcomes) : undefined;
  if (!batchId || !outcomes) return undefined;
  return { kind: "subagent-completion", entryId: value.id, timestamp: value.timestamp, batchId, outcomes };
}

export function formatTerminalNotification(input: {
  time: string;
  workingAgentIds: readonly string[];
  outcomes: readonly TerminalNotificationOutcome[];
}): string {
  const lines = ["<agent_status>", `Current time: ${input.time}`];
  for (const agentId of input.workingAgentIds) lines.push(`Working subagent:${agentId}`);
  for (const outcome of input.outcomes) {
    if (outcome.status === "complete") lines.push(`Complete subagent:${outcome.agentId}`);
  }
  for (const outcome of input.outcomes) {
    if (outcome.status !== "error") continue;
    lines.push(`Error subagent:${JSON.stringify({ name: outcome.agentId, session_path: outcome.sessionPath })}`);
  }
  lines.push("</agent_status>", "<agent_handoff>");
  for (const outcome of input.outcomes) {
    if (outcome.latestAssistantText === undefined || outcome.latestAssistantText.trim().length === 0) continue;
    lines.push(`Agent: ${outcome.agentId}`, `Result: ${outcome.latestAssistantText}`);
  }
  lines.push("</agent_handoff>");
  return lines.join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function privateSubagentEventDataReason(
  value: unknown,
  seen = new Set<object>(),
): "session path" | "hidden supervisor status" | undefined {
  if (value === null || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = privateSubagentEventDataReason(item, seen);
      if (reason) return reason;
    }
    return undefined;
  }
  const source = value as Record<string, unknown>;
  if ("sessionPath" in source || "session_path" in source) return "session path";
  if (source.customType === AGENT_STATUS_TYPE) return "hidden supervisor status";
  for (const item of Object.values(source)) {
    const reason = privateSubagentEventDataReason(item, seen);
    if (reason) return reason;
  }
  return undefined;
}

export function notificationBatchId(message: unknown): string | undefined {
  if (!isObject(message) || message.customType !== AGENT_STATUS_TYPE) return undefined;
  if (message.role !== "custom" && message.type !== "custom_message") return undefined;
  if (!isObject(message.details)) return undefined;
  const batchId = message.details.batchId;
  return typeof batchId === "string" && batchId.trim().length > 0 ? batchId : undefined;
}
