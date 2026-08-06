import type { SessionSnapshotDto } from "../../web/contracts";
import type { AgentSessionEvent, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

export interface ToolView {
  key: string;
  name: string;
  running: boolean;
  done: boolean;
  error: boolean;
  /** Compact string of the call arguments, e.g. `ls -la`. */
  args?: string;
  /** Compact string of the tool output, shown in the expanded body. */
  output?: string;
  /** Position in the shared message/tool stream; tools interleave with messages. */
  order: number;
}

export interface SessionMessageView {
  key: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  /** Reasoning/thinking content, rendered as a collapsible block. */
  reasoning?: string;
  streaming: boolean;
  error: boolean;
  /** Agent that produced this message; undefined means the orchestrator. */
  agentId?: string;
  /** Last applied text delta, used to make duplicate deliveries idempotent. */
  lastDelta?: string;
  /** Position in the shared message/tool stream; tools interleave with messages. */
  order: number;
  /** Display label overriding the role-based default (e.g. subagent-line dispatches). */
  label?: string;
}

export interface SessionViewState {
  messages: SessionMessageView[];
  tools: ToolView[];
  isStreaming: boolean;
  error: string | null;
  /** Agent name when this session line is a `lazyresearch:` subagent line. */
  subagentName?: string;
  /** Next value of the shared message/tool stream counter. */
  nextOrder: number;
}

/** ADR-022: named subagent session lines share this prefix (`subagent/tool.ts`). */
const SUBAGENT_SESSION_PREFIX = "lazyresearch:";

const emptyState: SessionViewState = {
  messages: [],
  tools: [],
  isStreaming: false,
  error: null,
  nextOrder: 0,
};

type UnknownMessage = {
  role?: string;
  id?: unknown;
  timestamp?: unknown;
  content?: unknown;
  errorMessage?: unknown;
  agentId?: unknown;
};

/**
 * Split a message's content blocks into display text and reasoning.
 * Thinking blocks render as a separate collapsible reasoning block;
 * everything else becomes the message body.
 */
function splitContent(message: UnknownMessage): { text: string; reasoning: string } {
  const content = message.content;
  if (typeof content === "string") return { text: content, reasoning: "" };
  if (Array.isArray(content)) {
    const texts: string[] = [];
    const reasoning: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: unknown; thinking?: unknown };
        if (b.type === "thinking" && typeof b.thinking === "string") {
          reasoning.push(b.thinking);
        } else if (b.type === "toolCall" || b.type === "tool_result") {
          // tool calls and results render as tool rows, not message text
        } else if (typeof b.text === "string") {
          texts.push(b.text);
        }
      }
    }
    const text = texts.join("\n\n");
    const joinedReasoning = reasoning.join("\n\n");
    if (text || joinedReasoning) return { text, reasoning: joinedReasoning };
  }
  if (typeof message.errorMessage === "string") return { text: `⚠ ${message.errorMessage}`, reasoning: "" };
  return { text: "", reasoning: "" };
}

function keyFor(message: { id?: unknown; timestamp?: unknown }, fallback: number): string {
  return String(message.id ?? message.timestamp ?? fallback);
}

function deltaOf(event: MessageUpdateEvent): string {
  const e = event.assistantMessageEvent;
  if (e && e.type === "text_delta" && typeof e.delta === "string") return e.delta;
  return "";
}

/** Compact string for a tool call's arguments (prefers the command/query). */
function compactArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.command === "string") return a.command;
    if (typeof a.query === "string") return a.query;
    if (typeof a.pattern === "string") return a.pattern;
    if (typeof a.filePath === "string") return a.filePath;
    if (typeof a.path === "string") return a.path;
    if (typeof a.description === "string") return a.description;
  }
  const text = typeof args === "string" ? args : JSON.stringify(args);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** Compact string for a tool result (prefers the output field). */
function compactOutput(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result.length > 2000 ? `${result.slice(0, 1997)}…` : result;
  if (Array.isArray(result)) {
    const text = result
      .map((block) => {
        if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
          return (block as { text: string }).text;
        }
        return null;
      })
      .filter((part): part is string => part !== null)
      .join("\n");
    if (text) return compactOutput(text);
    return JSON.stringify(result);
  }
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.output === "string") return compactOutput(r.output);
    if (typeof r.stdout === "string") return compactOutput(r.stdout);
  }
  const text = JSON.stringify(result);
  return text.length > 2000 ? `${text.slice(0, 1997)}…` : text;
}

/** Label to apply to a message on a subagent line: dispatches come from the
 * orchestrator, replies belong to the agent running that line. */
function labelFor(role: string, subagentName?: string): string | undefined {
  if (!subagentName) return undefined;
  return role === "user" ? "Orchestrator" : subagentName;
}

