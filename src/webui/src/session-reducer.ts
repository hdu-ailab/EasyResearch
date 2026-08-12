import type { AgentSessionEvent, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";
import type { SessionSnapshotDto, SubagentSessionSummaryDto } from "../../web/contracts";

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
  /** Complete latest assistant message from a `subagent` tool. */
  latestMessage?: string;
  /** Current chain step from a `subagent` tool update. */
  step?: number;
  /** Agent name for `subagent` tool rows (ADR-037/ADR-040: tab derivation). */
  agentName?: string;
  /** Exact persisted child session UUID for this invocation. */
  sessionId?: string;
  /** Every exact child mapping for this tool call, including chain steps. */
  sessionLinks?: SubagentSessionSummaryDto[];
  /** Position in the shared message/tool stream; tools interleave with messages. */
  order: number;
}

export interface SessionMessageView {
  key: string;
  /** Stable Pi identity used to deduplicate snapshot/live overlap when available. */
  identity?: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  /** Reasoning/thinking content, rendered as a collapsible block. */
  reasoning?: string;
  /** True only while the current assistant reasoning block is streaming. */
  isThinking?: boolean;
  streaming: boolean;
  error: boolean;
  /** Agent that produced this message; undefined means the assistant. */
  agentId?: string;
  /** Position in the shared message/tool stream; tools interleave with messages. */
  order: number;
  /** Display label overriding the role-based default (e.g. subagent-line dispatches). */
  label?: string;
}

export interface SessionViewState {
  messages: SessionMessageView[];
  tools: ToolView[];
  /** True while an agent run is active, independently of message streaming. */
  isStreaming: boolean;
  error: string | null;
  /** Agent name when this session line is a `easyresearch:` subagent line. */
  subagentName?: string;
  /** Next value of the shared message/tool stream counter. */
  nextOrder: number;
  /** Key of the assistant message currently streaming; set at message_start,
   * cleared at message_end. message_update deltas key to this because the
   * 0.84 RPC wire no longer carries the cumulative `message` field. */
  activeMessageKey?: string;
}

/** ADR-022: named subagent session lines share this prefix (`subagent/tool.ts`). */
const SUBAGENT_SESSION_PREFIX = "easyresearch:";

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

function identityFor(message: { id?: unknown; timestamp?: unknown }): string | undefined {
  const identity = message.id ?? message.timestamp;
  return identity === undefined || identity === null ? undefined : String(identity);
}

function contentFingerprint(message: SessionMessageView): string {
  return JSON.stringify([message.role, message.text, message.reasoning, message.error, message.agentId, message.label]);
}

