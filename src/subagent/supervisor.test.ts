import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AGENT_ALIAS_ENTRY } from "./agent-alias";
import type { AgentConfig } from "./agents";
import { SubagentCoordinator, type CoordinatorSessionManager, type ReservedDispatch } from "./coordinator";
import type { SubagentSupervisorEvent } from "./contracts";
import type { StageLaunchHandle, StageRunResult } from "./stage-session";
import { SubagentSupervisor, type SupervisableAgentSession } from "./supervisor";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function turn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const searchAgent: AgentConfig = {
  name: "search",
  description: "Search",
  enabled: true,
  builtin: true,
  source: "bundled",
  filePath: "/agents/search.md",
  systemPrompt: "Search carefully.",
  tools: ["read"],
  effectiveTools: ["read"],
  skills: ["paper-search"],
  effectiveSkills: ["paper-search"],
  missingSkills: [],
  subagents: [],
};

function assistant(text: string): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function result(
  text = "status: complete",
  overrides: Partial<StageRunResult> = {},
): StageRunResult {
  return {
    agent: "search",
    agentSource: "bundled",
    task: "find papers",
    exitCode: 0,
    messages: [assistant(text) as Message],
    stderr: "",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
    stopReason: "stop",
    agentId: "search_0",
    ...overrides,
  };
}

class MemorySessionManager implements CoordinatorSessionManager {
  readonly entries: unknown[] = [];
  private sequence = 0;

  getSessionId(): string {
    return "parent";
  }

  getSessionFile(): string {
    return "/sessions/parent.jsonl";
  }

  getEntries(): unknown[] {
    return this.entries;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const id = `entry-${this.sequence++}`;
    this.entries.push({ type: "custom", id, customType, data });
    return id;
  }
}

interface SentMessage {
  message: { customType: string; content: string; display: boolean; details?: unknown };
  options: { deliverAs: "steer"; triggerTurn: boolean };
}

class FakeParentSession implements SupervisableAgentSession {
  readonly sessionId = "parent";
  readonly sessionFile = "/sessions/parent.jsonl";
  isStreaming = false;
  readonly sent: SentMessage[] = [];
  readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  abortCalls = 0;
  disposeCalls = 0;
  sendImpl?: (sent: SentMessage, index: number) => Promise<void>;

  constructor(private readonly autoAcknowledge = false) {}

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendCustomMessage(
    message: SentMessage["message"],
    options: SentMessage["options"],
  ): Promise<void> {
    const sent = { message, options };
    this.sent.push(sent);
    await this.sendImpl?.(sent, this.sent.length - 1);
    if (this.autoAcknowledge) {
      this.emit({ type: "message_end", message: { role: "custom", ...message, timestamp: 1 } } as AgentSessionEvent);
    }
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  acknowledgeLaunch(toolCallId: string): void {
    this.emit({ type: "tool_execution_end", toolCallId, toolName: "subagent", isError: false } as AgentSessionEvent);
  }

  acknowledgeLastMessage(): void {
    const sent = this.sent.at(-1);
    if (!sent) throw new Error("No notification was sent.");
    this.emit({ type: "message_end", message: { role: "custom", ...sent.message, timestamp: 1 } } as AgentSessionEvent);
  }
}

class FakeStage {
  readonly materialization = deferred<void>();
  readonly completion = deferred<StageRunResult>();
  readonly listeners = new Set<(event: JsonAgentSessionEvent) => void>();
  abortCalls = 0;
  disposeCalls = 0;
  unsubscribeCalls = 0;
  abortImpl: () => Promise<void> = async () => {};
  readonly handle: StageLaunchHandle;

  constructor(
    readonly agentId: string,
    readonly childSessionId: string,
    readonly sessionPath: string,
  ) {
    this.handle = {
      agentId,
      childSessionId,
      sessionPath,
      materialized: this.materialization.promise,
      completion: this.completion.promise,
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => {
          if (this.listeners.delete(listener)) this.unsubscribeCalls += 1;
        };
      },
      abort: async () => {
        this.abortCalls += 1;
        await this.abortImpl();
      },
      dispose: async () => {
        this.disposeCalls += 1;
      },
    };
  }

