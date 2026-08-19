import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "./agents";
import { SubagentCoordinator, type CoordinatorSessionManager, type ReservedDispatch } from "./coordinator";
import {
  createStageSessionLauncher,
  type StageAgentSession,
  type StageLaunchOptions,
  type StageSessionDependencies,
} from "./stage-session";
import type { SubagentSupervisor } from "./supervisor";

const agent: AgentConfig = {
  name: "search",
  description: "Search",
  enabled: true,
  builtin: true,
  source: "bundled",
  filePath: "/agents/search.md",
  systemPrompt: "Search carefully.",
  tools: ["read", "web-search"],
  effectiveTools: ["read", "web-search"],
  skills: ["paper-search"],
  effectiveSkills: ["paper-search"],
  missingSkills: [],
  subagents: [],
};

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 5,
      totalTokens: 14,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

class MemoryCoordinatorSessionManager implements CoordinatorSessionManager {
  readonly entries: unknown[] = [];
  private sequence = 0;

  getSessionId(): string {
    return "root-session";
  }

  getSessionFile(): string {
    return "/sessions/root.jsonl";
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

class FakeStageSession implements StageAgentSession {
  readonly thinkingLevel: ThinkingLevel = "high";
  readonly model = { provider: "openai", id: "gpt-test" } as Model<any>;
  isStreaming = false;
  promptCalls: string[] = [];
  activeTools: string[][] = [];
  names: string[] = [];
  abortCalls = 0;
  disposeCalls = 0;
  bindError?: Error;
  abortImpl: () => Promise<void> = async () => {};
  promptStart?: () => void;
  readonly listeners = new Set<(event: unknown) => void>();

  constructor(
    readonly sessionId: string,
    readonly sessionFile: string,
    private readonly promptPromise: Promise<void>,
  ) {}

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async bindExtensions(): Promise<void> {
    if (this.bindError) throw this.bindError;
  }

  setSessionName(name: string): void {
    this.names.push(name);
  }

  getAllTools(): Array<{ name: string }> {
    return [{ name: "read" }, { name: "web-search" }, { name: "subagent" }];
  }

  setActiveToolsByName(names: string[]): void {
    this.activeTools.push(names);
  }

  prompt(message: string): Promise<void> {
    this.promptCalls.push(message);
    this.promptStart?.();
    return this.promptPromise;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    await this.abortImpl();
  }

  async sendCustomMessage(): Promise<void> {}

  dispose(): void {
    this.disposeCalls += 1;
  }

  emit(event: unknown): void {
    this.listeners.forEach((listener) => listener(event));
  }

  emitAssistantEndAndPersist(text = "stage complete"): void {
    this.emit({ type: "message_end", message: assistant(text) });
    writeFileSync(this.sessionFile, `${JSON.stringify({ type: "session", id: this.sessionId })}\n`);
  }
}

class FakeDirectChildSupervisor {
  readonly attached: StageAgentSession[] = [];
  abortReasons: string[] = [];
  disposeCalls = 0;

  attach(session: StageAgentSession): void {
    this.attached.push(session);
  }

  hasRunningChildren(): boolean {
    return false;
  }

  hasPendingNotifications(): boolean {
    return false;
  }

  waitForQuiescence(): Promise<void> {
    return Promise.resolve();
  }

  abortAll(reason: string): Promise<void> {
    this.abortReasons.push(reason);
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    this.disposeCalls += 1;
    return Promise.resolve();
  }
}

interface DependencyHarness {
  dependencies: StageSessionDependencies;
  calls: Array<{ name: string; value?: unknown }>;
  supervisors: FakeDirectChildSupervisor[];
  openedManager: {
    getSessionId(): string;
    getCwd(): string;
    getSessionFile(): string;
  };
}

function dependencyHarness(session: FakeStageSession): DependencyHarness {
  const calls: Array<{ name: string; value?: unknown }> = [];
  const supervisors: FakeDirectChildSupervisor[] = [];
  const openedManager = {
    getSessionId: () => session.sessionId,
    getCwd: () => "/project",
    getSessionFile: () => session.sessionFile,
  };
  return {
    calls,
    supervisors,
    openedManager,
    dependencies: {
      agentDir: "/agent",
      createSessionManager: (cwd) => {
        calls.push({ name: "createManager", value: cwd });
        return { kind: "new", cwd };
      },
      openSessionManager: (path) => {
        calls.push({ name: "openManager", value: path });
        return openedManager;
      },
      createSettingsManager: (cwd, agentDir) => {
        calls.push({ name: "settings", value: { cwd, agentDir } });
        return { getGlobalSettings: () => ({}) };
      },
      createModelRuntime: async () => ({
        getModel: (provider: string, id: string) => ({ provider, id } as Model<any>),
      }),
      createResourceLoader: (options) => {
        calls.push({ name: "loader", value: options });
        return { reload: async () => {} };
      },
      createAgentSession: async (options) => {
        calls.push({ name: "createSession", value: options });
        return { session };
      },
      createDirectChildSupervisor: (coordinator) => {
        const supervisor = new FakeDirectChildSupervisor();
        supervisors.push(supervisor);
        calls.push({ name: "supervisor", value: { coordinator, supervisor } });
        return supervisor as unknown as SubagentSupervisor;
      },
      createExtensionFactories: (stageAgent, coordinator, supervisor) => [
        { name: "stage", caller: stageAgent.name, coordinator, supervisor },
        { name: "web-search" },
      ],
      resolveSkillPaths: () => ["/skills/paper-search"],
    },
  };
}

function freshReservation(): ReservedDispatch {
  return {
    launchId: "launch-1",
    ownerSessionId: "owner-1",
    toolCallId: "tool-1",
    agent: "search",
    agentId: "search_0",
    continuation: false,
  };
}

function stageOptions(coordinator: SubagentCoordinator, reservation: ReservedDispatch = freshReservation()): StageLaunchOptions {
  return {
    reservation,
    agent,
    task: "find papers",
    cwd: "/project",
    model: "openai/gpt-test",
    thinking: "high",
    coordinator,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-stage-launch-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createStageSessionLauncher", () => {
  it("returns a handle whose materialization can resolve before completion", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const harness = dependencyHarness(session);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const launcher = createStageSessionLauncher(harness.dependencies);

    const handle = await launcher(stageOptions(coordinator));
    session.emitAssistantEndAndPersist();
    await handle.materialized;

    expect(await isSettled(handle.completion)).toBe(false);
    prompt.resolve();
    await expect(handle.completion).resolves.toMatchObject({
      exitCode: 0,
      agentId: "search_0",
      sessionId: "child-1",
      sessionPath: session.sessionFile,
      stopReason: "stop",
      usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25, contextTokens: 14, turns: 1 },
    });
    expect(handle.agentId).toBe("search_0");
    expect(handle.childSessionId).toBe("child-1");
    expect(handle.sessionPath).toBe(session.sessionFile);

    expect(harness.calls.find((call) => call.name === "createManager")?.value).toBe("/project");
    expect(harness.calls.find((call) => call.name === "loader")?.value).toMatchObject({
      cwd: "/project",
      noSkills: true,
      additionalSkillPaths: ["/skills/paper-search"],
      appendSystemPrompt: ["Search carefully."],
      extensionFactories: [
        { name: "stage", caller: "search", coordinator, supervisor: harness.supervisors[0] },
        { name: "web-search" },
      ],
    });
    expect(harness.calls.find((call) => call.name === "createSession")?.value).toMatchObject({
      cwd: "/project",
      tools: ["read", "web-search"],
      thinkingLevel: "high",
      model: { provider: "openai", id: "gpt-test" },
      sessionManager: { kind: "new", cwd: "/project" },
    });
    expect(session.names).toEqual(["easyresearch:search"]);
    expect(session.promptCalls).toEqual(["Task: find papers"]);
    expect(harness.supervisors).toHaveLength(1);
    expect(harness.supervisors[0]?.attached).toEqual([session]);
    expect(session.disposeCalls).toBe(0);

    await handle.dispose();
    expect(harness.supervisors[0]?.disposeCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
  });

  it("publishes only delta-shaped child events", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(dependencyHarness(session).dependencies)(stageOptions(coordinator));
    const events: JsonAgentSessionEvent[] = [];
    handle.subscribe((event) => events.push(event));

    session.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "new token",
        partial: { role: "assistant", content: [{ type: "text", text: "all tokens" }] },
      },
    });