function assistantUpdateOf(
  event: MessageUpdateEvent,
):
  | { kind: "text"; delta: string }
  | { kind: "text-start" }
  | { kind: "thinking-start" }
  | { kind: "thinking"; delta: string; complete?: boolean }
  | undefined {
  const update = event.assistantMessageEvent;
  if (update?.type === "text_delta" && typeof update.delta === "string") {
    return { kind: "text", delta: update.delta };
  }
  if (update?.type === "text_start") {
    return { kind: "text-start" };
  }
  if (update?.type === "thinking_start") {
    return { kind: "thinking-start" };
  }
  if (update?.type === "thinking_delta" && typeof update.delta === "string") {
    return { kind: "thinking", delta: update.delta };
  }
  if (update?.type === "thinking_end" && typeof update.content === "string") {
    return { kind: "thinking", delta: update.content, complete: true };
  }
  return undefined;
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

/** Agent name from a subagent tool call's arguments (single or chain mode). */
function agentNameOfToolCall(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  if (typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  if (typeof a.agent === "string" && a.agent) return a.agent;
  if (Array.isArray(a.chain) && a.chain.length > 0) {
    const first = a.chain[0] as { agent?: unknown } | undefined;
    if (typeof first?.agent === "string" && first.agent) return first.agent;
  }
  return undefined;
}

/** Extract text from Pi tool result values without applying presentation limits. */
function outputText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const text = result
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  if (result && typeof result === "object") {
    const value = result as Record<string, unknown>;
    return (
      outputText(value.content) ??
      (typeof value.output === "string" ? value.output : undefined) ??
      (typeof value.stdout === "string" ? value.stdout : undefined)
    );
  }
  return undefined;
}

/** Compact extracted tool text for generic transcript presentation. */
function compactOutput(result: unknown): string | undefined {
  const text = outputText(result);
  if (!text) return undefined;
  return text.length > 2000 ? `${text.slice(0, 1997)}…` : text;
}

function usableText(text: string | undefined): string | undefined {
  return text?.trim() ? text : undefined;
}

/** Label to apply to a message on a subagent line: dispatches come from the
 * assistant, replies belong to the agent running that line. */
function labelFor(role: string, subagentName?: string): string | undefined {
  if (!subagentName) return undefined;
  return role === "user" ? "Assistant" : subagentName;
}

function subagentNameOf(snapshot: SessionSnapshotDto): string | undefined {
  const name = snapshot.session?.sessionName;
  if (typeof name !== "string" || !name.startsWith(SUBAGENT_SESSION_PREFIX)) return undefined;
  const agent = name.slice(SUBAGENT_SESSION_PREFIX.length);
  return agent.length > 0 ? agent : undefined;
}

function isDirectBashExecution(message: UnknownMessage): boolean {
  return message.role === "bashExecution";
}

/** Tool results render as tool rows driven by `tool_execution_*` events and the
 * assistant message's toolCall blocks; their live `message_start` replay must
 * not produce a `system` bubble duplicating the tool row. Mirrors the snapshot
 * path, which folds toolResult messages into tool rows only. */
function isToolResultMessage(message: UnknownMessage): boolean {
  return message.role === "toolResult";
}

export function fromSnapshot(snapshot: SessionSnapshotDto): SessionViewState {
  const subagentName = subagentNameOf(snapshot);
  const isStreaming = snapshot.session.isStreaming || snapshot.session.status === "running";
  const state: SessionViewState = {
    messages: [],
    tools: [],
    isStreaming,
    error: null,
    subagentName,
    nextOrder: 0,
  };
  const next = () => state.nextOrder++;
  snapshot.messages.forEach((message, index) => {
    if (isDirectBashExecution(message as UnknownMessage)) return;
    if (message.role === "toolResult") {
      const toolMessage = message as unknown as { toolCallId?: unknown; toolName?: unknown; isError?: unknown };
      const tool = state.tools.find((t) => t.key === String(toolMessage.toolCallId));
      const toolName = tool?.name ?? (typeof toolMessage.toolName === "string" ? toolMessage.toolName : "tool");
      const text = outputText(message.content);
      const subagentText = usableText(text);
      const output = compactOutput(message.content);
      if (tool) {
        tool.running = false;
        tool.done = true;
        tool.error = Boolean(toolMessage.isError);
        if (tool.name === "subagent") {
          if (subagentText) tool.latestMessage = subagentText;
        } else if (output) {
          tool.output = output;
        }
      } else {
        state.tools.push({
          key: String(toolMessage.toolCallId ?? index),
          name: toolName,
          running: false,
          done: true,
          error: Boolean(toolMessage.isError),
          ...(toolName === "subagent" ? (subagentText ? { latestMessage: subagentText } : {}) : { output }),
          order: next(),
        });
      }
      return;
    }
    const role = message.role === "user" || message.role === "assistant" ? message.role : "system";
    const { text, reasoning } = splitContent(message as UnknownMessage);
    const content = (message as { content?: unknown }).content;
    const toolCallBlocks = Array.isArray(content)
      ? content.filter((block): block is { type?: string; id?: unknown; name?: unknown; arguments?: unknown } =>
          Boolean(block && typeof block === "object" && (block as { type?: string }).type === "toolCall"),
        )
      : [];
    const order = next();
    const nextMessage: SessionMessageView = {
      key: keyFor(message, index),
      ...(identityFor(message) !== undefined ? { identity: identityFor(message) } : {}),
      role,
      text,
      isThinking: false,
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
          agentName: b.name === "subagent" ? agentNameOfToolCall(b.arguments) : undefined,
          order: next(),
        });
      }
    }
  });
  state.tools = state.tools.map((tool) => ({
    ...tool,
    running: tool.done ? false : isStreaming,
  }));
  const candidate = state.messages.at(-1);
  if (isStreaming && candidate?.role === "assistant") {
    state.activeMessageKey = candidate.key;
    candidate.streaming = true;
  }
  return applySubagentSummaries(state, snapshot.subagents ?? []);
}