  emit(event: JsonAgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function reserve(coordinator: SubagentCoordinator, toolCallId: string, requested = "search"): ReservedDispatch {
  return coordinator.reserveDispatch({
    ownerSessionId: "parent",
    toolCallId,
    requested,
    catalog: { all: [searchAgent], available: [searchAgent] },
  });
}

function options(task = "find papers", cwd = "/exact/project") {
  return { agent: searchAgent, task, cwd };
}

function makeHarness(input: {
  launchStage: (reservation: ReservedDispatch) => Promise<StageLaunchHandle>;
  autoAcknowledge?: boolean;
  schedule?: (run: () => void) => void;
  createId?: () => string;
}) {
  const manager = new MemorySessionManager();
  const coordinator = new SubagentCoordinator(manager);
  const parent = new FakeParentSession(input.autoAcknowledge);
  let batchSequence = 0;
  const supervisor = new SubagentSupervisor({
    coordinator,
    launchStage: (launchOptions) => input.launchStage(launchOptions.reservation),
    now: () => "2026-08-19T00:00:00.000Z",
    createId: input.createId ?? (() => `batch-${batchSequence++}`),
    ...(input.schedule ? { schedule: input.schedule } : {}),
  });
  supervisor.attach(parent);
  return { manager, coordinator, parent, supervisor };
}

describe("SubagentSupervisor ownership and launch ordering", () => {
  it("acknowledges materialization while retaining completion ownership", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      autoAcknowledge: true,
    });
    const reservation = reserve(coordinator, "tool-0");

    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();

    await expect(launching).resolves.toEqual({
      mode: "single",
      background: true,
      job: {
        launchId: reservation.launchId,
        ownerSessionId: "parent",
        toolCallId: "tool-0",
        agent: "search",
        agentId: "search_0",
        childSessionId: "child-0",
        status: "working",
      },
    });
    expect(supervisor.hasRunningChildren()).toBe(true);
    parent.acknowledgeLaunch("tool-0");
    stage.completion.resolve(result());
    await supervisor.waitForQuiescence();
    expect(stage.disposeCalls).toBe(1);
  });

