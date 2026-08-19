import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { toJsonSessionEvent } from "../runtime/json-session-event";
import { readAgentAliases } from "./agent-alias";
import type { AgentConfig } from "./agents";
import { SubagentCoordinator, type CoordinatorSessionManager, type ReservedDispatch } from "./coordinator";
import { createSessionMaterializationBarrier, type SessionMaterializationBarrier } from "./materialization";
import { sessionNameFor } from "./session-links";

export interface StageUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface StageRunResult {
  agent: string;
  agentSource: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: StageUsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  sessionId?: string;
  sessionPath?: string;
  agentId?: string;
  wasAborted?: boolean;
}

export interface StageLaunchOptions {
  reservation: ReservedDispatch;
  agent: AgentConfig;
  task: string;
  cwd: string;
  model?: string;
  thinking?: string;
  coordinator: SubagentCoordinator;
  signal?: AbortSignal;
}

export interface StageLaunchHandle {
  readonly agentId: string;
  readonly childSessionId: string;
  readonly sessionPath: string;
  readonly materialized: Promise<void>;
  readonly completion: Promise<StageRunResult>;
  subscribe(listener: (event: JsonAgentSessionEvent) => void): () => void;
  abort(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

export type StageSessionLauncher = (options: StageLaunchOptions) => Promise<StageLaunchHandle>;

export interface StageAgentSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly thinkingLevel: ThinkingLevel;
  readonly model: Model<any> | undefined;
  readonly isStreaming: boolean;
  subscribe(listener: (event: unknown) => void): () => void;
  bindExtensions(bindings: unknown): Promise<void>;
  setSessionName(name: string): void;
  getAllTools(): Array<{ name: string }>;
  setActiveToolsByName(names: string[]): void;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

interface StageResourceLoader {
  reload(options?: { resolveProjectTrust?: () => Promise<boolean> }): Promise<void>;
}

interface OpenedStageSessionManager {
  getSessionId(): string;
  getCwd(): string;
  getSessionFile(): string | undefined;
}

export interface StageSessionDependencies {
  agentDir: string;
  createSessionManager(cwd: string): unknown;
  openSessionManager(path: string): OpenedStageSessionManager;
  createSettingsManager(cwd: string, agentDir: string): unknown;
  createModelRuntime(agentDir: string): Promise<{
    getModel(provider: string, modelId: string): Model<any> | undefined;
  }>;
  createResourceLoader(options: {
    cwd: string;
    agentDir: string;
    settingsManager: unknown;
    extensionFactories: unknown[];
    noSkills: boolean;
    additionalSkillPaths: string[];
    appendSystemPrompt: string[];
  }): StageResourceLoader;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: StageAgentSession }>;
  createExtensionFactories(agent: AgentConfig, coordinator: SubagentCoordinator): unknown[];
  resolveSkillPaths(agent: AgentConfig, cwd: string, agentDir: string): string[];
}

const emptyUsage = (): StageUsageStats => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
});

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class StageLaunchSetupError extends Error {
  constructor(
    cause: unknown,
    readonly childSessionId: string,
    readonly sessionPath: string,
  ) {
    super(describeError(cause), { cause });
    this.name = "StageLaunchSetupError";
  }
}

function validateContinuation(
  manager: OpenedStageSessionManager,
  reservation: ReservedDispatch,
  cwd: string,
  sessionPath: string,
): void {
  if (manager.getSessionId() !== reservation.childSessionId) {
    throw new Error(`Continuation session UUID does not match reserved child ${reservation.childSessionId}.`);
  }
  if (manager.getCwd() !== cwd) {
    throw new Error(`Continuation session cwd does not match the exact launch cwd ${cwd}.`);
  }
  if (manager.getSessionFile() !== sessionPath) {
    throw new Error("Continuation SessionManager did not reopen the exact reserved path.");
  }
}

