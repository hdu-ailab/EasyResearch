import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importPi } from "../runtime/pi-import";
import { createAgentDefinitionExtension } from "../extensions/agent-definition";
import type { LiveConfiguration } from "../runtime/live-configuration";
import { SubagentCoordinator } from "../subagent/coordinator";
import { SubagentSupervisor } from "../subagent/supervisor";
import type { AgentConfig } from "../subagent/agents";
import { ExecutionClaims } from "../background/execution-claims";
import { hasBackgroundOwner } from "../background/root-recovery";
import { pendingBackgroundInputs } from "../background/inbox";
import type { ManagedShellService, ShellOwner, ShellRecoveryOptions } from "../background/shell";
import { createManagedShellManager } from "../background/shell";
import { createPiAgentSessionCreator, PiSessionFactory, type ManagedAgentSession, type PiRuntimeDependencies, type SessionAdapter } from "./session-adapter";

vi.mock("../runtime/logger", () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
let root: string;
const adapters: SessionAdapter[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "root-background-"));
  for (const name of ["home", "agent", "project", "sessions"]) mkdirSync(join(root, name));
  vi.stubEnv("HOME", join(root, "home")); vi.stubEnv("USERPROFILE", join(root, "home"));
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(root, "agent")); vi.stubEnv("PI_OFFLINE", "1");
  vi.stubGlobal("fetch", async () => { throw new Error("Network forbidden in root background tests"); });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stop()));
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

async function harness(allowPreparedShellHandoff = false, realShell = false) {
  const pi = await importPi();
  const ai = await import("@earendil-works/pi-ai");
  const provider = ai.fauxProvider({ provider: "root-background-fixture", models: [{ id: "test", contextWindow: 16000, maxTokens: 1000 }], tokenSize: { min: 10000, max: 10000 } });
  provider.setResponses([ai.fauxAssistantMessage("complete")]);
  const rows: AgentConfig[] = [{ name: "research-assistant", description: "Root", enabled: true, builtin: true, source: "bundled",
    filePath: join(root, "root.md"), systemPrompt: "Root fixture", tools: [], effectiveTools: [], skills: [], effectiveSkills: [],
    effectiveSkillPaths: [], missingSkills: [], subagents: [], model: "root-background-fixture/test", thinking: "off" }];
  let generation = 1;
  const live = { get generation() { return generation; }, availabilityEpoch: 0, compactionPolicy: { triggerPercent: 70, globalEnabled: false, globalKeepRecentTokens: 100 },
    synchronize: async () => {}, acquireProject: async (cwd: string) => ({ cwd, release: async () => {} }), isCurrent: (n: number) => n === generation,
    resolveAgents: async () => rows, subscribe: () => () => {},
  } as unknown as LiveConfiguration;
  let owner: ShellOwner | undefined;
  let recoveryOptions: ShellRecoveryOptions | undefined;
  const shellErrors: unknown[] = [];
  let shell: ManagedShellService = {
    attachOwner(value) { owner = value; return () => { owner = undefined; }; }, detachOwner() {}, subscribe: () => () => {},
    tasks: () => [], list: () => [], blocking: () => [], hasWork: () => false, promote: async () => {}, cancel: async () => {},
    execute: async () => { throw new Error("No process expected"); }, executeRemote: async () => { throw new Error("No SSH expected"); },
    recover: async (value) => { recoveryOptions = value; }, recoveredCalls: () => [], flushNotifications: async () => {},
    prepareHandoff: async () => {}, revokeHandoff: async () => {}, dispose: async () => {},
  };
  const sessions: AgentSession[] = [];
  let managed!: ManagedAgentSession;
  const creator = createPiAgentSessionCreator({
    agentDir: join(root, "agent"), liveConfiguration: live, allowPreparedShellHandoff,
    createSessionManager: (cwd) => pi.SessionManager.create(cwd, join(root, "sessions")), openSessionManager: (path) => pi.SessionManager.open(path),
    createCoordinator: (manager) => new SubagentCoordinator(manager), createShellManager: ({ sessionID, cwd }) => {
      if (realShell) shell = createManagedShellManager({ agentDir: join(root, "agent"), rootSessionID: sessionID, cwd, worker: false,
        onError: (error) => { shellErrors.push(error); } });
      return shell;
    },
    recoverSubagentTree: async () => {},
    createDirectChildSupervisor: (coordinator) => new SubagentSupervisor({ coordinator, launchStage: async () => { throw new Error("No child expected"); } }),
    createSettingsManager: () => pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    createModelRuntime: async () => {
      const runtime = await pi.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
        modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
      runtime.registerNativeProvider(provider.provider); return runtime;
    },
    createResourceLoader: (options) => new pi.DefaultResourceLoader({ ...options as ConstructorParameters<typeof pi.DefaultResourceLoader>[0],
      noExtensions: true, noContextFiles: true, noPromptTemplates: true, noThemes: true }),
    createAgentSession: async (options) => {
      const created = await pi.createAgentSession(options as Parameters<typeof pi.createAgentSession>[0]); sessions.push(created.session); return created as never;
    },
    createExtensionFactories: ({ binding }) => [{ name: "agent-definition", factory: createAgentDefinitionExtension(binding) }],
    resolveAutomaticModel: async () => provider.getModel(),
  } as PiRuntimeDependencies);
  const factory = new PiSessionFactory(async (...args) => { managed = await creator(...args); return managed; }, pi.estimateTokens);
  const open = async (path?: string) => {
    const adapter = factory.create({ cwd: join(root, "project"), sessionPath: path }); adapters.push(adapter); await adapter.start(); return adapter;
  };
  const notify = () => owner!.notify({ id: "shell:finished", content: "HELD_SHELL_RESULT", wake: true, sessionID: owner!.sessionID,
    shellID: "shell", state: "completed", recovered: false,
    result: { output: "done", exitCode: 0, status: "completed", wallTimeSeconds: 1, truncated: false } });
  const block = () => {
    const entered = deferred();
    provider.setResponses([async (_context, options) => {
      entered.resolve();
      await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return ai.fauxAssistantMessage("interrupted");
    }]);
    return entered.promise;
  };
  return { pi, ai, provider, open, sessions, notify, block, get shell() { return shell; }, shellErrors, rows,
    refreshRuntime: async () => { generation++; rows[0]!.systemPrompt += " refreshed"; await managed.binding.ensureCurrent(); },
    managed: () => managed, recoveryOptions: () => recoveryOptions };
}