  it("holds a short child's terminal event until the parent launch tool ends", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      autoAcknowledge: true,
    });
    const events: SubagentSupervisorEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const reservation = reserve(coordinator, "tool-0");

    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    stage.completion.resolve(result("short result"));
    await turn();

    expect(events).not.toContainEqual(expect.objectContaining({ status: "complete" }));
    expect(coordinator.summaries()).toContainEqual(expect.objectContaining({ agentId: "search_0", status: "working" }));
    expect(parent.sent).toEqual([]);

    parent.acknowledgeLaunch("tool-0");
    await supervisor.waitForQuiescence();
    expect(events).toContainEqual(expect.objectContaining({ agentId: "search_0", status: "complete" }));
  });

  it("cleans up a pre-materialization failure without publishing terminal state", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/private-child.jsonl");
    stage.abortImpl = async () => {
      stage.completion.resolve(result("", { exitCode: 1, errorMessage: "provider failed", stderr: "provider failed" }));
    };
    const { coordinator, parent, supervisor } = makeHarness({ launchStage: async () => stage.handle });
    const events: SubagentSupervisorEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const reservation = reserve(coordinator, "tool-0");

    const launching = supervisor.launch(reservation, options());
    stage.materialization.reject(new Error("provider failed before output"));

    await expect(launching).rejects.toThrow("provider failed before output");
    expect(stage.abortCalls).toBe(1);
    expect(stage.disposeCalls).toBe(1);
    expect(stage.unsubscribeCalls).toBe(1);
    expect(supervisor.hasRunningChildren()).toBe(false);
    expect(coordinator.journal().jobs.get(reservation.launchId)?.status).toBe("pre_materialization_failed");
    expect(events).toEqual([]);
    expect(parent.sent).toEqual([]);
  });

  it("passes continuation identity and the exact cwd to the launcher", async () => {
    const stage = new FakeStage("search_0", "saved-child", "/sessions/saved-child.jsonl");
    const manager = new MemorySessionManager();
    manager.appendCustomEntry(AGENT_ALIAS_ENTRY, {
      id: "search_0",
      agent: "search",
      sessionId: "saved-child",
      sessionPath: "/sessions/saved-child.jsonl",
    });
    const coordinator = new SubagentCoordinator(manager);
    const parent = new FakeParentSession(true);
    const launchStage = vi.fn(async () => stage.handle);
    const supervisor = new SubagentSupervisor({ coordinator, launchStage });
    supervisor.attach(parent);
    const reservation = reserve(coordinator, "tool-1", "search_0");

    const launching = supervisor.launch(reservation, options("continue search", "/exact/project"));
    stage.materialization.resolve();
    await launching;

    expect(launchStage).toHaveBeenCalledWith({
      reservation,
      coordinator,
      agent: searchAgent,
      task: "continue search",
      cwd: "/exact/project",
    });
    parent.acknowledgeLaunch("tool-1");
    stage.completion.resolve(result("continued", { sessionId: "saved-child", sessionPath: stage.sessionPath }));
    await supervisor.waitForQuiescence();
  });

  it("owns same-role children through independent handles and event identities", async () => {
    const first = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const second = new FakeStage("search_1", "child-1", "/sessions/child-1.jsonl");
    const stages = new Map([["search_0", first], ["search_1", second]]);
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async (reservation) => stages.get(reservation.agentId)!.handle,
      autoAcknowledge: true,
    });
    const events: SubagentSupervisorEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const reservation0 = reserve(coordinator, "tool-0");
    const reservation1 = reserve(coordinator, "tool-1");

    const launch0 = supervisor.launch(reservation0, options("first"));
    const launch1 = supervisor.launch(reservation1, options("second"));
    first.materialization.resolve();
    second.materialization.resolve();
    await Promise.all([launch0, launch1]);

    first.emit({ type: "agent_start" } as JsonAgentSessionEvent);
    second.emit({ type: "agent_start" } as JsonAgentSessionEvent);
    expect(events).toContainEqual(expect.objectContaining({ agentId: "search_0", childSessionId: "child-0", event: { type: "agent_start" } }));
    expect(events).toContainEqual(expect.objectContaining({ agentId: "search_1", childSessionId: "child-1", event: { type: "agent_start" } }));

    parent.acknowledgeLaunch("tool-0");
    parent.acknowledgeLaunch("tool-1");
    first.completion.resolve(result("first done", { agentId: "search_0" }));
    second.completion.resolve(result("second done", { agentId: "search_1" }));
    await supervisor.waitForQuiescence();
    expect([first.disposeCalls, second.disposeCalls]).toEqual([1, 1]);
  });

  it("uses the latest non-empty assistant text for the terminal handoff", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      autoAcknowledge: true,
    });
    const reservation = reserve(coordinator, "tool-0");

    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    stage.emit({ type: "message_end", message: assistant("usable final text") } as JsonAgentSessionEvent);
    stage.emit({ type: "message_end", message: assistant("  \n\t") } as JsonAgentSessionEvent);
    parent.acknowledgeLaunch("tool-0");
    stage.completion.resolve(result("", { messages: [assistant("usable final text") as Message, assistant("  \n\t") as Message] }));

    await supervisor.waitForQuiescence();
    expect(parent.sent[0]?.message.content).toContain("Agent: search_0\nResult: usable final text");
  });

  it("disposes subscriptions and handles idempotently", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      autoAcknowledge: true,
    });
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");
    stage.completion.resolve(result());
    await supervisor.waitForQuiescence();

    await Promise.all([supervisor.dispose(), supervisor.dispose()]);
    expect(stage.disposeCalls).toBe(1);
    expect(stage.unsubscribeCalls).toBe(1);
    expect(parent.listeners.size).toBe(0);
    expect(parent.disposeCalls).toBe(0);
  });
});