export function createStageSessionLauncher(deps: StageSessionDependencies): StageSessionLauncher {
  return async (options) => {
    const result: StageRunResult = {
      agent: options.agent.name,
      agentSource: options.agent.source,
      task: options.task,
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      model: options.model,
      agentId: options.reservation.agentId,
    };
    let session: StageAgentSession | undefined;
    let barrier: SessionMaterializationBarrier | undefined;
    let unsubscribe: (() => void) | undefined;
    let signalListener: (() => void) | undefined;

    try {
      let sessionManager: unknown;
      if (options.reservation.continuation) {
        const { childSessionId, sessionPath } = options.reservation;
        if (!childSessionId || !sessionPath) {
          throw new Error("Continuation reservation is missing its child session UUID or exact path.");
        }
        barrier = createSessionMaterializationBarrier({ sessionPath, continuation: true });
        void barrier.materialized.catch(() => {});
        await barrier.materialized;
        const opened = deps.openSessionManager(sessionPath);
        validateContinuation(opened, options.reservation, options.cwd, sessionPath);
        sessionManager = opened;
      } else {
        sessionManager = deps.createSessionManager(options.cwd);
      }

      const settingsManager = deps.createSettingsManager(options.cwd, deps.agentDir);
      const modelRuntime = await deps.createModelRuntime(deps.agentDir);
      let model: Model<any> | undefined;
      if (options.model) {
        const separator = options.model.indexOf("/");
        if (separator <= 0 || separator === options.model.length - 1) {
          throw new Error(`Invalid model: ${options.model}`);
        }
        model = modelRuntime.getModel(options.model.slice(0, separator), options.model.slice(separator + 1));
        if (!model) throw new Error(`Unknown model: ${options.model}`);
      }
      const resourceLoader = deps.createResourceLoader({
        cwd: options.cwd,
        agentDir: deps.agentDir,
        settingsManager,
        extensionFactories: deps.createExtensionFactories(options.agent, options.coordinator),
        noSkills: true,
        additionalSkillPaths: deps.resolveSkillPaths(options.agent, options.cwd, deps.agentDir),
        appendSystemPrompt: options.agent.systemPrompt.trim() ? [options.agent.systemPrompt] : [],
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
      const created = await deps.createAgentSession({
        cwd: options.cwd,
        agentDir: deps.agentDir,
        sessionManager,
        settingsManager,
        modelRuntime,
        resourceLoader,
        ...(model ? { model } : {}),
        ...(options.thinking ? { thinkingLevel: options.thinking } : {}),
        ...(options.agent.tools && options.agent.tools.length > 0 ? { tools: options.agent.tools } : {}),
      });
      session = created.session;
      const sessionPath = session.sessionFile;
      if (!sessionPath) throw new Error("Stage AgentSession did not provide a persistent session path.");
      if (options.reservation.continuation) {
        if (session.sessionId !== options.reservation.childSessionId || sessionPath !== options.reservation.sessionPath) {
          throw new Error("Continued AgentSession identity does not match its reservation.");
        }
      } else {
        barrier = createSessionMaterializationBarrier({ sessionPath, continuation: false });
        void barrier.materialized.catch(() => {});
      }

      result.sessionId = session.sessionId;
      result.sessionPath = sessionPath;
      const listeners = new Set<(event: JsonAgentSessionEvent) => void>();
      const pendingOwnerEvents: JsonAgentSessionEvent[] = [];
      let ownerSubscribed = false;
      let abortRequested = false;
      let abortReapplied = false;
      let abortReason: string | undefined;
      let abortOperations = Promise.resolve();
      let completion!: Promise<StageRunResult>;
      let disposePromise: Promise<void> | undefined;

      const invokeAbort = () => {
        let operation: Promise<void>;
        try {
          operation = Promise.resolve(session!.abort()).catch(() => {});
        } catch {
          operation = Promise.resolve();
        }
        abortOperations = Promise.all([abortOperations, operation]).then(() => {});
        return abortOperations;
      };
      const requestAbort = (reason?: string) => {
        if (abortRequested) return abortOperations;
        abortRequested = true;
        abortReason = reason;
        result.wasAborted = true;
        result.exitCode = 1;
        return invokeAbort();
      };
      const deliver = (listener: (event: JsonAgentSessionEvent) => void, event: JsonAgentSessionEvent) => {
        try {
          listener(event);
        } catch {
          // A progress consumer must not delay Pi's post-callback persistence.
        }
      };

      unsubscribe = session.subscribe((rawEvent) => {
        const event = toJsonSessionEvent(rawEvent as AgentSessionEvent);
        if (abortRequested && !abortReapplied && event.type === "agent_start") {
          abortReapplied = true;
          void invokeAbort();
        }
        barrier!.observe(event);
        collectMessageEvent(result, event);
        if (!ownerSubscribed) pendingOwnerEvents.push(event);
        else for (const listener of listeners) deliver(listener, event);
      });
      await session.bindExtensions({ mode: "rpc" });
      if (!options.agent.tools || options.agent.tools.length === 0) {
        session.setActiveToolsByName(session.getAllTools().map(({ name }) => name));
      }
      session.setSessionName(sessionNameFor(options.agent.name));

      const finish = async (error?: unknown): Promise<StageRunResult> => {
        barrier!.settlePrompt(error);
        await abortOperations;
        result.sessionPath = session!.sessionFile;
        if (error !== undefined) {
          result.exitCode = 1;
          result.errorMessage = describeError(error);
          result.stderr = result.errorMessage;
        }
        if (abortRequested) {
          result.exitCode = 1;
          result.wasAborted = true;
          if (abortReason) {
            result.errorMessage = abortReason;
            result.stderr = abortReason;
          }
        }
        return result;
      };

      let prompt: Promise<void>;
      try {
        prompt = session.prompt(`Task: ${options.task}`);
      } catch (error) {
        prompt = Promise.reject(error);
      }
      completion = prompt.then(
        () => finish(),
        (error) => finish(error),
      );

      signalListener = () => {
        const signalReason = options.signal?.reason;
        void requestAbort(typeof signalReason === "string" ? signalReason : undefined);
      };
      if (options.signal?.aborted) signalListener();
      else options.signal?.addEventListener("abort", signalListener, { once: true });

      const handle: StageLaunchHandle = {
        agentId: options.reservation.agentId,
        childSessionId: session.sessionId,
        sessionPath,
        materialized: barrier!.materialized,
        completion,
        subscribe(listener) {
          listeners.add(listener);
          if (!ownerSubscribed) {
            ownerSubscribed = true;
            for (const event of pendingOwnerEvents.splice(0)) deliver(listener, event);
          }
          return () => listeners.delete(listener);
        },
        abort(reason) {
          return requestAbort(reason);
        },
        dispose() {
          disposePromise ??= (async () => {
            await completion;
            await abortOperations;
            if (signalListener) options.signal?.removeEventListener("abort", signalListener);
            unsubscribe?.();
            barrier!.dispose();
            listeners.clear();
            pendingOwnerEvents.length = 0;
            session!.dispose();
          })();
          return disposePromise;
        },
      };
      return handle;
    } catch (error) {
      const failure = session?.sessionFile
        ? new StageLaunchSetupError(error, session.sessionId, session.sessionFile)
        : error;
      barrier?.dispose();
      if (signalListener) options.signal?.removeEventListener("abort", signalListener);
      unsubscribe?.();
      session?.dispose();
      throw failure;
    }
  };
}

let defaultLauncher: Promise<StageSessionLauncher> | undefined;

export async function launchStageSession(options: StageLaunchOptions): Promise<StageLaunchHandle> {
  const { assertSafeExtensionSources } = await import("../runtime/extensions-guard");
  assertSafeExtensionSources({ cwd: options.cwd });
  defaultLauncher ??= resolveDefaultStageSessionLauncher();
  return (await defaultLauncher)(options);
}

async function resolveDefaultStageSessionLauncher(): Promise<StageSessionLauncher> {
  const { join } = await import("node:path");
  const { importPi, getAgentDir } = await import("../runtime/pi-import");
  const pi = await importPi();
  const { createSubagentExtension } = await import("../extensions/subagent");
  const { default: webSearchExtension } = await import("../extensions/web-search");
  const { default: webFetchExtension } = await import("../extensions/webfetch");
  const { isDotAgentsSkillEnabled, resolveAgentSkillDirectories } = await import("./skill-resolution");
  const agentDir = getAgentDir();
  return createStageSessionLauncher({
    agentDir,
    createSessionManager: (cwd) => pi.SessionManager.create(cwd),
    openSessionManager: (path) => pi.SessionManager.open(path),
    createSettingsManager: (cwd, root) => pi.SettingsManager.create(cwd, root),
    createModelRuntime: (root) =>
      pi.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") }),
    createResourceLoader: (options) =>
      new pi.DefaultResourceLoader(options as ConstructorParameters<typeof pi.DefaultResourceLoader>[0]),
    createAgentSession: async (options) => {
      const created = await pi.createAgentSession(options as Parameters<typeof pi.createAgentSession>[0]);
      return { session: created.session as unknown as StageAgentSession };
    },
    createExtensionFactories: (agent, coordinator) => [
      {
        name: "subagent",
        factory: createSubagentExtension({
          callerAgent: agent.name,
          allowedSubagents: agent.subagents,
          ownerSessionManager: coordinator.getRootSessionManager(),
        }),
      },
      { name: "web-search", factory: webSearchExtension },
      { name: "webfetch", factory: webFetchExtension },
    ],
    resolveSkillPaths: (agent, cwd, root) => {
      const deps = {
        cwd,
        agentDir: root,
        enableDotAgentsSkill: isDotAgentsSkillEnabled(
          pi.SettingsManager.create(cwd, root).getGlobalSettings(),
        ),
      };
      return resolveAgentSkillDirectories(agent, deps);
    },
  });
}

function collectMessageEvent(result: StageRunResult, event: JsonAgentSessionEvent): void {
  if (event.type !== "message_end") return;
  const message = event.message as AgentMessage;
  if (message.role !== "assistant" && message.role !== "user" && message.role !== "toolResult") return;
  result.messages.push(message as Message);
  if (message.role !== "assistant") return;
  result.usage.turns += 1;
  result.usage.input += message.usage.input || 0;
  result.usage.output += message.usage.output || 0;
  result.usage.cacheRead += message.usage.cacheRead || 0;
  result.usage.cacheWrite += message.usage.cacheWrite || 0;
  result.usage.cost += message.usage.cost?.total || 0;
  result.usage.contextTokens = message.usage.totalTokens || 0;
  result.model ??= message.model;
  result.stopReason = message.stopReason;
  result.errorMessage = message.errorMessage;
}

// Temporary adapter for the blocking tool path; supervisor wiring replaces this
// consumer in the following slice. Session disposal still goes through the handle.
export interface StageRunOptions {
  agent: AgentConfig;
  task: string;
  cwd: string;
  model?: string;
  thinking?: string;
  sessionPath?: string;
  ownerSessionManager?: unknown;
  signal?: AbortSignal;
  step?: number;
  agentId?: string;
  onSessionHeader?: (header: { id: string; cwd: string; sessionPath?: string }) => void;
  onEvent?: (event: unknown) => void;
}

export type StageSessionRunner = (options: StageRunOptions) => Promise<StageRunResult>;

function asCoordinatorSessionManager(value: unknown): CoordinatorSessionManager {
  const candidate = value as Partial<CoordinatorSessionManager> | undefined;
  if (candidate?.getEntries && candidate.appendCustomEntry) {
    return {
      getSessionId: () => candidate.getSessionId?.() ?? "legacy-owner",
      getSessionFile: () => candidate.getSessionFile?.(),
      getEntries: () => candidate.getEntries!(),
      appendCustomEntry: (customType, data) => candidate.appendCustomEntry!(customType, data),
    };
  }
  const entries: unknown[] = [];
  return {
    getSessionId: () => "legacy-owner",
    getSessionFile: () => undefined,
    getEntries: () => entries,
    appendCustomEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data });
      return `legacy-${entries.length}`;
    },
  };
}

