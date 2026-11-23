import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionFactory, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importPi } from "../runtime/pi-import";
import { createAgentDefinitionExtension } from "../extensions/agent-definition";
import type { LiveConfiguration } from "../runtime/live-configuration";
import { SubagentCoordinator } from "./coordinator";
import { SubagentSupervisor } from "./supervisor";
import { createStageSessionLauncher, type StageSessionDependencies } from "./stage-session";
import type { AgentConfig } from "./agents";
import type { BackgroundTask } from "../background/contracts";
import { Type } from "typebox";
import { LLM_RETRY_CONTROL_TYPE, type LlmRecoveryController } from "../runtime/llm-recovery";
import type { AgentRuntimeBinding } from "../runtime/agent-runtime-binding";
import type { SubagentShellService } from "./background-periods";
import { createSubagentDispatchExtension } from "../extensions/subagent-dispatch";
import { recoverSubagentTree, type RecoverySessionStore } from "./recovery";
import { createSubagentTool } from "./tool";

vi.mock("../runtime/logger", () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
let root: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "subagent-native-"));
  for (const name of ["home", "agent", "project", "sessions"]) mkdirSync(join(root, name));
  vi.stubEnv("HOME", join(root, "home")); vi.stubEnv("USERPROFILE", join(root, "home"));
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(root, "agent")); vi.stubEnv("PI_OFFLINE", "1");
  vi.stubGlobal("fetch", async () => { throw new Error("Network forbidden in native subagent tests"); });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
});

async function harness(extensions: ExtensionFactory[] = [], retry: { enabled: boolean; maxRetries?: number; baseDelayMs?: number } = { enabled: false }) {
  const pi = await importPi();
  const ai = await import("@earendil-works/pi-ai");
  const provider = ai.fauxProvider({ provider: "background-faux", models: [{ id: "test", contextWindow: 16000, maxTokens: 1000 }, { id: "alternate", contextWindow: 16000, maxTokens: 1000 }, { id: "reasoner", reasoning: true, contextWindow: 16000, maxTokens: 1000 }], tokenSize: { min: 10000, max: 10000 } });
  provider.setResponses([ai.fauxAssistantMessage("done")]);
  const rows = ["research-assistant", "search", "experiment"].map((name): AgentConfig => ({ name, description: name, enabled: true, builtin: true,
    source: "bundled", filePath: join(root, `${name}.md`), systemPrompt: `${name} role`, tools: undefined, effectiveTools: [],
    skills: [], effectiveSkills: [], effectiveSkillPaths: [], missingSkills: [], subagents: name === "research-assistant" ? ["search", "experiment"] : [],
    model: "background-faux/test", thinking: "off" }));
  let generation = 1;
  let modelRuntimeGate: (() => Promise<void>) | undefined;
  let createSessionGate: (() => Promise<void>) | undefined;
  const configurationListeners = new Set<(event: any) => void>();
  const bindings: AgentRuntimeBinding[] = [];
  const live = { get generation() { return generation; }, availabilityEpoch: 0, compactionPolicy: { triggerPercent: 70, globalEnabled: false, globalKeepRecentTokens: 100 },
    synchronize: async () => {}, acquireProject: async (cwd: string) => ({ cwd, release: async () => {} }),
    isCurrent: (value: number) => value === generation, resolveAgents: async () => rows,
    subscribe: (listener: (event: any) => void) => { configurationListeners.add(listener); return () => { configurationListeners.delete(listener); }; },
  } as unknown as LiveConfiguration;
  const sessions: AgentSession[] = [];
  const launchStage = createStageSessionLauncher({
    agentDir: join(root, "agent"),
    createSessionManager: (cwd) => pi.SessionManager.create(cwd, join(root, "sessions")),
    openSessionManager: (path) => pi.SessionManager.open(path, join(root, "sessions")),
    createSettingsManager: () => pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry }),
    createModelRuntime: async () => {
      await modelRuntimeGate?.();
      const runtime = await pi.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
        modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
      runtime.registerNativeProvider(provider.provider); return runtime;
    },
    createResourceLoader: (options) => new pi.DefaultResourceLoader({ ...options as any, noExtensions: "all", noContextFiles: true, noPromptTemplates: true, noThemes: true }),
    createAgentSession: async (options) => { await createSessionGate?.(); const created = await pi.createAgentSession(options as any); sessions.push(created.session); return created as any; },
    createDirectChildSupervisor: (coordinator, launchStage) => new SubagentSupervisor({ coordinator, launchStage }),
    createExtensionFactories: ({ binding, coordinator, supervisor }) => { bindings.push(binding); return [{ name: "agent-definition", factory: createAgentDefinitionExtension(binding) },
      { name: "subagent", factory: createSubagentDispatchExtension({ binding, coordinator, supervisor, liveConfiguration: live }) },
      ...extensions.map((factory, i) => ({ name: `fixture-${i}`, factory }))]; },
    resolveAutomaticModel: async () => provider.getModel(),
  } as StageSessionDependencies);
  const manager = pi.SessionManager.create(join(root, "project"), join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "Root input", timestamp: Date.now() });
  const coordinator = new SubagentCoordinator(manager);
  const supervisor = new SubagentSupervisor({ coordinator, launchStage });
  const notices: string[] = [];
  const attach = (target: SubagentSupervisor, journal: typeof manager) => target.attach({ sessionId: journal.getSessionId(), sessionFile: journal.getSessionFile(), isStreaming: false,
    sessionManager: journal, subscribe: () => () => {}, abort: async () => {}, dispose: () => {},
    async sendCustomMessage(message) { journal.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); notices.push(message.content); },
  });
  attach(supervisor, manager);
  cleanups.push(() => supervisor.dispose());
  let call = 0;
  const launch = (task = "Find source evidence", sessionID?: string, selection: { model?: string; agent?: string; thinking?: string } = {}) => {
    const inputID = `call-${call++}`;
    const agent = rows.find((row) => row.name === (selection.agent ?? "search"))!;
    const reservation = coordinator.reserveDispatch({ ownerSessionId: manager.getSessionId(), toolCallId: inputID,
      requested: agent.name, description: "Find source evidence", sessionID, catalog: { all: rows, available: rows.slice(1) } });
    return supervisor.launch(reservation, { agent, model: selection.model, thinking: selection.thinking, callerAgent: "research-assistant", task, inputID, cwd: join(root, "project"), liveConfiguration: live });
  };
  const restart = async (shellService?: SubagentShellService) => {
    const journal = pi.SessionManager.open(manager.getSessionFile()!);
    const nextCoordinator = new SubagentCoordinator(journal);
    if (shellService) nextCoordinator.setShellService(shellService);
    const next = new SubagentSupervisor({ coordinator: nextCoordinator, launchStage });
    attach(next, journal);
    cleanups.push(() => next.dispose());
    await next.recoverBackground({ cwd: join(root, "project"), liveConfiguration: live, verifiedPriorOwnerDead: true });
    return { coordinator: nextCoordinator, supervisor: next, manager: journal };
  };
  return { ai, pi, provider, sessions, coordinator, supervisor, launch, notices, manager, live, restart, rows, bindings,
    setModelRuntimeGate(gate?: () => Promise<void>) { modelRuntimeGate = gate; },
    setCreateSessionGate(gate?: () => Promise<void>) { createSessionGate = gate; },
    publishConfiguration() {
      generation++;
      for (const listener of configurationListeners) listener({ type: "config.updated", generation, runtimeChanged: true, modelsChanged: true, agentsChanged: true });
    },
  };
}