describe("SubagentSupervisor notification acknowledgement", () => {
  it("coalesces scheduled outcomes and captures the full Working state", async () => {
    const first = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const second = new FakeStage("search_1", "child-1", "/sessions/child-1.jsonl");
    const working = new FakeStage("search_2", "child-2", "/sessions/child-2.jsonl");
    const stages = new Map([["search_0", first], ["search_1", second], ["search_2", working]]);
    const scheduled: Array<() => void> = [];
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async (reservation) => stages.get(reservation.agentId)!.handle,
      schedule: (run) => scheduled.push(run),
    });
    const reservations = [reserve(coordinator, "tool-0"), reserve(coordinator, "tool-1"), reserve(coordinator, "tool-2")];
    const launches = reservations.map((reservation, index) => supervisor.launch(reservation, options(`task-${index}`)));
    first.materialization.resolve();
    second.materialization.resolve();
    working.materialization.resolve();
    await Promise.all(launches);
    reservations.forEach(({ toolCallId }) => parent.acknowledgeLaunch(toolCallId));

    first.completion.resolve(result("first", { agentId: "search_0" }));
    second.completion.resolve(result("second", { agentId: "search_1" }));
    await turn();

    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await turn();
    expect(parent.sent).toHaveLength(1);
    expect(parent.sent[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(parent.sent[0]?.message.content).toContain("Working subagent:search_2");
    expect(parent.sent[0]?.message.content).toContain("Complete subagent:search_0\nComplete subagent:search_1");

    parent.acknowledgeLastMessage();
    working.completion.resolve(result("third", { agentId: "search_2" }));
    await turn();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await turn();
    parent.acknowledgeLastMessage();
    await supervisor.waitForQuiescence();
  });

  it("freezes a batch at real send time and leaves later outcomes for the next batch", async () => {
    const first = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const second = new FakeStage("search_1", "child-1", "/sessions/child-1.jsonl");
    const stages = new Map([["search_0", first], ["search_1", second]]);
    const scheduled: Array<() => void> = [];
    const sendGate = deferred<void>();
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async (reservation) => stages.get(reservation.agentId)!.handle,
      schedule: (run) => scheduled.push(run),
    });
    parent.sendImpl = async (_sent, index) => {
      if (index === 0) await sendGate.promise;
    };
    const reservation0 = reserve(coordinator, "tool-0");
    const reservation1 = reserve(coordinator, "tool-1");
    const launch0 = supervisor.launch(reservation0, options("first"));
    const launch1 = supervisor.launch(reservation1, options("second"));
    first.materialization.resolve();
    second.materialization.resolve();
    await Promise.all([launch0, launch1]);
    parent.acknowledgeLaunch("tool-0");
    parent.acknowledgeLaunch("tool-1");

    first.completion.resolve(result("first", { agentId: "search_0" }));
    await turn();
    const firstSend = supervisor.flushNotifications();
    await turn();
    expect(parent.sent[0]?.message.content).toContain("Complete subagent:search_0");
    expect(parent.sent[0]?.message.content).not.toContain("Complete subagent:search_1");

    second.completion.resolve(result("second", { agentId: "search_1" }));
    await turn();
    expect(parent.sent[0]?.message.content).not.toContain("Complete subagent:search_1");
    sendGate.resolve();
    await firstSend;
    parent.acknowledgeLastMessage();

    await supervisor.flushNotifications();
    expect(parent.sent[1]?.message.content).toContain("Complete subagent:search_1");
    expect(parent.sent[1]?.message.content).not.toContain("Complete subagent:search_0");
    parent.acknowledgeLastMessage();
    await supervisor.waitForQuiescence();
  });

  it("consumes a batch only after observing its live hidden custom message", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      schedule: () => {},
    });
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");
    stage.completion.resolve(result());
    await turn();

    await supervisor.flushNotifications();
    expect(supervisor.hasPendingNotifications()).toBe(true);
    expect(supervisor.isQuiescent()).toBe(false);
    parent.acknowledgeLastMessage();
    expect(supervisor.hasPendingNotifications()).toBe(false);
    await supervisor.waitForQuiescence();
  });

  it("recognizes persisted custom-message acknowledgement", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      schedule: () => {},
    });
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");
    stage.completion.resolve(result());
    await turn();
    await supervisor.flushNotifications();
    const sent = parent.sent[0]!;

    parent.emit({
      type: "entry_appended",
      entry: {
        type: "custom_message",
        id: "custom-0",
        parentId: null,
        timestamp: "2026-08-19T00:00:00.000Z",
        ...sent.message,
      },
    } as AgentSessionEvent);

    expect(supervisor.hasPendingNotifications()).toBe(false);
    await supervisor.waitForQuiescence();
  });

  it("keeps a failed send retryable with the same frozen batch", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      schedule: () => {},
    });
    parent.sendImpl = async (_sent, index) => {
      if (index === 0) throw new Error("send failed");
    };
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");
    stage.completion.resolve(result());
    await turn();

    await expect(supervisor.flushNotifications()).rejects.toThrow("send failed");
    expect(supervisor.hasPendingNotifications()).toBe(true);
    await supervisor.flushNotifications();
    expect(parent.sent[1]?.message).toEqual(parent.sent[0]?.message);
    parent.acknowledgeLastMessage();
    expect(supervisor.hasPendingNotifications()).toBe(false);
    await supervisor.waitForQuiescence();
  });

  it("does not resend acknowledged terminal membership", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      schedule: () => {},
    });
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");
    stage.completion.resolve(result());
    await turn();

    await supervisor.flushNotifications();
    parent.acknowledgeLastMessage();
    await supervisor.flushNotifications();

    expect(parent.sent).toHaveLength(1);
    expect(coordinator.journal().acknowledgedBatchIds).toContain("batch-0");
    await supervisor.waitForQuiescence();
  });

  it("keeps startup, active sends, and unacknowledged batches non-quiescent", async () => {
    const startup = deferred<StageLaunchHandle>();
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const sendGate = deferred<void>();
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => startup.promise,
      schedule: () => {},
    });
    parent.sendImpl = async () => sendGate.promise;
    const reservation = reserve(coordinator, "tool-0");

    const launching = supervisor.launch(reservation, options());
    expect(supervisor.isQuiescent()).toBe(false);
    expect(supervisor.hasRunningChildren()).toBe(true);
    startup.resolve(stage.handle);
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");
    stage.completion.resolve(result());
    await turn();

    const sending = supervisor.flushNotifications();
    await turn();
    expect(supervisor.isQuiescent()).toBe(false);
    sendGate.resolve();
    await sending;
    expect(supervisor.isQuiescent()).toBe(false);
    parent.acknowledgeLastMessage();
    await supervisor.waitForQuiescence();
    expect(supervisor.isQuiescent()).toBe(true);
  });
});

