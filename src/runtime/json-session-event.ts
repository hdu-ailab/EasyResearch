import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

/** Pi keeps prompts and tool declarations in native history, never public chat. */
export function isSystemTranscriptMessage(value: unknown): boolean {
  return value !== null && typeof value === "object" && "role" in value && value.role === "system";
}

function toJsonAssistantMessageEvent(
  event: MessageUpdateEvent["assistantMessageEvent"],
): JsonMessageUpdateEvent["assistantMessageEvent"] {
  if (event.type === "toolcall_start") {
    const toolCall = event.partial.content[event.contentIndex];
    if (toolCall?.type !== "toolCall") {
      throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
    }
    const { partial: _partial, ...deltaEvent } = event;
    return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
  }

  if (!("partial" in event)) return event;
  const { partial: _partial, ...deltaEvent } = event;
  return deltaEvent;
}

/** Normalize direct SDK events for the shared Web/subagent JSON boundary. */
export function toJsonSessionEvent(event: AgentSessionEvent): JsonAgentSessionEvent | undefined {
  if ("message" in event && isSystemTranscriptMessage(event.message)) return undefined;
  if (event.type === "entry_appended" && event.entry.type === "message"
    && isSystemTranscriptMessage(event.entry.message)) return undefined;
  if (event.type === "agent_end") {
    return { ...event, messages: event.messages.filter((message) => !isSystemTranscriptMessage(message)) };
  }
  if (event.type === "message_start" && event.message.role === "assistant") {
    // Pi's mutable partial can already contain later deltas when start reaches us.
    return { ...event, message: { ...event.message, content: [] } };
  }
  if (event.type !== "message_update") return event;
  if (event.message.role !== "assistant") {
    throw new Error("message_update message is not an assistant message");
  }

  return {
    type: "message_update",
    usage: event.message.usage,
    assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
  };
}