    expect(events).toEqual([{
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "new token" },
    }]);

    session.emitAssistantEndAndPersist();
    await handle.materialized;
    prompt.resolve();
    await handle.completion;
    await handle.dispose();
  });

  it("replays synchronous prompt-start events once to the first owner subscriber", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    session.promptStart = () => session.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "early token",
        partial: { role: "assistant", content: [{ type: "text", text: "all early tokens" }] },
      },
    });
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());

    const handle = await createStageSessionLauncher(dependencyHarness(session).dependencies)(stageOptions(coordinator));
    const firstOwnerEvents: JsonAgentSessionEvent[] = [];
    const laterSubscriberEvents: JsonAgentSessionEvent[] = [];
    handle.subscribe((event) => firstOwnerEvents.push(event));
    handle.subscribe((event) => laterSubscriberEvents.push(event));

    expect(firstOwnerEvents).toEqual([{
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "early token" },
    }]);
    expect(laterSubscriberEvents).toEqual([]);

    session.emitAssistantEndAndPersist();
    await handle.materialized;
    prompt.resolve();
    await handle.completion;
    await handle.dispose();
  });

  it("remembers an early abort and reapplies it after agent_start", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    session.abortImpl = async () => {
      if (session.isStreaming) prompt.resolve();
    };
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(dependencyHarness(session).dependencies)(stageOptions(coordinator));
    const materializationFailure = expect(handle.materialized).rejects.toThrow(/materializ|ENOENT/i);

    const aborting = handle.abort("stopped by parent");
    expect(session.abortCalls).toBe(1);
    session.isStreaming = true;
    session.emit({ type: "agent_start" });
    await aborting;

    const result = await handle.completion;
    await materializationFailure;
    expect(session.abortCalls).toBe(2);
    expect(result).toMatchObject({ exitCode: 1, wasAborted: true, errorMessage: "stopped by parent" });
    await handle.dispose();
  });

  it("propagates handle abort to the stage's direct-child supervisor", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    session.abortImpl = async () => prompt.resolve();
    const harness = dependencyHarness(session);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator));
    const materializationFailure = handle.materialized.catch((error) => error);

    await handle.abort("stop the nested tree");
    await handle.completion;

    expect(harness.supervisors[0]?.abortReasons).toEqual(["stop the nested tree"]);
    expect(await materializationFailure).toBeInstanceOf(Error);
    await handle.dispose();
  });

  it("makes abort and disposal idempotent", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(dependencyHarness(session).dependencies)(stageOptions(coordinator));

    session.emitAssistantEndAndPersist();
    await handle.materialized;
    await Promise.all([handle.abort(), handle.abort()]);
    prompt.resolve();
    await handle.completion;
    await Promise.all([handle.dispose(), handle.dispose()]);

    expect(session.abortCalls).toBe(1);
    expect(session.disposeCalls).toBe(1);
    expect(session.listeners.size).toBe(0);
  });

  it("rejects setup failure and disposes a session that has no launch handle", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    session.bindError = new Error("extension setup failed");
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const launcher = createStageSessionLauncher(dependencyHarness(session).dependencies);

    await expect(launcher(stageOptions(coordinator))).rejects.toThrow("extension setup failed");
    expect(session.promptCalls).toEqual([]);
    expect(session.disposeCalls).toBe(1);
    expect(session.listeners.size).toBe(0);
  });

  it("rejects materialization but resolves completion when the prompt fails before output", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(dependencyHarness(session).dependencies)(stageOptions(coordinator));
    const materializationFailure = expect(handle.materialized).rejects.toThrow("provider failed before output");

    prompt.reject(new Error("provider failed before output"));

    await materializationFailure;
    await expect(handle.completion).resolves.toMatchObject({
      exitCode: 1,
      errorMessage: "provider failed before output",
      stderr: "provider failed before output",
    });
    await handle.dispose();
  });

  it("keeps materialization successful when the prompt fails afterward", async () => {
    const prompt = deferred<void>();
    const session = new FakeStageSession("child-1", join(root, "child-1.jsonl"), prompt.promise);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const handle = await createStageSessionLauncher(dependencyHarness(session).dependencies)(stageOptions(coordinator));

    session.emitAssistantEndAndPersist("partial final text");
    await expect(handle.materialized).resolves.toBeUndefined();
    prompt.reject(new Error("provider failed after output"));

    await expect(handle.completion).resolves.toMatchObject({
      exitCode: 1,
      errorMessage: "provider failed after output",
      messages: [expect.objectContaining({ role: "assistant" })],
    });
    await handle.dispose();
  });

  it("checks a continuation before opening it and validates its UUID and cwd", async () => {
    const prompt = deferred<void>();
    const sessionPath = join(root, "continued.jsonl");
    writeFileSync(sessionPath, "{}\n");
    const session = new FakeStageSession("continued-child", sessionPath, prompt.promise);
    const harness = dependencyHarness(session);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const reservation: ReservedDispatch = {
      ...freshReservation(),
      continuation: true,
      childSessionId: "continued-child",
      sessionPath,
    };
    const handle = await createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator, reservation));

    await expect(handle.materialized).resolves.toBeUndefined();
    expect(harness.calls.some((call) => call.name === "createManager")).toBe(false);
    expect(harness.calls.find((call) => call.name === "openManager")?.value).toBe(sessionPath);
    prompt.resolve();
    await handle.completion;
    await handle.dispose();

    harness.openedManager.getSessionId = () => "wrong-child";
    await expect(createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator, reservation))).rejects.toThrow(/UUID|session id/i);

    harness.openedManager.getSessionId = () => "continued-child";
    harness.openedManager.getCwd = () => "/another-project";
    await expect(createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator, reservation))).rejects.toThrow(/cwd/i);
  });

  it("rejects an unreadable continuation before calling SessionManager.open", async () => {
    const prompt = deferred<void>();
    const sessionPath = join(root, "deleted.jsonl");
    const session = new FakeStageSession("continued-child", sessionPath, prompt.promise);
    const harness = dependencyHarness(session);
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const reservation: ReservedDispatch = {
      ...freshReservation(),
      continuation: true,
      childSessionId: "continued-child",
      sessionPath,
    };

    await expect(
      createStageSessionLauncher(harness.dependencies)(stageOptions(coordinator, reservation)),
    ).rejects.toThrow();
    expect(harness.calls.some((call) => call.name === "openManager")).toBe(false);
    expect(session.disposeCalls).toBe(0);
  });
});
