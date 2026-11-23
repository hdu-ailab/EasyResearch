import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { emptyState, fromSnapshot, reduceSessionEvent, reduceSubagentSupervisorEvent } from "./session-reducer";

describe("background subagent admission projection", () => {
  const args = {
    agent: "search",
    description: "Find literature",
    prompt: "Read the papers",
    sessionID: "child-native",
    model: "provider/model",
  };
  const start = {
    type: "tool_execution_start",
    toolCallId: "dispatch",
    toolName: "subagent",
    args,
  } as AgentSessionEvent;
  const result = {
    content: [{ type: "text", text: "Accepted child" }],
    details: { mode: "single", results: [], sessionID: "child-native", status: "running", output: "" },
  };
  const end = {
    type: "tool_execution_end",
    toolCallId: "dispatch",
    toolName: "subagent",
    result,
    isError: false,
  } as AgentSessionEvent;
  it("exposes the actual child identity before any model event and keeps it through root settlement", () => {
    let view = reduceSessionEvent(emptyState, start);
    view = reduceSessionEvent(view, end);
    expect(view.tools[0]).toMatchObject({
      agentName: "search",
      args: "Find literature",
      taskDescription: "Find literature",
      sessionId: "child-native",
      running: true,
      done: false,
    });
    view = reduceSessionEvent(view, { type: "agent_settled" } as AgentSessionEvent);
    expect(view.tools[0]?.running).toBe(true);
  });
  it("does not let a late admission result erase newer supervisor completion", () => {
    let view = reduceSessionEvent(emptyState, start);
    view = reduceSubagentSupervisorEvent(view, {
      type: "subagent_supervisor",
      launchId: "launch",
      toolCallId: "dispatch",
      ownerSessionId: "root",
      childSessionId: "child-native",
      agent: "search",
      agentId: "search_0",
      status: "complete",
      latestMessage: "Found papers",
    });
    view = reduceSessionEvent(view, end);
    expect(view.tools[0]).toMatchObject({
      sessionId: "child-native",
      running: false,
      done: true,
      latestMessage: "Found papers",
    });
  });
  it("retains early native identity in history without reviving an old running acknowledgement", () => {
    const view = fromSnapshot({
      runtimeConfigurationGeneration: 0,
      session: { id: "root", cwd: "/p", status: "ready", isStreaming: false },
      subagents: [],
      timeline: [
        {
          kind: "message",
          entryId: "call",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "dispatch", name: "subagent", arguments: args }],
          },
        },
        {
          kind: "message",
          entryId: "result",
          message: { role: "toolResult", toolCallId: "dispatch", toolName: "subagent", ...result },
        },
      ],
    } as never);
    expect(view.tools[0]).toMatchObject({
      sessionId: "child-native",
      running: false,
      done: true,
      args: "Find literature",
    });
  });
});
