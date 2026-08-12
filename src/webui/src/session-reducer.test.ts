import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  fromSnapshot,
  mergeSnapshot,
  nestedSubagentEvent,
  reduceSessionEvent,
  type SessionViewState,
} from "./session-reducer";

const emptyState: SessionViewState = { messages: [], tools: [], isStreaming: false, error: null, nextOrder: 0 };

function userMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }] } as never;
}

function assistantMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] } as never;
}

function assistantEvent(type: "message_start" | "message_update" | "message_end", text: string): AgentSessionEvent {
  if (type === "message_update") {
    return {
      type,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
    } as AgentSessionEvent;
  }
  return {
    type,
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as AgentSessionEvent;
}

function toolEvent(
  type: "tool_execution_start" | "tool_execution_end",
  toolCallId = "t1",
  toolName = "bash",
): AgentSessionEvent {
  return { type, toolCallId, toolName, args: {} } as AgentSessionEvent;
}

describe("session reducer", () => {
  it("hydrates from a snapshot", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" } as never,
      subagents: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ] as never,
    });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]!.role).toBe("user");
    expect(state.messages[1]!.role).toBe("assistant");
    expect(state.isStreaming).toBe(true);
  });

  it("restores the assistant delta cursor from a running snapshot", () => {
    const hydrated = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [userMessage("question"), assistantMessage("partial")],
    });

    const updated = reduceSessionEvent(hydrated, assistantEvent("message_update", " answer"));

    expect(updated.messages.at(-1)?.text).toBe("partial answer");
    expect(updated.activeMessageKey).toBe(hydrated.messages.at(-1)?.key);
  });

  it("restores run and assistant cursor state when status is running but isStreaming is false", () => {
    const hydrated = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "running" },
      subagents: [],
      messages: [userMessage("question"), assistantMessage("partial")],
    });

    expect(hydrated.isStreaming).toBe(true);
    expect(hydrated.activeMessageKey).toBe(hydrated.messages.at(-1)?.key);
    expect(hydrated.messages.map((message) => message.streaming)).toEqual([false, true]);
  });

  it("does not fabricate an assistant cursor when a running snapshot ends in a user message", () => {
    const hydrated = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [assistantMessage("earlier"), userMessage("follow-up")],
    });

    expect(hydrated.isStreaming).toBe(true);
    expect(hydrated.activeMessageKey).toBeUndefined();
    expect(hydrated.messages.every((message) => !message.streaming)).toBe(true);
  });

  it("tracks agent lifecycle independently from assistant message completion", () => {
    const running = reduceSessionEvent(emptyState, { type: "agent_start" } as AgentSessionEvent);
    expect(running.isStreaming).toBe(true);

    const withAssistant = reduceSessionEvent(running, assistantEvent("message_start", "partial"));
    const afterAssistantMessageEnd = reduceSessionEvent(withAssistant, assistantEvent("message_end", "complete"));
    expect(afterAssistantMessageEnd.isStreaming).toBe(true);

    const afterAgentSettled = reduceSessionEvent(afterAssistantMessageEnd, {
      type: "agent_settled",
    } as AgentSessionEvent);
    expect(afterAgentSettled.isStreaming).toBe(false);
  });

  it("does not add direct bash execution output to the snapshot transcript", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" } as never,
      subagents: [],
      messages: [
        {
          role: "bashExecution",
          command: "ls",
          output: "secretly duplicated output",
          exitCode: 0,
          cancelled: false,
          truncated: false,
        },
      ] as never,
    });

    expect(state.messages).toEqual([]);
    expect(state.tools).toEqual([]);
  });

  it("appends a message on message_start", () => {
    const running = reduceSessionEvent(emptyState, { type: "agent_start" } as AgentSessionEvent);
    const state = reduceSessionEvent(running, assistantEvent("message_start", ""));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.role).toBe("assistant");
    expect(state.messages[0]!.streaming).toBe(true);
    expect(state.isStreaming).toBe(true);
  });

  it("ignores live bash execution messages", () => {
    const state = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: {
        role: "bashExecution",
        command: "ls",
        output: "secretly duplicated output",
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
    } as never);

    expect(state.messages).toEqual([]);
    expect(state.isStreaming).toBe(false);
  });

  it("ignores live toolResult message_start instead of rendering a system bubble", () => {
    const state = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "secretly duplicated output" }],
        isError: false,
        timestamp: 123,
      },
    } as never);

    expect(state.messages).toEqual([]);
    expect(state.tools).toEqual([]);
    expect(state.isStreaming).toBe(false);
  });

  it("updates the streaming message in place per token delta", () => {
    const started = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    const first = reduceSessionEvent(started, assistantEvent("message_update", "two "));
    const second = reduceSessionEvent(first, assistantEvent("message_update", "deltas"));
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]!.text).toBe("two deltas");
  });

  it("tracks live thinking until thinking ends and keeps text deltas on the same assistant row", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as never);
    expect(state.messages[0]!.isThinking).toBe(true);
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "first " },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "second" },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "first second" },
    } as never);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.reasoning).toBe("first second");
    expect(state.messages[0]!.isThinking).toBe(false);

    state = reduceSessionEvent(state, assistantEvent("message_update", "answer"));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.text).toBe("answer");
    expect(state.messages[0]!.reasoning).toBe("first second");
    expect(state.messages[0]!.isThinking).toBe(false);
  });

  it("reconciles a thinking and tool-call message without retaining the live placeholder body", () => {
    let state = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: { id: "m1", role: "assistant", content: [] },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "inspect first" },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_end",
      message: {
        id: "m1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "inspect first" },
          { type: "toolCall", id: "t1", name: "bash", arguments: { command: "pwd" } },
        ],
      },
    } as never);
    state = reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "pwd" },
    } as never);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ text: "", reasoning: "inspect first", streaming: false });
    expect(state.tools).toHaveLength(1);
    expect(state.messages[0]!.order).toBeLessThan(state.tools[0]!.order);
  });

  it("removes the temporary assistant row when the final message contains only a tool call", () => {
    let state = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: { id: "m1", role: "assistant", content: [] },
    } as never);
    state = reduceSessionEvent(state, {
      type: "message_end",
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "pwd" } }],
      },
    } as never);

    expect(state.messages).toEqual([]);
  });

  it("clears active thinking when text output starts or the agent settles", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
    } as never);
    expect(state.messages[0]!.isThinking).toBe(true);

    state = reduceSessionEvent(state, assistantEvent("message_update", "answer"));
    expect(state.messages[0]!.isThinking).toBe(false);

    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "more" },
    } as never);
    expect(state.messages[0]!.isThinking).toBe(true);

    state = reduceSessionEvent(state, { type: "agent_settled" } as AgentSessionEvent);
    expect(state.messages[0]!.isThinking).toBe(false);
  });

  it("clears active thinking when the text block starts before its first token", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
    } as never);

    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    } as never);

    expect(state.messages[0]!.isThinking).toBe(false);
    expect(state.messages[0]!.text).toBe("");
  });

  it("ignores empty text deltas without ending active thinking", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
    } as never);

    state = reduceSessionEvent(state, assistantEvent("message_update", ""));

    expect(state.messages[0]!.isThinking).toBe(true);
    expect(state.messages[0]!.text).toBe("");
  });

  it("clears active thinking when the assistant message ends", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    state = reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "working" },
    } as never);

    state = reduceSessionEvent(state, assistantEvent("message_end", ""));

    expect(state.messages[0]!.isThinking).toBe(false);
  });

  it("handles agent_settled by clearing streaming state", () => {
    const started = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    const settled = reduceSessionEvent(started, { type: "agent_settled" } as AgentSessionEvent);
    expect(settled.isStreaming).toBe(false);
    expect(settled.messages[0]!.streaming).toBe(false);
  });

  it("adds a tool block on start and marks it done on end", () => {
    const active = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "bash"));
    expect(active.tools).toHaveLength(1);
    expect(active.tools[0]).toMatchObject({ key: "t1", name: "bash", running: true, done: false });
    const done = reduceSessionEvent(active, toolEvent("tool_execution_end", "t1", "bash"));
    expect(done.tools[0]).toMatchObject({ running: false, done: true, error: false });
  });

  it("marks a failing tool with its error flag and keeps other tools intact", () => {
    const first = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "bash"));
    const second = reduceSessionEvent(first, toolEvent("tool_execution_start", "t2", "grep"));
    const failed = reduceSessionEvent(second, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: "nope",
      isError: true,
    } as never);
    expect(failed.tools).toHaveLength(2);
    expect(failed.tools[0]).toMatchObject({ error: true, done: true });
    expect(failed.tools[1]).toMatchObject({ name: "grep", running: true });
  });

  it("surfaces an assistant error message", () => {
    const started = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: { role: "assistant", content: [], errorMessage: "provider down" },
    } as unknown as AgentSessionEvent);
    expect(started.messages[0]!.error).toBe(true);
    expect(started.messages[0]!.text).toContain("provider down");
  });

  it("flags the run error on the session state and clears it on settle", () => {
    const started = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: { role: "assistant", content: [], errorMessage: "provider down" },
    } as unknown as AgentSessionEvent);
    expect(started.error).toBe("provider down");
    const settled = reduceSessionEvent(started, { type: "agent_settled" } as unknown as AgentSessionEvent);
    expect(settled.error).toBeNull();
    const ok = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    expect(ok.error).toBeNull();
  });

  it("appends consecutive identical token deltas without dropping text", () => {
    const started = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    const once = reduceSessionEvent(started, assistantEvent("message_update", "same"));
    const twice = reduceSessionEvent(once, assistantEvent("message_update", "same"));
    expect(twice.messages).toHaveLength(1);
    expect(twice.messages[0]!.text).toBe("samesame");
  });

  it("keeps user messages distinct from assistant streaming", () => {
    const withUser = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: userMessage("question"),
    } as AgentSessionEvent);
    const streaming = reduceSessionEvent(withUser, assistantEvent("message_start", ""));
    expect(streaming.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(streaming.messages[0]!.streaming).toBe(false);
  });

  it("splits thinking blocks into reasoning, keeping the body text", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me think hard", thinkingSignature: "reasoning" },
            { type: "text", text: "here is the answer" },
          ],
        },
      ] as never,
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.reasoning).toBe("let me think hard");
    expect(state.messages[0]!.text).toBe("here is the answer");
    expect(state.messages[0]!.isThinking).toBe(false);
  });

  it("captures tool args on start and output on end", () => {
    const active = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls -la" },
    } as never);
    expect(active.tools[0]).toMatchObject({ args: "ls -la" });
    const done = reduceSessionEvent(active, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { output: "total 8" },
    } as never);
    expect(done.tools[0]).toMatchObject({ output: "total 8", done: true });
  });

  it("shows textual partial content from generic tool updates", () => {
    const active = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "bash"));
    const updated = reduceSessionEvent(active, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    } as never);

    expect(updated.tools[0]!.output).toBe("partial");
  });

  it("unwraps Pi content from a completed generic tool result", () => {
    const active = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "bash"));
    const done = reduceSessionEvent(active, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "final" }], details: { opaque: true } },
    } as never);

    expect(done.tools[0]!.output).toBe("final");
  });

  it("caps generic completed output at its presentation limit", () => {
    const longOutput = "g".repeat(2_500);
    const active = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "bash"));
    const done = reduceSessionEvent(active, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: longOutput }] },
    } as never);

    expect(done.tools[0]!.output).toMatch(/^g+/);
    expect(done.tools[0]!.output!.length).toBeLessThanOrEqual(2_000);
    expect(done.tools[0]!.output).toMatch(/…$/);
  });

  it("keeps a completed subagent latest message unbounded", () => {
    const latestMessage = "s".repeat(2_500);
    const active = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "subagent"));
    const done = reduceSessionEvent(active, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "subagent",
      result: { content: [{ type: "text", text: latestMessage }], details: { opaque: true } },
    } as never);

    expect(done.tools[0]!.latestMessage).toBe(latestMessage);
  });

  it("retains live subagent text when completion content is empty", () => {
    let state = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "subagent"));
    state = reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "subagent",
      partialResult: { details: { subagent: { latestMessage: "latest live message" } } },
    } as never);
    state = reduceSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "subagent",
      result: { content: [], details: {} },
    } as never);

    expect(state.tools[0]!.latestMessage).toBe("latest live message");
  });

  it("retains live subagent text when an aborted completion has no usable final text", () => {
    let state = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "subagent"));
    state = reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "subagent",
      partialResult: { details: { subagent: { latestMessage: "complete progress before abort" } } },
    } as never);
    state = reduceSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "subagent",
      result: { content: [{ type: "text", text: "   " }], details: {} },
      isError: true,
    } as never);

    expect(state.tools[0]).toMatchObject({
      running: false,
      done: true,
      error: true,
      latestMessage: "complete progress before abort",
    });
  });

  it("pairs snapshot toolCall blocks with toolResult messages", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: '{"command":"ls"}' }],
        },
        {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "bash",
          content: [{ type: "text", text: "file.txt" }],
          isError: false,
        },
      ] as never,
    });
    expect(state.messages).toHaveLength(0);
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({ key: "tc-1", name: "bash", done: true, error: false });
    expect(state.tools[0]!.output).toBe("file.txt");
  });

  it("unwraps text-block arrays from toolResult content", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "toolResult",
          toolCallId: "tc-9",
          toolName: "bash",
          content: [{ type: "text", text: "总计 4\nnotes" }],
          isError: false,
        },
      ] as never,
    });
    expect(state.tools[0]).toMatchObject({ key: "tc-9", output: "总计 4\nnotes" });
  });

  it("keeps snapshot subagent latest messages unbounded while capping generic output", () => {
    const latestMessage = "s".repeat(2_500);
    const genericOutput = "g".repeat(2_500);
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "sub-1", name: "subagent", arguments: '{"agent":"writing"}' },
            { type: "toolCall", id: "bash-1", name: "bash", arguments: '{"command":"run"}' },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "sub-1",
          toolName: "subagent",
          content: [{ type: "text", text: latestMessage }],
          isError: false,
        },
        {
          role: "toolResult",
          toolCallId: "bash-1",
          toolName: "bash",
          content: [{ type: "text", text: genericOutput }],
          isError: false,
        },
      ] as never,
    });

    expect(state.tools.find((tool) => tool.key === "sub-1")!.latestMessage).toBe(latestMessage);
    expect(state.tools.find((tool) => tool.key === "bash-1")!.output!.length).toBeLessThanOrEqual(2_000);
    expect(state.tools.find((tool) => tool.key === "bash-1")!.output).toMatch(/…$/);
  });

  it("does not treat whitespace-only snapshot subagent output as a latest message", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-space", name: "subagent", arguments: '{"agent":"search"}' }],
        },
        {
          role: "toolResult",
          toolCallId: "sub-space",
          toolName: "subagent",
          content: [{ type: "text", text: " \n\t " }],
          isError: true,
        },
      ] as never,
    });

    expect(state.tools[0]).toMatchObject({ running: false, done: true, error: true });
    expect(state.tools[0]!.latestMessage).toBeUndefined();
  });

  it("orders tools at their stream position, interleaving with messages", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "about to run" },
            { type: "toolCall", id: "tc-1", name: "bash", arguments: '{"command":"ls"}' },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "bash",
          content: [{ type: "text", text: "file.txt" }],
          isError: false,
        },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ] as never,
    });
    const order = (m: { order: number }) => m.order;
    const merged = [...state.messages, ...state.tools].sort((a, b) => a.order - b.order);
    expect(merged.map((e) => ("role" in e ? e.role : "tool"))).toEqual(["user", "assistant", "tool", "assistant"]);
    const messageOrders = state.messages.map(order);
    const toolOrders = state.tools.map(order);
    expect(new Set(messageOrders).size).toBe(messageOrders.length);
    expect(new Set(toolOrders).size).toBe(toolOrders.length);
    expect(messageOrders.every((o, i) => i === 0 || o > messageOrders[i - 1]!)).toBe(true);
  });

  it("labels a subagent-line dispatch as assistant, not the user", () => {
    const state = fromSnapshot({
      session: { id: "s2", cwd: "/p", sessionName: "easyresearch:search", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "Task: search papers" }] },
        { role: "assistant", content: [{ type: "text", text: "found 3 papers" }] },
      ] as never,
    });
    expect(state.subagentName).toBe("search");
    expect(state.messages[0]).toMatchObject({ role: "user", label: "Assistant" });
    expect(state.messages[1]).toMatchObject({ role: "assistant", label: "search" });
  });

  it("keeps plain sessions user-labeled and unlabeled assistants", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ] as never,
    });
    expect(state.subagentName).toBeUndefined();
    expect(state.messages[0]!.label).toBeUndefined();
    expect(state.messages[1]!.label).toBeUndefined();
  });

  it("assigns stream positions to live tools between messages", () => {
    let state = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: userMessage("go"),
    } as AgentSessionEvent);
    state = reduceSessionEvent(state, assistantEvent("message_start", "running"));
    state = reduceSessionEvent(state, toolEvent("tool_execution_start", "t1", "bash"));
    const final = reduceSessionEvent(state, assistantEvent("message_start", "done"));
    expect(final.messages.map((m) => m.order)).toEqual([0, 1, 3]);
    expect(final.tools.map((t) => t.order)).toEqual([2]);
  });

  it("attaches subagent state to the matching tool on tool_execution_update", () => {
    let state = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "subagent"));
    state = reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "subagent",
      args: { agent: "search" },
      partialResult: {
        details: { subagent: { agent: "writing", step: 2, status: "running", latestMessage: "drafting method" } },
      },
    } as never);
    expect(state.tools[0]).toMatchObject({ agentName: "writing", step: 2, latestMessage: "drafting method" });
    expect(state.tools[0]!.running).toBe(true);
    expect(state.messages).toHaveLength(0);
  });

  it("keeps live subagent latest messages unbounded", () => {
    const latestMessage = "l".repeat(2_500);
    let state = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "subagent"));
    state = reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "subagent",
      partialResult: { details: { subagent: { latestMessage } } },
    } as never);

    expect(state.tools[0]!.latestMessage).toBe(latestMessage);
  });

  it("captures the agent name from single-mode subagent args", () => {
    const state = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "subagent",
      args: { agent: "search", task: "find papers" },
    } as never);
    expect(state.tools[0]).toMatchObject({ agentName: "search" });
  });

  it("captures the first agent name from chain-mode subagent args", () => {
    const state = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "t2",
      toolName: "subagent",
      args: {
        chain: [
          { agent: "search", task: "first" },
          { agent: "writing", task: "then" },
        ],
      },
    } as never);
    expect(state.tools[0]).toMatchObject({ agentName: "search" });
  });

  it("captures the agent name from snapshot subagent toolCall blocks (JSON-string args)", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-1", name: "subagent", arguments: '{"agent":"figures","task":"draw"}' }],
        },
      ] as never,
    });
    expect(state.tools[0]).toMatchObject({ name: "subagent", agentName: "figures" });
  });

  it("applies persisted child summaries to the exact parent tool invocation", () => {
    const state = fromSnapshot({
      session: { id: "parent", cwd: "/p", isStreaming: false, status: "ready" } as never,
      subagents: [
        {
          toolCallId: "sub-linked",
          childSessionId: "child-uuid",
          agent: "writing",
          step: 2,
          latestMessage: "historical progress",
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "sub-linked", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ] as never,
    });

    expect(state.tools[0]).toMatchObject({
      key: "sub-linked",
      agentName: "writing",
      step: 2,
      sessionId: "child-uuid",
      latestMessage: "historical progress",
    });
  });

  it("preserves every historical chain-step mapping on one parent tool row", () => {
    const state = fromSnapshot({
      session: { id: "parent", cwd: "/p", isStreaming: false, status: "ready" } as never,
      subagents: [
        { toolCallId: "chain-linked", childSessionId: "child-search", agent: "search", step: 1 },
        { toolCallId: "chain-linked", childSessionId: "child-writing", agent: "writing", step: 2 },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "chain-linked", name: "subagent", arguments: '{"chain":[]}' }],
        },
      ] as never,
    });

    expect(state.tools[0]).toMatchObject({
      agentName: "writing",
      step: 2,
      sessionId: "child-writing",
      sessionLinks: [
        { toolCallId: "chain-linked", childSessionId: "child-search", agent: "search", step: 1 },
        { toolCallId: "chain-linked", childSessionId: "child-writing", agent: "writing", step: 2 },
      ],
    });
  });

  it("lets an authoritative snapshot summary replace prior live chain agent and step", () => {
    const prior: SessionViewState = {
      ...emptyState,
      tools: [
        {
          key: "chain-call",
          name: "subagent",
          running: true,
          done: false,
          error: false,
          agentName: "search",
          step: 1,
          latestMessage: "live progress",
          order: 0,
        },
      ],
      nextOrder: 1,
    };
    const snapshot = {
      session: { id: "parent", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [
        {
          toolCallId: "chain-call",
          childSessionId: "child-writing",
          agent: "writing",
          step: 2,
        },
      ],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "chain-call", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    } as never;

    expect(mergeSnapshot(prior, snapshot).tools[0]).toMatchObject({
      agentName: "writing",
      step: 2,
      sessionId: "child-writing",
      latestMessage: "live progress",
    });
  });

  it("preserves prior live chain agent and step when the snapshot has no summary", () => {
    const prior: SessionViewState = {
      ...emptyState,
      tools: [
        {
          key: "chain-call",
          name: "subagent",
          running: true,
          done: false,
          error: false,
          agentName: "writing",
          step: 2,
          order: 0,
        },
      ],
      nextOrder: 1,
    };
    const snapshot = {
      session: { id: "parent", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "chain-call", name: "subagent", arguments: '{"agent":"search"}' }],
        },
      ],
    } as never;

    expect(mergeSnapshot(prior, snapshot).tools[0]).toMatchObject({ agentName: "writing", step: 2 });
  });

  it("preserves live-only rows after reconnect snapshot rows without duplicating persisted rows", () => {
    const persistedSnapshot = {
      session: { id: "parent", cwd: "/p", isStreaming: true, status: "running" },
      subagents: [],
      messages: [{ id: "persisted", role: "user", content: [{ type: "text", text: "question" }] }],
    } as never;
    let prior = fromSnapshot(persistedSnapshot);
    prior = reduceSessionEvent(prior, {
      type: "message_start",
      message: { id: "live-assistant", role: "assistant", content: [{ type: "text", text: "newer reply" }] },
    } as never);
    prior = reduceSessionEvent(prior, {
      type: "tool_execution_start",
      toolCallId: "live-tool",
      toolName: "bash",
      args: { command: "pwd" },
    } as never);

    const merged = mergeSnapshot(prior, persistedSnapshot);
    const rows = [...merged.messages, ...merged.tools].sort((left, right) => left.order - right.order);

    expect(merged.messages.map((message) => message.identity)).toEqual(["persisted", "live-assistant"]);
    expect(merged.tools.map((tool) => tool.key)).toEqual(["live-tool"]);
    expect(rows.map((row) => row.key)).toEqual(["persisted", "live-assistant", "live-tool"]);
    expect(merged.activeMessageKey).toBe("live-assistant");
    expect(merged.messages.filter((message) => message.streaming).map((message) => message.key)).toEqual([
      "live-assistant",
    ]);
  });

  it("preserves distinct no-id live messages when snapshot fallback keys collide", () => {
    const prior = reduceSessionEvent(emptyState, {
      type: "message_start",
      message: userMessage("live question"),
    } as AgentSessionEvent);
    const snapshot = {
      session: { id: "parent", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [assistantMessage("persisted answer")],
    } as never;

    const merged = mergeSnapshot(prior, snapshot);

    expect(merged.messages.map((message) => [message.role, message.text])).toEqual([
      ["assistant", "persisted answer"],
      ["user", "live question"],
    ]);
  });

  it("does not duplicate an unchanged no-id message from the snapshot", () => {
    const snapshot = {
      session: { id: "parent", cwd: "/p", isStreaming: false, status: "ready" },
      subagents: [],
      messages: [assistantMessage("persisted answer")],
    } as never;
    const prior = fromSnapshot(snapshot);

    const merged = mergeSnapshot(prior, snapshot);

    expect(merged.messages.map((message) => [message.role, message.text])).toEqual([
      ["assistant", "persisted answer"],
    ]);
  });

  it("extracts nested child deltas and reduces them token-by-token into only that child state", () => {
    const start = nestedSubagentEvent({
      type: "tool_execution_update",
      toolCallId: "parent-tool",
      partialResult: {
        details: {
          subagent: {
            agent: "search",
            sessionId: "child-uuid",
            event: { type: "message_start", message: { id: "child-message", role: "assistant", content: [] } },
          },
        },
      },
    } as never)!;
    const first = nestedSubagentEvent({
      type: "tool_execution_update",
      toolCallId: "parent-tool",
      partialResult: {
        details: {
          subagent: {
            agent: "search",
            sessionId: "child-uuid",
            event: {
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "two " },
            },
          },
        },
      },
    } as never)!;
    const second = nestedSubagentEvent({
      type: "tool_execution_update",
      toolCallId: "parent-tool",
      partialResult: {
        details: {
          subagent: {
            agent: "search",
            sessionId: "child-uuid",
            event: {
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tokens" },
            },
          },
        },
      },
    } as never)!;

    expect(start).toMatchObject({ sessionId: "child-uuid", toolCallId: "parent-tool", agent: "search" });
    let child = reduceSessionEvent({ ...emptyState, subagentName: "search" }, start.event!);
    child = reduceSessionEvent(child, first.event!);
    child = reduceSessionEvent(child, second.event!);
    expect(child.messages).toEqual([expect.objectContaining({ text: "two tokens", label: "search" })]);
  });

  it("deduplicates replayed nested child message starts by stable Pi message id", () => {
    const nested = nestedSubagentEvent({
      type: "tool_execution_update",
      toolCallId: "parent-tool",
      partialResult: {
        details: {
          subagent: {
            agent: "search",
            sessionId: "child-uuid",
            event: { type: "message_start", message: { id: "child-message", role: "assistant", content: [] } },
          },
        },
      },
    } as never)!.event!;

    let child = reduceSessionEvent({ ...emptyState, subagentName: "search" }, nested);
    child = reduceSessionEvent(child, nested);

    expect(child.messages).toHaveLength(1);
    expect(child.nextOrder).toBe(1);
  });

  it("deduplicates replayed nested child tool starts by toolCallId", () => {
    const nested = nestedSubagentEvent({
      type: "tool_execution_update",
      toolCallId: "parent-tool",
      partialResult: {
        details: {
          subagent: {
            agent: "search",
            sessionId: "child-uuid",
            event: { type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "ls" } },
          },
        },
      },
    } as never)!.event!;

    let child = reduceSessionEvent({ ...emptyState, subagentName: "search" }, nested);
    child = reduceSessionEvent(child, nested);

    expect(child.tools).toHaveLength(1);
    expect(child.nextOrder).toBe(1);
  });

  it("preserves nested child tool order among child messages", () => {
    const nested = (event: AgentSessionEvent) =>
      nestedSubagentEvent({
        type: "tool_execution_update",
        toolCallId: "parent-tool",
        partialResult: { details: { subagent: { agent: "search", sessionId: "child-uuid", event } } },
      } as never)!.event!;
    let child = reduceSessionEvent(
      { ...emptyState, subagentName: "search" },
      nested({
        type: "message_start",
        message: { id: "m1", role: "assistant", content: [{ type: "text", text: "before" }] },
      } as never),
    );
    child = reduceSessionEvent(
      child,
      nested({
        type: "tool_execution_start",
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "ls" },
      } as never),
    );
    child = reduceSessionEvent(
      child,
      nested({
        type: "tool_execution_end",
        toolCallId: "bash-1",
        toolName: "bash",
        result: { output: "done" },
      } as never),
    );
    child = reduceSessionEvent(
      child,
      nested({
        type: "message_start",
        message: { id: "m2", role: "assistant", content: [{ type: "text", text: "after" }] },
      } as never),
    );

    expect(
      [...child.messages, ...child.tools]
        .sort((a, b) => a.order - b.order)
        .map((entry) => ("name" in entry ? entry.name : entry.text)),
    ).toEqual(["before", "bash", "after"]);
  });

  it("ignores tool_execution_update for unknown toolCallIds", () => {
    const state = reduceSessionEvent(emptyState, {
      type: "tool_execution_update",
      toolCallId: "ghost",
      toolName: "subagent",
      partialResult: { details: { subagent: { agent: "search", status: "running" } } },
    } as never);
    expect(state.tools).toHaveLength(0);
  });

  it("does not overwrite subagent state with a later malformed update", () => {
    let state = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "subagent"));
    state = reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "subagent",
      partialResult: { details: { subagent: { agent: "writing", step: 2, latestMessage: "first" } } },
    } as never);
    state = reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "subagent",
      partialResult: { details: { subagent: { agent: 42, step: "third", latestMessage: null } } },
    } as never);
    expect(state.tools[0]).toMatchObject({ agentName: "writing", step: 2, latestMessage: "first" });
  });

  it("rehydrates unresolved tools as running only from a streaming snapshot", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc-1", name: "subagent", arguments: '{"agent":"writing"}' }],
      },
    ] as never;
    const streaming = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" } as never,
      subagents: [],
      messages,
    });
    const settled = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      subagents: [],
      messages,
    });

    expect(streaming.tools[0]).toMatchObject({ running: true, done: false });
    expect(settled.tools[0]).toMatchObject({ running: false, done: false });
  });

  it("resolves message_update deltas by the message_start key, even without ids", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    expect(state.activeMessageKey).toBe("0");
    state = reduceSessionEvent(state, assistantEvent("message_update", "one "));
    state = reduceSessionEvent(state, assistantEvent("message_update", "two"));
    expect(state.messages[0]!.text).toBe("one two");
    state = reduceSessionEvent(state, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "one two" }] },
    } as never);
    expect(state.activeMessageKey).toBeUndefined();
    expect(state.messages[0]!.streaming).toBe(false);
  });
});