function createLegacyStageSessionRunner(launcher: StageSessionLauncher): StageSessionRunner {
  return async (options) => {
    const manager = asCoordinatorSessionManager(options.ownerSessionManager);
    const coordinator = new SubagentCoordinator(manager);
    const agentId = options.agentId ?? `${options.agent.name}_0`;
    const alias = options.sessionPath
      ? readAgentAliases(manager.getEntries()).find((entry) => entry.id === agentId && entry.sessionPath === options.sessionPath)
      : undefined;
    const reservation: ReservedDispatch = {
      launchId: randomUUID(),
      ownerSessionId: manager.getSessionId(),
      toolCallId: `legacy-${randomUUID()}`,
      agent: options.agent.name,
      agentId,
      continuation: options.sessionPath !== undefined,
      ...(alias ? { childSessionId: alias.sessionId, sessionPath: alias.sessionPath } : {}),
    };
    let handle: StageLaunchHandle | undefined;
    try {
      handle = await launcher({
        reservation,
        agent: options.agent,
        task: options.task,
        cwd: options.cwd,
        model: options.model,
        thinking: options.thinking,
        coordinator,
        signal: options.signal,
      });
      options.onSessionHeader?.({ id: handle.childSessionId, cwd: options.cwd, sessionPath: handle.sessionPath });
      const unsubscribe = options.onEvent ? handle.subscribe(options.onEvent) : undefined;
      void handle.materialized.catch(() => {});
      const result = await handle.completion;
      result.step = options.step;
      unsubscribe?.();
      await handle.dispose();
      return result;
    } catch (error) {
      if (handle) {
        try {
          await handle.abort();
          await handle.dispose();
        } catch {
          // Preserve the operation failure that triggered cleanup.
        }
      }
      const metadata = error instanceof StageLaunchSetupError ? error : undefined;
      let failure = error;
      if (metadata) {
        try {
          options.onSessionHeader?.({
            id: metadata.childSessionId,
            cwd: options.cwd,
            sessionPath: metadata.sessionPath,
          });
        } catch (headerError) {
          failure = headerError;
        }
      }
      const message = describeError(failure);
      return {
        agent: options.agent.name,
        agentSource: options.agent.source,
        task: options.task,
        exitCode: 1,
        messages: [],
        stderr: message,
        usage: emptyUsage(),
        model: options.model,
        errorMessage: message,
        step: options.step,
        ...(metadata ? { sessionId: metadata.childSessionId } : {}),
        sessionPath: metadata?.sessionPath ?? options.sessionPath,
        agentId,
      };
    }
  };
}

export function createStageSessionRunner(deps: StageSessionDependencies): StageSessionRunner {
  return createLegacyStageSessionRunner(createStageSessionLauncher(deps));
}

export async function runStageSession(options: StageRunOptions): Promise<StageRunResult> {
  return createLegacyStageSessionRunner(launchStageSession)(options);
}
