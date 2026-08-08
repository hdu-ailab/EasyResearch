import { describe, expect, it } from "vitest";
import { fromSnapshot, reduceSessionEvent, type SessionViewState } from "./session-reducer";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const emptyState: SessionViewState = { messages: [], tools: [], isStreaming: false, error: null, nextOrder: 0 };

function userMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }] } as never;
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

function toolEvent(type: "tool_execution_start" | "tool_execution_end", toolCallId = "t1", toolName = "bash"): AgentSessionEvent {
  return { type, toolCallId, toolName, args: {} } as AgentSessionEvent;
}

describe("session reducer", () => {
  it("hydrates from a snapshot", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: true, status: "running" } as never,
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

  it("appends a message on message_start", () => {
    const state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.role).toBe("assistant");
    expect(state.messages[0]!.streaming).toBe(true);
    expect(state.isStreaming).toBe(true);
  });

  it("updates the streaming message in place per token delta", () => {
    const started = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    const first = reduceSessionEvent(started, assistantEvent("message_update", "two "));
    const second = reduceSessionEvent(first, assistantEvent("message_update", "deltas"));
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]!.text).toBe("two deltas");
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
    const withUser = reduceSessionEvent(emptyState, { type: "message_start", message: userMessage("question") } as AgentSessionEvent);
    const streaming = reduceSessionEvent(withUser, assistantEvent("message_start", ""));
    expect(streaming.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(streaming.messages[0]!.streaming).toBe(false);
  });

  it("splits thinking blocks into reasoning, keeping the body text", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
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

  it("pairs snapshot toolCall blocks with toolResult messages", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
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

  it("orders tools at their stream position, interleaving with messages", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
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

  it("labels a subagent-line dispatch as orchestrator, not the user", () => {
    const state = fromSnapshot({
      session: { id: "s2", cwd: "/p", sessionName: "lazyresearch:search", isStreaming: false, status: "done" } as never,
      messages: [
        { role: "user", content: [{ type: "text", text: "Task: search papers" }] },
        { role: "assistant", content: [{ type: "text", text: "found 3 papers" }] },
      ] as never,
    });
    expect(state.subagentName).toBe("search");
    expect(state.messages[0]).toMatchObject({ role: "user", label: "Orchestrator" });
    expect(state.messages[1]).toMatchObject({ role: "assistant", label: "search" });
  });

  it("keeps plain sessions user-labeled and unlabeled assistants", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
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
    let state = reduceSessionEvent(emptyState, { type: "message_start", message: userMessage("go") } as AgentSessionEvent);
    state = reduceSessionEvent(state, assistantEvent("message_start", "running"));
    state = reduceSessionEvent(state, toolEvent("tool_execution_start", "t1", "bash"));
    const final = reduceSessionEvent(state, assistantEvent("message_start", "done"));
    expect(final.messages.map((m) => m.order)).toEqual([0, 1, 3]);
    expect(final.tools.map((t) => t.order)).toEqual([2]);
  });

  it("attaches subagent progress to the matching tool on tool_execution_update", () => {
    let state = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "subagent"));
    state = reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "subagent",
      args: { agent: "search" },
      partialResult: { details: { subagent: { agent: "search", step: 2, status: "running", lastText: "looking at arxiv entries" } } },
    } as never);
    expect(state.tools[0]!.progress).toContain("looking at arxiv entries");
    expect(state.tools[0]!.running).toBe(true);
    expect(state.messages).toHaveLength(0);
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
      args: { chain: [{ agent: "search", task: "first" }, { agent: "writing", task: "then" }] },
    } as never);
    expect(state.tools[0]).toMatchObject({ agentName: "search" });
  });

  it("captures the agent name from snapshot subagent toolCall blocks (JSON-string args)", () => {
    const state = fromSnapshot({
      session: { id: "s1", cwd: "/p", isStreaming: false, status: "done" } as never,
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-1", name: "subagent", arguments: '{"agent":"figures","task":"draw"}' }],
        },
      ] as never,
    });
    expect(state.tools[0]).toMatchObject({ name: "subagent", agentName: "figures" });
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

  it("does not overwrite progress with a later empty update", () => {
    let state = reduceSessionEvent(emptyState, toolEvent("tool_execution_start", "t1", "subagent"));
    state = reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "subagent",
      partialResult: { details: { subagent: { agent: "search", lastText: "first" } } },
    } as never);
    state = reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "subagent",
      partialResult: { details: {} },
    } as never);
    expect(state.tools[0]!.progress).toContain("first");
  });

  it("resolves message_update deltas by the message_start key, even without ids", () => {
    let state = reduceSessionEvent(emptyState, assistantEvent("message_start", ""));
    expect(state.activeMessageKey).toBe("0");
    state = reduceSessionEvent(state, assistantEvent("message_update", "one "));
    state = reduceSessionEvent(state, assistantEvent("message_update", "two"));
    expect(state.messages[0]!.text).toBe("one two");
    state = reduceSessionEvent(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "one two" }] } } as never);
    expect(state.activeMessageKey).toBeUndefined();
    expect(state.messages[0]!.streaming).toBe(false);
  });
});