function subagentNameOf(snapshot: SessionSnapshotDto): string | undefined {
  const name = snapshot.session?.sessionName;
  if (typeof name !== "string" || !name.startsWith(SUBAGENT_SESSION_PREFIX)) return undefined;
  const agent = name.slice(SUBAGENT_SESSION_PREFIX.length);
  return agent.length > 0 ? agent : undefined;
}

export function fromSnapshot(snapshot: SessionSnapshotDto): SessionViewState {
  const subagentName = subagentNameOf(snapshot);
  const state: SessionViewState = {
    messages: [],
    tools: [],
    isStreaming: snapshot.session.isStreaming,
    error: null,
    subagentName,
    nextOrder: 0,
  };
  const next = () => state.nextOrder++;
  snapshot.messages.forEach((message, index) => {
    if (message.role === "toolResult") {
      const toolMessage = message as unknown as { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
      const tool = state.tools.find((t) => t.key === String(toolMessage.toolCallId));
      const output = compactOutput(message.content);
      next();
      if (tool) {
        tool.done = true;
        tool.error = Boolean(toolMessage.isError);
        tool.output = output ?? tool.output;
      } else {
        state.tools.push({
          key: String(toolMessage.toolCallId ?? index),
          name: typeof toolMessage.toolName === "string" ? toolMessage.toolName : "tool",
          running: false,
          done: true,
          error: Boolean(toolMessage.isError),
          output,
          order: state.nextOrder,
        });
        next();
      }
      return;
    }
    const role = message.role === "user" || message.role === "assistant" ? message.role : "system";
    const { text, reasoning } = splitContent(message as UnknownMessage);
    const content = (message as { content?: unknown }).content;
    const toolCallBlocks =
      Array.isArray(content)
        ? content.filter(
            (block): block is { type?: string; id?: unknown; name?: unknown; arguments?: unknown } =>
              Boolean(block && typeof block === "object" && (block as { type?: string }).type === "toolCall"),
          )
        : [];
    const order = next();
    const nextMessage: SessionMessageView = {
      key: keyFor(message, index),
      role,
      text,
      streaming: false,
      error: Boolean((message as { errorMessage?: string }).errorMessage),
      agentId:
        typeof (message as { agentId?: unknown }).agentId === "string"
          ? ((message as { agentId?: unknown }).agentId as string)
          : undefined,
      order,
    };
    const label = labelFor(role, subagentName);
    if (label) nextMessage.label = label;
    if (reasoning) nextMessage.reasoning = reasoning;
    // A message made only of tool calls renders as tool rows, not a bubble.
    if (text || reasoning || nextMessage.error || toolCallBlocks.length === 0) state.messages.push(nextMessage);
    if (role === "assistant") {
      for (const b of toolCallBlocks) {
        state.tools.push({
          key: String(b.id ?? b.name ?? index),
          name: typeof b.name === "string" ? b.name : "tool",
          running: false,
          done: false,
          error: false,
          args: compactArgs(b.arguments),
          order: next(),
        });
      }
    }
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
      const message = event.message as UnknownMessage;
      const role = message.role === "user" || message.role === "assistant" ? message.role : "system";
      const errorMessage = message.errorMessage;
      const { text, reasoning } = splitContent(message);
      const next: SessionViewState = {
        ...state,
        isStreaming: true,
        error: null,
        nextOrder: state.nextOrder + 1,
      };
      const view: SessionMessageView = {
        key: keyFor(message, state.messages.length),
        role,
        text: text || (errorMessage ? "" : "..."),
        streaming: role === "assistant",
        error: Boolean(errorMessage),
        agentId:
          typeof message.agentId === "string" ? message.agentId : undefined,
        order: state.nextOrder,
      };
      const label = labelFor(role, state.subagentName);
      if (label) view.label = label;
      if (reasoning) view.reasoning = reasoning;
      next.messages = [...state.messages, view];
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
      const { toolCallId, toolName, args } = event as unknown as {
        toolCallId: string;
        toolName: string;
        args?: unknown;
      };
      return {
        ...state,
        nextOrder: state.nextOrder + 1,
        tools: [
          ...state.tools,
          {
            key: toolCallId,
            name: toolName,
            running: true,
            done: false,
            error: false,
            args: compactArgs(args),
            order: state.nextOrder,
          },
        ],
      };
    }
    case "tool_execution_end": {
      const { toolCallId, isError, result } = event as unknown as {
        toolCallId: string;
        isError?: boolean;
        result?: unknown;
      };
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.key === toolCallId
            ? { ...tool, running: false, done: true, error: Boolean(isError), output: compactOutput(result) }
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
