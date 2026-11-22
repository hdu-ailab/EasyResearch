import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Context, FauxResponseFactory } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { importPi } from "../runtime/pi-import";
import type { LiveConfiguration } from "../runtime/live-configuration";
import type { AgentRuntimeBinding } from "../runtime/agent-runtime-binding";
import type { ConfigurationEvent } from "./contracts";
import { createAgentDefinitionExtension } from "../extensions/agent-definition";
import type { AgentConfig } from "../subagent/agents";
import { SubagentCoordinator } from "../subagent/coordinator";
import { SubagentSupervisor } from "../subagent/supervisor";
import { createStageSessionLauncher, type StageSessionDependencies } from "../subagent/stage-session";
import { createManualCompactionExtension } from "./manual-compaction";
import { createSessionStatsExtension } from "../extensions/session-stats";
import { ActiveSessionRegistry } from "./active-sessions";
import { AGENT_STATUS_TYPE, projectSubagentCompletionEntry } from "../subagent/notifications";
import { projectSessionTimeline } from "./session-timeline";
import type { SubagentSupervisorEvent } from "../subagent/contracts";
import type { TimelineEntryAppendedEventDto } from "./contracts";
import {
  createPiAgentSessionCreator,
  PiSessionFactory,
  type ManagedAgentSession,
  type PiRuntimeDependencies,
} from "./session-adapter";
import { LLM_RETRY_CONTROL_TYPE } from "../runtime/llm-recovery";

