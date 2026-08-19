import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AGENT_ALIAS_ENTRY, readAgentAliases } from "./agent-alias";
import type { AgentConfig } from "./agents";
import { SubagentCoordinator, type CoordinatorSessionManager, type ReservedDispatch } from "./coordinator";
import type { SubagentSupervisorEvent } from "./contracts";
import { AGENT_STATUS_TYPE } from "./notifications";
import { readSubagentSessionLinks, SUBAGENT_SESSION_LINK_ENTRY } from "./session-links";
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
  appendImpl?: (customType: string, data?: unknown) => void;

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
    this.appendImpl?.(customType, data);
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
  disposeImpl: () => Promise<void> = async () => {};
  subscribeError?: Error;
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
        if (this.subscribeError) throw this.subscribeError;
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
        await this.disposeImpl();
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

  it("holds raw terminal child events until launch acknowledgement while forwarding delta progress", async () => {
    const nestedPath = "/sessions/private-nested-child.jsonl";
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

    stage.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "progress" },
    } as JsonAgentSessionEvent);
    stage.emit({
      type: "agent_end",
      messages: [
        assistant("short result"),
        {
          role: "custom",
          customType: AGENT_STATUS_TYPE,
          content: `<agent_status>\nError subagent:{"name":"search_1","session_path":"${nestedPath}"}\n</agent_status>`,
          display: false,
          details: { batchId: "nested-terminal" },
          timestamp: 1,
        },
      ],
      willRetry: false,
    } as JsonAgentSessionEvent);
    stage.completion.resolve(result("short result"));
    await turn();

    expect(events).toContainEqual(expect.objectContaining({
      event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "progress" } },
    }));
    expect(events.some((event) => event.event?.type === "agent_end")).toBe(false);

    parent.acknowledgeLaunch("tool-0");
    await supervisor.waitForQuiescence();
    expect(events.some((event) => event.event?.type === "agent_end")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(AGENT_STATUS_TYPE);
    expect(JSON.stringify(events)).not.toContain(nestedPath);
    expect(events.at(-1)).toMatchObject({ agentId: "search_0", status: "complete" });
  });

  it("never publishes nested hidden status events or their path-bearing content", async () => {
    const leakedPath = "/sessions/private-nested-child.jsonl";
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
    const content = `<agent_status>\nError subagent:{"name":"search_1","session_path":"${leakedPath}"}\n</agent_status>`;

    stage.emit({
      type: "message_end",
      message: { role: "custom", customType: AGENT_STATUS_TYPE, content, display: false, details: { batchId: "nested-live" }, timestamp: 1 },
    } as JsonAgentSessionEvent);
    stage.emit({
      type: "entry_appended",
      entry: {
        type: "custom_message",
        id: "nested-entry",
        parentId: null,
        timestamp: "2026-08-19T00:00:00.000Z",
        customType: AGENT_STATUS_TYPE,
        content,
        display: false,
        details: { batchId: "nested-persisted" },
      },
    } as JsonAgentSessionEvent);

    expect(JSON.stringify(events)).not.toContain(AGENT_STATUS_TYPE);
    expect(JSON.stringify(events)).not.toContain(leakedPath);
    parent.acknowledgeLaunch("tool-0");
    stage.completion.resolve(result());
    await supervisor.waitForQuiescence();
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

  it.each(["created", "materialized"] as const)(
    "cleans up a returned handle when the %s journal transition fails",
    async (failedKind) => {
      const stage = new FakeStage("search_0", "child-0", "/sessions/private-child.jsonl");
      stage.abortImpl = async () => {
        stage.completion.resolve(result("", {
          exitCode: 1,
          wasAborted: true,
          errorMessage: "launch transition failed",
          stderr: "launch transition failed",
        }));
      };
      const { manager, coordinator, supervisor } = makeHarness({ launchStage: async () => stage.handle });
      const reservation = reserve(coordinator, "tool-0");
      const transitionFailure = new Error(`${failedKind} persistence failed`);
      let failed = false;
      manager.appendImpl = (_customType, data) => {
        if (
          !failed
          && data !== null
          && typeof data === "object"
          && "kind" in data
          && data.kind === failedKind
        ) {
          failed = true;
          throw transitionFailure;
        }
      };

      const launching = supervisor.launch(reservation, options());
      if (failedKind === "materialized") stage.materialization.resolve();
      const launchError = await launching.then(
        () => undefined,
        (error) => error,
      );
      const stateAfterRejection = {
        abortCalls: stage.abortCalls,
        disposeCalls: stage.disposeCalls,
        unsubscribeCalls: stage.unsubscribeCalls,
        hasRunningChildren: supervisor.hasRunningChildren(),
        status: coordinator.journal().jobs.get(reservation.launchId)?.status,
      };
      manager.appendImpl = undefined;
      if (stateAfterRejection.hasRunningChildren) await supervisor.dispose();

      expect(launchError).toBe(transitionFailure);
      expect(stateAfterRejection).toEqual({
        abortCalls: 1,
        disposeCalls: 1,
        unsubscribeCalls: 1,
        hasRunningChildren: false,
        status: "pre_materialization_failed",
      });
    },
  );

  it("does not resume an alias left by partial materialization persistence", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/partial-alias.jsonl");
    stage.abortImpl = async () => {
      stage.completion.resolve(result("", {
        exitCode: 1,
        wasAborted: true,
        errorMessage: "materialization persistence failed",
        stderr: "materialization persistence failed",
      }));
    };
    const { manager, coordinator, supervisor } = makeHarness({ launchStage: async () => stage.handle });
    const reservation = reserve(coordinator, "tool-0");
    const persistenceFailure = new Error("session link persistence failed");
    let failed = false;
    manager.appendImpl = (customType) => {
      if (!failed && customType === SUBAGENT_SESSION_LINK_ENTRY) {
        failed = true;
        throw persistenceFailure;
      }
    };

    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await expect(launching).rejects.toBe(persistenceFailure);
    manager.appendImpl = undefined;

    expect(readAgentAliases(manager.entries)).toEqual([{
      id: "search_0",
      agent: "search",
      sessionId: "child-0",
      sessionPath: "/sessions/partial-alias.jsonl",
    }]);
    expect(readSubagentSessionLinks(manager.entries)).toEqual([]);
    expect(coordinator.journal().jobs.get(reservation.launchId)).toMatchObject({
      agentId: "search_0",
      status: "pre_materialization_failed",
    });
    expect(coordinator.summaries()).toEqual([]);
    expect(() => reserve(coordinator, "tool-1", "search_0")).toThrow(/unknown|resume|continu/i);

    const next = reserve(coordinator, "tool-2");
    expect(next.agentId).toBe("search_1");
  });

  it("isolates throwing coordinator subscribers from launch and terminal delivery", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      autoAcknowledge: true,
    });
    const observerFailure = new Error("observer failed");
    const throwingObserver = vi.fn(() => { throw observerFailure; });
    const observed: SubagentSupervisorEvent[] = [];
    const unsubscribeThrowing = coordinator.subscribe(throwingObserver);
    coordinator.subscribe((event) => observed.push(event));
    const reservation = reserve(coordinator, "tool-0");

    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    const launchOutcome = await launching.then(
      (details) => details,
      (error) => error,
    );
    if (launchOutcome instanceof Error) unsubscribeThrowing();

    expect(launchOutcome).toMatchObject({ job: { agentId: "search_0", status: "working" } });
    expect(observed).toContainEqual(expect.objectContaining({ agentId: "search_0", status: "working" }));

    parent.acknowledgeLaunch("tool-0");
    stage.completion.resolve(result("terminal handoff"));
    await supervisor.waitForQuiescence();

    expect(throwingObserver).toHaveBeenCalledTimes(2);
    expect(observed.map(({ status }) => status)).toEqual(["working", "complete"]);
    expect(parent.sent).toHaveLength(1);
    expect(parent.sent[0]?.message.content).toContain("Complete subagent:search_0");
    unsubscribeThrowing();
  });

  it("settles and disposes a returned handle when identity validation fails", async () => {
    const stage = new FakeStage("wrong-agent-id", "child-0", "/sessions/child-0.jsonl");
    stage.abortImpl = async () => {
      stage.completion.resolve(result("", {
        exitCode: 1,
        wasAborted: true,
        errorMessage: "identity rejected",
        stderr: "identity rejected",
      }));
    };
    const { coordinator, supervisor } = makeHarness({ launchStage: async () => stage.handle });
    const reservation = reserve(coordinator, "tool-0");

    await expect(supervisor.launch(reservation, options())).rejects.toThrow(/identity/i);

    expect(stage.abortCalls).toBe(1);
    await expect(stage.completion.promise).resolves.toMatchObject({ wasAborted: true });
    expect(stage.disposeCalls).toBe(1);
    expect(stage.listeners.size).toBe(0);
    expect(supervisor.hasRunningChildren()).toBe(false);
    expect(coordinator.journal().jobs.get(reservation.launchId)?.status).toBe("pre_materialization_failed");
  });

  it("settles and disposes a returned handle when subscription setup fails", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    stage.subscribeError = new Error("subscription setup failed");
    stage.abortImpl = async () => {
      stage.completion.resolve(result("", {
        exitCode: 1,
        wasAborted: true,
        errorMessage: "subscription rejected",
        stderr: "subscription rejected",
      }));
    };
    const { coordinator, supervisor } = makeHarness({ launchStage: async () => stage.handle });
    const reservation = reserve(coordinator, "tool-0");

    await expect(supervisor.launch(reservation, options())).rejects.toThrow("subscription setup failed");

    expect(stage.abortCalls).toBe(1);
    await expect(stage.completion.promise).resolves.toMatchObject({ wasAborted: true });
    expect(stage.disposeCalls).toBe(1);
    expect(stage.listeners.size).toBe(0);
    expect(supervisor.hasRunningChildren()).toBe(false);
    expect(coordinator.journal().jobs.get(reservation.launchId)?.status).toBe("pre_materialization_failed");
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

  it("rejects a pending quiescence wait when natural child disposal fails", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const failure = new Error("stage handle disposal failed");
    let fail = true;
    stage.disposeImpl = async () => {
      if (!fail) return;
      fail = false;
      throw failure;
    };
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      autoAcknowledge: true,
    });
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");
    const quiescence = supervisor.waitForQuiescence();

    stage.completion.resolve(result());

    await expect(quiescence).rejects.toBe(failure);
    await expect(supervisor.waitForQuiescence()).rejects.toBe(failure);
    expect(supervisor.hasRunningChildren()).toBe(true);
    await supervisor.dispose();
    expect(stage.disposeCalls).toBe(2);
    expect(supervisor.hasRunningChildren()).toBe(false);
  });

  it("retains and retries a child handle whose first disposal fails", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/child-0.jsonl");
    const failure = new Error("stage handle disposal failed");
    let fail = true;
    stage.disposeImpl = async () => {
      if (!fail) return;
      fail = false;
      throw failure;
    };
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
    await turn();

    expect(stage.disposeCalls).toBe(1);
    expect(supervisor.hasRunningChildren()).toBe(true);

    await supervisor.dispose();
    expect(stage.disposeCalls).toBe(2);
    expect(stage.unsubscribeCalls).toBe(1);
    expect(supervisor.hasRunningChildren()).toBe(false);
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
  it("clears an abort failure that arrives after natural settlement releases the child", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/naturally-settled.jsonl");
    const abortFailure = new Error("abort lost the settlement race");
    const allowAbortRejection = deferred<void>();
    stage.abortImpl = async () => {
      stage.completion.resolve(result("settled despite abort failure", {
        exitCode: 1,
        wasAborted: true,
        errorMessage: "shutdown",
        stderr: "shutdown",
      }));
      await allowAbortRejection.promise;
      throw abortFailure;
    };
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      autoAcknowledge: true,
      schedule: () => {},
    });
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");

    const firstAbort = supervisor.abortAll("shutdown");
    await vi.waitFor(() => expect(supervisor.hasRunningChildren()).toBe(false));
    expect(stage.disposeCalls).toBe(1);
    allowAbortRejection.resolve();

    await expect(firstAbort).rejects.toBe(abortFailure);
    await expect(supervisor.waitForQuiescence()).resolves.toBeUndefined();
    await expect(supervisor.abortAll("shutdown retry")).resolves.toBeUndefined();
    await expect(supervisor.waitForQuiescence()).resolves.toBeUndefined();
    expect(stage.abortCalls).toBe(1);
    expect(stage.disposeCalls).toBe(1);
  });

  it("starts sibling cleanup before awaiting a pending child startup", async () => {
    const firstStartup = deferred<StageLaunchHandle>();
    const first = new FakeStage("search_0", "child-0", "/sessions/pending-startup.jsonl");
    const second = new FakeStage("search_1", "child-1", "/sessions/running-sibling.jsonl");
    first.abortImpl = async () => {
      first.completion.resolve(result("first stopped", {
        agentId: "search_0",
        exitCode: 1,
        wasAborted: true,
        errorMessage: "shutdown",
        stderr: "shutdown",
      }));
      first.materialization.reject(new Error("shutdown before materialization"));
    };
    second.abortImpl = async () => {
      second.completion.resolve(result("second stopped", {
        agentId: "search_1",
        exitCode: 1,
        wasAborted: true,
        errorMessage: "shutdown",
        stderr: "shutdown",
      }));
    };
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async (reservation) => reservation.agentId === "search_0"
        ? firstStartup.promise
        : second.handle,
      autoAcknowledge: true,
      schedule: () => {},
    });
    const firstReservation = reserve(coordinator, "tool-0");
    const secondReservation = reserve(coordinator, "tool-1");
    const firstLaunching = supervisor.launch(firstReservation, options("pending"));
    const secondLaunching = supervisor.launch(secondReservation, options("running"));
    second.materialization.resolve();
    await secondLaunching;
    parent.acknowledgeLaunch("tool-1");

    let abortSettled = false;
    const aborting = supervisor.abortAll("shutdown").finally(() => {
      abortSettled = true;
    });
    await turn();

    expect(second.abortCalls).toBe(1);
    expect(second.disposeCalls).toBe(1);
    expect(abortSettled).toBe(false);

    firstStartup.resolve(first.handle);
    await expect(firstLaunching).rejects.toThrow("shutdown before materialization");
    await aborting;

    expect(first.abortCalls).toBe(1);
    expect(first.disposeCalls).toBe(1);
    expect(second.abortCalls).toBe(1);
    expect(second.disposeCalls).toBe(1);
    expect(supervisor.isQuiescent()).toBe(true);
  });

  it("reports a failed child abort without blocking siblings and retries only that ownership", async () => {
    const failed = new FakeStage("search_0", "child-0", "/sessions/failed-abort.jsonl");
    const sibling = new FakeStage("search_1", "child-1", "/sessions/sibling.jsonl");
    const abortFailure = new Error("child abort failed");
    let failedAttempts = 0;
    failed.abortImpl = async () => {
      failedAttempts += 1;
      if (failedAttempts === 1) throw abortFailure;
      failed.completion.resolve(result("failed child stopped", {
        agentId: "search_0",
        exitCode: 1,
        wasAborted: true,
        errorMessage: "shutdown retry",
        stderr: "shutdown retry",
      }));
    };
    sibling.abortImpl = async () => {
      sibling.completion.resolve(result("sibling stopped", {
        agentId: "search_1",
        exitCode: 1,
        wasAborted: true,
        errorMessage: "shutdown",
        stderr: "shutdown",
      }));
    };
    const stages = new Map([["search_0", failed], ["search_1", sibling]]);
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async (reservation) => stages.get(reservation.agentId)!.handle,
      autoAcknowledge: true,
      schedule: () => {},
    });
    const terminalEvents: SubagentSupervisorEvent[] = [];
    coordinator.subscribe((event) => {
      if (event.status === "complete" || event.status === "error") terminalEvents.push(event);
    });
    const reservations = [reserve(coordinator, "tool-0"), reserve(coordinator, "tool-1")];
    const launches = reservations.map((reservation) => supervisor.launch(reservation, options()));
    failed.materialization.resolve();
    sibling.materialization.resolve();
    await Promise.all(launches);
    reservations.forEach(({ toolCallId }) => parent.acknowledgeLaunch(toolCallId));

    const firstAbort = supervisor.abortAll("shutdown").then(
      () => undefined,
      (error) => error,
    );
    const firstOutcome = await Promise.race([
      firstAbort,
      new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 50)),
    ]);
    if (firstOutcome === "timed out") {
      failed.completion.resolve(result("test cleanup", {
        agentId: "search_0",
        exitCode: 1,
        wasAborted: true,
      }));
      await firstAbort;
    }

    expect(firstOutcome).toBe(abortFailure);
    expect({
      failedAbort: failed.abortCalls,
      failedDispose: failed.disposeCalls,
      siblingAbort: sibling.abortCalls,
      siblingDispose: sibling.disposeCalls,
    }).toEqual({ failedAbort: 1, failedDispose: 0, siblingAbort: 1, siblingDispose: 1 });
    expect(supervisor.hasRunningChildren()).toBe(true);
    expect(terminalEvents.filter(({ agentId }) => agentId === "search_1")).toHaveLength(1);
    expect(terminalEvents.filter(({ agentId }) => agentId === "search_0")).toHaveLength(0);

    await supervisor.abortAll("shutdown retry");

    expect({
      failedAbort: failed.abortCalls,
      failedDispose: failed.disposeCalls,
      siblingAbort: sibling.abortCalls,
      siblingDispose: sibling.disposeCalls,
    }).toEqual({ failedAbort: 2, failedDispose: 1, siblingAbort: 1, siblingDispose: 1 });
    expect(terminalEvents.filter(({ agentId }) => agentId === "search_1")).toHaveLength(1);
    expect(terminalEvents.filter(({ agentId }) => agentId === "search_0")).toHaveLength(1);
    expect(supervisor.hasRunningChildren()).toBe(false);
    expect(supervisor.isQuiescent()).toBe(true);
  });

  it("settles a materialized but unacknowledged launch during closing without a terminal batch", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/unacknowledged-child.jsonl");
    stage.abortImpl = async () => {
      stage.completion.resolve(result("unacknowledged partial", {
        exitCode: 1,
        wasAborted: true,
        errorMessage: "stopped before acknowledgement",
        stderr: "stopped before acknowledgement",
      }));
    };
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      schedule: () => {},
    });
    const events: SubagentSupervisorEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;

    let stopped = false;
    const aborting = supervisor.abortAll("stop before launch acknowledgement").then(() => {
      stopped = true;
    });
    await turn();

    expect(stopped).toBe(true);
    await aborting;
    expect(parent.sent).toEqual([]);
    expect(events.some((event) => event.status === "complete" || event.status === "error")).toBe(false);
    expect(supervisor.hasPendingNotifications()).toBe(false);
    expect(supervisor.isQuiescent()).toBe(true);
    expect(coordinator.journal().jobs.get(reservation.launchId)).toMatchObject({
      status: "working",
      terminalStatus: "error",
      launchAcknowledged: false,
    });
    expect(() => reserve(coordinator, "tool-1", "search_0")).toThrow(/running/i);

    await supervisor.dispose();
    expect(parent.listeners.size).toBe(0);
  });

  it("ignores a delayed launch acknowledgement after closing finalized an unacknowledged child", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/delayed-ack-child.jsonl");
    stage.abortImpl = async () => {
      stage.completion.resolve(result("delayed acknowledgement partial", {
        exitCode: 1,
        wasAborted: true,
        errorMessage: "stopped before acknowledgement",
        stderr: "stopped before acknowledgement",
      }));
    };
    const scheduled: Array<() => void> = [];
    const { manager, coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      schedule: (run) => scheduled.push(run),
    });
    const events: SubagentSupervisorEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;

    await supervisor.abortAll("stop before launch acknowledgement");
    const entryCount = manager.entries.length;
    parent.acknowledgeLaunch("tool-0");
    await turn();

    expect(manager.entries).toHaveLength(entryCount);
    expect(coordinator.journal().jobs.get(reservation.launchId)).toMatchObject({
      status: "working",
      terminalStatus: "error",
      launchAcknowledged: false,
    });
    expect(events.some((event) => event.status === "complete" || event.status === "error")).toBe(false);
    expect(scheduled).toEqual([]);
    expect(parent.sent).toEqual([]);
    expect(coordinator.journal().pendingBatches).toEqual([]);

    await supervisor.dispose();
    expect(parent.listeners.size).toBe(0);
  });

  it("retries a failed closing dispose send without repeating child work or replacing the frozen batch", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/retry-child.jsonl");
    stage.abortImpl = async () => {
      stage.completion.resolve(result("retry partial", {
        exitCode: 1,
        wasAborted: true,
        errorMessage: "disposed",
        stderr: "disposed",
      }));
    };
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      autoAcknowledge: true,
      schedule: () => {},
    });
    const events: SubagentSupervisorEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    parent.sendImpl = async (_sent, index) => {
      if (index === 0) throw new Error("closing send failed");
    };
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");

    await expect(supervisor.dispose()).rejects.toThrow("closing send failed");
    expect(parent.sent).toHaveLength(1);
    expect(parent.sent[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(coordinator.journal().pendingBatches).toEqual([
      expect.objectContaining({ launchIds: [reservation.launchId] }),
    ]);
    expect(stage.abortCalls).toBe(1);
    expect(stage.disposeCalls).toBe(1);
    expect(events.filter((event) => event.status === "error")).toHaveLength(1);

    await expect(supervisor.dispose()).resolves.toBeUndefined();
    expect(parent.sent).toHaveLength(2);
    expect(parent.sent[1]).toEqual(parent.sent[0]);
    expect(stage.abortCalls).toBe(1);
    expect(stage.disposeCalls).toBe(1);
    expect(events.filter((event) => event.status === "error")).toHaveLength(1);
    expect(coordinator.journal().pendingBatches).toEqual([]);
    expect(coordinator.journal().acknowledgedNotificationLaunchIds).toContain(reservation.launchId);
    expect(parent.listeners.size).toBe(0);

    await supervisor.dispose();
    expect(parent.sent).toHaveLength(2);
    expect(stage.abortCalls).toBe(1);
    expect(stage.disposeCalls).toBe(1);
  });

  it("keeps parent acknowledgement observation until a closing batch is acknowledged", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/private-child.jsonl");
    stage.abortImpl = async () => {
      stage.completion.resolve(result("partial handoff", {
        exitCode: 1,
        wasAborted: true,
        errorMessage: "disposed",
        stderr: "disposed",
      }));
    };
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      schedule: () => {},
    });
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");

    let disposed = false;
    const disposing = supervisor.dispose().then(() => {
      disposed = true;
    });
    await turn();

    expect(parent.sent).toHaveLength(1);
    expect(parent.sent[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(supervisor.hasPendingNotifications()).toBe(true);
    expect(supervisor.isQuiescent()).toBe(false);
    expect(parent.listeners.size).toBe(1);
    expect(disposed).toBe(false);

    parent.acknowledgeLastMessage();
    await disposing;
    expect(disposed).toBe(true);
    expect(parent.listeners.size).toBe(0);
  });

  it("settles an in-flight natural send before creating the merged no-trigger closing batch", async () => {
    const completed = new FakeStage("search_0", "child-0", "/sessions/completed.jsonl");
    const running = new FakeStage("search_1", "child-1", "/sessions/running.jsonl");
    const naturalSendGate = deferred<void>();
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
    parent.sendImpl = async (_sent, index) => {
      if (index === 0) await naturalSendGate.promise;
    };
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
    const naturalSend = supervisor.flushNotifications();
    await turn();
    expect(parent.sent[0]?.options.triggerTurn).toBe(true);

    const aborting = supervisor.abortAll("shutdown");
    await turn();
    expect(parent.sent).toHaveLength(1);
    naturalSendGate.resolve();
    await naturalSend;
    await turn();

    expect(parent.sent).toHaveLength(2);
    expect(parent.sent[1]?.options).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(parent.sent[1]?.message.content).toContain("Complete subagent:search_0");
    expect(parent.sent[1]?.message.content).toContain(
      'Error subagent:{"name":"search_1","session_path":"/sessions/running.jsonl"}',
    );
    expect(coordinator.journal().supersededBatchIds).toContain("batch-0");
    parent.acknowledgeLastMessage();
    await aborting;
    await supervisor.waitForQuiescence();
  });

  it("supersedes a delayed natural batch and waits for the distinct closing batch acknowledgement", async () => {
    const stage = new FakeStage("search_0", "child-0", "/sessions/completed.jsonl");
    const naturalSendGate = deferred<void>();
    const { coordinator, parent, supervisor } = makeHarness({
      launchStage: async () => stage.handle,
      schedule: () => {},
    });
    parent.sendImpl = async (_sent, index) => {
      if (index === 0) await naturalSendGate.promise;
    };
    const reservation = reserve(coordinator, "tool-0");
    const launching = supervisor.launch(reservation, options());
    stage.materialization.resolve();
    await launching;
    parent.acknowledgeLaunch("tool-0");
    stage.completion.resolve(result("completed handoff"));
    await turn();

    const naturalSend = supervisor.flushNotifications();
    await turn();
    const naturalMessage = parent.sent[0]!;
    const naturalBatchId = (naturalMessage.message.details as { batchId: string }).batchId;
    expect(naturalMessage.options.triggerTurn).toBe(true);

    let stopped = false;
    const aborting = supervisor.abortAll("shutdown").then(() => {
      stopped = true;
    });
    await turn();
    expect(parent.sent).toHaveLength(1);

    naturalSendGate.resolve();
    await naturalSend;
    await turn();

    const closingMessage = parent.sent[1]!;
    const closingBatchId = (closingMessage.message.details as { batchId: string }).batchId;
    expect.soft(closingMessage.options).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect.soft(closingBatchId).not.toBe(naturalBatchId);
    expect.soft(coordinator.journal().supersededBatchIds).toContain(naturalBatchId);
    expect.soft(coordinator.journal().pendingBatches.map(({ batchId }) => batchId)).toEqual([closingBatchId]);

    parent.emit({
      type: "message_end",
      message: { role: "custom", ...naturalMessage.message, timestamp: 1 },
    } as AgentSessionEvent);
    await turn();
    expect.soft(stopped).toBe(false);
    expect.soft(coordinator.journal().pendingBatches.map(({ batchId }) => batchId)).toEqual([closingBatchId]);

    parent.emit({
      type: "message_end",
      message: { role: "custom", ...closingMessage.message, timestamp: 2 },
    } as AgentSessionEvent);
    await aborting;
    expect(stopped).toBe(true);
    expect(supervisor.isQuiescent()).toBe(true);
  });

  it("sets only local closing before awaiting startup and leaves other coordinator owners open", async () => {
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
    const otherOwner = coordinator.reserveDispatch({
      ownerSessionId: "other-parent",
      toolCallId: "tool-1",
      requested: "search",
      catalog: { all: [searchAgent], available: [searchAgent] },
    });
    expect(otherOwner).toMatchObject({ ownerSessionId: "other-parent", agentId: "search_1" });
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
    await turn();

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
    await aborting;
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
    await turn();

    expect(events).toContainEqual(expect.objectContaining({ agentId: "search_0", status: "error" }));
    expect(events).not.toContainEqual(expect.objectContaining({ agentId: "search_0", status: "complete" }));
    expect(parent.sent[0]?.options.triggerTurn).toBe(false);
    expect(parent.sent[0]?.message.content).toContain(
      'Error subagent:{"name":"search_0","session_path":"/sessions/short-child.jsonl"}',
    );
    parent.acknowledgeLastMessage();
    await aborting;
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

    const aborting = supervisor.abortAll("shutdown");
    await turn();

    expect(parent.sent).toHaveLength(2);
    expect(parent.sent[1]?.options).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(parent.sent[1]?.message.content).toContain("Complete subagent:search_0");
    expect(parent.sent[1]?.message.content).toContain(
      'Error subagent:{"name":"search_1","session_path":"/sessions/running.jsonl"}',
    );
    expect(coordinator.journal().supersededBatchIds).toContain("batch-0");
    expect(coordinator.journal().pendingBatches.map(({ batchId }) => batchId)).toEqual(["batch-1"]);
    parent.acknowledgeLastMessage();
    await aborting;
    await supervisor.waitForQuiescence();
  });
});
