export interface LoggedEvent {
  level: "debug" | "info" | "warn";
  message: string;
  fields?: Record<string, unknown>;
}

// Channel split: session_start, model_select, tool_result are delivered only
// via the extension channel (pi.on -> pi-event-logger, TUI/stage runtimes);
// the Web RPC wire (session.subscribe) never delivers them, so the Web
// event-logger sees only agent-level/retry/compaction events. Shared by both.
const INFO_TYPES = new Set([
  "session_start", "agent_start", "agent_end", "agent_settled",
  "turn_start", "turn_end", "model_select",
]);
const DEBUG_TYPES = new Set(["message_update", "tool_result"]);
const WARN_TYPES = new Set([
  "auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end",
  "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
]);
const TOOL_EVENT_TYPES = new Set(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);

function mapToolEvent(type: string, event: { type: string; [key: string]: unknown }): LoggedEvent {
  const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
  const suffix = type === "tool_execution_end" ? (event.isError ? " error" : " ok") : "";
  const level = type === "tool_execution_update" ? "debug" : "info";
  return { level, message: `${type} ${toolName}${suffix}`, fields: { toolName } };
}

export function mapEventToLog(event: { type: string; [key: string]: unknown }): LoggedEvent | null {
  const { type } = event;
  if (TOOL_EVENT_TYPES.has(type)) {
    return mapToolEvent(type, event);
  }
  if (INFO_TYPES.has(type)) {
    if (type === "model_select") {
      const model = event.model as { provider?: string; id?: string } | undefined;
      const name = model?.provider && model?.id ? `${model.provider}/${model.id}` : "unknown";
      return { level: "info", message: `model_select ${name}`, fields: { model: name } };
    }
    return { level: "info", message: type };
  }
  if (DEBUG_TYPES.has(type)) {
    return { level: "debug", message: type };
  }
  if (WARN_TYPES.has(type)) {
    if (type === "auto_retry_start") {
      return { level: "warn", message: type, fields: { attempt: event.attempt, maxAttempts: event.maxAttempts } };
    }
    return { level: "warn", message: type };
  }
  return null;
}
