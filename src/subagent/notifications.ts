export const AGENT_STATUS_TYPE = "easyresearch:agent_status";

export interface TerminalNotificationOutcome {
  launchId: string;
  agentId: string;
  status: "complete" | "error";
  sessionPath: string;
  latestAssistantText?: string;
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

export function notificationBatchId(message: unknown): string | undefined {
  if (!isObject(message) || message.customType !== AGENT_STATUS_TYPE) return undefined;
  if (message.role !== "custom" && message.type !== "custom_message") return undefined;
  if (!isObject(message.details)) return undefined;
  const batchId = message.details.batchId;
  return typeof batchId === "string" && batchId.trim().length > 0 ? batchId : undefined;
}