describe("SubagentSupervisor recursive abort", () => {
  it("sets closing before awaiting startup and cleans up an unacknowledged child without notification", async () => {
    const startup = deferred<StageLaunchHandle>();
    const stage = new FakeStage("search_0", "child-0", "/sessions/private-child.jsonl");
    stage.abortImpl = async () => {
      stage.completion.resolve(result("", {
        exitCode: 1,
        wasAborted: true,
        errorMessage: "shutdown",
        stderr: "shutdown",
      }));
      stage.materialization.reject(new Error("shutdown before materialization"));
    };
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => startup.promise,
      schedule: () => {},
    });
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());

    const aborting = supervisor.abortAll("shutdown");
    expect(() => reserve(coordinator, "tool-1")).toThrow(/closing/i);
    startup.resolve(stage.handle);

    await expect(launching).rejects.toThrow("shutdown before materialization");
    await aborting;
    expect(stage.abortCalls).toBe(1);
    expect(stage.disposeCalls).toBe(1);
    expect(parent.sent).toEqual([]);
    expect(supervisor.hasRunningChildren()).toBe(false);
  });

  it("waits for descendant settlement, publishes one path-free Error, then sends without triggering", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/private-child.jsonl");
    const nestedSettled = deferred<void>();
    const order: string[] = [];
    stage.abortImpl = async () => {
      order.push("abort");
      await nestedSettled.promise;
      order.push("descendants-settled");
      stage.completion.resolve(result("partial handoff", {
        exitCode: 1,
        wasAborted: true,
        errorMessage: "user stopped",
        stderr: "user stopped",
      }));
    };
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      schedule: () => {},
    });
    const events: SubagentSupervisorEvent[] = [];
    coordinator.subscribe((event) => {
      events.push(event);
      if (event.status === "error") order.push("published");
    });
    parent.sendImpl = async () => {
      order.push("sent");
    };
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");

    const aborting = supervisor.abortAll("user stopped");
    await turn();
    expect(order).toEqual(["abort"]);
    expect(parent.sent).toEqual([]);
    nestedSettled.resolve();
    await aborting;

    expect(order).toEqual(["abort", "descendants-settled", "published", "sent"]);
    expect(events.filter((event) => event.status === "error")).toHaveLength(1);
    expect(Object.hasOwn(events.find((event) => event.status === "error") ?? {}, "sessionPath")).toBe(false);
    expect(parent.sent).toHaveLength(1);
    expect(parent.sent[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(parent.sent[0]?.message.content).toContain(
      'Error subagent:{"name":"search_0","session_path":"/sessions/private-child.jsonl"}',
    );
    expect(parent.sent[0]?.message.content.match(/Error subagent:/g)).toHaveLength(1);
    expect(stage.disposeCalls).toBe(1);

    parent.acknowledgeLastMessage();
    await supervisor.waitForQuiescence();
    await supervisor.abortAll("duplicate stop");
    expect(stage.abortCalls).toBe(1);
    expect(parent.sent).toHaveLength(1);
  });

  it("reclassifies a pre-materialization successful settlement when closing wins the launch race", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/short-child.jsonl");
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      schedule: () => {},
    });
    const events: SubagentSupervisorEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.completion.resolve(result("short success"));
    await turn();

    const aborting = supervisor.abortAll("stop won the race");
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");
    await aborting;

    expect(events).toContainEqual(expect.objectContaining({ agentId: "search_0", status: "error" }));
    expect(events).not.toContainEqual(expect.objectContaining({ agentId: "search_0", status: "complete" }));
    expect(parent.sent[0]?.options.triggerTurn).toBe(false);
    expect(parent.sent[0]?.message.content).toContain(
      'Error subagent:{"name":"search_0","session_path":"/sessions/short-child.jsonl"}',
    );
    parent.acknowledgeLastMessage();
    await supervisor.waitForQuiescence();
  });

  it("supersedes an unacknowledged batch and persists one merged closing batch", async () => {
    const completed = new FakeStage("search_0", "child-0", "/sessions/completed.jsonl");
    const running = new FakeStage("search_1", "child-1", "/sessions/running.jsonl");
    running.abortImpl = async () => {
      running.completion.resolve(result("running partial", {
        agentId: "search_1",
        exitCode: 1,
        wasAborted: true,
        errorMessage: "shutdown",
        stderr: "shutdown",
      }));
    };
    const stages = new Map([["search_0", completed], ["search_1", running]]);
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async (reservation) => stages.get(reservation.agentId)!.handle,
      schedule: () => {},
    });
    const reservation0 = reserve(coordinator, "tool-0");
    const reservation1 = reserve(coordinator, "tool-1");
    const launch0 = supervisor.launch(reservation0, options("completed"));
    const launch1 = supervisor.launch(reservation1, options("running"));
    completed.materialization.resolve();
    running.materialization.resolve();
    await Promise.all([launch0, launch1]);
    parent.acknowledgeLaunch("tool-0");
    parent.acknowledgeLaunch("tool-1");
    completed.completion.resolve(result("completed handoff", { agentId: "search_0" }));
    await turn();
    await supervisor.flushNotifications();
    expect(parent.sent).toHaveLength(1);
    expect(parent.sent[0]?.options.triggerTurn).toBe(true);

    await supervisor.abortAll("shutdown");

    expect(parent.sent).toHaveLength(2);
    expect(parent.sent[1]?.options).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(parent.sent[1]?.message.content).toContain("Complete subagent:search_0");
    expect(parent.sent[1]?.message.content).toContain(
      'Error subagent:{"name":"search_1","session_path":"/sessions/running.jsonl"}',
    );
    expect(coordinator.journal().supersededBatchIds).toContain("batch-0");
    expect(coordinator.journal().pendingBatches.map(({ batchId }) => batchId)).toEqual(["batch-1"]);
    parent.acknowledgeLastMessage();
    await supervisor.waitForQuiescence();
  });
});
