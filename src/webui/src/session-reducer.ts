import type { SessionSnapshotDto } from "../../web/contracts";
import type { AgentSessionEvent, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

export interface ToolView {
  key: string;
  name: string;
  running: boolean;
  done: boolean;
  error: boolean;
}

export interface SessionMessageView {
  key: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  streaming: boolean;
  error: boolean;
  /** Agent that produced this message; undefined means the orchestrator. */
  agentId?: string;
  /** Last applied text delta, used to make duplicate deliveries idempotent. */
  lastDelta?: string;
}

export interface SessionViewState {
  messages: SessionMessageView[];
  tools: ToolView[];
  isStreaming: boolean;
  error: string | null;
}

const emptyState: SessionViewState = {
  messages: [],
  tools: [],
  isStreaming: false,
  error: null,
};

type UnknownMessage = {
  role?: string;
  id?: unknown;
  timestamp?: unknown;
  content?: unknown;
  errorMessage?: unknown;
  agentId?: unknown;
};

function textOf(message: UnknownMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: unknown; thinking?: unknown };
        if (b.type === "thinking" && typeof b.thinking === "string") {
          parts.push(`💭 ${b.thinking}`);
        } else if (typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  if (typeof message.errorMessage === "string") return `⚠ ${message.errorMessage}`;
  return "";
}

function keyFor(message: { id?: unknown; timestamp?: unknown }, fallback: number): string {
  return String(message.id ?? message.timestamp ?? fallback);
}

function deltaOf(event: MessageUpdateEvent): string {
  const e = event.assistantMessageEvent;
  if (e && e.type === "text_delta" && typeof e.delta === "string") return e.delta;
  return "";
}

export function fromSnapshot(snapshot: SessionSnapshotDto): SessionViewState {
  const state: SessionViewState = {
    messages: [],
    tools: [],
    isStreaming: snapshot.session.isStreaming,
    error: null,
  };
  snapshot.messages.forEach((message, index) => {
    const role = message.role === "user" || message.role === "assistant" ? message.role : "system";
    state.messages.push({
      key: keyFor(message, index),
      role,
      text: textOf(message),
      streaming: false,
      error: Boolean((message as { errorMessage?: string }).errorMessage),
          agentId: typeof (message as { agentId?: unknown }).agentId === "string" ? (message as { agentId?: unknown }).agentId as string : undefined,
    });
  });
  return state;
}

/**
 * Pure session event reducer. Streaming assistant text is updated in place on
 * each `message_update` token delta; `agent_settled` clears the streaming
 * flag. Tool activity is reflected in `activity` rather than as a message.
 */
export function reduceSessionEvent(state: SessionViewState, event: AgentSessionEvent): SessionViewState {
  switch (event.type) {
    case "message_start": {
      const message = event.message;
      const role = message.role === "user" || message.role === "assistant" ? message.role : "system";
      const errorMessage = (message as { errorMessage?: string }).errorMessage;
      const next: SessionViewState = {
        ...state,
        isStreaming: true,
        error: null,
      };
      next.messages = [
        ...state.messages,
        {
          key: keyFor(message, state.messages.length),
          role,
          text: textOf(message) || (errorMessage ? "" : "..."),
          streaming: role === "assistant",
          error: Boolean(errorMessage),
      agentId: typeof (message as { agentId?: unknown }).agentId === "string" ? (message as { agentId?: unknown }).agentId as string : undefined,
        },
      ];
      return next;
    }
    case "message_update": {
      const key = keyFor(event.message, 0);
      const delta = deltaOf(event);
      let lastIndex = -1;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        if (state.messages[i]!.key === key) {
          lastIndex = i;
          break;
        }
      }
      if (lastIndex === -1) return state;
      const target = state.messages[lastIndex]!;
      if (delta === target.lastDelta) return state;
      const nextMessages = [...state.messages];
      nextMessages[lastIndex] = {
        ...target,
        text: target.text === "..." ? delta : target.text + delta,
        lastDelta: delta,
        streaming: true,
      };
      return { ...state, messages: nextMessages, isStreaming: true };
    }
    case "message_end": {
      const key = keyFor(event.message, 0);
      const nextMessages = state.messages.map((m) =>
        m.key === key ? { ...m, streaming: false } : m,
      );
      return { ...state, messages: nextMessages };
    }
    case "tool_execution_start": {
      const { toolCallId, toolName } = event as unknown as { toolCallId: string; toolName: string };
      return {
        ...state,
        tools: [
          ...state.tools,
          { key: toolCallId, name: toolName, running: true, done: false, error: false },
        ],
      };
    }
    case "tool_execution_end": {
      const { toolCallId, isError } = event as unknown as { toolCallId: string; isError?: boolean };
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.key === toolCallId
            ? { ...tool, running: false, done: true, error: Boolean(isError) }
            : tool,
        ),
      };
    }
    case "agent_settled": {
      return {
        ...state,
        isStreaming: false,
        messages: state.messages.map((m) => ({ ...m, streaming: false })),
      };
    }
    default:
      return state;
  }
}

export { emptyState };