describe("native background subagent ownership", () => {
  it.each([false, true])("classifies materialized children before awaited setup, including setup failure=%s", async (failSetup) => {
    const h = await harness();
    const entered = deferred(); const release = deferred();
    h.setCreateSessionGate(async () => { entered.resolve(); await release.promise; if (failSetup) throw new Error("Controlled setup failure"); });
    const launching = h.launch().then((result) => ({ result }), (error: unknown) => ({ error }));
    try {
      await entered.promise;
      const { toUserSessionSummaries } = await import("../web/server");
      const { validateHistoricalSession } = await import("../web/session-lifecycle");
      const { createReadonlySubagentSessionStore } = await import("../web/subagent-sessions");
      const store = createReadonlySubagentSessionStore(h.pi);
      const inspect = async () => {
        const histories = await h.pi.SessionManager.list(join(root, "project"), join(root, "sessions"));
        const children = histories.filter((entry) => entry.id !== h.manager.getSessionId());
        expect(children).toHaveLength(1);
        expect.soft(toUserSessionSummaries(histories).some((entry) => entry.id === children[0]!.id)).toBe(false);
        expect.soft(() => validateHistoricalSession(children[0]!, store)).toThrow(/Unknown user session/);
      };
      await inspect();
      expect(h.provider.state.callCount).toBe(0);
      release.resolve();
      const outcome = await launching;
      if (failSetup) {
        expect("error" in outcome && String(outcome.error)).toContain("Controlled setup failure");
        await inspect();
        expect(h.provider.state.callCount).toBe(0);
      } else expect("result" in outcome).toBe(true);
    } finally { release.resolve(); await launching; h.setCreateSessionGate(); }
  });

  it("keeps described child sessions out of Home and root lifecycle admission", async () => {
    const h = await harness();
    const launched = await h.launch("Retrieve the requested evidence");
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    const { toUserSessionSummaries } = await import("../web/server");
    const { validateHistoricalSession } = await import("../web/session-lifecycle");
    const { createReadonlySubagentSessionStore } = await import("../web/subagent-sessions");
    const histories = await h.pi.SessionManager.list(join(root, "project"), join(root, "sessions"));
    const child = histories.find((entry) => entry.id === launched.job.childSessionId)!;
    expect(child).toBeDefined();
    expect(toUserSessionSummaries(histories).some((entry) => entry.id === child.id)).toBe(false);
    const store = createReadonlySubagentSessionStore(h.pi);
    expect(() => validateHistoricalSession(child, store)).toThrow(/Unknown user session/);
  });

  it("acknowledges a durable native UUID/input before a blocked first model response", async () => {
    const gate = deferred(); const entered = deferred();
    const h = await harness();
    h.provider.setResponses([async () => { entered.resolve(); await gate.promise; return h.ai.fauxAssistantMessage("first result"); }]);
    const launched = await h.launch();
    expect(launched.job.childSessionId).toMatch(/^[a-f0-9-]{36}$/);
    const session = h.sessions[0]!;
    const disk = readFileSync(session.sessionFile!, "utf8");
    expect(disk).toContain("You are a subagent spawned by another session.");
    expect(disk).not.toContain('"role":"assistant"');
    await entered.promise;
    expect(h.supervisor.backgroundTasks()).toHaveLength(1);
    gate.resolve();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.notices[0]).toContain('state="completed"');
  });

  it("refuses provider inference when the physical native execution journal loses its identity", async () => {
    let header = "";
    let file = "";
    const h = await harness([(api) => {
      api.on("before_agent_start", (_event, ctx) => {
        file = ctx.sessionManager.getSessionFile()!;
        const disk = readFileSync(file, "utf8");
        const newline = disk.indexOf("\n");
        header = disk.slice(0, newline);
        writeFileSync(file, JSON.stringify({ ...JSON.parse(header), id: "wrong-owner" }) + disk.slice(newline));
      });
    }]);
    await h.launch();
    try {
      await vi.waitFor(() => expect(h.notices).toHaveLength(1));
      expect(h.provider.state.callCount).toBe(0);
      expect(h.notices[0]).toContain('state="error"');
      expect(h.notices[0]).toContain("identity");
    } finally {
      const disk = readFileSync(file, "utf8");
      writeFileSync(file, header + disk.slice(disk.indexOf("\n")));
    }
  });

  it("steers a running child in the same runtime and emits one report for the busy period", async () => {
    const gate = deferred(); const entered = deferred(); const contexts: string[] = [];
    const h = await harness();
    h.provider.setResponses([async () => { entered.resolve(); await gate.promise; return h.ai.fauxAssistantMessage("intermediate"); },
      (context) => { contexts.push(JSON.stringify(context.messages)); return h.ai.fauxAssistantMessage("Final followup answer"); }]);
    const launched = await h.launch(); await entered.promise;
    await h.launch("Only primary sources", launched.job.childSessionId);
    await h.launch("Also check dates", launched.job.childSessionId);
    expect(h.sessions).toHaveLength(1);
    expect(h.notices).toHaveLength(0);
    gate.resolve();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(contexts[0]).toContain("Only primary sources"); expect(contexts[0]).toContain("Also check dates");
    expect(h.notices[0]).toContain("Final followup answer");
    expect([...h.coordinator.journal().jobs.values()]).toHaveLength(1);
  });

  it("reports an idle period with outstanding shell work and reports a later shell-triggered period", async () => {
    const h = await harness();
    let owner: { notify(notice: { id: string; content: string }): Promise<void> } | undefined;
    const tasks: BackgroundTask[] = [];
    h.coordinator.setShellService({ attachOwner(value) { owner = value; return () => { owner = undefined; }; },
      tasks: () => tasks, hasWork: (id) => tasks.some((task) => task.sessionID === id), subscribe: () => () => {}, cancel: async () => { tasks.length = 0; } });
    const gate = deferred(); const entered = deferred();
    h.provider.setResponses([async () => { entered.resolve(); await gate.promise; return h.ai.fauxAssistantMessage("Launched training"); }, h.ai.fauxAssistantMessage("Training finished")]);
    const launched = await h.launch(); await entered.promise;
    tasks.push({ id: "shell-1", kind: "shell", sessionID: launched.job.childSessionId, description: "Training", status: "running", blocking: false });
    gate.resolve();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.notices[0]).toContain('state="running"'); expect(h.notices[0]).toContain("shell-1");
    expect(h.supervisor.backgroundTasks()).toHaveLength(1);
    tasks.length = 0;
    await owner!.notify({ id: "shell-1:complete", content: '<background-result kind="shell">done</background-result>' });
    await vi.waitFor(() => expect(h.notices).toHaveLength(2));
    expect(h.notices[1]).toContain("Training finished"); expect(h.notices[1]).not.toContain("Launched training");
    await owner!.notify({ id: "shell-1:complete", content: '<background-result kind="shell">done</background-result>' });
    expect(h.notices).toHaveLength(2);
  });

  it("admits recovered non-waking shell notices without starting an idle child", async () => {
    const h = await harness();
    let notify!: (notice: { id: string; content: string; wake?: boolean }) => Promise<void>;
    h.coordinator.setShellService({ attachOwner(owner) { notify = owner.notify; return () => {}; }, tasks: () => [],
      hasWork: () => false, subscribe: () => () => {}, cancel: async () => {} });
    const contexts: string[] = [];
    h.provider.setResponses([h.ai.fauxAssistantMessage("First result"), (context) => { contexts.push(JSON.stringify(context.messages)); return h.ai.fauxAssistantMessage("Explicit next result"); }]);
    const launched = await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    await notify({ id: "recovered-lost-shell", content: "Previously owned shell was lost", wake: false });
    await notify({ id: "recovered-lost-shell", content: "Previously owned shell was lost", wake: true });
    expect(h.provider.state.callCount).toBe(1);
    expect(h.notices).toHaveLength(1);
    await h.launch("Continue explicitly", launched.job.childSessionId);
    await vi.waitFor(() => expect(h.notices).toHaveLength(2));
    expect(contexts[0]).toContain("Previously owned shell was lost");
  });

  it("suspends without a fake report and reconstructs the same claimed native child", async () => {
    const entered = deferred();
    const h = await harness();
    h.provider.setResponses([async (_context, options) => {
      entered.resolve();
      await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return h.ai.fauxAssistantMessage("interrupted output");
    }]);
    const launched = await h.launch(); await entered.promise;
    await h.supervisor.suspendAll("planned restart");
    expect(h.notices).toHaveLength(0);
    const before = h.coordinator.journal().jobs.get(launched.job.launchId)!;
    expect(before.terminalStatus).toBeUndefined();
    h.provider.setResponses([h.ai.fauxAssistantMessage("Recovered answer")]);
    const next = await h.restart();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.sessions.at(-1)!.sessionId).toBe(launched.job.childSessionId);
    expect(h.notices[0]).toContain("Recovered answer");
    expect(next.coordinator.journal().jobs.get(launched.job.launchId)?.terminalStatus).toBe("complete");
  });

  it("replays a committed outbox without rerunning or admitting an already delivered report twice", async () => {
    const h = await harness();
    const ack = vi.spyOn(h.coordinator, "acknowledgeNotification").mockImplementation(() => { throw new Error("simulated acknowledgement interruption"); });
    await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.coordinator.journal().pendingBatches).toHaveLength(1);
    await h.supervisor.suspendAll();
    await h.supervisor.dispose();
    ack.mockRestore();
    const next = await h.restart();
    await vi.waitFor(() => expect(next.coordinator.journal().pendingBatches).toHaveLength(0));
    expect(h.notices).toHaveLength(1);
    expect(h.sessions).toHaveLength(1);
  });

  it("does not resurrect explicitly cancelled children on restart", async () => {
    const entered = deferred();
    const h = await harness();
    h.provider.setResponses([async (_context, options) => {
      entered.resolve(); await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return h.ai.fauxAssistantMessage("cancelled output");
    }]);
    const launched = await h.launch(); await entered.promise;
    await h.coordinator.cancelTask(launched.job.childSessionId);
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.notices[0]).toContain('state="cancelled"');
    const count = h.sessions.length;
    await h.supervisor.suspendAll();
    await h.restart();
    expect(h.sessions).toHaveLength(count);
    expect(h.notices).toHaveLength(1);
  });

  it("revokes suspended claims after disposal without waking or resuming the child", async () => {
    const entered = deferred();
    const h = await harness();
    h.provider.setResponses([async (_context, options) => {
      entered.resolve(); await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return h.ai.fauxAssistantMessage("interrupted");
    }]);
    const launched = await h.launch(); await entered.promise;
    await h.supervisor.suspendAll();
    await h.supervisor.dispose();
    await h.supervisor.revokeSuspension();
    expect(h.notices).toHaveLength(0);
    expect(h.coordinator.journal().jobs.get(launched.job.launchId)?.backgroundResult?.state).toBe("cancelled");
    expect(h.coordinator.journal().pendingBatches[0]?.triggerTurn).toBe(false);
    await h.restart();
    expect(h.sessions).toHaveLength(1);
  });

  it("does not reuse historical assistant text in a later empty period", async () => {
    const h = await harness();
    h.provider.setResponses([h.ai.fauxAssistantMessage("Earlier answer"), h.ai.fauxAssistantMessage("")]);
    const launched = await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    await h.launch("Second task", launched.job.childSessionId);
    await vi.waitFor(() => expect(h.notices).toHaveLength(2));
    expect(h.notices[1]).toContain("without a text response");
    expect(h.notices[1]).not.toContain("Earlier answer");
  });

  it("coalesces concurrent idle follow-ups without orphan reservations", async () => {
    const h = await harness(); const gate = deferred();
    h.provider.setResponses([h.ai.fauxAssistantMessage("First answer"), async () => { await gate.promise; return h.ai.fauxAssistantMessage("Intermediate"); }, h.ai.fauxAssistantMessage("Both followups")]);
    const launched = await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    const results = await Promise.all([h.launch("One", launched.job.childSessionId), h.launch("Two", launched.job.childSessionId)]);
    expect(results[0]!.job.launchId).toBe(results[1]!.job.launchId);
    gate.resolve();
    await vi.waitFor(() => expect(h.notices).toHaveLength(2));
    expect([...h.coordinator.journal().jobs.values()].map((job) => job.status)).toEqual(["complete", "complete"]);
  });

  it("keeps explicit models local and switches idle roles without replacing the native session or title", async () => {
    const h = await harness();
    const contexts: string[] = [];
    h.provider.setResponses([h.ai.fauxAssistantMessage("First result"),
      (context) => { contexts.push(JSON.stringify(context.messages)); return h.ai.fauxAssistantMessage("Experiment result"); }]);
    const launched = await h.launch("Use the requested model", undefined, { model: "background-faux/alternate" });
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.sessions[0]!.model?.id).toBe("alternate");
    expect(h.rows[1]!.model).toBe("background-faux/test");
    const title = h.sessions[0]!.sessionManager.getSessionName();
    h.rows[2]!.model = undefined;
    await h.launch("Perform the experiment", launched.job.childSessionId, { agent: "experiment" });
    await vi.waitFor(() => expect(h.notices).toHaveLength(2));
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.model?.id).toBe("alternate");
    expect(h.sessions[0]!.sessionManager.getSessionName()).toBe(title);
    expect(contexts[0]).toContain("experiment role");
  });

  it("durably accepts running role/model changes and applies them only after whole-run settlement", async () => {
    const h = await harness(); const gate = deferred(); const entered = deferred();
    const modelIDs: string[] = [];
    h.provider.setResponses([
      async (_context, _options, _state, model) => { modelIDs.push(model.id); entered.resolve(); await gate.promise; return h.ai.fauxAssistantMessage("First turn"); },
      (_context, _options, _state, model) => { modelIDs.push(model.id); return h.ai.fauxAssistantMessage("Steer consumed in current run"); },
      (_context, _options, _state, model) => { modelIDs.push(model.id); return h.ai.fauxAssistantMessage("Next run uses new selection"); },
    ]);
    const launched = await h.launch(); await entered.promise;
    await h.launch("Use the requested experiment role and model", launched.job.childSessionId, { agent: "experiment", model: "background-faux/alternate" });
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.model?.id).toBe("test");
    expect(readFileSync(h.sessions[0]!.sessionFile!, "utf8")).toContain('"pending":true');
    gate.resolve();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    await vi.waitFor(() => expect(h.sessions[0]!.model?.id).toBe("alternate"));
    expect(modelIDs).toEqual(["test", "test"]);
    await h.launch("Continue after settlement", launched.job.childSessionId, { agent: "experiment" });
    await vi.waitFor(() => expect(h.notices).toHaveLength(2));
    expect(modelIDs).toEqual(["test", "test", "alternate"]);
    expect(h.rows[2]!.model).toBe("background-faux/test");
  });

  it("runs an actual owned shell tool and delivers its completion through a later child period", async () => {
    const { createManagedShellManager } = await import("../background/shell");
    const { createManagedShellExtension } = await import("../extensions/managed-shell");
    let service!: ReturnType<typeof createManagedShellManager>;
    let sessionID = "";
    const h = await harness([(api) => {
      api.on("session_start", (_event, ctx) => { sessionID = ctx.sessionManager.getSessionId(); });
      return createManagedShellExtension({ manager: service, owner: () => ({ sessionID, cwd: join(root, "project") }) })(api);
    }]);
    service = createManagedShellManager({ agentDir: join(root, "agent"), rootSessionID: h.manager.getSessionId(), cwd: join(root, "project"), worker: false });
    h.coordinator.setShellService(service);
    cleanups.push(() => service.dispose());
    const flag = join(root, "project", "finish");
    const command = process.platform === "win32"
      ? `while (!(Test-Path '${flag}')) { Start-Sleep -Milliseconds 10 }; Write-Output 'shell finished'`
      : `while [ ! -f '${flag}' ]; do sleep 0.01; done; printf 'shell finished'`;
    h.provider.setResponses([
      h.ai.fauxAssistantMessage([{ type: "toolCall", id: "shell-call", name: "shell", arguments: { command, background: true } }], { stopReason: "toolUse" }),
      h.ai.fauxAssistantMessage("Started the command"), h.ai.fauxAssistantMessage("Observed shell completion"),
    ]);
    await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.notices[0]).toContain('state="running"');
    writeFileSync(flag, "finish");
    await vi.waitFor(() => expect(h.notices).toHaveLength(2));
    expect(h.notices[1]).toContain("Observed shell completion");
    expect(service.tasks()[0]?.status).toBe("completed");
  });

  it("reports provider errors while retaining Retry authority and completed side effects", async () => {
    let sideEffects = 0;
    const h = await harness([(api) => { api.registerTool({ name: "effect", label: "Effect", description: "One owned side effect", parameters: Type.Object({}),
      execute: async () => { sideEffects++; return { content: [{ type: "text", text: "effect committed" }], details: {} }; } }); }]);
    h.coordinator.registerRecovery({ sessionId: h.manager.getSessionId(), sessionPath: h.manager.getSessionFile()!,
      recovery: { state: () => ({ targetSessionId: h.manager.getSessionId() }) } as LlmRecoveryController });
    h.provider.setResponses([
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("effect", {}), { stopReason: "toolUse" }),
      h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" }),
      h.ai.fauxAssistantMessage("Recovered without repeating tools"),
    ]);
    const launched = await h.launch();
    await vi.waitFor(() => expect(h.coordinator.retryState(launched.job.childSessionId)?.llmRecovery?.status).toBe("available"));
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.notices[0]).toContain('state="error"');
    expect(h.supervisor.hasRunningChildren()).toBe(true);
    const checkpoint = h.coordinator.retryState(launched.job.childSessionId)!.llmRecovery!;
    await h.coordinator.retry(launched.job.childSessionId, checkpoint.failureId);
    await vi.waitFor(() => expect(h.notices).toHaveLength(2));
    expect(h.notices[1]).toContain("Recovered without repeating tools");
    expect(sideEffects).toBe(1);
    expect(h.sessions).toHaveLength(1);
    expect(h.coordinator.retryState(launched.job.childSessionId)?.llmRecovery).toBeNull();
  });

  it("reports an idle parent before its nested child completes and later propagates the child result", async () => {
    const h = await harness(); const nested = deferred();
    h.rows[1]!.subagents = ["experiment"];
    const response: import("@earendil-works/pi-ai").FauxResponseFactory = async (context) => {
      const system = h.ai.getCurrentSystemPrompt(context.messages);
      if (system.includes("experiment role")) { await nested.promise; return h.ai.fauxAssistantMessage("Nested evidence complete"); }
      const transcript = JSON.stringify(context.messages);
      if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent")) {
        return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", { agent: "experiment", description: "Verify nested evidence", prompt: "Nested task" }), { stopReason: "toolUse" });
      }
      return h.ai.fauxAssistantMessage(transcript.includes("Nested evidence complete") ? "Accepted nested evidence" : "Parent independently idle");
    };
    h.provider.setResponses(Array.from({ length: 10 }, () => response));
    await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    expect(h.notices[0]).toContain("Parent independently idle");
    expect(h.notices[0]).toContain('state="running"');
    expect(h.notices[0]).toContain("- subagent (experiment, sessionID:");
    nested.resolve();
    await vi.waitFor(() => expect(h.notices).toHaveLength(2));
    expect(h.notices[1]).toContain("Accepted nested evidence");
    expect(h.sessions).toHaveLength(2);
  });

  it("retains aggregate ownership for a parked nested recovery after its ancestors idle", async () => {
    const h = await harness();
    const activity: boolean[] = [];
    h.supervisor.subscribeActivity((active) => activity.push(active));
    h.rows[1]!.subagents = ["experiment"];
    const response: import("@earendil-works/pi-ai").FauxResponseFactory = (context) => {
      if (h.ai.getCurrentSystemPrompt(context.messages).includes("experiment role")) return h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 nested failure" });
      if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent")) {
        return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", { agent: "experiment", description: "Nested task", prompt: "Nested work" }), { stopReason: "toolUse" });
      }
      return h.ai.fauxAssistantMessage("Parent is idle");
    };
    h.provider.setResponses(Array.from({ length: 12 }, () => response));
    const parent = await h.launch();
    await vi.waitFor(() => expect(h.sessions).toHaveLength(2));
    const child = h.sessions.find((session) => session.systemPrompt.includes("experiment role"))!;
    await vi.waitFor(() => expect(h.coordinator.retryState(child.sessionId)?.llmRecovery?.status).toBe("available"));
    await vi.waitFor(() => expect(h.sessions.every((session) => session.isIdle)).toBe(true));
    await vi.waitFor(() => expect(h.coordinator.journal().pendingBatches).toHaveLength(0));
    expect(h.supervisor.isQuiescent()).toBe(false);
    expect(activity.at(-1)).toBe(true);
    expect(h.supervisor.backgroundTasks().map((task) => task.sessionID)).toContain(parent.job.childSessionId);
    await h.coordinator.cancelTask(child.sessionId);
    await vi.waitFor(() => expect(h.supervisor.isQuiescent()).toBe(true));
    expect(activity.at(-1)).toBe(false);
  });

  it.each(["selected subtree", "terminal owner"] as const)("preserves late descendant cancellation reports during %s shutdown without inference", async (mode) => {
    const h = await harness();
    h.rows[1]!.subagents = ["experiment"];
    const response: import("@earendil-works/pi-ai").FauxResponseFactory = (context) => {
      if (h.ai.getCurrentSystemPrompt(context.messages).includes("experiment role")) return h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 parked descendant" });
      if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent")) {
        return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", { agent: "experiment", description: "Nested task", prompt: "Nested work" }), { stopReason: "toolUse" });
      }
      return h.ai.fauxAssistantMessage("Parent is idle");
    };
    h.provider.setResponses(Array.from({ length: 12 }, () => response));
    const parent = await h.launch();
    await vi.waitFor(() => expect(h.sessions).toHaveLength(2));
    const child = h.sessions.find((session) => session.systemPrompt.includes("experiment role"))!;
    const owner = h.sessions.find((session) => session.sessionId === parent.job.childSessionId)!;
    await vi.waitFor(() => expect(h.coordinator.retryState(child.sessionId)?.llmRecovery?.status).toBe("available"));
    await vi.waitFor(() => expect(h.sessions.every((session) => session.isIdle)).toBe(true));
    await vi.waitFor(() => expect(h.coordinator.journal().pendingBatches).toHaveLength(0));
    const requests = h.provider.state.callCount;
    const entered = deferred(); const release = deferred();
    const abort = child.abort.bind(child);
    const delayedAbort = vi.spyOn(child, "abort").mockImplementation(async () => { entered.resolve(); await release.promise; await abort(); });
    const stopping = mode === "selected subtree" ? h.coordinator.cancelTask(owner.sessionId) : h.supervisor.abortAll("Terminal Exit");
    try {
      await entered.promise;
      // Let the recipient's closing flush reach its asynchronous boundary while
      // the descendant still owns its final cancellation report.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      release.resolve();
      await stopping;
      const cancelled = [...h.coordinator.journal().jobs.values()].filter((job) => job.childSessionId === child.sessionId && job.backgroundResult?.state === "cancelled");
      expect(cancelled).toHaveLength(1);
      const handoffs = owner.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && typeof entry.content === "string"
        && entry.content.includes(`sessionID="${child.sessionId}"`) && entry.content.includes('state="cancelled"'));
      expect(handoffs).toHaveLength(1);
      expect(h.coordinator.journal().acknowledgedNotificationLaunchIds.has(cancelled[0]!.launchId)).toBe(true);
      expect(h.coordinator.journal().pendingBatches).toHaveLength(0);
      expect(h.provider.state.callCount).toBe(requests);
      expect(h.supervisor.isQuiescent()).toBe(true);
    } finally { release.resolve(); await stopping; delayedAbort.mockRestore(); }
  });

  it("serializes same-session continuation behind cancelled runtime disposal", async () => {
    const h = await harness();
    const disposalEntered = deferred(); const releaseDisposal = deferred();
    const secondEntered = deferred(); const releaseSecond = deferred();
    vi.spyOn(h.live, "acquireProject").mockImplementation(async (cwd) => ({ cwd, release: async () => { disposalEntered.resolve(); await releaseDisposal.promise; } }));
    h.provider.setResponses([h.ai.fauxAssistantMessage("First result"), async () => { secondEntered.resolve(); await releaseSecond.promise; return h.ai.fauxAssistantMessage("Second result"); }]);
    const launched = await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    const cancelling = h.coordinator.cancelTask(launched.job.childSessionId);
    await disposalEntered.promise;
    const following = h.launch("Continue after cancellation", launched.job.childSessionId);
    const staleCancellation = h.coordinator.cancelTask(launched.job.childSessionId);
    try {
      await vi.waitFor(() => expect([...h.coordinator.journal().jobs.values()]).toHaveLength(2));
      const admittedBeforeDisposal = await Promise.race([following.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))]);
      expect(admittedBeforeDisposal).toBe(false);
      expect(h.sessions).toHaveLength(1);
      releaseDisposal.resolve();
      await cancelling; await following; await staleCancellation; await secondEntered.promise;
      expect(h.supervisor.backgroundTasks().map((task) => task.sessionID)).toContain(launched.job.childSessionId);
      expect([...h.coordinator.journal().jobs.values()].at(-1)?.status).toBe("working");
    } finally {
      releaseDisposal.resolve(); releaseSecond.resolve();
      await cancelling; await following; await staleCancellation;
    }
  });

  it.each(["preparing", "applying"] as const)("does not lose child role/model selection while a configuration candidate is %s", async (phase) => {
    const h = await harness();
    h.provider.setResponses([h.ai.fauxAssistantMessage("First result"), h.ai.fauxAssistantMessage("Next result")]);
    const launched = await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    const loading = deferred(); const release = deferred();
    let restoreReload: (() => void) | undefined;
    if (phase === "preparing") h.setModelRuntimeGate(async () => { loading.resolve(); await release.promise; });
    else {
      const originalReload = h.sessions[0]!.reload.bind(h.sessions[0]);
      const reload = vi.spyOn(h.sessions[0]!, "reload").mockImplementation(async () => { loading.resolve(); await release.promise; await originalReload(); });
      restoreReload = () => reload.mockRestore();
    }
    const selection = vi.spyOn(h.bindings[0]! as AgentRuntimeBinding & Required<Pick<AgentRuntimeBinding, "setChildSelection">>, "setChildSelection");
    h.publishConfiguration();
    await loading.promise;
    const following = h.launch("Switch child role", launched.job.childSessionId, { agent: "experiment", model: "background-faux/alternate" });
    try {
      await vi.waitFor(() => expect(selection).toHaveBeenCalled());
      release.resolve(); await following;
      await vi.waitFor(() => expect(h.notices).toHaveLength(2));
      expect(h.bindings[0]!.current().name).toBe("experiment");
      expect(h.sessions[0]!.systemPrompt).toContain("experiment role");
      expect(h.sessions[0]!.model?.id).toBe("alternate");
      await h.bindings[0]!.ensureCurrent();
      expect(h.bindings[0]!.current().name).toBe("experiment");
    } finally { release.resolve(); await following; h.setModelRuntimeGate(); restoreReload?.(); }
  });

  it("restores an idle child's latest persisted selection rather than its previous period model", async () => {
    const h = await harness(); const entered = deferred(); const release = deferred();
    const tasks: BackgroundTask[] = [];
    const service: SubagentShellService = { attachOwner: () => () => {}, tasks: () => tasks,
      hasWork: (id) => tasks.some((task) => !id || task.sessionID === id), subscribe: () => () => {}, cancel: async () => { tasks.length = 0; } };
    h.coordinator.setShellService(service);
    h.provider.setResponses([async () => { entered.resolve(); await release.promise; return h.ai.fauxAssistantMessage("Initial response"); }, h.ai.fauxAssistantMessage("Followup consumed")]);
    const launched = await h.launch(); await entered.promise;
    tasks.push({ id: "remaining-shell", kind: "shell", sessionID: launched.job.childSessionId, description: "Remaining work", status: "running", blocking: false });
    try {
      await h.launch("Switch while working", launched.job.childSessionId, { agent: "experiment", model: "background-faux/alternate" });
      release.resolve();
      await vi.waitFor(() => expect(h.sessions[0]!.model?.id).toBe("alternate"));
      await h.supervisor.suspendAll();
      await h.restart(service);
      expect(h.sessions).toHaveLength(2);
      expect(h.sessions[1]!.systemPrompt).toContain("experiment role");
      expect(h.sessions[1]!.model?.id).toBe("alternate");
      expect(h.provider.state.callCount).toBe(2);
    } finally { release.resolve(); tasks.length = 0; }
  });

  it.each(["prepare", "revoke"] as const)("does not %s inherited execution claims in a native fork", async (operation) => {
    const h = await harness(); const entered = deferred(); const release = deferred();
    h.provider.setResponses([async () => { entered.resolve(); await release.promise; return h.ai.fauxAssistantMessage("Original child finished"); }]);
    const launched = await h.launch(); await entered.promise;
    const child = h.sessions[0]!;
    const fork = h.pi.SessionManager.forkFrom(h.manager.getSessionFile()!, join(root, "project"), join(root, "sessions"));
    const forkCoordinator = new SubagentCoordinator(fork);
    expect(fork.getSessionId()).not.toBe(h.manager.getSessionId());
    expect(forkCoordinator.journal().jobs.has(launched.job.launchId)).toBe(true);
    const before = {
      child: readFileSync(child.sessionFile!), root: readFileSync(h.manager.getSessionFile()!), fork: readFileSync(fork.getSessionFile()!),
      childLeaf: child.sessionManager.getLeafId(), forkLeaf: fork.getLeafId(), rootLeaf: h.manager.getLeafId(),
    };
    try {
      if (operation === "prepare") await forkCoordinator.prepareBackgroundRecovery(join(root, "project"), true);
      else await forkCoordinator.cancelSuspended();
      expect(forkCoordinator.claimBackgroundRestart(launched.job.launchId)).toBe(false);
      forkCoordinator.commitBackgroundReport(launched.job.launchId, { state: "cancelled", text: "Not owned", outstanding: [] });
      expect(readFileSync(child.sessionFile!)).toEqual(before.child);
      expect(child.sessionManager.getLeafId()).toBe(before.childLeaf);
      expect(h.pi.SessionManager.open(child.sessionFile!).getLeafId()).toBe(before.childLeaf);
      expect(readFileSync(h.manager.getSessionFile()!)).toEqual(before.root);
      expect(h.manager.getLeafId()).toBe(before.rootLeaf);
      expect(readFileSync(fork.getSessionFile()!)).toEqual(before.fork);
      expect(fork.getLeafId()).toBe(before.forkLeaf);
      expect(child.isStreaming).toBe(true);
    } finally { release.resolve(); }
  });

  it("keeps completed fork references readable without granting UUID or alias continuation authority", async () => {
    const h = await harness(); const entered = deferred(); const release = deferred();
    h.provider.setResponses([h.ai.fauxAssistantMessage("First period complete"), async () => { entered.resolve(); await release.promise; return h.ai.fauxAssistantMessage("Live original period"); }]);
    const launched = await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    const fork = h.pi.SessionManager.forkFrom(h.manager.getSessionFile()!, join(root, "project"), join(root, "sessions"));
    const forkCoordinator = new SubagentCoordinator(fork);
    await h.launch("Original child continues", launched.job.childSessionId); await entered.promise;
    const child = h.sessions[0]!;
    const childBytes = readFileSync(child.sessionFile!); const forkBytes = readFileSync(fork.getSessionFile()!);
    const childLeaf = child.sessionManager.getLeafId();
    try {
      expect(forkCoordinator.journal().jobs.has(launched.job.launchId)).toBe(true);
      expect(forkCoordinator.ownedJournal().jobs.size).toBe(0);
      const request = { ownerSessionId: fork.getSessionId(), toolCallId: "foreign-followup", catalog: { all: h.rows, available: [h.rows[1]!] } };
      expect(() => forkCoordinator.reserveDispatch({ ...request, requested: "search", description: "Foreign followup", sessionID: launched.job.childSessionId })).toThrow(/immediate child/);
      expect(() => forkCoordinator.reserveDispatch({ ...request, requested: launched.job.agentId })).toThrow(/owned immediate child/);
      expect(readFileSync(child.sessionFile!)).toEqual(childBytes);
      expect(child.sessionManager.getLeafId()).toBe(childLeaf);
      expect(readFileSync(fork.getSessionFile()!)).toEqual(forkBytes);
    } finally { release.resolve(); }
  });

  it("never replays inherited reports or terminalizes inherited nested jobs from a native fork", async () => {
    const h = await harness(); const entered = deferred(); const release = deferred();
    h.provider.setResponses([async () => { entered.resolve(); await release.promise; return h.ai.fauxAssistantMessage("Original child finished"); }, h.ai.fauxAssistantMessage("Original reports consumed")]);
    await h.launch(); await entered.promise;
    const child = h.sessions[0]!;
    const makeNested = (modern: boolean) => {
      const manager = h.pi.SessionManager.create(join(root, "project"), join(root, "sessions"));
      manager.appendMessage({ role: "user", content: "Nested admitted input", timestamp: Date.now() });
      const reservation = h.coordinator.reserveDispatch({ ownerSessionId: child.sessionId, toolCallId: modern ? "modern" : "legacy", requested: "experiment",
        catalog: { all: h.rows, available: [h.rows[2]!] }, ...(modern ? { description: "Nested report" } : {}) });
      h.coordinator.recordMaterialized(reservation, { childSessionId: manager.getSessionId(), sessionPath: manager.getSessionFile()! });
      h.coordinator.recordLaunchAcknowledged(reservation.launchId);
      if (modern) {
        h.coordinator.recordBackgroundAdmission(reservation.launchId, { cwd: join(root, "project"), callerAgent: "search", description: "Nested report" });
        h.coordinator.commitBackgroundReport(reservation.launchId, { state: "completed", text: "Previously committed nested result", outstanding: [] });
      }
      return { manager, reservation };
    };
    const modern = makeNested(true); const legacy = makeNested(false);
    const fork = h.pi.SessionManager.forkFrom(h.manager.getSessionFile()!, join(root, "project"), join(root, "sessions"));
    const forkCoordinator = new SubagentCoordinator(fork);
    const paths = [h.manager.getSessionFile()!, child.sessionFile!, modern.manager.getSessionFile()!, legacy.manager.getSessionFile()!, fork.getSessionFile()!];
    const bytes = paths.map((path) => readFileSync(path));
    const leaves = paths.map((path) => h.pi.SessionManager.open(path).getLeafId());
    const store: RecoverySessionStore = {
      inspect: vi.fn(async (path) => { const manager = h.pi.SessionManager.open(path); return { readable: true, sessionId: manager.getSessionId(), cwd: manager.getCwd() }; }),
      appendHiddenMessage: vi.fn(async (path, message) => { const manager = h.pi.SessionManager.open(path); manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); }),
    };
    try {
      const recovered = await recoverSubagentTree({ coordinator: forkCoordinator, store, expectedCwd: join(root, "project") });
      forkCoordinator.acknowledgeNotification(`subagent:${modern.reservation.launchId}`);
      forkCoordinator.recordTerminal({ launchId: legacy.reservation.launchId, status: "error" });
      expect(recovered).toEqual({ interruptedLaunchIds: [], unmaterializedLaunchIds: [], acknowledgedBatchIds: [], notifications: [] });
      expect(store.inspect).not.toHaveBeenCalled();
      expect(store.appendHiddenMessage).not.toHaveBeenCalled();
      for (let index = 0; index < paths.length; index++) {
        expect(readFileSync(paths[index]!)).toEqual(bytes[index]);
        expect(h.pi.SessionManager.open(paths[index]!).getLeafId()).toBe(leaves[index]);
      }
      expect(child.sessionManager.getLeafId()).toBe(leaves[1]);
      expect(forkCoordinator.journal().jobs.get(legacy.reservation.launchId)?.status).toBe("working");
      expect(forkCoordinator.journal().pendingBatches.some((batch) => batch.launchIds.includes(modern.reservation.launchId))).toBe(true);
    } finally { h.coordinator.recordLaunchSuppressed(legacy.reservation.launchId); release.resolve(); }
  });

  it("prepares and revokes owned descendant claims through a terminal parent edge", async () => {
    const h = await harness();
    const launched = await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    const descendant = h.pi.SessionManager.create(join(root, "project"), join(root, "sessions"));
    descendant.appendMessage({ role: "user", content: "Interrupted nested task", timestamp: Date.now() });
    const nested = h.coordinator.reserveDispatch({ ownerSessionId: launched.job.childSessionId, toolCallId: "nested-claim", requested: "experiment", description: "Nested interrupted task",
      catalog: { all: h.rows, available: [h.rows[2]!] } });
    h.coordinator.recordMaterialized(nested, { childSessionId: descendant.getSessionId(), sessionPath: descendant.getSessionFile()! });
    h.coordinator.recordBackgroundAdmission(nested.launchId, { cwd: join(root, "project"), callerAgent: "search", description: "Nested interrupted task" });
    h.coordinator.recordLaunchAcknowledged(nested.launchId);
    const { ExecutionClaims } = await import("../background/execution-claims");
    new ExecutionClaims(descendant).start();
    await h.supervisor.suspendAll();
    const parentBytes = readFileSync(h.sessions[0]!.sessionFile!);
    const successor = new SubagentCoordinator(h.pi.SessionManager.open(h.manager.getSessionFile()!));
    await successor.prepareBackgroundRecovery(join(root, "project"), true);
    expect(new ExecutionClaims(h.pi.SessionManager.open(descendant.getSessionFile()!)).current()).toMatchObject({ attempts: 1, pending: true });
    expect(successor.journal().jobs.get(nested.launchId)?.restartAttempts).toBe(1);
    expect(readFileSync(h.sessions[0]!.sessionFile!)).toEqual(parentBytes);
    await successor.cancelSuspended();
    expect(new ExecutionClaims(h.pi.SessionManager.open(descendant.getSessionFile()!)).current()).toMatchObject({ pending: false, outcome: "cancelled" });
    expect(successor.ownedJournal().pendingBatches).toEqual([expect.objectContaining({ ownerSessionId: launched.job.childSessionId, launchIds: [nested.launchId], triggerTurn: false })]);
  });

  it.each([false, true])("distinguishes reused provider call IDs across native assistant rows (same text: %s)", async (sameText) => {
    const h = await harness();
    h.provider.setResponses([h.ai.fauxAssistantMessage("Initial result"), h.ai.fauxAssistantMessage("First followup result"), h.ai.fauxAssistantMessage("Second followup result")]);
    const child = await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    const tool = createSubagentTool({ coordinator: h.coordinator, supervisor: h.supervisor, liveConfiguration: h.live, callerAgent: "research-assistant" });
    const context = { cwd: join(root, "project"), sessionManager: h.manager, model: h.provider.getModel() } as unknown as ExtensionToolContext;
    const prompts = ["Please check again", sameText ? "Please check again" : "Please check the second source"];
    let latestParams!: { agent: string; description: string; prompt: string; sessionID: string };
    for (let index = 0; index < prompts.length; index++) {
      latestParams = { agent: "search", description: "Verify source", prompt: prompts[index]!, sessionID: child.job.childSessionId };
      h.manager.appendMessage(h.ai.fauxAssistantMessage([
        { type: "toolCall", id: "reused-call", name: "subagent", arguments: latestParams },
        { type: "toolCall", id: `sibling-${index}`, name: "read", arguments: { path: "notes.md" } },
      ], { stopReason: "toolUse", timestamp: 1 }));
      h.manager.appendMessage({ role: "toolResult", toolCallId: `sibling-${index}`, toolName: "read", content: [{ type: "text", text: "Sibling tool already finished" }], isError: false, timestamp: 1 });
      const result = await tool.execute("reused-call", latestParams, undefined, undefined, context);
      h.manager.appendMessage({ role: "toolResult", toolCallId: "reused-call", toolName: "subagent", content: result.content as any, details: result.details, isError: false, timestamp: 1 });
      await vi.waitFor(() => expect(h.notices).toHaveLength(index + 2));
    }
    const inputs = h.sessions[0]!.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "easyresearch:subagent_input");
    expect(inputs.map((entry) => (entry as any).content)).toEqual(prompts);
    expect(new Set(inputs.map((entry) => (entry as any).details.inputID)).size).toBe(2);
    const periods = h.coordinator.ownedJournal().jobs.size;
    await tool.execute("reused-call", latestParams, undefined, undefined, context);
    expect(h.provider.state.callCount).toBe(3);
    expect(h.coordinator.ownedJournal().jobs.size).toBe(periods);
    expect(h.sessions[0]!.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "easyresearch:subagent_input")).toHaveLength(2);
  });

  it("shares one initial admission when the same native invocation is re-admitted concurrently", async () => {
    const h = await harness(); const entered = deferred(); const release = deferred();
    h.provider.setResponses([async () => { entered.resolve(); await release.promise; return h.ai.fauxAssistantMessage("One child result"); }]);
    const params = { agent: "search", description: "One task", prompt: "Perform one task" };
    h.manager.appendMessage(h.ai.fauxAssistantMessage([{ type: "toolCall", id: "spawn-id", name: "subagent", arguments: params }], { stopReason: "toolUse" }));
    const tool = createSubagentTool({ coordinator: h.coordinator, supervisor: h.supervisor, liveConfiguration: h.live, callerAgent: "research-assistant" });
    const context = { cwd: join(root, "project"), sessionManager: h.manager, model: h.provider.getModel() } as unknown as ExtensionToolContext;
    try {
      const [first, duplicate] = await Promise.all([tool.execute("spawn-id", params, undefined, undefined, context), tool.execute("spawn-id", params, undefined, undefined, context)]);
      await entered.promise;
      expect(first.details).toEqual(duplicate.details);
      expect(h.sessions).toHaveLength(1);
      expect(h.coordinator.ownedJournal().jobs.size).toBe(1);
      release.resolve();
      await vi.waitFor(() => expect(h.notices).toHaveLength(1));
      await tool.execute("spawn-id", params, undefined, undefined, context);
      expect(h.provider.state.callCount).toBe(1);
      expect(h.sessions).toHaveLength(1);
      await expect(tool.execute("spawn-id", { ...params, prompt: "Conflicting replacement" }, undefined, undefined, context)).rejects.toThrow(/identity conflicts/);
    } finally { release.resolve(); }
  });

  it("allocates independent host admission IDs when no exact native assistant entry is available", async () => {
    const h = await harness();
    h.provider.setResponses([h.ai.fauxAssistantMessage("Initial"), h.ai.fauxAssistantMessage("First followup"), h.ai.fauxAssistantMessage("Second followup")]);
    const child = await h.launch();
    await vi.waitFor(() => expect(h.notices).toHaveLength(1));
    const params = { agent: "search", description: "Repeat request", prompt: "Please repeat", sessionID: child.job.childSessionId };
    const tool = createSubagentTool({ coordinator: h.coordinator, supervisor: h.supervisor, liveConfiguration: h.live, callerAgent: "research-assistant" });
    const context = { cwd: join(root, "project"), model: h.provider.getModel(), sessionManager: {
      getSessionId: () => h.manager.getSessionId(),
      getBranch: () => [{ type: "message", message: h.ai.fauxAssistantMessage([{ type: "toolCall", id: "host-call", name: "subagent", arguments: params }], { stopReason: "toolUse" }) }],
    } } as unknown as ExtensionToolContext;
    for (let index = 0; index < 2; index++) {
      await tool.execute("host-call", params, undefined, undefined, context);
      await vi.waitFor(() => expect(h.notices).toHaveLength(index + 2));
    }
    const inputs = h.sessions[0]!.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "easyresearch:subagent_input");
    expect(inputs).toHaveLength(2);
    expect(new Set(inputs.map((entry) => (entry as any).details.inputID)).size).toBe(2);
  });

  it("invalidates Retry preflight synchronously and deduplicates cancellation of the captured generation", async () => {
    const h = await harness(); const entered = deferred(); const release = deferred();
    h.coordinator.registerRecovery({ sessionId: h.manager.getSessionId(), sessionPath: h.manager.getSessionFile()!,
      recovery: { state: () => ({ targetSessionId: h.manager.getSessionId() }) } as LlmRecoveryController });
    h.provider.setResponses([h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 unavailable" }), h.ai.fauxAssistantMessage("Must not run")]);
    const child = await h.launch();
    await vi.waitFor(() => expect(h.coordinator.retryState(child.job.childSessionId)?.llmRecovery?.status).toBe("available"));
    const checkpoint = h.coordinator.retryState(child.job.childSessionId)!.llmRecovery!;
    vi.spyOn(h.bindings[0]!, "ensureCurrent").mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const retry = h.coordinator.retry(child.job.childSessionId, checkpoint.failureId).then(() => undefined, (error) => error);
    await entered.promise;
    const cancelling = h.coordinator.cancelTask(child.job.childSessionId);
    const duplicate = h.coordinator.cancelTask(child.job.childSessionId);
    try {
      expect(h.coordinator.retryState(child.job.childSessionId)?.llmRecovery ?? null).toBeNull();
      release.resolve();
      expect(await retry).toBeInstanceOf(Error);
      await Promise.all([cancelling, duplicate]);
      await vi.waitFor(() => expect(h.supervisor.isQuiescent()).toBe(true));
      expect(h.provider.state.callCount).toBe(1);
      expect(h.sessions[0]!.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === LLM_RETRY_CONTROL_TYPE)).toBe(false);
    } finally { release.resolve(); await Promise.all([cancelling, duplicate]); }
  });

  it.each([
    { targetThinking: undefined, targetModel: undefined, expected: "medium" },
    { targetThinking: "low", targetModel: undefined, expected: "low" },
    { targetThinking: "low", targetModel: "background-faux/test", expected: "off" },
  ] as const)("inherits the caller variant with target precedence and native clamping: $expected", async ({ targetThinking, targetModel, expected }) => {
    const h = await harness();
    h.rows[0]!.model = "background-faux/reasoner"; h.rows[0]!.thinking = "high";
    h.rows[1]!.model = "background-faux/reasoner"; h.rows[1]!.thinking = undefined; h.rows[1]!.subagents = ["experiment"];
    h.rows[2]!.model = targetModel; h.rows[2]!.thinking = targetThinking;
    h.coordinator.bindResearchAssistantState({ model: () => h.rows[0]!.model, thinking: () => h.rows[0]!.thinking });
    const response: import("@earendil-works/pi-ai").FauxResponseFactory = (context) => {
      if (h.ai.getCurrentSystemPrompt(context.messages).includes("experiment role")) return h.ai.fauxAssistantMessage("Nested result");
      if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent")) return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", {
        agent: "experiment", description: "Nested reasoning task", prompt: "Use inherited settings",
      }), { stopReason: "toolUse" });
      return h.ai.fauxAssistantMessage("Parent result");
    };
    h.provider.setResponses(Array.from({ length: 12 }, () => response));
    await h.launch("Delegate with the selected variant", undefined, { model: "background-faux/reasoner", thinking: "medium" });
    await vi.waitFor(() => expect(h.sessions).toHaveLength(2));
    await vi.waitFor(() => expect(h.supervisor.isQuiescent()).toBe(true));
    expect(h.coordinator.getResearchAssistantThinking()).toBe("high");
    expect(h.sessions[0]!.thinkingLevel).toBe("medium");
    expect(h.sessions[1]!.thinkingLevel).toBe(expected);
  });

  it("retries a completion-woken period once when the actual child report is already consumed", async () => {
    const released = deferred(); const childEntered = deferred();
    const h = await harness([(api) => { api.registerTool({ name: "hold", label: "Hold", description: "Wait for child release", parameters: Type.Object({}),
      execute: async () => { childEntered.resolve(); await released.promise; return { content: [{ type: "text", text: "Nested tool done" }], details: {} }; } }); }], { enabled: true, maxRetries: 1, baseDelayMs: 0 });
    h.rows[1]!.subagents = ["experiment"];
    h.coordinator.registerRecovery({ sessionId: h.manager.getSessionId(), sessionPath: h.manager.getSessionFile()!,
      recovery: { state: () => ({ targetSessionId: h.manager.getSessionId() }) } as LlmRecoveryController });
    const requests: Array<{ notices: string[]; last: unknown }> = [];
    const response: import("@earendil-works/pi-ai").FauxResponseFactory = (context) => {
      const toolDone = (name: string) => context.messages.some((message) => message.role === "toolResult" && message.toolName === name);
      if (h.ai.getCurrentSystemPrompt(context.messages).includes("experiment role")) return h.ai.fauxAssistantMessage(toolDone("hold") ? "Nested result"
        : h.ai.fauxToolCall("hold", {}), { stopReason: toolDone("hold") ? "stop" : "toolUse" });
      if (!toolDone("subagent")) return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", { agent: "experiment", description: "Nested task", prompt: "Nested work" }), { stopReason: "toolUse" });
      const notices = context.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("<background-result"));
      if (notices.length) {
        requests.push({ notices: notices.map((notice) => JSON.stringify(notice)), last: context.messages.at(-1) });
        return requests.length <= 2 ? h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 failed completion wake" }) : h.ai.fauxAssistantMessage("Recovered completion wake");
      }
      return h.ai.fauxAssistantMessage("Waiting for child");
    };
    h.provider.setResponses(Array.from({ length: 20 }, () => response));
    try {
      const parent = await h.launch(); await childEntered.promise;
      await vi.waitFor(() => expect(h.sessions[0]!.isIdle).toBe(true));
      expect(requests).toHaveLength(0);
      released.resolve();
      await vi.waitFor(() => expect(h.coordinator.retryState(parent.job.childSessionId)?.llmRecovery?.status).toBe("available"));
      expect(requests).toHaveLength(2);
      const checkpoint = h.coordinator.retryState(parent.job.childSessionId)!.llmRecovery!;
      await h.coordinator.retry(parent.job.childSessionId, checkpoint.failureId);
      await vi.waitFor(() => expect(h.supervisor.isQuiescent()).toBe(true));
      expect(requests, JSON.stringify(requests)).toHaveLength(3);
      const notices = h.sessions[0]!.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "easyresearch:agent_status");
      expect(notices).toHaveLength(1);
    } finally { released.resolve(); }
  });
});