export function applySubagentSummaries(
  state: SessionViewState,
  summaries: SubagentSessionSummaryDto[],
): SessionViewState {
  if (summaries.length === 0) return state;
  const byToolCall = new Map<string, SubagentSessionSummaryDto[]>();
  for (const summary of summaries) {
    const links = byToolCall.get(summary.toolCallId) ?? [];
    links.push(summary);
    byToolCall.set(summary.toolCallId, links);
  }
  let changed = false;
  const tools = state.tools.map((tool) => {
    const links = byToolCall.get(tool.key);
    if (tool.name !== "subagent" || !links?.length) return tool;
    const summary = links.at(-1);
    if (!summary) return tool;
    changed = true;
    return {
      ...tool,
      agentName: summary.agent,
      sessionId: summary.childSessionId,
      sessionLinks: links,
      ...(summary.step !== undefined ? { step: summary.step } : {}),
      ...(usableText(summary.latestMessage) !== undefined ? { latestMessage: summary.latestMessage } : {}),
    };
  });
  return changed ? { ...state, tools } : state;
}

export function nestedSubagentEvent(event: AgentSessionEvent):
  | {
      sessionId?: string;
      toolCallId: string;
      agent: string;
      event?: AgentSessionEvent;
    }
  | undefined {
  if (event.type !== "tool_execution_update") return undefined;
  const value = event as unknown as {
    toolCallId?: unknown;
    partialResult?: { details?: { subagent?: Record<string, unknown> } };
  };
  const subagent = value.partialResult?.details?.subagent;
  if (typeof value.toolCallId !== "string" || typeof subagent?.agent !== "string" || !subagent.agent.trim()) {
    return undefined;
  }
  return {
    toolCallId: value.toolCallId,
    agent: subagent.agent,
    ...(typeof subagent.sessionId === "string" && subagent.sessionId ? { sessionId: subagent.sessionId } : {}),
    ...(subagent.event && typeof subagent.event === "object" ? { event: subagent.event as AgentSessionEvent } : {}),
  };
}

/** Rehydrate authoritative snapshot state without discarding richer live-only
 * subagent progress that is not persisted in the session transcript. */