describe("root background restart and inbox ownership", () => {
  it.each([false, true])("only grants prepared live-owner custody from an explicit managed-host authority (%s)", async (allowed) => {
    const h = await harness(allowed);
    const history = h.pi.SessionManager.create(join(root, "project"), join(root, "sessions"));
    history.appendMessage({ role: "user", content: "accepted", timestamp: Date.now() });
    await h.open(history.getSessionFile());
    const options = h.recoveryOptions()!;
    expect(await options.verifyPriorOwner({ rootSessionID: history.getSessionId(), pid: process.ppid, instanceID: "predecessor" })).toBe(false);
    expect((options as ShellRecoveryOptions & { allowPreparedHandoff?: boolean }).allowPreparedHandoff).toBe(allowed);
  });

  it("persists only native steers still queued after suspension, including repeated text", async () => {
    const h = await harness(); const entered = h.block(); const adapter = await h.open();
    await adapter.prompt("original"); await entered;
    await adapter.prompt("correction"); await adapter.prompt("correction");
    await adapter.suspend!();
    const session = h.sessions[0]!;
    const reopened = h.pi.SessionManager.open(session.sessionFile!);
    expect(reopened.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [])).toEqual([
        [{ type: "text", text: "original" }], [{ type: "text", text: "correction" }], [{ type: "text", text: "correction" }],
      ]);
    expect(new ExecutionClaims(reopened).current()?.pending).toBe(true);
  });

  it("does not replay steers already consumed by native history during abort", async () => {
    const h = await harness(); const first = deferred(); const release = deferred(); const second = deferred();
    h.provider.setResponses([async () => { first.resolve(); await release.promise; return h.ai.fauxAssistantMessage("first"); },
      async (_ctx, options) => { second.resolve(); await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true })); return h.ai.fauxAssistantMessage("interrupted"); }]);
    const adapter = await h.open(); await adapter.prompt("original"); await first.promise;
    await adapter.prompt("consumed correction"); release.resolve(); await second.promise;
    await adapter.suspend!();
    const reopened = h.pi.SessionManager.open(h.sessions[0]!.sessionFile!);
    expect(reopened.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("consumed correction"))).toHaveLength(1);
  });

  it.each([false, true])("preserves actual queued custom input, rejecting an additional follow-up queue (%s)", async (followUp) => {
    const h = await harness(); const entered = h.block(); const adapter = await h.open();
    await adapter.prompt("original"); await entered;
    const session = h.sessions[0]!;
    await session.sendCustomMessage({ customType: "fixture:custom", content: [{ type: "text", text: "actual extension input" }], display: false,
      details: { accepted: "original metadata" } }, { deliverAs: "steer", triggerTurn: true });
    if (followUp) await session.followUp("parked extension input");
    const dispose = vi.spyOn(session, "dispose");
    if (followUp) {
      await expect(adapter.suspend!()).rejects.toThrow(/follow-up input/);
      expect(dispose).not.toHaveBeenCalled();
      expect(JSON.stringify(session.agent.peekQueuedMessages())).toContain("parked extension input");
    } else await adapter.suspend!();
    const disk = h.pi.SessionManager.open(session.sessionFile!);
    expect(disk.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "fixture:custom")).toEqual([
      expect.objectContaining({ content: [{ type: "text", text: "actual extension input" }], details: { accepted: "original metadata" } }),
    ]);
    await adapter.stop();
  });

  it("keeps prepared process custody owned when handoff preparation fails, and terminal cleanup revokes it", async () => {
    const h = await harness(); const adapter = await h.open(); await adapter.prompt("original");
    await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
    let prepared = false; let released = false; let revoked = false;
    h.shell.prepareHandoff = async () => { prepared = true; throw new Error("handoff preparation failed"); };
    h.shell.dispose = async () => { released = true; };
    h.shell.revokeHandoff = async () => { revoked = true; };
    await expect(adapter.suspend!()).rejects.toThrow("handoff preparation failed");
    expect(prepared).toBe(true); expect(released).toBe(false);
    await adapter.stop();
    expect(revoked).toBe(true); expect(released).toBe(true);
  });

  it("retains partial suspension append progress and retries without disposing or duplicating inputs", async () => {
    const h = await harness(); const entered = h.block(); const adapter = await h.open();
    await adapter.prompt("original"); await entered; await adapter.prompt("first"); await adapter.prompt("second");
    const session = h.sessions[0]!; const append = session.sessionManager.appendMessage.bind(session.sessionManager);
    const dispose = vi.spyOn(session, "dispose"); let fail = true;
    vi.spyOn(session.sessionManager, "appendMessage").mockImplementation((message) => {
      if (message.role === "user" && JSON.stringify(message.content).includes("second") && fail) { fail = false; throw new Error("disk full"); }
      return append(message);
    });
    await expect(adapter.suspend!()).rejects.toThrow("disk full");
    expect(dispose).not.toHaveBeenCalled();
    await adapter.suspend!();
    const disk = h.pi.SessionManager.open(session.sessionFile!);
    const users = disk.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user");
    expect(users).toHaveLength(3);
    expect(JSON.stringify(users)).toContain("second");
  });

  it("preserves terminally cancelled inbox results passively and reopening does not infer", async () => {
    const h = await harness(); const entered = h.block(); const adapter = await h.open();
    await adapter.prompt("original"); await entered; await h.notify(); await adapter.stop();
    const path = h.sessions[0]!.sessionFile!; const disk = h.pi.SessionManager.open(path);
    expect(new ExecutionClaims(disk).current()?.outcome).toBe("cancelled");
    expect(pendingBackgroundInputs(disk)).toEqual([]);
    expect(disk.getEntries().filter((entry) => entry.type === "custom_message" && entry.content === "HELD_SHELL_RESULT")).toHaveLength(1);
    const calls = h.provider.state.callCount;
    await h.open(path);
    expect(h.provider.state.callCount).toBe(calls);
  });

  it("drains held shell results when manual Retry releases the wake hold", async () => {
    const h = await harness(); h.provider.setResponses([h.ai.fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "503 overloaded" })]);
    const adapter = await h.open(); await adapter.prompt("original"); const session = h.sessions[0]!;
    await vi.waitFor(() => expect(adapter.getRetryState!(session.sessionId)?.llmRecovery?.status).toBe("available"));
    await session.waitForIdle();
    const checkpoint = adapter.getRetryState!(session.sessionId)!.llmRecovery!;
    await h.notify();
    const contexts: string[] = [];
    h.provider.setResponses(Array.from({ length: 3 }, () => (context) => { contexts.push(JSON.stringify(context.messages)); return h.ai.fauxAssistantMessage("recovered"); }));
    await adapter.retry!(session.sessionId, checkpoint.failureId);
    await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
    expect(contexts.some((context) => context.includes("HELD_SHELL_RESULT"))).toBe(true);
    expect(pendingBackgroundInputs(session.sessionManager)).toEqual([]);
  });

  it.each(["prompt", "retry", "configuration"] as const)("retries an actual shell outbox after failed inbox admission at the %s boundary", async (boundary) => {
    const h = await harness(false, true);
    if (boundary === "retry") h.provider.setResponses([h.ai.fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "503 overloaded" })]);
    const adapter = await h.open(); await adapter.prompt("original"); const session = h.sessions[0]!;
    await vi.waitFor(() => expect(session.isIdle).toBe(true));
    if (boundary === "retry") await vi.waitFor(() => expect(adapter.getRetryState!(session.sessionId)?.llmRecovery?.status).toBe("available"));
    else await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
    const append = session.sessionManager.appendCustomEntry.bind(session.sessionManager);
    let fail = true;
    vi.spyOn(session.sessionManager, "appendCustomEntry").mockImplementation((type, data) => {
      if (type === "easyresearch:background_inbox" && fail) { fail = false; throw new Error("inbox temporarily unavailable"); }
      return append(type, data);
    });
    await h.shell.execute(session.sessionId, { command: "echo OUTBOX_RECOVERED_RESULT", background: true });
    await vi.waitFor(() => expect(h.shellErrors.length).toBeGreaterThan(0));
    expect(pendingBackgroundInputs(session.sessionManager)).toEqual([]);
    expect(h.shell.hasWork()).toBe(true);
    const contexts: string[] = [];
    h.provider.setResponses(Array.from({ length: 4 }, () => (context) => { contexts.push(JSON.stringify(context.messages)); return h.ai.fauxAssistantMessage("handled"); }));
    if (boundary === "prompt") await adapter.prompt("explicit input retries delivery");
    else if (boundary === "configuration") await h.refreshRuntime();
    else await adapter.retry!(session.sessionId, adapter.getRetryState!(session.sessionId)!.llmRecovery!.failureId);
    await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
    expect(h.shell.hasWork()).toBe(false);
    expect(contexts.some((context) => context.includes("OUTBOX_RECOVERED_RESULT"))).toBe(true);
    expect(pendingBackgroundInputs(session.sessionManager)).toEqual([]);
  });

  it("revokes suspended root journals through a fresh manager without rolling back successor history", async () => {
    const h = await harness(); const adapter = await h.open(); await adapter.prompt("original");
    await vi.waitFor(() => expect(adapter.hasBackgroundWork()).toBe(false));
    const old = h.managed(); old.backgroundOwner!.update(true); await adapter.suspend!();
    const path = h.sessions[0]!.sessionFile!;
    const successor = h.pi.SessionManager.open(path);
    successor.appendMessage({ role: "user", content: "SUCCESSOR_INPUT", timestamp: Date.now() });
    const child = h.pi.SessionManager.create(join(root, "project"), join(root, "sessions"));
    child.appendMessage({ role: "user", content: "successor admitted child", timestamp: Date.now() });
    new ExecutionClaims(child).start();
    const nextCoordinator = new SubagentCoordinator(successor);
    const childAgent = { ...h.rows[0]!, name: "search" };
    const reservation = nextCoordinator.reserveDispatch({ ownerSessionId: successor.getSessionId(), requested: "search",
      toolCallId: "successor-dispatch", description: "successor child", catalog: { all: [childAgent], available: [childAgent] } });
    nextCoordinator.recordMaterialized(reservation, { childSessionId: child.getSessionId(), sessionPath: child.getSessionFile()! });
    nextCoordinator.recordBackgroundAdmission(reservation.launchId, { cwd: join(root, "project"), callerAgent: "research-assistant", description: "successor child" });
    new ExecutionClaims(successor).start();
    const bytes = readFileSync(path, "utf8");
    vi.spyOn(h.sessions[0]!.sessionManager, "appendCustomEntry").mockImplementation(() => { throw new Error("Stale manager write"); });
    await adapter.revokeSuspension!();
    const final = h.pi.SessionManager.open(path);
    expect(readFileSync(path, "utf8").startsWith(bytes)).toBe(true);
    expect(JSON.stringify(final.getBranch())).toContain("SUCCESSOR_INPUT");
    expect(new ExecutionClaims(final).current()?.outcome).toBe("cancelled");
    expect(new ExecutionClaims(h.pi.SessionManager.open(child.getSessionFile()!)).current()?.outcome).toBe("cancelled");
    const finalCoordinator = new SubagentCoordinator(final);
    expect(finalCoordinator.journal().jobs.get(reservation.launchId)?.backgroundResult?.state).toBe("cancelled");
    expect(finalCoordinator.journal().pendingBatches.every((batch) => batch.triggerTurn === false)).toBe(true);
    expect(hasBackgroundOwner(final.getEntries(), final.getSessionId())).toBe(false);
  });
});
