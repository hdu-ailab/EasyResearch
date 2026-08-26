import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

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

/** Convert direct SDK events to Pi's delta-only JSON/RPC wire shape. */
export function toJsonSessionEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
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