export function mergeSnapshot(state: SessionViewState, snapshot: SessionSnapshotDto): SessionViewState {
  const next = fromSnapshot(snapshot);
  const snapshotActiveMessageKey = next.activeMessageKey;
  const summaries = new Map<string, SubagentSessionSummaryDto>();
  for (const summary of snapshot.subagents ?? []) summaries.set(summary.toolCallId, summary);
  const priorSubagents = new Map(
    state.tools.filter((tool) => tool.name === "subagent").map((tool) => [tool.key, tool]),
  );
  next.tools = next.tools.map((tool) => {
    if (tool.name !== "subagent") return tool;
    const prior = priorSubagents.get(tool.key);
    if (!prior) return tool;
    const summary = summaries.get(tool.key);
    return {
      ...tool,
      ...(usableText(tool.latestMessage) === undefined && usableText(prior.latestMessage) !== undefined
        ? { latestMessage: prior.latestMessage }
        : {}),
      ...(summary === undefined && prior.agentName !== undefined ? { agentName: prior.agentName } : {}),
      ...(summary?.step === undefined && prior.step !== undefined ? { step: prior.step } : {}),
      ...(summary === undefined && prior.sessionId !== undefined ? { sessionId: prior.sessionId } : {}),
      ...(tool.sessionLinks === undefined && prior.sessionLinks !== undefined
        ? { sessionLinks: prior.sessionLinks }
        : {}),
    };
  });
  const priorActiveNoIdentityAssistant = state.messages.find(
    (message) =>
      message.key === state.activeMessageKey && message.role === "assistant" && message.identity === undefined,
  );
  const snapshotActiveNoIdentityAssistant = next.messages.find(
    (message) =>
      message.key === snapshotActiveMessageKey && message.role === "assistant" && message.identity === undefined,
  );
  const reconciledPriorActive =
    priorActiveNoIdentityAssistant &&
    snapshotActiveNoIdentityAssistant &&
    priorActiveNoIdentityAssistant.error === snapshotActiveNoIdentityAssistant.error &&
    priorActiveNoIdentityAssistant.agentId === snapshotActiveNoIdentityAssistant.agentId &&
    priorActiveNoIdentityAssistant.label === snapshotActiveNoIdentityAssistant.label &&
    priorActiveNoIdentityAssistant.text.startsWith(snapshotActiveNoIdentityAssistant.text) &&
    (priorActiveNoIdentityAssistant.reasoning ?? "").startsWith(snapshotActiveNoIdentityAssistant.reasoning ?? "")
      ? priorActiveNoIdentityAssistant
      : undefined;
  if (reconciledPriorActive && snapshotActiveNoIdentityAssistant) {
    snapshotActiveNoIdentityAssistant.text = reconciledPriorActive.text;
    snapshotActiveNoIdentityAssistant.reasoning = reconciledPriorActive.reasoning;
    snapshotActiveNoIdentityAssistant.error = reconciledPriorActive.error;
    snapshotActiveNoIdentityAssistant.isThinking = reconciledPriorActive.isThinking;
  }
  const snapshotMessageIdentities = new Set(
    next.messages.flatMap((message): string[] => (message.identity === undefined ? [] : [message.identity])),
  );
  const snapshotNoIdentityCounts = new Map<string, number>();
  for (const message of next.messages) {
    if (message.identity !== undefined) continue;
    const fingerprint = contentFingerprint(message);
    snapshotNoIdentityCounts.set(fingerprint, (snapshotNoIdentityCounts.get(fingerprint) ?? 0) + 1);
  }
  if (reconciledPriorActive && snapshotActiveNoIdentityAssistant) {
    const fingerprint = contentFingerprint(snapshotActiveNoIdentityAssistant);
    const remaining = snapshotNoIdentityCounts.get(fingerprint) ?? 0;
    if (remaining <= 1) snapshotNoIdentityCounts.delete(fingerprint);
    else snapshotNoIdentityCounts.set(fingerprint, remaining - 1);
  }
  const snapshotToolKeys = new Set(next.tools.map((tool) => tool.key));
  const liveOnlyRows: Array<SessionMessageView | ToolView> = [
    ...state.messages.filter((message) => {
      if (message === reconciledPriorActive) return false;
      if (message.identity !== undefined) return !snapshotMessageIdentities.has(message.identity);
      const fingerprint = contentFingerprint(message);
      const remaining = snapshotNoIdentityCounts.get(fingerprint) ?? 0;
      if (remaining === 0) return true;
      snapshotNoIdentityCounts.set(fingerprint, remaining - 1);
      return false;
    }),
    ...state.tools.filter((tool) => !snapshotToolKeys.has(tool.key)),
  ].sort((left, right) => left.order - right.order);
  const reservedKeys = new Set([...next.messages.map((message) => message.key), ...next.tools.map((tool) => tool.key)]);
  let remappedPriorActiveAssistantKey: string | undefined;
  for (const row of liveOnlyRows) {
    const order = next.nextOrder++;
    let key = row.key;
    if (reservedKeys.has(key)) {
      const base = `${key}-${order}`;
      key = base;
      let suffix = 1;
      while (reservedKeys.has(key)) key = `${base}-${suffix++}`;
    }
    reservedKeys.add(key);
    const appended = { ...row, key, order };
    if ("role" in appended) {
      next.messages.push(appended);
      if (appended.role === "assistant" && row.key === state.activeMessageKey) {
        remappedPriorActiveAssistantKey = key;
      }
    } else {
      next.tools.push(appended);
    }
  }
  const activeMessageKey = next.isStreaming ? (remappedPriorActiveAssistantKey ?? snapshotActiveMessageKey) : undefined;
  next.messages = next.messages.map((message) => ({
    ...message,
    streaming: message.role === "assistant" && message.key === activeMessageKey,
  }));
  next.activeMessageKey = activeMessageKey;
  return next;
}

