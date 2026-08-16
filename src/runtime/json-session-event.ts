import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Convert direct SDK events to Pi's delta-only JSON/RPC wire shape. */
export function toJsonSessionEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
  if (event.type !== "message_update") return event;
  const assistantMessageEvent = event.assistantMessageEvent;
  if (!("partial" in assistantMessageEvent)) return { type: "message_update", assistantMessageEvent };
  const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
  return { type: "message_update", assistantMessageEvent: deltaEvent } as JsonAgentSessionEvent;
}