vi.mock("../runtime/logger", () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-session-lifecycle-"));
  for (const name of ["home", "agent", "project", "sessions"]) mkdirSync(join(root, name));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("USERPROFILE", join(root, "home"));
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubGlobal("fetch", async () => { throw new Error("Network forbidden in lifecycle tests"); });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function harness(options: {
  extensions?: ExtensionFactory[];
  compact?: boolean;
  keepRecentTokens?: number;
  filesystemExtensions?: boolean;
  failAfterAttach?: boolean;
  schedule?: (run: () => void) => void;
  dispatch?: boolean;
  retry?: { enabled: boolean; maxRetries?: number; baseDelayMs?: number };
} = {}) {
  const pi = await importPi();
  const ai = await import("@earendil-works/pi-ai");
  const provider = ai.fauxProvider({
    provider: "lifecycle-faux",
    models: [{ id: "test", contextWindow: 16_000, maxTokens: 1_000 }],
    tokenSize: { min: 10_000, max: 10_000 },
  });
  provider.setResponses([ai.fauxAssistantMessage("complete")]);
  const rows = ["research-assistant", "search", ...(options.dispatch ? ["reviewer"] : [])].map((name): AgentConfig => ({
    name, description: name, enabled: true, builtin: true, source: "bundled",
    filePath: join(root, `${name}.md`), systemPrompt: `${name} test role`,
    tools: options.dispatch ? ["hold", "subagent"] : ["hold"], effectiveTools: options.dispatch ? ["hold", "subagent"] : ["hold"],
    skills: [], effectiveSkills: [], effectiveSkillPaths: [], missingSkills: [],
    subagents: name === "research-assistant" ? ["search"] : options.dispatch && name === "search" ? ["reviewer"] : [],
    model: "lifecycle-faux/test", thinking: "off",
  }));
  const configListeners = new Set<(event: ConfigurationEvent) => void>();
  let generation = 1;
  const live = {
    get generation() { return generation; }, availabilityEpoch: 0,
    compactionPolicy: { triggerPercent: 70, globalEnabled: options.compact ?? false, globalKeepRecentTokens: options.keepRecentTokens ?? 100 },
    synchronize: async () => {},
    acquireProject: async (cwd: string) => ({ cwd, release: async () => {} }),
    isCurrent: (candidate: number) => candidate === generation,
    resolveAgents: async () => rows,
    subscribe: (listener: (event: ConfigurationEvent) => void) => {
      configListeners.add(listener);
      return () => configListeners.delete(listener);
    },
  } as unknown as LiveConfiguration;
  const sessions: AgentSession[] = [];
  const supervisors: SubagentSupervisor[] = [];
  const bindings: AgentRuntimeBinding[] = [];
  const trackBinding = (binding: AgentRuntimeBinding) => {
    bindings.push(binding);
    if (options.failAfterAttach) {
      const attach = binding.attach.bind(binding);
      vi.spyOn(binding, "attach").mockImplementation(async (session) => {
        await attach(session);
        throw new Error("fixture attachment failed");
      });
    }
  };
  const common = {
    agentDir: join(root, "agent"),
    createSessionManager: (cwd: string) => pi.SessionManager.create(cwd, join(root, "sessions")),
    openSessionManager: (path: string) => pi.SessionManager.open(path, join(root, "sessions")),
    createSettingsManager: () => pi.SettingsManager.inMemory({
      compaction: { enabled: options.compact ?? false, keepRecentTokens: options.keepRecentTokens ?? 100 }, retry: options.retry ?? { enabled: false },
    }),
    createModelRuntime: async () => {
      const runtime = await pi.ModelRuntime.create({
        credentials: new ai.InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models-store.json"),
        refreshOnCreate: false,
      });
      runtime.registerNativeProvider(provider.provider);
      return runtime;
    },
    createResourceLoader: (input: Parameters<PiRuntimeDependencies["createResourceLoader"]>[0]) =>
      new pi.DefaultResourceLoader({
        ...input as ConstructorParameters<typeof pi.DefaultResourceLoader>[0],
        noExtensions: !options.filesystemExtensions, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      }),
    createAgentSession: async (input: Record<string, unknown>) => {
      const created = await pi.createAgentSession(input as Parameters<typeof pi.createAgentSession>[0]);
      sessions.push(created.session);
      return created;
    },
    resolveAutomaticModel: async () => provider.getModel(),
  };
  const extra = (options.extensions ?? []).map((factory, index) => ({ name: `fixture-${index}`, factory }));
  const { createSubagentExtension } = await import("../extensions/subagent");
  const launchStage = createStageSessionLauncher({
    ...common,
    createDirectChildSupervisor: (coordinator, launch) => {
      const supervisor = new SubagentSupervisor({ coordinator, launchStage: launch, schedule: options.schedule });
      supervisors.push(supervisor);
      return supervisor;
    },
    createExtensionFactories: ({ binding, coordinator, supervisor }) => {
      trackBinding(binding);
      return [{ name: "agent-definition", factory: createAgentDefinitionExtension(binding) },
        ...(options.dispatch ? [{ name: "subagent", factory: createSubagentExtension({ binding, coordinator, supervisor, liveConfiguration: live }) }] : []),
        ...extra];
    },
  } as StageSessionDependencies);
  let managed!: ManagedAgentSession;
  const creator = createPiAgentSessionCreator({
    ...common, liveConfiguration: live,
    createCoordinator: (manager) => new SubagentCoordinator(manager),
    recoverSubagentTree: async () => {},
    createDirectChildSupervisor: (coordinator) => {
      const supervisor = new SubagentSupervisor({ coordinator, launchStage, schedule: options.schedule });
      supervisors.push(supervisor);
      return supervisor;
    },
    createExtensionFactories: ({ binding, compaction, stats, coordinator, supervisor }) => {
      trackBinding(binding);
      return [
        { name: "agent-definition", factory: createAgentDefinitionExtension(binding) },
        ...(options.dispatch ? [{ name: "subagent", factory: createSubagentExtension({ binding, coordinator, supervisor, liveConfiguration: live }) }] : []),
        { name: "session-stats", factory: createSessionStatsExtension(stats) },
        { name: "manual-compaction", factory: createManualCompactionExtension(compaction) }, ...extra,
      ];
    },
  } as PiRuntimeDependencies);
  const factory = new PiSessionFactory(async (...args) => {
    managed = await creator(...args);
    return managed;
  }, pi.estimateTokens);
  const launch = async (task = "complete") => {
    const manager = common.createSessionManager(join(root, "project"));
    const coordinator = new SubagentCoordinator(manager);
    const reservation = coordinator.reserveDispatch({
      ownerSessionId: manager.getSessionId(), toolCallId: "stage", requested: "search",
      catalog: { all: rows, available: [rows[1]!] },
    });
    const handle = await launchStage({
      reservation, agent: rows[1]!, callerAgent: "research-assistant", task,
      cwd: join(root, "project"), coordinator, liveConfiguration: live,
    });
    return { handle, coordinator, session: sessions.at(-1)!, supervisor: supervisors.at(-1)!, binding: bindings.at(-1)! };
  };
  const publishConfiguration = () => {
    generation += 1;
    for (const row of rows) row.systemPrompt += " updated";
    const event: ConfigurationEvent = {
      type: "config.updated", generation, agentsChanged: true, modelsChanged: false,
      skillsChanged: false, runtimeChanged: true,
    };
    for (const listener of [...configListeners]) listener(event);
  };
  return { ai, provider, factory, launch, sessions, supervisors, live, rows, bindings, publishConfiguration, managed: () => managed };
}

describe("Pinned Pi lifecycle ownership", () => {
  it("inspects native idle prompt/tool refreshes before the next provider request", async () => {
    const h = await harness({ extensions: [(api) => {
      for (const name of ["hold", "other"]) api.registerTool({ name, label: name, description: `${name} fixture tool`, parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "complete" }], details: {} }) });
    }] });
    const adapter = h.factory.create({ cwd: join(root, "project") });
    await adapter.start();
    try {
      await adapter.prompt("Initial");
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      const session = h.sessions[0]!;
      const before = await adapter.getContext!();
      const requests = h.provider.state.callCount;
      h.rows[0]!.tools = ["other"];
      h.rows[0]!.effectiveTools = ["other"];
      h.publishConfiguration();
      await vi.waitFor(() => expect(adapter.getRuntimeConfigurationGeneration()).toBe(2));
      expect(session.getActiveToolNames()).toEqual(["other"]);
      const after = await adapter.getContext!();
      const system = after.items.filter((item) => item.type === "system");
      expect(system).toHaveLength(1);
      const raw = await adapter.getContextItem!(after.revision, system[0]!.id, "current", 0);
      expect(raw.text).toContain("research-assistant test role updated");
      expect(raw.text).toContain("other fixture tool");
      const pi = await importPi();
      const effective = h.ai.createInitialSystemMessage(session.systemPrompt, session.agent.state.tools.map((tool) => h.ai.toToolDeclaration(tool)))!;
      expect(system[0]!.tokens).toBe(pi.estimateTokens(effective));
      expect((await adapter.previewContext!({ revision: after.revision, edits: [] })).cache.hitRate).toBeNull();
      await expect(adapter.getContextItem!(before.revision, before.items[0]!.id, "current", 0)).rejects.toMatchObject({ code: "CONTEXT_STALE" });
      expect(h.provider.state.callCount).toBe(requests);
    } finally { await adapter.stop(); }
  });

  it("applies manual root context edits through native admission and the next real provider input", async () => {
    const h = await harness({ extensions: [(api) => api.registerTool({ name: "hold", label: "Hold", description: "Fixture output",
      parameters: Type.Object({ value: Type.String() }), execute: async (_id, args) => ({ content: [{ type: "text", text: `RAW_${args.value}_`.repeat(1000) }], details: {} }) })] });
    h.provider.setResponses([
      h.ai.fauxAssistantMessage([{ type: "text", text: "Retain mixed prose" }, { type: "thinking", thinking: "Retain thinking" },
        h.ai.fauxToolCall("hold", { value: "A" }, { id: "pair-a" }), h.ai.fauxToolCall("hold", { value: "B" }, { id: "pair-b" })], { stopReason: "toolUse" }),
      h.ai.fauxAssistantMessage("Complete"),
    ]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();
    try {
      await adapter.prompt("Start");
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      const session = h.sessions[0]!;
      const bytes = readFileSync(session.sessionFile!);
      const snapshot = await adapter.getContext!();
      expect(snapshot.busy).toBe(false);
      const outputs = snapshot.items.filter((item) => item.type === "tool-result");
      const request = { revision: snapshot.revision, edits: [
        { target: "item" as const, id: outputs[0]!.id, action: "fold" as const },
        { target: "item" as const, id: outputs[1]!.id, action: "delete" as const },
      ] };
      const calls = h.provider.state.callCount;
      const prediction = await adapter.previewContext!(request);
      events.length = 0;
      const after = await adapter.applyContext!(request);
      expect(after.totalTokens).toBe(prediction.afterTokens);
      expect(after.busy).toBe(false);
      expect(h.provider.state.callCount).toBe(calls);
      expect(events).toContainEqual(expect.objectContaining({ type: "session_stats_changed" }));
      expect(JSON.stringify(events)).not.toContain("Current system");
      expect(readFileSync(session.sessionFile!).subarray(0, bytes.length)).toEqual(bytes);
      expect(JSON.stringify(await adapter.getTranscriptSnapshot())).toContain("RAW_B_");
      const inputs: string[] = [];
      h.provider.setResponses([(context) => { inputs.push(JSON.stringify(context.messages)); return h.ai.fauxAssistantMessage("After edits"); }]);
      await adapter.prompt("Continue");
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toContain("已折叠的工具输出");
      expect(inputs[0]).toContain("Retain mixed prose");
      for (const absent of ["RAW_A_", "RAW_B_", "pair-b"]) expect(inputs[0]).not.toContain(absent);
    } finally { await adapter.stop(); }
  });

  it("fences context mutation against prompt/retry/navigation/compaction and owns it through disposal", async () => {
    const h = await harness();
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const entered = deferred();
    const release = deferred();
    await adapter.start();
    try {
      await adapter.prompt("Initial");
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      const session = h.sessions[0]!;
      const snapshot = await adapter.getContext!();
      const prose = snapshot.items.find((item) => item.type === "assistant")!;
      const bytes = readFileSync(session.sessionFile!);
      vi.spyOn(h.bindings[0]!, "ensureCurrent").mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
      const operation = adapter.applyContext!({ revision: snapshot.revision, edits: [{ target: "item", id: prose.id, action: "delete" }] });
      const rejected = expect(operation).rejects.toMatchObject({ code: "CONTEXT_BUSY" });
      await entered.promise;
      await expect(adapter.prompt("Race")).rejects.toMatchObject({ code: "CONTEXT_BUSY" });
      await expect(adapter.compact()).rejects.toMatchObject({ code: "CONTEXT_BUSY" });
      expect(() => adapter.retry!(session.sessionId, "race")).toThrow(expect.objectContaining({ code: "CONTEXT_BUSY" }));
      await expect(adapter.navigateTree(session.sessionManager.getLeafId()!)).rejects.toThrow();
      expect(adapter.hasBackgroundWork()).toBe(true);
      const stop = adapter.stop();
      release.resolve();
      await rejected;
      await stop;
      expect(readFileSync(session.sessionFile!)).toEqual(bytes);
    } finally { release.resolve(); await adapter.stop(); }
  });

  it("rechecks context revision after current configuration is applied under admission", async () => {
    const h = await harness();
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const entered = deferred();
    const release = deferred();
    await adapter.start();
    try {
      await adapter.prompt("Initial");
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      const session = h.sessions[0]!;
      const snapshot = await adapter.getContext!();
      const prose = snapshot.items.find((item) => item.type === "assistant")!;
      const ensureCurrent = h.bindings[0]!.ensureCurrent.bind(h.bindings[0]!);
      vi.spyOn(h.bindings[0]!, "ensureCurrent").mockImplementationOnce(async () => {
        entered.resolve(); await release.promise; await ensureCurrent();
      });
      const operation = adapter.applyContext!({ revision: snapshot.revision, edits: [{ target: "item", id: prose.id, action: "delete" }] });
      const rejected = expect(operation).rejects.toMatchObject({ code: "CONTEXT_STALE" });
      await entered.promise;
      h.publishConfiguration();
      release.resolve();
      await rejected;
      expect(session.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(false);
    } finally { release.resolve(); await adapter.stop(); }
  });

  it.each(["root", "stage"] as const)("rejects context writes while %s recovery owns unfinished work", async (scope) => {
    const h = await harness({ dispatch: scope === "stage" });
    const responder: FauxResponseFactory = (context) => {
      if (scope === "root" || getCurrentSystemPrompt(context.messages).includes("search test role")) return h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 unavailable" });
      if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent")) {
        return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", { agent: "search", task: "original" }), { stopReason: "toolUse" });
      }
      return h.ai.fauxAssistantMessage("Waiting");
    };
    h.provider.setResponses(Array.from({ length: 12 }, () => responder));
    const adapter = h.factory.create({ cwd: join(root, "project") });
    await adapter.start();
    try {
      await adapter.prompt("Start");
      await vi.waitFor(() => expect(h.sessions[scope === "root" ? 0 : 1]
        && adapter.getRetryState!(h.sessions[scope === "root" ? 0 : 1]!.sessionId)?.llmRecovery?.status).toBe("available"));
      const snapshot = await adapter.getContext!();
      expect(snapshot.busy).toBe(true);
      const bytes = readFileSync(h.sessions[0]!.sessionFile!);
      await expect(adapter.applyContext!({ revision: snapshot.revision, edits: [] })).rejects.toMatchObject({ code: "CONTEXT_BUSY" });
      expect(readFileSync(h.sessions[0]!.sessionFile!)).toEqual(bytes);
    } finally { await adapter.stop(); }
  });

  it.each([false, true])("expands @ Skill context through native Pi without executing a colliding command (streaming=%s)", async (streaming) => {
    const entered = deferred();
    const release = deferred();
    const skill = join(root, "context-skill");
    mkdirSync(skill);
    const skillPath = join(skill, "SKILL.md");
    writeFileSync(skillPath, "---\nname: context-skill\ndescription: Fixture context\n---\nNATIVE_SKILL_BODY\n");
    const command = vi.fn();
    const h = await harness({ extensions: [(api) => {
      api.on("resources_discover", () => ({ skillPaths: [skill] }));
      api.registerCommand("context-skill", { description: "Collision", handler: command });
      api.registerTool({
        name: "hold", label: "Hold", description: "Wait", parameters: Type.Object({}),
        execute: async () => {
          entered.resolve();
          await release.promise;
          return { content: [{ type: "text", text: "released" }], details: {} };
        },
      });
    }] });
    const contexts: string[] = [];
    const answer: FauxResponseFactory = (context) => {
      contexts.push(JSON.stringify(context.messages));
      return h.ai.fauxAssistantMessage("done");
    };
    h.provider.setResponses(streaming ? [
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }), answer,
    ] : [answer]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    await adapter.start();
    try {
      if (streaming) {
        await adapter.prompt("Start");
        await entered.promise;
      }
      await adapter.prompt('@skill:context-skill Compare "/project/paper.md"\nkeep user instructions');
      release.resolve();
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      expect(command).not.toHaveBeenCalled();
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toContain("NATIVE_SKILL_BODY");
      const users = h.sessions[0]!.messages.filter((message) => message.role === "user");
      const expanded = users.at(-1)!;
      const text = typeof expanded.content === "string" ? expanded.content : expanded.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      expect(text).toBe(`<skill name="context-skill" location="${skillPath}">\nReferences are relative to ${skill}.\n\nNATIVE_SKILL_BODY\n</skill>\n\nCompare "/project/paper.md"\nkeep user instructions`);
    } finally {
      release.resolve();
      await adapter.stop();
    }
  });

  it.each(["root", "stage"] as const)("keeps native %s system declarations in model context and JSONL but out of public transport/history", async (scope) => {
    const h = await harness({ extensions: [(api) => {
      api.registerTool({
        name: "hold", label: "Hold", description: "PRIVATE_DECLARATION_MARKER", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "public result" }], details: {} }),
      });
    }] });
    for (const row of h.rows) row.systemPrompt = "PRIVATE_ROLE_MARKER";
    const contexts: string[] = [];
    const answer: FauxResponseFactory = (context) => {
      contexts.push(JSON.stringify(context.messages));
      return h.ai.fauxAssistantMessage("public answer");
    };
    h.provider.setResponses([answer, answer]);
    const events: unknown[] = [];
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const stage = scope === "stage" ? await h.launch("public task") : undefined;
    if (stage) stage.handle.subscribe((event) => events.push(event));
    else {
      adapter.onEvent((event) => events.push(event));
      await adapter.start();
      await adapter.prompt("public task");
    }
    try {
      if (stage) await stage.handle.completion;
      else await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      const session = stage?.session ?? h.sessions[0]!;
      session.setActiveToolsByName([]);
      await session.prompt("second public task");
      const nativeSystems = session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "system");
      expect(nativeSystems.length).toBeGreaterThan(1);
      expect(JSON.stringify(nativeSystems)).toContain("toolsRemoved");
      expect(contexts).toHaveLength(2);
      for (const marker of ["PRIVATE_ROLE_MARKER", "PRIVATE_DECLARATION_MARKER"]) {
        expect(contexts[0]).toContain(marker);
        expect(readFileSync(session.sessionFile!, "utf8")).toContain(marker);
        expect(JSON.stringify(events)).not.toContain(marker);
      }
      expect(JSON.stringify(events)).not.toContain('"role":"system"');
      const timeline = stage
        ? projectSessionTimeline(session.sessionManager.getBranch())
        : (await adapter.getTranscriptSnapshot()).timeline;
      expect(JSON.stringify(timeline)).not.toContain("PRIVATE_");
      expect(timeline.filter((entry) => entry.kind === "message").map((entry) => entry.message.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(events).toContainEqual(expect.objectContaining({ type: "message_end", message: expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "public answer" }] }) }));
      expect(events).toContainEqual(expect.objectContaining({ type: "agent_settled" }));
    } finally {
      if (stage) await stage.handle.dispose();
      else await adapter.stop();
    }
  });

  it("retains a parked root's idle lease until Stop releases the checkpoint", async () => {
    const h = await harness();
    h.provider.setResponses([h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" })]);
    const registry = new ActiveSessionRegistry(h.factory, undefined, { idleTimeoutMs: 0 });
    try {
      const rootSession = await registry.create({ cwd: join(root, "project") });
      await registry.prompt(rootSession.id, "request");
      await vi.waitFor(() => expect(registry.retryState(rootSession.id, rootSession.id).llmRecovery?.status).toBe("available"));
      expect(registry.has(rootSession.id)).toBe(true);
      expect(await registry.snapshot(rootSession.id)).toMatchObject({ llmRecovery: { status: "available" } });
      await registry.abort(rootSession.id);
      await vi.waitFor(() => expect(registry.has(rootSession.id)).toBe(false));
    } finally { await registry.shutdown(); }
  });

  it("does not turn a failed tool or explicit summarization failure into request recovery", async () => {
    const h = await harness({ extensions: [(api) => api.registerTool({ name: "hold", label: "Write", description: "Denied write",
      parameters: Type.Object({}), execute: async () => { throw new Error("EACCES permission denied"); } })] });
    const adapter = h.factory.create({ cwd: join(root, "project") });
    try {
      await adapter.start();
      const session = h.sessions[0]!;
      await adapter.compact();
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      expect(adapter.getRetryState!(session.sessionId)?.llmRecovery).toBeNull();
      h.provider.setResponses([
        h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
        h.ai.fauxAssistantMessage("write permission is missing"),
      ]);
      await adapter.prompt("write");
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      expect(session.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError)).toBe(true);
      expect(adapter.getRetryState!(session.sessionId)?.llmRecovery).toBeNull();
    } finally { await adapter.stop(); }
  });

  it.each(["root", "stage"] as const)("cancels %s manual recovery during native backoff", async (scope) => {
    let manual = false;
    const h = await harness({ dispatch: scope === "stage", retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 } });
    const responder: FauxResponseFactory = (context) => {
      const target = scope === "root" || getCurrentSystemPrompt(context.messages).includes("search test role");
      if (target) return h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: manual ? "503 overloaded" : "400 invalid request" });
      if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent")) {
        return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", { agent: "search", task: "original task" }), { stopReason: "toolUse" });
      }
      return h.ai.fauxAssistantMessage("waiting");
    };
    h.provider.setResponses(Array.from({ length: 20 }, () => responder));
    const adapter = h.factory.create({ cwd: join(root, "project") });
    try {
      await adapter.start(); await adapter.prompt("start");
      await vi.waitFor(() => expect(h.sessions[scope === "root" ? 0 : 1]
        && adapter.getRetryState!(h.sessions[scope === "root" ? 0 : 1]!.sessionId)?.llmRecovery?.status).toBe("available"));
      const target = h.sessions[scope === "root" ? 0 : 1]!;
      const checkpoint = adapter.getRetryState!(target.sessionId)!.llmRecovery!;
      manual = true;
      await adapter.retry!(target.sessionId, checkpoint.failureId);
      await vi.waitFor(() => expect(adapter.getRetryState!(target.sessionId)?.automaticRetry?.delayMs).toBe(60_000));
      await adapter.abort();
      expect(adapter.getRetryState!(target.sessionId)?.llmRecovery ?? null).toBeNull();
      expect(adapter.getRetryState!(target.sessionId)?.automaticRetry ?? null).toBeNull();
      expect(adapter.hasBackgroundWork()).toBe(false);
      h.provider.setResponses([h.ai.fauxAssistantMessage("new user task")]);
      await adapter.prompt("new task after Stop");
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
    } finally { await adapter.stop(); }
  });

  it.each(["root", "stage"] as const)("owns and cancels %s recovery configuration preflight without a late native wake", async (scope) => {
    const h = await harness({ dispatch: scope === "stage" });
    const responder: FauxResponseFactory = (context) => {
      if (scope === "root" || getCurrentSystemPrompt(context.messages).includes("search test role")) {
        return h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" });
      }
      if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent")) {
        return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", { agent: "search", task: "original task" }), { stopReason: "toolUse" });
      }
      return h.ai.fauxAssistantMessage("waiting");
    };
    h.provider.setResponses(Array.from({ length: 20 }, () => responder));
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const entered = deferred();
    const release = deferred();
    try {
      await adapter.start(); await adapter.prompt("start");
      const index = scope === "root" ? 0 : 1;
      await vi.waitFor(() => expect(h.sessions[index] && adapter.getRetryState!(h.sessions[index]!.sessionId)?.llmRecovery?.status).toBe("available"));
      await h.sessions[0]!.waitForIdle();
      const target = h.sessions[index]!;
      const checkpoint = adapter.getRetryState!(target.sessionId)!.llmRecovery!;
      vi.spyOn(h.bindings[index]!, "ensureCurrent").mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
      const attempts = h.provider.state.callCount;
      const request = adapter.retry!(target.sessionId, checkpoint.failureId);
      const rejected = expect(request).rejects.toThrow();
      await entered.promise;
      const stop = adapter.abort();
      expect(h.managed().coordinator.retryState(target.sessionId)?.llmRecovery ?? null).toBeNull();
      release.resolve();
      await rejected;
      await stop;
      expect(h.provider.state.callCount).toBe(attempts);
      expect(adapter.hasBackgroundWork()).toBe(false);
      expect(target.sessionManager.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === LLM_RETRY_CONTROL_TYPE)).toBe(false);
    } finally { release.resolve(); await adapter.stop(); }
  });

  it("revalidates a parked stage's original caller authority and rotates failed admission", async () => {
    const h = await harness({ dispatch: true });
    h.provider.setResponses([
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", { agent: "search", task: "original" }), { stopReason: "toolUse" }),
      h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" }),
      h.ai.fauxAssistantMessage("waiting"),
    ]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    try {
      await adapter.start(); await adapter.prompt("start");
      await vi.waitFor(() => expect(h.sessions[1] && adapter.getRetryState!(h.sessions[1]!.sessionId)?.llmRecovery?.status).toBe("available"));
      const target = h.sessions[1]!;
      const checkpoint = adapter.getRetryState!(target.sessionId)!.llmRecovery!;
      const calls = h.provider.state.callCount;
      h.rows[0]!.subagents = [];
      h.publishConfiguration();
      await expect(adapter.retry!(target.sessionId, checkpoint.failureId)).rejects.toMatchObject({ code: "LLM_RETRY_UNAVAILABLE" });
      await vi.waitFor(() => expect(adapter.getRetryState!(target.sessionId)?.llmRecovery?.status).toBe("available"));
      const repaired = adapter.getRetryState!(target.sessionId)!.llmRecovery!;
      expect(repaired.failureId).not.toBe(checkpoint.failureId);
      expect(h.provider.state.callCount).toBe(calls);
      h.rows[0]!.subagents = ["search"];
      h.publishConfiguration();
      h.provider.setResponses([h.ai.fauxAssistantMessage("recovered"), h.ai.fauxAssistantMessage("accepted")]);
      await adapter.retry!(target.sessionId, repaired.failureId);
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
    } finally { await adapter.stop(); }
  });

  it("recovers a genuine overflow-failed Agent from current context without treating its compaction diagnostic as a request", async () => {
    const h = await harness({ compact: true });
    h.provider.setResponses([h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" })]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    try {
      await adapter.start(); await adapter.prompt("small original request");
      const session = h.sessions[0]!;
      await vi.waitFor(() => expect(adapter.getRetryState!(session.sessionId)?.llmRecovery?.status).toBe("available"));
      const checkpoint = adapter.getRetryState!(session.sessionId)!.llmRecovery!;
      const entry = session.sessionManager.getEntries().find((entry) => entry.id === checkpoint.failedEntryId);
      expect(entry).toMatchObject({ type: "message", message: { role: "assistant", stopReason: "error" } });
      const contexts: string[] = [];
      h.provider.setResponses([(context) => { contexts.push(JSON.stringify(context.messages)); return h.ai.fauxAssistantMessage("recovered"); }]);
      await adapter.retry!(session.sessionId, checkpoint.failureId);
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toContain("small original request");
      expect(contexts[0]).not.toContain("maximum context length exceeded");
      expect(session.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
    } finally { await adapter.stop(); }
  });

  it("parks a completion-woken stage after its original finish has begun waiting for quiescence", async () => {
    const releaseChild = deferred();
    const childEntered = deferred();
    let searchFailures = 0;
    const h = await harness({ dispatch: true, retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 }, extensions: [(api) => {
      api.registerTool({ name: "hold", label: "Hold", description: "Hold child", parameters: Type.Object({}), execute: async () => {
        childEntered.resolve();
        await releaseChild.promise;
        return { content: [{ type: "text", text: "child tool finished" }], details: {} };
      } });
    }] });
    const responder: FauxResponseFactory = (context) => {
      const role = getCurrentSystemPrompt(context.messages).includes("reviewer test role") ? "reviewer"
        : getCurrentSystemPrompt(context.messages).includes("search test role") ? "search" : "research-assistant";
      const toolDone = (name: string) => context.messages.some((message) => message.role === "toolResult" && message.toolName === name);
      if (role === "reviewer") return h.ai.fauxAssistantMessage(toolDone("hold") ? "nested completed"
        : h.ai.fauxToolCall("hold", {}), { stopReason: toolDone("hold") ? "stop" : "toolUse" });
      if (!toolDone("subagent")) return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", {
        agent: role === "research-assistant" ? "search" : "reviewer", task: "nested task",
      }), { stopReason: "toolUse" });
      if (role === "search" && JSON.stringify(context.messages).includes("<agent_status>")) {
        searchFailures += 1;
        if (searchFailures <= 2) return h.ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" });
        return h.ai.fauxAssistantMessage("recovered completion wake");
      }
      return h.ai.fauxAssistantMessage("waiting for child");
    };
    h.provider.setResponses(Array.from({ length: 35 }, () => responder));
    const adapter = h.factory.create({ cwd: join(root, "project") });
    try {
      await adapter.start();
      await adapter.prompt("start nested work");
      await childEntered.promise;
      await vi.waitFor(() => expect(h.sessions.find((session) => session.systemPrompt.includes("search test role"))?.isIdle).toBe(true));
      const caller = h.sessions.find((session) => session.systemPrompt.includes("search test role"))!;
      releaseChild.resolve();
      await vi.waitFor(() => expect(adapter.getRetryState!(caller.sessionId)?.llmRecovery?.status).toBe("available"));
      const job = [...h.managed().coordinator.journal().jobs.values()].find((job) => job.childSessionId === caller.sessionId)!;
      expect(job.terminalStatus).toBeUndefined();
      expect(adapter.hasBackgroundWork()).toBe(true);
      const checkpoint = adapter.getRetryState!(caller.sessionId)!.llmRecovery!;
      await adapter.retry!(caller.sessionId, checkpoint.failureId);
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      expect(searchFailures).toBe(3);
      expect([...h.managed().coordinator.journal().jobs.values()]).toHaveLength(2);
      expect(h.managed().coordinator.journal().jobs.get(job.launchId)?.terminalStatus).toBe("complete");
      expect(caller.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
    } finally {
      releaseChild.resolve();
      await adapter.stop();
    }
  });

  it("holds pending completion wakes through configuration recovery until manual admission", async () => {
    const h = await harness();
    h.provider.setResponses([h.ai.fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "503 overloaded" })]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    try {
      await adapter.start();
      await adapter.prompt("original task");
      const rootSession = h.sessions[0]!;
      await vi.waitFor(() => expect(adapter.getRetryState!(rootSession.sessionId)?.llmRecovery?.status).toBe("available"));
      const { coordinator, supervisor } = h.managed();
      const checkpoint = adapter.getRetryState!(rootSession.sessionId)!.llmRecovery!;
      coordinator.recordNotificationBatch({ batchId: "held-handoff", ownerSessionId: rootSession.sessionId,
        launchIds: ["finished-child"], content: "<agent_status>complete</agent_status>\n<agent_handoff>held handoff</agent_handoff>", triggerTurn: true });
      await supervisor.flushNotifications();
      h.publishConfiguration();
      await h.managed().binding.ensureCurrent();
      await supervisor.flushNotifications();
      expect(h.provider.state.callCount).toBe(1);
      expect(coordinator.journal().pendingBatches.map((batch) => batch.batchId)).toEqual(["held-handoff"]);
      const contexts: string[] = [];
      h.provider.setResponses([(context) => { contexts.push(JSON.stringify(context.messages)); return h.ai.fauxAssistantMessage("recovered"); }]);
      await adapter.retry!(rootSession.sessionId, checkpoint.failureId);
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toContain("held handoff");
      expect(contexts[0]).not.toContain(LLM_RETRY_CONTROL_TYPE);
      expect(coordinator.journal().pendingBatches).toEqual([]);
    } finally { await adapter.stop(); }
  });

  it.each(["abort", "stop"] as const)("%s releases a parked child and publishes one terminal outcome without another model turn", async (action) => {
    const h = await harness({ dispatch: true });
    const responder: FauxResponseFactory = (context) => {
      if (getCurrentSystemPrompt(context.messages).includes("search test role")) return h.ai.fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "503 overloaded" });
      if (!context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent")) {
        return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", { agent: "search", task: "original task" }), { stopReason: "toolUse" });
      }
      return h.ai.fauxAssistantMessage("owner waiting");
    };
    h.provider.setResponses(Array.from({ length: 20 }, () => responder));
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const events: any[] = [];
    adapter.onEvent((event) => events.push(event));
    try {
      await adapter.start(); await adapter.prompt("start");
      await vi.waitFor(() => expect(h.sessions[1] && adapter.getRetryState!(h.sessions[1]!.sessionId)?.llmRecovery?.status).toBe("available"));
      await h.sessions[0]!.waitForIdle();
      const calls = h.provider.state.callCount;
      const coordinator = h.managed().coordinator;
      await adapter[action]();
      expect(h.provider.state.callCount).toBe(calls);
      expect(coordinator.journal().pendingBatches).toEqual([]);
      expect(events.filter((event) => event.type === "subagent_supervisor" && event.status === "error")).toHaveLength(1);
      expect(coordinator.retryState(h.sessions[1]!.sessionId)).toBeUndefined();
      expect(adapter.hasBackgroundWork()).toBe(false);
    } finally { await adapter.stop(); }
  });

  it.each(["research-assistant", "search", "reviewer"] as const)(
    "recovers the same %s request with a fresh native budget and one side effect",
    async (targetAgent) => {
      const sideEffect = join(root, "project", "side-effect.txt");
      let toolCalls = 0;
      let failedRequestCalls = 0;
      const requestContexts: Context[] = [];
      const h = await harness({
        dispatch: targetAgent !== "research-assistant",
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
        extensions: [(api) => api.registerTool({
          name: "hold", label: "Write evidence", description: "Write evidence once", parameters: Type.Object({}),
          execute: async () => {
            toolCalls += 1;
            appendFileSync(sideEffect, "completed\n");
            return { content: [{ type: "text", text: "side effect completed" }], details: {} };
          },
        })],
      });
      h.rows.find((row) => row.name === "reviewer")?.builtin && (h.rows.find((row) => row.name === "reviewer")!.builtin = false);
      const response: FauxResponseFactory = (context) => {
        const role = getCurrentSystemPrompt(context.messages).includes("reviewer test role") ? "reviewer"
          : getCurrentSystemPrompt(context.messages).includes("search test role") ? "search" : "research-assistant";
        const hasTool = (name: string) => context.messages.some((message) => message.role === "toolResult" && message.toolName === name);
        if (role === targetAgent) {
          if (!hasTool("hold")) return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" });
          requestContexts.push(context);
          failedRequestCalls += 1;
          return failedRequestCalls < 6
            ? h.ai.fauxAssistantMessage("partial response", { stopReason: "error", errorMessage: "503 overloaded" })
            : h.ai.fauxAssistantMessage("recovered response");
        }
        if (!hasTool("subagent")) return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("subagent", {
          agent: role === "research-assistant" ? "search" : "reviewer", task: "finish the original task",
        }), { stopReason: "toolUse" });
        return h.ai.fauxAssistantMessage("owner accepted");
      };
      h.provider.setResponses(Array.from({ length: 40 }, () => response));
      const adapter = h.factory.create({ cwd: join(root, "project") });
      const events: any[] = [];
      adapter.onEvent((event) => events.push(event));
      try {
        await adapter.start();
        await adapter.prompt("complete exactly one side effect");
        await vi.waitFor(() => expect(h.sessions.find((session) => session.systemPrompt.includes(`${targetAgent} test role`))
          && failedRequestCalls).toBe(2));
        const target = h.sessions.find((session) => session.systemPrompt.includes(`${targetAgent} test role`))!;
        await vi.waitFor(() => expect(adapter.getRetryState!(target.sessionId)?.llmRecovery?.status).toBe("available"));
        const checkpoint = adapter.getRetryState!(target.sessionId)!.llmRecovery!;
        const originalUsers = target.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user");
        const jobs = [...h.managed().coordinator.journal().jobs.values()];
        if (targetAgent !== "research-assistant") {
          const job = jobs.find((job) => job.childSessionId === target.sessionId)!;
          expect(job.terminalStatus).toBeUndefined();
          expect(job.launchAcknowledged).toBe(true);
          expect(h.managed().coordinator.journal().acknowledgedNotificationLaunchIds.has(job.launchId)).toBe(false);
          if (targetAgent === "reviewer") expect(job.ownerSessionId).not.toBe(h.sessions[0]!.sessionId);
        }
        expect(adapter.hasBackgroundWork()).toBe(true);
        h.publishConfiguration();
        const accepted = adapter.retry!(target.sessionId, checkpoint.failureId);
        expect(() => adapter.retry!(target.sessionId, checkpoint.failureId)).toThrow();
        await expect(accepted).resolves.toEqual({ accepted: true, targetSessionId: target.sessionId, failureId: checkpoint.failureId });
        await vi.waitFor(() => expect(adapter.getRetryState!(target.sessionId)?.llmRecovery?.status).toBe("available"));
        const secondFailure = adapter.getRetryState!(target.sessionId)!.llmRecovery!;
        expect(secondFailure.failureId).not.toBe(checkpoint.failureId);
        expect(() => adapter.retry!(target.sessionId, checkpoint.failureId)).toThrow();
        await adapter.retry!(target.sessionId, secondFailure.failureId);
        await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
        expect(failedRequestCalls).toBe(6);
        expect(toolCalls).toBe(1);
        expect(readFileSync(sideEffect, "utf8")).toBe("completed\n");
        const entries = target.sessionManager.getEntries();
        expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toEqual(originalUsers);
        expect(entries.filter((entry) => entry.type === "custom_message" && entry.customType === LLM_RETRY_CONTROL_TYPE)).toHaveLength(2);
        expect(entries.some((entry) => entry.id === checkpoint.failedEntryId)).toBe(true);
        expect(requestContexts.every((context) => context.messages.filter((message) => message.role === "user").length === 1)).toBe(true);
        expect(requestContexts.every((context) => !JSON.stringify(context.messages).includes(LLM_RETRY_CONTROL_TYPE))).toBe(true);
        expect(requestContexts.every((context) => !context.messages.some((message) => message.role === "assistant" && message.stopReason === "error"))).toBe(true);
        expect(requestContexts.slice(2).every((context) => getCurrentSystemPrompt(context.messages).includes("updated"))).toBe(true);
        const retryEvents = events.flatMap((event) => event.type === "subagent_supervisor" ? [event.event] : [event])
          .filter((event) => event?.type === "auto_retry_start");
        expect(retryEvents.map((event) => event.attempt)).toEqual([1, 1, 1]);
        expect(JSON.stringify(events)).not.toContain(LLM_RETRY_CONTROL_TYPE);
        expect(adapter.getRetryState!(target.sessionId)?.llmRecovery ?? null).toBeNull();
        const finalJobs = [...h.managed().coordinator.journal().jobs.values()];
        expect(finalJobs.map(({ launchId, childSessionId, ownerSessionId, sessionPath }) => ({ launchId, childSessionId, ownerSessionId, sessionPath })))
          .toEqual(jobs.map(({ launchId, childSessionId, ownerSessionId, sessionPath }) => ({ launchId, childSessionId, ownerSessionId, sessionPath })));
        for (const job of finalJobs) {
          expect(job.terminalStatus).toBe("complete");
          const terminal = events.filter((event) => event.type === "subagent_supervisor" && event.launchId === job.launchId && event.status === "complete");
          expect(terminal).toHaveLength(1);
          expect(h.managed().coordinator.journal().acknowledgedNotificationLaunchIds.has(job.launchId)).toBe(true);
        }
      } finally { await adapter.stop(); }
    },
  );

  it.each(["root", "stage"] as const)("applies slow-provider and write-recovery policies in the real %s factory", async (scope) => {
    const h = await harness();
    for (const row of h.rows) { row.tools = ["write"]; row.effectiveTools = ["write"]; }
    const requests: Array<{ timeout: number | undefined; content: string }> = [];
    h.provider.setResponses([
      (context, options) => {
        requests.push({ timeout: options?.timeoutMs, content: JSON.stringify(context.messages) });
        return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("write", { path: "report.md" }), { stopReason: "toolUse" });
      },
      (context, options) => {
        requests.push({ timeout: options?.timeoutMs, content: JSON.stringify(context.messages) });
        return h.ai.fauxAssistantMessage("resume by section");
      },
    ]);
    if (scope === "stage") {
      const { handle } = await h.launch("finish report");
      try { await handle.completion; } finally { await handle.dispose(); }
    } else {
      const adapter = h.factory.create({ cwd: join(root, "project") });
      try {
        await adapter.start(); await adapter.prompt("finish report"); await h.sessions[0]!.waitForIdle();
      } finally { await adapter.stop(); }
    }
    expect(requests.map(request => request.timeout)).toEqual([3_600_000, 3_600_000]);
    expect(requests[1]!.content).toContain("Write recovery:");
    expect(requests[1]!.content).toContain("smaller section");
  });

  it.each(["root", "stage"] as const)("compacts a large %s tool result before the next model request", async (scope) => {
    const pi = await importPi();
    const order: string[] = [];
    const toolTurns: Array<{ contextTokens: number | null | undefined; responseTokens: number; resultTokens: number }> = [];
    const compactions: Array<{ reason: string; tokensBefore: number }> = [];
    const oldEvidence = "initial evidence ".repeat(1_700);
    const largeEvidence = "evidence ".repeat(2_000);
    let toolResults = 0;
    let agentStarts = 0;
    let nextRequest = "";
    // The newest result must fit the kept tail: Pi cannot cut at a tool result.
    const h = await harness({ compact: true, keepRecentTokens: 5_000, extensions: [(api) => {
      api.on("agent_start", () => { agentStarts += 1; });
      api.on("turn_end", (event, ctx) => {
        if (event.message.role !== "assistant" || event.toolResults.length === 0) return;
        toolTurns.push({
          contextTokens: ctx.getContextUsage()?.tokens,
          responseTokens: pi.calculateContextTokens(event.message.usage),
          resultTokens: event.toolResults.reduce((total, message) => total + pi.estimateTokens(message), 0),
        });
      });
      api.registerTool({
        name: "hold", label: "Evidence", description: "Return evidence", parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: ++toolResults === 1 ? oldEvidence : largeEvidence }],
          details: {},
        }),
      });
      api.on("session_before_compact", (event) => {
        return { compaction: {
          summary: "Evidence summary",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        } };
      });
      api.on("session_compact", (event) => {
        order.push("compact");
        compactions.push({ reason: event.reason, tokensBefore: event.compactionEntry.tokensBefore });
      });
    }] });
    h.provider.setResponses([
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      (context) => {
        order.push("response");
        nextRequest = JSON.stringify(context.messages);
        return h.ai.fauxAssistantMessage("finished");
      },
    ]);
    if (scope === "stage") {
      const { handle } = await h.launch("inspect evidence");
      try {
        await handle.completion;
      } finally {
        await handle.dispose();
      }
    } else {
      const adapter = h.factory.create({ cwd: join(root, "project") });
      try {
        await adapter.start();
        await adapter.prompt("inspect evidence");
        await h.sessions[0]!.waitForIdle();
      } finally {
        await adapter.stop();
      }
    }
    expect(order).toEqual(["compact", "response"]);
    const native = h.sessions[0]!;
    const settings = native.settingsManager.getCompactionSettings();
    const contextWindow = native.model!.contextWindow;
    const threshold = contextWindow - settings.reserveTokens;
    expect(threshold).toBe(Math.floor(contextWindow * 0.7));
    expect(toolTurns).toHaveLength(2);
    expect(toolTurns[0]!.contextTokens).toBeLessThan(threshold);
    const lastTurn = toolTurns[1]!;
    expect(lastTurn.responseTokens).toBeLessThan(threshold);
    expect(lastTurn.resultTokens).toBeLessThan(settings.keepRecentTokens);
    expect(lastTurn.contextTokens).toBe(lastTurn.responseTokens + lastTurn.resultTokens);
    expect(lastTurn.contextTokens).toBeGreaterThan(threshold);
    expect(lastTurn.contextTokens).toBeLessThan(contextWindow);
    expect(compactions).toEqual([{ reason: "threshold", tokensBefore: lastTurn.contextTokens }]);
    expect(nextRequest).toContain("Evidence summary");
    expect(nextRequest).toContain(largeEvidence);
    expect(nextRequest).not.toContain(oldEvidence);
    expect(agentStarts).toBe(1);
    expect(h.provider.state.callCount).toBe(3);
    expect(native.getLastAssistantText()).toBe("finished");
  });

  it("refreshes estimated capacity after compaction retry cleanup before the retry response", async () => {
    const atRetry = deferred();
    const releaseRetry = deferred();
    let willRetry = false;
    const h = await harness({ compact: true, extensions: [(api) => {
      api.on("session_compact", (event) => { willRetry = event.willRetry; });
    }] });
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const stats: unknown[] = [];
    adapter.onEvent((value) => {
      const event = value as { type?: string; contextUsage?: unknown };
      if (event.type === "session_stats_changed") stats.push(event.contextUsage);
    });
    let running: Promise<void> | undefined;
    try {
      await adapter.start();
      const native = h.sessions[0]!;
      h.provider.setResponses([h.ai.fauxAssistantMessage("seed")]);
      await native.prompt("old evidence ".repeat(400));
      expect(willRetry).toBe(false);
      const summarizeOrRetry: FauxResponseFactory = async () => {
        if (!willRetry) return h.ai.fauxAssistantMessage("compact summary");
        atRetry.resolve();
        await releaseRetry.promise;
        return h.ai.fauxAssistantMessage("recovered");
      };
      h.provider.setResponses([
        h.ai.fauxAssistantMessage("X".repeat(1600), { stopReason: "length" }),
        summarizeOrRetry, summarizeOrRetry, summarizeOrRetry,
      ]);
      running = native.prompt("recent evidence ".repeat(100));
      await Promise.race([atRetry.promise, running]);
      expect(willRetry).toBe(true);
      expect(native.isIdle).toBe(false);
      expect(native.getContextUsage()?.tokens).toBeNull();
      expect(native.messages.some(message => message.role === "assistant" && message.stopReason === "length")).toBe(false);
      const current = adapter.getContextUsage();
      expect(current).toMatchObject({ estimated: true });
      expect(stats.at(-1)).toEqual(current);
    } finally {
      releaseRetry.resolve();
      try { await running; } finally { await adapter.stop(); }
    }
  });

  it("estimates native compacted context after cold reopen and returns to native usage after a new response", async () => {
    const h = await harness();
    h.provider.setResponses(["first answer", "second answer", "compact summary", "new answer"].map((text) => {
      const answer = h.ai.fauxAssistantMessage(text);
      answer.usage = { ...answer.usage, input: 2_000, output: 100, totalTokens: 2_100 };
      return answer;
    }));
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    let reopened: ReturnType<typeof h.factory.create> | undefined;
    try {
      await adapter.start();
      const native = h.sessions[0]!;
      await adapter.prompt("old evidence ".repeat(1000));
      await vi.waitFor(() => expect(native.sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(1));
      await vi.waitFor(() => expect(native.isIdle).toBe(true));
      await adapter.prompt("recent evidence ".repeat(1000));
      await vi.waitFor(() => expect(native.sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "assistant")).toHaveLength(2));
      await vi.waitFor(() => expect(native.isIdle).toBe(true));
      const result = await native.compact();
      expect(native.getContextUsage()?.tokens).toBeNull();
      const expected = {
        tokens: result.estimatedTokensAfter,
        contextWindow: native.model!.contextWindow,
        percent: result.estimatedTokensAfter! / native.model!.contextWindow * 100,
        estimated: true,
      };
      expect(expected.tokens).toBeGreaterThan(0);
      expect(adapter.getContextUsage()).toEqual(expected);
      expect(events).toContainEqual(expect.objectContaining({ type: "session_stats_changed", contextUsage: expected }));
      const sessionPath = native.sessionFile!;
      await adapter.stop();

      reopened = h.factory.create({ cwd: join(root, "project"), sessionPath });
      await reopened.start();
      expect(reopened.getContextUsage()).toEqual(expected);
      await reopened.prompt("report the result");
      await vi.waitFor(() => expect(h.sessions.at(-1)!.getContextUsage()?.tokens).toBeGreaterThan(0));
      await vi.waitFor(() => expect(h.sessions.at(-1)!.isIdle).toBe(true));
      expect(reopened.getContextUsage()).toEqual(h.sessions.at(-1)!.getContextUsage());
      expect(reopened.getContextUsage()).not.toHaveProperty("estimated");
    } finally {
      await reopened?.stop();
      await adapter.stop();
    }
  });

  it.each([
    ["root", "inline"], ["root-stop", "inline"], ["stage", "inline"],
    ["root", "filesystem"], ["root-stop", "filesystem"], ["stage", "filesystem"],
  ] as const)("does not start %s automatic compaction after Stop during agent-end with %s hooks", async (scope, source) => {
    const atAgentEnd = deferred();
    const releaseAgentEnd = deferred();
    let beforeCompactCalls = 0;
    const hooks: ExtensionFactory = (api) => {
      api.on("agent_end", async () => {
        atAgentEnd.resolve();
        await releaseAgentEnd.promise;
      });
      api.on("session_before_compact", async (event) => {
        beforeCompactCalls += 1;
        return { cancel: true };
      });
    };
    if (source === "filesystem") {
      mkdirSync(join(root, "agent", "extensions"));
      vi.stubGlobal("easyresearchLifecycleHooks", hooks);
      writeFileSync(join(root, "agent", "extensions", "compaction.js"),
        "export default (api) => globalThis.easyresearchLifecycleHooks(api);\n");
    }
    const h = await harness({
      compact: true, extensions: source === "inline" ? [hooks] : [], filesystemExtensions: source === "filesystem",
    });
    h.provider.setResponses([h.ai.fauxAssistantMessage("result ".repeat(200))]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const stage = scope === "stage" ? await h.launch("evidence ".repeat(7_000)) : undefined;
    if (!stage) {
      await adapter.start();
      await adapter.prompt("evidence ".repeat(7_000));
    }
    await atAgentEnd.promise;
    const session = h.sessions[0]!;
    expect(session.isCompacting).toBe(false);
    const abortReached = deferred();
    const originalAbort = session.abort.bind(session);
    vi.spyOn(session, "abort").mockImplementation(() => {
      abortReached.resolve();
      return originalAbort();
    });
    let stopped = false;
    const stopping = (stage ? stage.handle.abort("Stop") : scope === "root-stop" ? adapter.stop() : adapter.abort())
      .then(() => { stopped = true; });
    await abortReached.promise;
    releaseAgentEnd.resolve();
    try {
      await stopping;
      expect(beforeCompactCalls).toBe(0);
      expect(h.provider.state.callCount).toBe(1);
    } finally {
      if (stage) {
        await stage.handle.completion;
        await stage.handle.dispose();
      } else {
        await adapter.stop();
      }
    }
    expect(session.isCompacting).toBe(false);
    expect(stopped).toBe(true);
  });

  it.each(["root", "stage"] as const)("excludes %s configuration reload throughout asynchronous terminal shutdown", async (scope) => {
    const entered = deferred();
    const release = deferred();
    const lifecycle: string[] = [];
    const open = new Set<number>();
    let instance = 0;
    const h = await harness({ extensions: [(api) => {
      const id = ++instance;
      api.on("session_start", (event) => { open.add(id); lifecycle.push(`${id}:start:${event.reason}`); });
      api.on("session_shutdown", async (event) => {
        lifecycle.push(`${id}:shutdown:${event.reason}`);
        if (event.reason === "quit") {
          entered.resolve();
          await release.promise;
        }
        open.delete(id);
      });
    }] });
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const stage = scope === "stage" ? await h.launch() : undefined;
    if (stage) await stage.handle.completion;
    else await adapter.start();
    const binding = stage?.binding ?? h.managed().binding;
    const stopping = stage ? stage.handle.dispose() : adapter.stop();
    await entered.promise;
    try {
      h.publishConfiguration();
      await binding.ensureCurrent().catch(() => {});
    } finally {
      release.resolve();
      await stopping;
    }
    expect(lifecycle).toEqual(["1:start:startup", "1:shutdown:quit"]);
    expect(open.size).toBe(0);
  });

  it.each(["root", "stage"] as const)("excludes %s configuration reload during failed-setup shutdown", async (scope) => {
    const entered = deferred();
    const release = deferred();
    const lifecycle: string[] = [];
    const h = await harness({ failAfterAttach: true, extensions: [(api) => {
      api.on("session_start", (event) => { lifecycle.push(`start:${event.reason}`); });
      api.on("session_shutdown", async (event) => {
        lifecycle.push(`shutdown:${event.reason}`);
        if (event.reason === "quit") {
          entered.resolve();
          await release.promise;
        }
      });
    }] });
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const starting = (scope === "root" ? adapter.start() : h.launch()).catch((error: unknown) => error);
    await entered.promise;
    try {
      h.publishConfiguration();
      await h.bindings[0]!.ensureCurrent().catch(() => {});
    } finally {
      release.resolve();
    }
    expect(await starting).toMatchObject({ message: "fixture attachment failed" });
    expect(lifecycle).toEqual(["start:startup", "shutdown:quit"]);
  });

  it.each(["root", "stage"] as const)("drains an admitted %s reload before shutting down the final runner", async (scope) => {
    const reloadEntered = deferred();
    const releaseReload = deferred();
    const closeEntered = deferred();
    const lifecycle: string[] = [];
    const open = new Set<number>();
    let instance = 0;
    const h = await harness({ extensions: [(api) => {
      const id = ++instance;
      api.on("session_start", (event) => { open.add(id); lifecycle.push(`${id}:start:${event.reason}`); });
      api.on("session_shutdown", async (event) => {
        lifecycle.push(`${id}:shutdown:${event.reason}`);
        if (event.reason === "reload") {
          reloadEntered.resolve();
          await releaseReload.promise;
        }
        open.delete(id);
      });
    }] });
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const stage = scope === "stage" ? await h.launch() : undefined;
    if (stage) await stage.handle.completion;
    else await adapter.start();
    const binding = stage?.binding ?? h.managed().binding;
    const originalClose = binding.close.bind(binding);
    vi.spyOn(binding, "close").mockImplementation(() => {
      const closing = originalClose();
      closeEntered.resolve();
      return closing;
    });
    h.publishConfiguration();
    const applying = binding.ensureCurrent();
    await reloadEntered.promise;
    const stopping = stage ? stage.handle.dispose() : adapter.stop();
    await closeEntered.promise;
    try {
      expect(lifecycle).toEqual(["1:start:startup", "1:shutdown:reload"]);
      h.publishConfiguration();
      await expect(binding.ensureCurrent()).rejects.toThrow(/closed/);
    } finally {
      releaseReload.resolve();
      await applying;
      await stopping;
    }
    expect(lifecycle).toEqual([
      "1:start:startup", "1:shutdown:reload", "2:start:reload", "2:shutdown:quit",
    ]);
    expect(open.size).toBe(0);
  });

  it.each(["root", "stage"] as const)("steers the next %s provider request while a tool is still running", async (scope) => {
    const entered = deferred();
    const release = deferred();
    const h = await harness({ extensions: [(api) => {
      api.registerTool({
        name: "hold", label: "Hold", description: "Controlled tool", parameters: Type.Object({}),
        execute: async () => {
          entered.resolve();
          await release.promise;
          return { content: [{ type: "text", text: "finished" }], details: {} };
        },
      });
    }] });
    const requests: string[] = [];
    h.provider.setResponses([
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return h.ai.fauxAssistantMessage("accepted");
      },
    ]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const stage = scope === "stage" ? await h.launch() : undefined;
    if (!stage) {
      await adapter.start();
      await adapter.prompt("work");
    }
    await entered.promise;
    const { coordinator, supervisor, session } = stage ?? h.managed();
    coordinator.recordNotificationBatch({
      batchId: "completed-child", ownerSessionId: session.sessionId, launchIds: [],
      content: "<agent_handoff>verified evidence</agent_handoff>", triggerTurn: true,
    });
    try {
      await supervisor.flushNotifications();
      coordinator.recordNotificationBatch({
        batchId: "another-completed-child", ownerSessionId: session.sessionId, launchIds: [],
        content: "<agent_handoff>additional evidence</agent_handoff>", triggerTurn: true,
      });
      await supervisor.flushNotifications();
      expect(h.sessions.at(-1)!.agent.hasQueuedMessages()).toBe(true);
    } finally {
      release.resolve();
    }
    if (stage) {
      await stage.handle.completion;
      await stage.handle.dispose();
    } else {
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      await adapter.stop();
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("verified evidence");
    expect(requests[0]).toContain("additional evidence");
    expect(requests[0]!.indexOf("verified evidence")).toBeLessThan(requests[0]!.indexOf("additional evidence"));
    expect(coordinator.journal().pendingBatches).toEqual([]);
  });

  it.each(["root", "stage"] as const)("steers the next %s LLM when an earlier handoff woke the caller", async (scope) => {
    const seedEnding = deferred();
    const releaseSeed = deferred();
    const wakeTool = deferred();
    const releaseTool = deferred();
    let firstEnd = true;
    const h = await harness({ extensions: [(api) => {
      api.on("agent_end", async () => {
        if (!firstEnd) return;
        firstEnd = false;
        seedEnding.resolve();
        await releaseSeed.promise;
      });
      api.registerTool({
        name: "hold", label: "Hold", description: "Controlled wake tool", parameters: Type.Object({}),
        execute: async () => {
          wakeTool.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "wake tool finished" }], details: {} };
        },
      });
    }] });
    const requests: string[] = [];
    h.provider.setResponses([
      h.ai.fauxAssistantMessage("initial run complete"),
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return h.ai.fauxAssistantMessage("handoffs reviewed");
      },
    ]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const stage = scope === "stage" ? await h.launch() : undefined;
    if (!stage) {
      await adapter.start();
      await adapter.prompt("seed");
    }
    await seedEnding.promise;
    const { coordinator, supervisor, session } = stage ?? h.managed();
    coordinator.recordNotificationBatch({
      batchId: "wake-a", ownerSessionId: session.sessionId, launchIds: [],
      content: "<agent_handoff>FIRST_HANDOFF</agent_handoff>", triggerTurn: true,
    });
    releaseSeed.resolve();
    await vi.waitFor(() => expect(session.isIdle).toBe(true));
    const firstSend = supervisor.flushNotifications();
    await wakeTool.promise;
    coordinator.recordNotificationBatch({
      batchId: "steer-b", ownerSessionId: session.sessionId, launchIds: [],
      content: "<agent_handoff>SECOND_HANDOFF</agent_handoff>", triggerTurn: true,
    });
    const secondSend = supervisor.flushNotifications();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queuedBeforeToolRelease = h.sessions.at(-1)!.agent.hasQueuedMessages();
    releaseTool.resolve();
    try {
      await Promise.all([firstSend, secondSend]);
      await supervisor.flushNotifications();
      await supervisor.waitForQuiescence();
      expect(queuedBeforeToolRelease).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("SECOND_HANDOFF");
      expect(coordinator.journal().pendingBatches).toEqual([]);
    } finally {
      if (stage) { await stage.handle.completion; await stage.handle.dispose(); }
      else await adapter.stop();
    }
  });

  it("does not reschedule a stage notification when Stop wins admission", async () => {
    const seedEnding = deferred();
    const releaseSeed = deferred();
    const toolEntered = deferred();
    const releaseTool = deferred();
    let firstEnd = true;
    let scheduled = 0;
    const h = await harness({
      schedule: (run) => {
        // Bound a regressed microtask spin so the test can report and clean up.
        if (++scheduled <= 20) queueMicrotask(run);
      },
      extensions: [(api) => {
        api.on("agent_end", async () => {
          if (!firstEnd) return;
          firstEnd = false;
          seedEnding.resolve();
          await releaseSeed.promise;
        });
        api.registerTool({
          name: "hold", label: "Hold", description: "Controlled tool", parameters: Type.Object({}),
          execute: async () => {
            toolEntered.resolve();
            await releaseTool.promise;
            return { content: [{ type: "text", text: "released" }], details: {} };
          },
        });
      }],
    });
    h.provider.setResponses([
      h.ai.fauxAssistantMessage("seed complete"),
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    ]);
    const { handle, session, coordinator, supervisor } = await h.launch();
    await seedEnding.promise;
    coordinator.recordNotificationBatch({
      batchId: "A", ownerSessionId: session.sessionId, launchIds: [], content: "HANDOFF_A", triggerTurn: true,
    });
    releaseSeed.resolve();
    await session.waitForIdle();
    await supervisor.flushNotifications();
    await toolEntered.promise;
    coordinator.recordNotificationBatch({
      batchId: "B", ownerSessionId: session.sessionId, launchIds: [], content: "HANDOFF_B", triggerTurn: true,
    });
    const baseline = scheduled;
    const sending = supervisor.flushNotifications();
    let stopped = false;
    const stopping = handle.abort("Stop").then(() => { stopped = true; });
    try {
      await sending;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(scheduled).toBe(baseline);
      expect(stopped).toBe(false);
      expect(supervisor.isQuiescent()).toBe(false);
      expect(session.agent.signal?.aborted).toBe(true);
    } finally {
      releaseTool.resolve();
      await stopping;
      await handle.completion;
      await handle.dispose();
    }
    expect(supervisor.isQuiescent()).toBe(true);
  });

  it.each(["root", "stage"] as const)("admits later %s handoffs before an async wake acknowledgement", async (scope) => {
    const seedEnding = deferred();
    const releaseSeed = deferred();
    const ackEntered = deferred();
    const releaseAck = deferred();
    let firstEnd = true;
    const h = await harness({ extensions: [(api) => {
      api.on("agent_end", async () => {
        if (!firstEnd) return;
        firstEnd = false;
        seedEnding.resolve();
        await releaseSeed.promise;
      });
      api.on("message_end", async (event) => {
        if (event.message.role !== "custom" || (event.message.details as { batchId?: string })?.batchId !== "A") return;
        ackEntered.resolve();
        await releaseAck.promise;
      });
    }] });
    const requests: string[] = [];
    h.provider.setResponses([
      h.ai.fauxAssistantMessage("seed complete"),
      ...[0, 1].map(() => (context: Context) => {
        requests.push(JSON.stringify(context.messages));
        return h.ai.fauxAssistantMessage("reviewed");
      }),
    ]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const stage = scope === "stage" ? await h.launch() : undefined;
    const delivered: unknown[] = [];
    if (stage) stage.handle.subscribe((event) => {
      if (event.type === "entry_appended") {
        const entry = projectSubagentCompletionEntry(event.entry);
        if (entry) delivered.push(entry);
      }
    });
    else adapter.onEvent((event) => {
      if ((event as { type?: string }).type === "timeline_entry_appended") delivered.push((event as TimelineEntryAppendedEventDto).entry);
    });
    if (!stage) { await adapter.start(); await adapter.prompt("seed"); }
    await seedEnding.promise;
    const { coordinator, supervisor, session } = stage ?? h.managed();
    coordinator.recordNotificationBatch({
      batchId: "A", ownerSessionId: session.sessionId, launchIds: ["launch-A"], content: "HANDOFF_A", triggerTurn: true,
      outcomes: [{ launchId: "launch-A", agentId: "search_0", status: "complete", text: "frozen A" }],
    });
    releaseSeed.resolve();
    await session.waitForIdle();
    const first = supervisor.flushNotifications();
    await ackEntered.promise;
    for (const batchId of ["B", "C"]) {
      coordinator.recordNotificationBatch({
        batchId, ownerSessionId: session.sessionId, launchIds: [`launch-${batchId}`], content: `HANDOFF_${batchId}`, triggerTurn: true,
        outcomes: [{ launchId: `launch-${batchId}`, agentId: "search_0", status: "complete", text: `frozen ${batchId}` }],
      });
    }
    const later = supervisor.flushNotifications();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requests).toEqual([]);
    expect(coordinator.journal().acknowledgedBatchIds.has("A")).toBe(false);
    expect(delivered).toEqual([]);
    releaseAck.resolve();
    try {
      await Promise.all([first, later]);
      await supervisor.waitForQuiescence();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("HANDOFF_A");
      expect(requests[0]).toContain("HANDOFF_B");
      expect(requests[0]).toContain("HANDOFF_C");
      expect(coordinator.journal().pendingBatches).toEqual([]);
      const history = projectSessionTimeline(session.sessionManager.getBranch()).filter((entry) => entry.kind === "subagent-completion");
      expect(delivered).toEqual(history);
      expect(history.map((entry) => entry.batchId)).toEqual(["A", "B", "C"]);
      expect(new Set(history.map((entry) => entry.entryId)).size).toBe(3);
      expect(requests[0]).not.toMatch(/frozen|outcomes|launch-A/);
    } finally {
      if (stage) { await stage.handle.completion; await stage.handle.dispose(); }
      else await adapter.stop();
    }
  });

  it.each(["complete", "stop"] as const)("routes a real nested completion only to its caller and preserves %s ownership", async (mode) => {
    const toolEntered = deferred();
    const releaseTool = deferred();
    const h = await harness({ extensions: [(api) => {
      api.registerTool({
        name: "hold", label: "Hold", description: "Hold child", parameters: Type.Object({}),
        execute: async () => {
          toolEntered.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "tool done" }], details: {} };
        },
      });
    }] });
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();
    await adapter.prompt("seed");
    await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
    const contexts: string[] = [];
    h.provider.setResponses([
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      (context) => { contexts.push(JSON.stringify(context.messages)); return h.ai.fauxAssistantMessage("child final body"); },
      (context) => { contexts.push(JSON.stringify(context.messages)); return h.ai.fauxAssistantMessage("root accepted"); },
    ]);
    const { coordinator, supervisor, session: caller } = h.managed();
    const reservation = coordinator.reserveDispatch({
      ownerSessionId: caller.sessionId, toolCallId: "launch", requested: "search",
      catalog: { all: h.rows, available: [h.rows[1]!] },
    });
    const launched = await supervisor.launch(reservation, {
      agent: h.rows[1]!, callerAgent: "research-assistant", task: "nested work", cwd: join(root, "project"), liveConfiguration: h.live,
    });
    supervisor.observeParentEvent({ type: "tool_execution_end", toolCallId: "launch", toolName: "subagent", isError: false, result: {} });
    await toolEntered.promise;
    const child = h.sessions.at(-1)!;
    const childSupervisor = h.supervisors.at(-1)!;
    const nestedBatch = {
      batchId: "nested", ownerSessionId: child.sessionId, launchIds: ["grandchild-launch"], triggerTurn: mode === "complete",
      content: `<agent_status>private ${child.sessionFile}</agent_status>\n<agent_handoff>nested model handoff</agent_handoff>`,
      outcomes: [{ launchId: "grandchild-launch", agentId: "search_1", status: "error" as const, text: "status: blocked\nFrozen nested body." }],
    };
    coordinator.recordNotificationBatch(nestedBatch);
    await childSupervisor.flushNotifications();
    let stopping: Promise<void> | undefined;
    try {
      if (mode === "stop") {
        stopping = adapter.abort();
        await vi.waitFor(() => expect(child.agent.signal?.aborted).toBe(true));
      }
      releaseTool.resolve();
      if (stopping) await stopping;
      await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
      const nested = (events as SubagentSupervisorEvent[]).filter((event) => event.type === "subagent_supervisor"
        && event.event?.type === "timeline_entry_appended" && event.event.entry.batchId === "nested");
      expect(nested).toHaveLength(1);
      expect(nested[0]).toMatchObject({ childSessionId: launched.job.childSessionId, event: { entry: { batchId: "nested", outcomes: nestedBatch.outcomes } } });
      expect((nested[0]!.event as TimelineEntryAppendedEventDto).entry).toEqual(projectSessionTimeline(child.sessionManager.getBranch()).find((entry) => entry.kind === "subagent-completion" && entry.batchId === "nested"));
      const rootCards = (events as TimelineEntryAppendedEventDto[]).filter((event) => event.type === "timeline_entry_appended" && event.entry.kind === "subagent-completion");
      expect(rootCards).toHaveLength(1);
      expect(rootCards[0]!.entry).toMatchObject({ outcomes: [{ launchId: reservation.launchId, status: mode === "stop" ? "error" : "complete" }] });
      expect((await adapter.getTranscriptSnapshot()).timeline.filter((entry) => entry.kind === "subagent-completion")).toEqual(rootCards.map((event) => event.entry));
      expect(JSON.stringify(events)).not.toContain(AGENT_STATUS_TYPE);
      expect(JSON.stringify(events)).not.toContain(child.sessionFile!);
      if (mode === "stop") expect(contexts).toEqual([]);
      else {
        expect(contexts).toHaveLength(2);
        expect(contexts[0]).toContain("nested model handoff");
        expect(contexts[1]).not.toContain("nested model handoff");
      }
    } finally {
      releaseTool.resolve();
      await stopping;
      await adapter.stop();
    }
  });

  it.each([
    ["abort", "settling"], ["stop", "settling"], ["abort", "scheduled"], ["stop", "scheduled"],
  ] as const)("blocks root handoff admission during %s (%s)", async (operation, timing) => {
    const toolEntered = deferred();
    const abortEntered = deferred();
    const releaseTool = deferred();
    const h = await harness({ extensions: [(api) => {
      api.registerTool({
        name: "hold", label: "Hold", description: "Controlled tool", parameters: Type.Object({}),
        execute: async (_id, _params, signal) => {
          signal!.addEventListener("abort", () => abortEntered.resolve(), { once: true });
          toolEntered.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "released" }], details: {} };
        },
      });
    }] });
    h.provider.setResponses([
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      h.ai.fauxAssistantMessage("reviewed"),
    ]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    await adapter.start();
    const { coordinator, supervisor, session } = h.managed();
    coordinator.recordNotificationBatch({
      batchId: "A", ownerSessionId: session.sessionId, launchIds: [], content: "HANDOFF_A", triggerTurn: true,
    });
    await supervisor.flushNotifications();
    await toolEntered.promise;
    const nativeSend = vi.spyOn(h.sessions[0]!, "sendCustomMessage");
    const sendLaterHandoff = () => {
      coordinator.recordNotificationBatch({
        batchId: "B", ownerSessionId: session.sessionId, launchIds: [], content: "HANDOFF_B", triggerTurn: true,
      });
      return supervisor.flushNotifications();
    };
    let sending = timing === "scheduled" ? sendLaterHandoff() : undefined;
    let stopped = false;
    const stopping = adapter[operation]().then(() => { stopped = true; });
    await abortEntered.promise;
    sending ??= sendLaterHandoff();
    try {
      await sending;
      expect(nativeSend.mock.calls.filter(([message, options]) => message.content === "HANDOFF_B" && options?.triggerTurn)).toEqual([]);
      expect(h.sessions[0]!.agent.hasQueuedMessages()).toBe(false);
      expect(stopped).toBe(false);
      expect(supervisor.isQuiescent()).toBe(false);
    } finally {
      releaseTool.resolve();
      await stopping;
      await adapter.stop();
    }
  });

  it.each(["root", "stage"] as const)("serializes %s native prompt preflight with idle handoff admission", async (scope) => {
    const preflightEntered = deferred();
    const releasePreflight = deferred();
    const h = await harness({ schedule: () => {}, extensions: [(api) => {
      api.on("before_agent_start", async () => {
        preflightEntered.resolve();
        await releasePreflight.promise;
      });
    }] });
    const requests: string[] = [];
    h.provider.setResponses([0, 1, 2].map(() => (context) => {
      requests.push(JSON.stringify(context.messages));
      return h.ai.fauxAssistantMessage("reviewed");
    }));
    const adapter = h.factory.create({ cwd: join(root, "project") });
    const stage = scope === "stage" ? await h.launch("USER_REQUEST") : undefined;
    if (!stage) await adapter.start();
    const user = stage ? Promise.resolve() : adapter.prompt("USER_REQUEST");
    await preflightEntered.promise;
    const { coordinator, supervisor, session } = stage ?? h.managed();
    for (const batchId of ["A", "B"]) {
      coordinator.recordNotificationBatch({
        batchId, ownerSessionId: session.sessionId, launchIds: [], content: `HANDOFF_${batchId}`, triggerTurn: true,
      });
    }
    const sending = supervisor.flushNotifications();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(requests).toEqual([]);
      releasePreflight.resolve();
      await user;
      await sending;
      await supervisor.waitForQuiescence();
      await session.waitForIdle();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("USER_REQUEST");
      expect(requests[0]).toContain("HANDOFF_A");
      expect(requests[0]).toContain("HANDOFF_B");
      expect(coordinator.journal().pendingBatches).toEqual([]);
    } finally {
      releasePreflight.resolve();
      await user;
      await sending;
      if (stage) { await stage.handle.completion; await stage.handle.dispose(); }
      else await adapter.stop();
    }
  });

  it("admits an extension command's native run before its command preflight callback", async () => {
    const commandEntered = deferred();
    const startCommandRun = deferred();
    const releaseCommand = deferred();
    const h = await harness({ schedule: () => {}, extensions: [(api) => {
      api.registerCommand("review-now", {
        description: "Review in a native extension-owned run",
        handler: async (_args, ctx) => {
          commandEntered.resolve();
          await startCommandRun.promise;
          api.sendMessage({ customType: "review", content: "COMMAND_REQUEST", display: false }, { triggerTurn: true });
          // The escape releases a regressed admission deadlock during test cleanup.
          await Promise.race([ctx.waitForIdle(), releaseCommand.promise]);
        },
      });
    }] });
    const requests: string[] = [];
    h.provider.setResponses([0, 1].map(() => (context) => {
      requests.push(JSON.stringify(context.messages));
      return h.ai.fauxAssistantMessage("reviewed");
    }));
    const adapter = h.factory.create({ cwd: join(root, "project") });
    await adapter.start();
    const command = adapter.prompt("/review-now");
    await commandEntered.promise;
    const { coordinator, supervisor, session } = h.managed();
    coordinator.recordNotificationBatch({
      batchId: "B", ownerSessionId: session.sessionId, launchIds: [], content: "HANDOFF_B", triggerTurn: true,
    });
    const sending = supervisor.flushNotifications();
    startCommandRun.resolve();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("COMMAND_REQUEST");
      expect(requests[0]).toContain("HANDOFF_B");
    } finally {
      releaseCommand.resolve();
      await command;
      await sending;
      await adapter.stop();
    }
  });

  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])("settles an active-run command waiting for native idle (Stop: %s, handoff: %s)", async (stop, handoff) => {
    const toolEntered = deferred();
    const releaseTool = deferred();
    const commandEntered = deferred();
    const releaseCommand = deferred();
    const boundaryEntered = deferred();
    const h = await harness({ schedule: () => {}, extensions: [(api) => {
      api.registerCommand("wait-root", {
        description: "Wait for the current native root run",
        handler: async (_args, ctx) => {
          commandEntered.resolve();
          // Only cleanup uses the escape, so a regressed cycle cannot leak the run.
          await Promise.race([ctx.waitForIdle(), releaseCommand.promise]);
        },
      });
      api.registerTool({
        name: "hold", label: "Hold", description: "Controlled tool", parameters: Type.Object({}),
        execute: async () => {
          toolEntered.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "released" }], details: {} };
        },
      });
    }] });
    const requests: string[] = [];
    h.provider.setResponses([
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      (context) => { requests.push(JSON.stringify(context.messages)); return h.ai.fauxAssistantMessage("reviewed"); },
    ]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    await adapter.start();
    await adapter.prompt("ROOT_REQUEST");
    await toolEntered.promise;
    const { coordinator, supervisor, session } = h.managed();
    let commandSettled = false;
    const command = adapter.prompt("/wait-root current run").then(() => { commandSettled = true; });
    await commandEntered.promise;
    if (handoff) {
      coordinator.recordNotificationBatch({
        batchId: "B", ownerSessionId: session.sessionId, launchIds: [], content: "HANDOFF_B", triggerTurn: true,
      });
    }
    const drain = supervisor.drainNotifications.bind(supervisor);
    vi.spyOn(supervisor, "drainNotifications").mockImplementation((nativeStart) => {
      const draining = drain(nativeStart);
      if (!nativeStart) boundaryEntered.resolve();
      return draining;
    });
    releaseTool.resolve();
    await boundaryEntered.promise;
    let stopped = false;
    const stopping = stop ? adapter.abort().then(() => { stopped = true; }) : Promise.resolve();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(commandSettled).toBe(true);
      expect(session.isIdle).toBe(true);
      if (stop) expect(stopped).toBe(true);
      else {
        expect(requests).toHaveLength(1);
        if (handoff) expect(requests[0]).toContain("HANDOFF_B");
      }
      expect(coordinator.journal().pendingBatches).toEqual([]);
    } finally {
      releaseTool.resolve();
      releaseCommand.resolve();
      await command;
      await stopping;
      await adapter.stop();
    }
  });

  it("uses current native command parsing after reload without releasing Skill or unknown-slash admission", async () => {
    const toolEntered = deferred();
    const releaseTool = deferred();
    let registerCommand = false;
    let supervisor!: SubagentSupervisor;
    const observed: Array<{ kind: string; text: string; admissionHeld: boolean }> = [];
    const skill = join(root, "local-skill");
    mkdirSync(skill);
    writeFileSync(join(skill, "SKILL.md"), "---\nname: local-skill\ndescription: Fixture Skill\n---\nRead fixture evidence.\n");
    const h = await harness({ extensions: [(api) => {
      api.on("resources_discover", () => ({ skillPaths: [skill] }));
      if (registerCommand) {
        api.registerCommand("wait-root", {
          description: "Newly registered command",
          handler: async (args) => {
            observed.push({ kind: "command", text: args, admissionHeld: !supervisor.isQuiescent() });
          },
        });
      }
      api.on("input", (event) => {
        if (event.text === "ROOT_REQUEST") return;
        observed.push({ kind: "input", text: event.text, admissionHeld: !supervisor.isQuiescent() });
        return { action: "handled" };
      });
      api.registerTool({
        name: "hold", label: "Hold", description: "Controlled tool", parameters: Type.Object({}),
        execute: async () => {
          toolEntered.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "released" }], details: {} };
        },
      });
    }] });
    h.provider.setResponses([
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      h.ai.fauxAssistantMessage("finished"),
    ]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    await adapter.start();
    ({ supervisor } = h.managed());
    expect((await adapter.getCommands()).some(({ name }) => name === "wait-root")).toBe(false);
    registerCommand = true;
    h.publishConfiguration();
    await h.managed().binding.ensureCurrent();
    expect((await adapter.getCommands()).some(({ name }) => name === "wait-root")).toBe(true);
    await adapter.prompt("ROOT_REQUEST");
    await toolEntered.promise;
    try {
      for (const text of [
        "/wait-root", "/wait-root  args\tmore", " /wait-root args", "/wait-root\targs",
        "/wait-root\nargs", "/unknown args", "/skill:local-skill args", "/local-skill args",
      ]) await adapter.prompt(text);
      expect(observed).toEqual([
        { kind: "command", text: "", admissionHeld: false },
        { kind: "command", text: " args\tmore", admissionHeld: false },
        { kind: "input", text: " /wait-root args", admissionHeld: true },
        { kind: "input", text: "/wait-root\targs", admissionHeld: true },
        { kind: "input", text: "/wait-root\nargs", admissionHeld: true },
        { kind: "input", text: "/unknown args", admissionHeld: true },
        { kind: "input", text: "/skill:local-skill args", admissionHeld: true },
        { kind: "input", text: "/skill:local-skill args", admissionHeld: true },
      ]);
    } finally {
      releaseTool.resolve();
      await h.managed().session.waitForIdle();
      await adapter.stop();
    }
  });

  it("executes an active command immediately while another input owns preflight admission", async () => {
    const toolEntered = deferred();
    const releaseTool = deferred();
    const inputEntered = deferred();
    const releaseInput = deferred();
    let commandEntered = false;
    const h = await harness({ extensions: [(api) => {
      api.on("input", async (event) => {
        if (event.text !== "HELD_INPUT") return;
        inputEntered.resolve();
        await releaseInput.promise;
        return { action: "handled" };
      });
      api.registerCommand("release-input", {
        description: "Release the pending input",
        handler: async () => {
          commandEntered = true;
          releaseInput.resolve();
        },
      });
      api.registerTool({
        name: "hold", label: "Hold", description: "Controlled tool", parameters: Type.Object({}),
        execute: async () => {
          toolEntered.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "released" }], details: {} };
        },
      });
    }] });
    h.provider.setResponses([
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      h.ai.fauxAssistantMessage("finished"),
    ]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    await adapter.start();
    await adapter.prompt("ROOT_REQUEST");
    await toolEntered.promise;
    const input = adapter.prompt("HELD_INPUT");
    await inputEntered.promise;
    const command = adapter.prompt("/release-input");
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(commandEntered).toBe(true);
      await Promise.all([input, command]);
    } finally {
      releaseInput.resolve();
      releaseTool.resolve();
      await Promise.all([input, command]);
      await adapter.stop();
    }
  });

  it("projects native compaction as running in events and snapshots without marking the root streaming", async () => {
    const entered = deferred();
    const release = deferred();
    const h = await harness({ extensions: [(api) => {
      api.on("session_before_compact", async () => {
        entered.resolve();
        await release.promise;
        return { cancel: true };
      });
    }] });
    const registry = new ActiveSessionRegistry(h.factory, { debug() {}, info() {}, warn() {}, error() {} });
    const events: unknown[] = [];
    try {
      const dto = await registry.create({ cwd: join(root, "project") });
      registry.subscribe(dto.id, (event) => events.push(event));
      for (const seed of ["first", "second"]) {
        await registry.prompt(dto.id, `${seed} ${"evidence ".repeat(1000)}`);
        await vi.waitFor(() => expect(h.managed().session.isIdle).toBe(true));
      }
      await registry.compact(dto.id);
      await entered.promise;
      expect(registry.list()[0]).toMatchObject({ status: "running", isStreaming: false });
      expect(await registry.snapshot(dto.id)).toMatchObject({ session: { status: "running", isStreaming: false }, compactionState: "running" });
      expect(events).toContainEqual({ type: "session_activity_changed", status: "running", isStreaming: false });
      release.resolve();
      await vi.waitFor(() => expect(h.managed().compaction.state()).toBe("idle"));
      expect((await registry.snapshot(dto.id)).session.status).toBe("ready");
    } finally {
      release.resolve();
      await registry.shutdown();
    }
  });

  it("queues handoffs during native preflight without starting a reentrant run or spinning", async () => {
    const preflightEntered = deferred();
    const releasePreflight = deferred();
    const toolEntered = deferred();
    const releaseTool = deferred();
    let scheduled = 0;
    const h = await harness({
      schedule: (run) => { if (++scheduled <= 30) queueMicrotask(run); },
      extensions: [(api) => {
        api.on("before_agent_start", async () => {
          preflightEntered.resolve();
          await releasePreflight.promise;
        });
        api.registerTool({
          name: "hold", label: "Hold", description: "Controlled tool", parameters: Type.Object({}),
          execute: async () => {
            toolEntered.resolve();
            await releaseTool.promise;
            return { content: [{ type: "text", text: "released" }], details: {} };
          },
        });
      }],
    });
    const requests: string[] = [];
    h.provider.setResponses([
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      ...[0, 1].map(() => (context: Context) => {
        requests.push(JSON.stringify(context.messages));
        return h.ai.fauxAssistantMessage("reviewed");
      }),
    ]);
    const adapter = h.factory.create({ cwd: join(root, "project") });
    await adapter.start();
    const { coordinator, supervisor } = h.managed();
    const session = h.sessions[0]!;
    // Deliberately bypass the Web host's admission to exercise the upstream race.
    const user = session.prompt("RAW_SDK_USER", { streamingBehavior: "steer" }).catch((error: unknown) => error);
    await preflightEntered.promise;
    coordinator.recordNotificationBatch({
      batchId: "A", ownerSessionId: session.sessionId, launchIds: [], content: "HANDOFF_A", triggerTurn: true,
    });
    await supervisor.flushNotifications();
    releasePreflight.resolve();
    await toolEntered.promise;
    expect(session.isStreaming).toBe(true);
    expect(session.agent.state.isStreaming).toBe(true);
    coordinator.recordNotificationBatch({
      batchId: "B", ownerSessionId: session.sessionId, launchIds: [], content: "HANDOFF_B", triggerTurn: true,
    });
    await supervisor.flushNotifications().catch(() => {});
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(scheduled).toBeLessThan(30);
      releaseTool.resolve();
      expect(await user).toBeUndefined();
      await session.waitForIdle();
      await new Promise<void>((resolve) => setImmediate(resolve));
      supervisor.runtimeBecameCoherent();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(coordinator.journal().pendingBatches).toEqual([]);
      expect(requests.at(-1)).toContain("HANDOFF_B");
      expect(requests.at(-1)).toContain("HANDOFF_A");
      await supervisor.waitForQuiescence();
    } finally {
      releaseTool.resolve();
      await adapter.stop();
    }
  });

  it.each(["abort", "stop"] as const)("%s cancels and settles branch navigation without a compaction_end event", async (operation) => {
    const entered = deferred<AbortSignal>();
    const release = deferred();
    const h = await harness({ extensions: [(api) => {
      api.on("session_before_tree", async (event) => {
        entered.resolve(event.signal);
        await release.promise;
        return { cancel: event.signal.aborted, summary: { summary: "branch summary" } };
      });
    }] });
    const adapter = h.factory.create({ cwd: join(root, "project") });
    await adapter.start();
    await adapter.prompt("seed");
    await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
    const session = h.sessions[0]!;
    const compactionEvents: string[] = [];
    session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") compactionEvents.push(event.type);
    });
    const target = session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user")!;
    const navigation = adapter.navigateTree(target.id, { summarize: true });
    const signal = await entered.promise;
    let finished = false;
    const stopping = adapter[operation]().then(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      expect(finished).toBe(false);
      expect(adapter.hasBackgroundWork()).toBe(true);
    } finally {
      release.resolve();
      await navigation;
      await stopping;
      await adapter.stop();
    }
    expect(session.isCompacting).toBe(false);
    expect(compactionEvents).toEqual([]);
    expect(adapter.hasBackgroundWork()).toBe(false);
  });

  it("aborts stage automatic compaction before waiting for native idle", async () => {
    const entered = deferred<AbortSignal>();
    const release = deferred();
    const h = await harness({ compact: true, extensions: [(api) => {
      api.on("session_before_compact", async (event) => {
        entered.resolve(event.signal);
        await release.promise;
        return { cancel: true };
      });
    }] });
    h.provider.setResponses([h.ai.fauxAssistantMessage("result ".repeat(200))]);
    const { handle, session } = await h.launch("evidence ".repeat(7_000));
    const signal = await entered.promise;
    await handle.materialized;
    const stopping = handle.abort("Stop");
    try {
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
    } finally {
      release.resolve();
      await stopping;
      await handle.completion;
      await handle.dispose();
    }
    expect(session.isCompacting).toBe(false);
    await expect(handle.completion).resolves.toMatchObject({ wasAborted: true, exitCode: 1 });
  });

  it.each(["root", "stage"] as const)("closes %s extension resources exactly once before terminal invalidation", async (scope) => {
    const lifecycle: string[] = [];
    let resourceOpen = false;
    const h = await harness({ extensions: [(api) => {
      api.on("session_start", () => { lifecycle.push("start"); resourceOpen = true; });
      api.on("session_shutdown", (event, ctx) => {
        ctx.sessionManager.getSessionId();
        lifecycle.push(event.reason);
        resourceOpen = false;
      });
    }] });
    if (scope === "stage") {
      const { handle } = await h.launch();
      await handle.completion;
      await Promise.all([handle.dispose(), handle.dispose()]);
    } else {
      const adapter = h.factory.create({ cwd: join(root, "project") });
      await adapter.start();
      await adapter.abort();
      expect(resourceOpen).toBe(true);
      await Promise.all([adapter.stop(), adapter.stop()]);
    }
    expect(lifecycle).toEqual(["start", "quit"]);
    expect(resourceOpen).toBe(false);
  });

  it("re-arms idle expiry after the native prompt promise leaves background ownership", async () => {
    const h = await harness();
    const registry = new ActiveSessionRegistry(h.factory, { debug() {}, info() {}, warn() {}, error() {} }, { idleTimeoutMs: 80 });
    vi.useFakeTimers();
    try {
      const dto = await registry.create({ cwd: join(root, "project") });
      const prompting = registry.prompt(dto.id, "finish");
      await vi.advanceTimersByTimeAsync(0);
      await prompting;
      await vi.advanceTimersByTimeAsync(400);
      expect(h.managed().session.isIdle).toBe(true);
      expect(registry.has(dto.id)).toBe(false);
    } finally {
      await registry.shutdown();
    }
  });
});