/**
 * Pure session event reducer. Streaming assistant text is updated in place on
 * each `message_update` token delta; `agent_settled` clears the streaming
 * flag. Tool activity is reflected in `activity` rather than as a message.
 */
export function reduceSessionEvent(state: SessionViewState, event: AgentSessionEvent): SessionViewState {
  switch (event.type) {
    case "agent_start":
      return { ...state, isStreaming: true };
    case "message_start": {
      const message = event.message as UnknownMessage;
      if (isDirectBashExecution(message) || isToolResultMessage(message)) return state;
      const identity = identityFor(message);
      if (identity !== undefined && state.messages.some((candidate) => candidate.identity === identity)) return state;
      const role = message.role === "user" || message.role === "assistant" ? message.role : "system";
      const errorMessage = message.errorMessage;
      const { text, reasoning } = splitContent(message);
      const key = keyFor(message, state.messages.length);
      const next: SessionViewState = {
        ...state,
        error: typeof errorMessage === "string" && errorMessage ? errorMessage : null,
        nextOrder: state.nextOrder + 1,
      };
      const view: SessionMessageView = {
        key,
        ...(identity !== undefined ? { identity } : {}),
        role,
        text: text || (errorMessage ? "" : "..."),
        isThinking: false,
        streaming: role === "assistant",
        error: Boolean(errorMessage),
        agentId: typeof message.agentId === "string" ? message.agentId : undefined,
        order: state.nextOrder,
      };
      const label = labelFor(role, state.subagentName);
      if (label) view.label = label;
      if (reasoning) view.reasoning = reasoning;
      next.messages = [...state.messages, view];
      next.activeMessageKey = role === "assistant" ? key : undefined;
      return next;
    }
    case "message_update": {
      const update = assistantUpdateOf(event);
      if (!update) return state;
      const key = state.activeMessageKey;
      let lastIndex = -1;
      if (key !== undefined) {
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i]?.key === key) {
            lastIndex = i;
            break;
          }
        }
      }
      if (lastIndex === -1) {
        // fallback: last streaming message (no active key or row already cleared)
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i]?.streaming) {
            lastIndex = i;
            break;
          }
        }
      }
      if (lastIndex === -1) return state;
      if (
        (update.kind === "text" && !update.delta) ||
        (update.kind === "thinking" && !update.delta && !update.complete)
      )
        return state;
      const target = state.messages[lastIndex];
      if (!target) return state;
      const nextMessages = [...state.messages];
      nextMessages[lastIndex] =
        update.kind === "text"
          ? {
              ...target,
              text: target.text === "..." ? update.delta : target.text + update.delta,
              isThinking: false,
              streaming: true,
            }
          : update.kind === "text-start"
            ? {
                ...target,
                text: target.text === "..." ? "" : target.text,
                isThinking: false,
                streaming: true,
              }
            : update.kind === "thinking-start"
              ? {
                  ...target,
                  text: target.text === "..." ? "" : target.text,
                  isThinking: true,
                  streaming: true,
                }
              : {
                  ...target,
                  text: target.text === "..." ? "" : target.text,
                  reasoning: update.complete ? update.delta : (target.reasoning ?? "") + update.delta,
                  isThinking: !update.complete,
                  streaming: true,
                };
      return { ...state, messages: nextMessages };
    }
    case "message_end": {
      const key = state.activeMessageKey ?? keyFor(event.message, 0);
      const message = event.message as UnknownMessage;
      const { text, reasoning } = splitContent(message);
      const content = message.content;
      const hasToolCall = Array.isArray(content)
        ? content.some(
            (block) => block && typeof block === "object" && (block as { type?: string }).type === "toolCall",
          )
        : false;
      const error = typeof message.errorMessage === "string" && Boolean(message.errorMessage);
      const omitToolCallOnlyRow = message.role === "assistant" && hasToolCall && !text && !reasoning && !error;
      const nextMessages = omitToolCallOnlyRow
        ? state.messages.filter((m) => m.key !== key)
        : state.messages.map((m) =>
            m.key === key
              ? {
                  ...m,
                  text,
                  ...(reasoning ? { reasoning } : { reasoning: undefined }),
                  isThinking: false,
                  streaming: false,
                  error,
                }
              : m,
          );
      return { ...state, messages: nextMessages, activeMessageKey: undefined };
    }
    case "tool_execution_start": {
      const { toolCallId, toolName, args } = event as unknown as {
        toolCallId: string;
        toolName: string;
        args?: unknown;
      };
      if (state.tools.some((tool) => tool.key === toolCallId)) return state;
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
            agentName: toolName === "subagent" ? agentNameOfToolCall(args) : undefined,
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
        tools: state.tools.map((tool) => {
          if (tool.key !== toolCallId) return tool;
          const text = outputText(result);
          const finalText = usableText(text);
          const output = compactOutput(result);
          return {
            ...tool,
            running: false,
            done: true,
            error: Boolean(isError),
            ...(tool.name === "subagent" ? (finalText ? { latestMessage: finalText } : {}) : output ? { output } : {}),
          };
        }),
      };
    }
    case "tool_execution_update": {
      const { toolCallId, partialResult } = event as unknown as {
        toolCallId: string;
        partialResult?: {
          content?: unknown;
          details?: { subagent?: { agent?: unknown; step?: unknown; sessionId?: unknown; latestMessage?: unknown } };
        };
      };
      const subagent = partialResult?.details?.subagent;
      const output = compactOutput(partialResult?.content);
      let changed = false;
      const tools = state.tools.map((tool) => {
        if (tool.key !== toolCallId || !tool.running) return tool;
        if (tool.name !== "subagent") {
          if (!output) return tool;
          changed = true;
          return { ...tool, output };
        }

        const agentName = typeof subagent?.agent === "string" && subagent.agent.trim() ? subagent.agent : undefined;
        const step = typeof subagent?.step === "number" && Number.isFinite(subagent.step) ? subagent.step : undefined;
        const latestMessage =
          typeof subagent?.latestMessage === "string" && subagent.latestMessage.trim()
            ? subagent.latestMessage
            : undefined;
        const sessionId =
          typeof subagent?.sessionId === "string" && subagent.sessionId.trim() ? subagent.sessionId : undefined;
        if (agentName === undefined && step === undefined && sessionId === undefined && latestMessage === undefined)
          return tool;
        const stepChanged = step !== undefined && step !== tool.step;
        const effectiveAgent = agentName ?? tool.agentName;
        const effectiveSessionId = sessionId ?? (stepChanged ? undefined : tool.sessionId);
        const effectiveLatestMessage = latestMessage ?? (stepChanged ? undefined : tool.latestMessage);
        let sessionLinks = tool.sessionLinks;
        if (sessionId && effectiveAgent) {
          const link: SubagentSessionSummaryDto = {
            toolCallId,
            childSessionId: sessionId,
            agent: effectiveAgent,
            ...(step !== undefined ? { step } : {}),
            ...(latestMessage !== undefined ? { latestMessage } : {}),
          };
          const identity = (candidate: SubagentSessionSummaryDto) =>
            candidate.toolCallId === toolCallId && candidate.step === step;
          sessionLinks = [...(sessionLinks ?? []).filter((candidate) => !identity(candidate)), link];
        }
        changed = true;
        return {
          ...tool,
          ...(agentName !== undefined ? { agentName } : {}),
          ...(step !== undefined ? { step } : {}),
          sessionId: effectiveSessionId,
          latestMessage: effectiveLatestMessage,
          ...(sessionLinks !== undefined ? { sessionLinks } : {}),
        };
      });
      return changed ? { ...state, tools } : state;
    }
    case "agent_settled": {
      return {
        ...state,
        isStreaming: false,
        error: null,
        activeMessageKey: undefined,
        messages: state.messages.map((m) => ({ ...m, isThinking: false, streaming: false })),
      };
    }
    default:
      return state;
  }
}

export { emptyState };
