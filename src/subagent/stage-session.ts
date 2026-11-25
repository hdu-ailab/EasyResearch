import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  JsonAgentSessionEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentRuntimeBinding,
  type AgentRuntimeBinding,
  type AgentRuntimeModelRuntime,
} from "../runtime/agent-runtime-binding";
import { runCleanupSteps } from "../runtime/cleanup";
import { toJsonSessionEvent } from "../runtime/json-session-event";
import { ConfigurationUnavailableError, type LiveConfiguration } from "../runtime/live-configuration";
import { excludedLocalShellTools } from "../runtime/platform-tools";
import { guardExtensionReload } from "../runtime/extensions-guard";
import { installAgentToolPolicy, type ObservableToolRuntime } from "../runtime/agent-tool-policy";
import { observeToolDiagnostics, type NativeExtensionDiagnostics } from "../runtime/tool-diagnostics";
import { createProviderTimeoutExtension } from "../extensions/provider-timeout";
import { createFileWriteRecoveryExtension } from "../extensions/file-write-recovery";
import { createLlmRetryPolicyBinding } from "../runtime/llm-retry-policy";
import { createLlmRetryPolicyExtension } from "../extensions/llm-retry-policy";
import { disposeLlmRecoveryRuntime, LlmRecoveryController, LlmRetryError } from "../runtime/llm-recovery";
import { createLlmRecoveryExtension } from "../extensions/llm-recovery";
import {
  createCompactionPolicyBinding,
  type CompactionPolicySettingsManager,
} from "../runtime/compaction-policy";
import { resolvePiDefaultModel, type PiDefaultModelApi } from "../runtime/pi-default-model";
import { publishPersistedUsageEntry } from "../runtime/persisted-usage-event";
import { applySkillSnapshotBaseDirs } from "../runtime/resource-fingerprint";
import { assertModelRequestReady, ModelRequestError } from "../runtime/model-request-error";
import { configureBatchedSteering, type RuntimeSteeringSession } from "../runtime/steering-mode";
import type { AgentSessionNetworkRouter } from "../runtime/network-routing";
import { createConfiguredModelRuntime } from "../web/auth-runtime";
import type { AgentConfig, RegisteredAgentTool } from "./agents";
import { createCompactionCancellationExtension, prioritizeCompactionCancellation } from "./compaction-cancellation";
import {
  AgentConfigurationChangedError,
  availableSubagentsForCaller,
  throwIfAuthorizationAborted,
  withCurrentAgentCatalog,
} from "./dispatch-authorization";
import type { ReservedDispatch, SubagentCoordinator } from "./coordinator";
import type { SubagentProgressEvent } from "./contracts";
import { createSessionMaterializationBarrier, type SessionMaterializationBarrier } from "./materialization";
import { sessionNameFor } from "./session-links";
import { createSubagentNotificationExtension, type SubagentSupervisor, type SupervisableAgentSession } from "./supervisor";
import { CHILD_SELECTION, createStageBackgroundController, type StageBackgroundController } from "./stage-background";
import type { BackgroundPeriodResult } from "./background-periods";
import { isThinkingLevel } from "../thinking-levels";
import { resolveSystemPrompt } from "../runtime/system-prompt";

const SAFE_STAGE_AUTHORIZATION_ERROR =
  "The selected Agent is not available to this caller in the current valid configuration.";

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
  inputID?: string;
  inputFingerprint?: string;
  backgroundLifecycle?: {
    started(): void;
    settled(result: BackgroundPeriodResult): void;
    activity?(): void;
  };
  resume?: boolean;
  restoreIdle?: boolean;
  reservation: ReservedDispatch;
  agent: AgentConfig;
  callerAgent: string;
  task: string;
  cwd: string;
  model?: string;
  thinking?: string;
  coordinator: SubagentCoordinator;
  liveConfiguration: Omit<Pick<
    LiveConfiguration,
    | "generation"
    | "availabilityEpoch"
    | "synchronize"
    | "acquireProject"
    | "isCurrent"
    | "resolveAgents"
    | "subscribe"
  >, "availabilityEpoch" | "synchronize"> & {
    readonly availabilityEpoch?: number;
    synchronize(options?: { projectCwds?: readonly string[] }): Promise<unknown>;
  } & Partial<Pick<LiveConfiguration, "compactionPolicy" | "updateRuntimeTools">>;
  signal?: AbortSignal;
}

export interface StageLaunchHandle {
  readonly background?: StageBackgroundController;
  readonly agentId: string;
  readonly childSessionId: string;
  readonly sessionPath: string;
  readonly materialized: Promise<void>;
  readonly completion: Promise<StageRunResult>;
  subscribe(listener: (event: SubagentProgressEvent) => void): () => void;
  abort(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

export type StageSessionLauncher = (options: StageLaunchOptions) => Promise<StageLaunchHandle>;

export interface StageAgentSession extends RuntimeSteeringSession {
  agent: RuntimeSteeringSession["agent"] & { state: { model: Model<any> | undefined } };
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly thinkingLevel: ThinkingLevel;
  readonly model: Model<any> | undefined;
  readonly isStreaming: boolean;
  readonly isIdle: boolean;
  readonly isCompacting: boolean;
  readonly retryAttempt: number;
  readonly extensionRunner: {
    emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  };
  readonly sessionManager: {
    getEntries(): readonly unknown[]; getBranch(): readonly unknown[];
    appendMessage?(message: AgentMessage): string;
    appendCustomEntry?(customType: string, data?: unknown): string;
  };
  subscribe(listener: (event: unknown) => void): () => void;
  bindExtensions(bindings: unknown): Promise<void>;
  setSessionName(name: string): void;
  getAllTools(): RegisteredAgentTool[];
  setActiveToolsByName(names: string[]): void;
  reload(): Promise<void>;
  setModel(model: Model<any>): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  waitForIdle(): Promise<void>;
  navigateTree(targetId: string, options?: Record<string, unknown>): Promise<{ cancelled: boolean }>;
  prompt(message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void>;
  sendCustomMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { deliverAs: "steer"; triggerTurn: boolean },
  ): Promise<void>;
  abort(): Promise<void>;
  abortCompaction(): void;
  abortBranchSummary(): void;
  dispose(): void;
}

interface StageResourceLoader {
  getExtensions?(): NativeExtensionDiagnostics & { runtime?: ObservableToolRuntime };
  reload(options?: { resolveProjectTrust?: () => Promise<boolean> }): Promise<void>;
}

interface OpenedStageSessionManager {
  getSessionId(): string;
  getCwd(): string;
  getSessionFile(): string | undefined;
}

export interface StageExtensionRuntime {
  owner(): { sessionID: string; cwd: string };
  binding: AgentRuntimeBinding;
  networkRouter?: AgentSessionNetworkRouter;
  liveConfiguration: Omit<Pick<
    LiveConfiguration,
    | "generation"
    | "availabilityEpoch"
    | "synchronize"
    | "acquireProject"
    | "isCurrent"
    | "resolveAgents"
    | "subscribe"
  >, "availabilityEpoch" | "synchronize"> & {
    readonly availabilityEpoch?: number;
    synchronize(options?: { projectCwds?: readonly string[] }): Promise<unknown>;
  } & Partial<Pick<LiveConfiguration, "compactionPolicy" | "updateRuntimeTools">>;
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
  publishTimelineEntry: (entry: unknown) => void;
}

export interface StageSessionDependencies {
  agentDir: string;
  networkRouter?: AgentSessionNetworkRouter;
  beforeLaunch?(options: StageLaunchOptions): void | Promise<void>;
  createSessionManager(cwd: string): unknown;
  openSessionManager(path: string): OpenedStageSessionManager;
  createSettingsManager(cwd: string, agentDir: string): unknown;
  createModelRuntime(agentDir: string): Promise<AgentRuntimeModelRuntime>;
  createResourceLoader(options: {
    cwd: string;
    agentDir: string;
    settingsManager: unknown;
    extensionFactories: unknown[];
    extensionsOverride: typeof prioritizeCompactionCancellation;
    noSkills: boolean;
    additionalSkillPaths: string[];
    skillsOverride: typeof applySkillSnapshotBaseDirs;
    systemPromptOverride(base: string | undefined): string;
    appendSystemPromptOverride(base: string[]): string[];
  }): StageResourceLoader;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: StageAgentSession }>;
  createDirectChildSupervisor(
    coordinator: SubagentCoordinator,
    launchStage: StageSessionLauncher,
  ): SubagentSupervisor;
  createExtensionFactories(runtime: StageExtensionRuntime): unknown[];
  resolveAutomaticModel(options: {
    cwd: string;
    agentDir: string;
    modelRuntime: AgentRuntimeModelRuntime;
    settingsManager: unknown;
  }): Promise<Model<any> | undefined>;
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

function stageSetupAggregate(originalError: unknown, cleanupError: unknown): AggregateError {
  const failures: unknown[] = [];
  const append = (error: unknown): void => {
    if (error instanceof AggregateError) {
      for (const nested of error.errors) append(nested);
      return;
    }
    if (!failures.some((failure) => Object.is(failure, error))) failures.push(error);
  };
  append(originalError);
  append(cleanupError);
  return new AggregateError(failures, "Stage AgentSession setup cleanup failed.");
}

export class RetryableStageSessionCreationError extends AggregateError {
  constructor(
    originalError: unknown,
    readonly retryCleanup: () => Promise<void>,
    cleanupError: unknown,
  ) {
    const aggregate = stageSetupAggregate(originalError, cleanupError);
    super(aggregate.errors, aggregate.message, { cause: cleanupError });
    this.name = "RetryableStageSessionCreationError";
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
  const launchStage: StageSessionLauncher = async (options) => {
    await deps.beforeLaunch?.(options);
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
    let binding: AgentRuntimeBinding | undefined;
    const recovery = new LlmRecoveryController();
    let retryPolicy: ReturnType<typeof createLlmRetryPolicyBinding> | undefined;
    let releaseRecovery: (() => void) | undefined;
    let unsubscribeRecovery: (() => void) | undefined;
    let recoveryDisposed = false;
    const disposeRecovery = () => {
      if (recoveryDisposed) return;
      disposeLlmRecoveryRuntime(recovery, retryPolicy, releaseRecovery);
      unsubscribeRecovery?.();
      recoveryDisposed = true;
    };
    let abortRequested = false;
    let session: StageAgentSession | undefined;
    let supervisor: SubagentSupervisor | undefined;
    let barrier: SessionMaterializationBarrier | undefined;
    let unsubscribe: (() => void) | undefined;
    let signalListener: (() => void) | undefined;
    let pendingAbortOperation: Promise<void> | undefined;
    let setupBarrierDisposed = false;
    let setupSignalListenerRemoved = false;
    let setupAbortSettled = false;
    let setupSessionUnsubscribed = false;
    let setupSupervisorDisposed = false;
    let setupSessionDisposed = false;
    let sessionShutdownComplete = false;
    let setupBindingDisposed = false;
    let background: StageBackgroundController | undefined;
    const pendingTimelineEntries: unknown[] = [];
    let publishTimelineEntry: (entry: unknown) => void = (entry) => {
      pendingTimelineEntries.push(entry);
    };

    const retrySetupCleanup = async (): Promise<void> => {
      recovery.cancel();
      await runCleanupSteps([
        () => {
          if (setupBarrierDisposed) return;
          barrier?.dispose();
          setupBarrierDisposed = true;
        },
        () => {
          if (setupSignalListenerRemoved) return;
          if (signalListener) options.signal?.removeEventListener("abort", signalListener);
          signalListener = undefined;
          setupSignalListenerRemoved = true;
        },
        async () => {
          if (setupAbortSettled) return;
          try {
            await pendingAbortOperation;
          } finally {
            setupAbortSettled = true;
          }
        },
        () => {
          if (setupSessionUnsubscribed) return;
          unsubscribe?.();
          unsubscribe = undefined;
          setupSessionUnsubscribed = true;
        },
        async () => {
          if (setupSupervisorDisposed) return;
          if (supervisor) await supervisor.dispose();
          setupSupervisorDisposed = true;
        },
        async () => {
          if (setupSessionDisposed) return;
          await binding?.close();
          if (session) {
            if (!sessionShutdownComplete) {
              await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
              sessionShutdownComplete = true;
            }
            session.dispose();
          }
          setupSessionDisposed = true;
        },
        () => {
          if (!setupSessionDisposed) return;
          disposeRecovery();
        },
        async () => {
          if (setupBindingDisposed || !setupSessionDisposed) return;
          if (binding) await binding.dispose();
          setupBindingDisposed = true;
        },
      ], "Stage AgentSession setup cleanup failed.");
    };

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
      if (options.resume || options.restoreIdle) {
        const repairs = options.coordinator.getShellService()?.recoveredCalls?.();
        if (repairs?.length) {
          const { repairRecoveredShellCalls } = await import("../background/shell-repair");
          repairRecoveredShellCalls(sessionManager as Parameters<typeof repairRecoveredShellCalls>[0], repairs);
        }
      }

      const settingsManager = deps.createSettingsManager(options.cwd, deps.agentDir);
      retryPolicy = createLlmRetryPolicyBinding(settingsManager as SettingsManager);
      const automaticCompaction = createCompactionPolicyBinding(
        settingsManager as CompactionPolicySettingsManager,
      );
      let childSelection: { agentName: string; model?: string; thinking?: ThinkingLevel } | undefined;
      if (options.reservation.description !== undefined) {
        childSelection = { agentName: options.agent.name, model: options.model,
          ...(isThinkingLevel(options.thinking) ? { thinking: options.thinking } : {}) };
        if (options.reservation.continuation && !options.resume) {
          const manager = sessionManager as {
            getEntries(): any[];
            buildSessionContext(): { model: { provider: string; modelId: string } | null; thinkingLevel: string };
            appendCustomEntry(type: string, data: unknown): string;
          };
          const saved = manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === CHILD_SELECTION
            && typeof entry.data?.selection?.agentName === "string").at(-1)?.data.selection;
          const previous = [...options.coordinator.journal().jobs.values()].filter((job) => job.launchId !== options.reservation.launchId
            && job.childSessionId === options.reservation.childSessionId && job.background).at(-1);
          const context = manager.buildSessionContext();
          const previousAgent = saved?.agentName ?? previous?.agent ?? options.agent.name;
          const agentName = options.restoreIdle ? previousAgent : options.agent.name;
          const savedModel = typeof saved?.model === "string" ? saved.model : undefined;
          const nativeModel = context.model ? `${context.model.provider}/${context.model.modelId}` : undefined;
          const inheritedModel = savedModel ?? nativeModel ?? previous?.background?.model;
          const thinking = options.restoreIdle ? saved?.thinking ?? context.thinkingLevel ?? options.thinking
            : options.thinking ?? saved?.thinking ?? context.thinkingLevel;
          childSelection = { agentName,
            // Recovery passes historical period defaults, not a new dispatch override.
            model: options.restoreIdle ? savedModel ?? nativeModel ?? options.model ?? previous?.background?.model
              : options.model ?? (agentName !== previousAgent ? options.agent.model : undefined) ?? inheritedModel,
            ...(isThinkingLevel(thinking) ? { thinking } : {}),
          };
          manager.appendCustomEntry(CHILD_SELECTION, { selection: childSelection, pending: false });
        }
      }
      binding = createAgentRuntimeBinding({
        ...(childSelection ? { childSelection } : {}),
        live: options.liveConfiguration,
        agentName: options.agent.name,
        cwd: options.cwd,
        createModelRuntime: async () => {
          const runtime = await deps.createModelRuntime(deps.agentDir);
          return deps.networkRouter?.decorateModelRuntime(runtime) ?? runtime;
        },
        resolveAutomaticModel: (modelRuntime) => deps.resolveAutomaticModel({
          cwd: options.cwd,
          agentDir: deps.agentDir,
          modelRuntime,
          settingsManager,
        }),
        compaction: automaticCompaction,
        onRuntimeCoherent: () => {
          supervisor?.runtimeBecameCoherent();
          if (session && background?.isStarted()) void options.coordinator.getShellService()?.flushNotifications?.(session.sessionId).catch(() => {});
        },
      });
      await binding.ensureCurrent();
      const currentAgent = binding.current();
      if (!currentAgent.enabled) {
        throw new Error("The selected Agent is not enabled in the current valid configuration.");
      }
      result.agentSource = currentAgent.source;
      const modelRuntime = binding.modelRuntime();
      supervisor = deps.createDirectChildSupervisor(options.coordinator, launchStage);
      const resourceLoader = guardExtensionReload(deps.createResourceLoader({
        cwd: options.cwd,
        agentDir: deps.agentDir,
        settingsManager,
        extensionFactories: [
          { name: "provider-timeout", factory: createProviderTimeoutExtension(settingsManager as SettingsManager, () => binding!.providerTimeoutSettings()) },
          { name: "file-write-recovery", factory: createFileWriteRecoveryExtension() },
          { name: "llm-retry-policy", factory: createLlmRetryPolicyExtension(retryPolicy) },
          createCompactionCancellationExtension(() => abortRequested, () => session!.abortCompaction()),
          ...(options.reservation.description === undefined ? [] : [{ name: "background-period", factory: (api: import("@earendil-works/pi-coding-agent").ExtensionAPI) => {
            api.on("before_agent_start", async () => { background?.begin(); await background?.drainPending(); });
            api.on("context", (event) => ({ messages: event.messages.filter((message) =>
              !(message.role === "custom" && message.customType === "easyresearch:subagent_wake" && message.content === "")) }));
          } }]),
          ...deps.createExtensionFactories({
            owner: () => ({ sessionID: session!.sessionId, cwd: options.cwd }),
            binding,
            networkRouter: deps.networkRouter,
            liveConfiguration: options.liveConfiguration,
            coordinator: options.coordinator,
            supervisor,
            publishTimelineEntry: (entry) => publishTimelineEntry(entry),
          }),
          { name: "llm-recovery", factory: createLlmRecoveryExtension(recovery) },
          createSubagentNotificationExtension(supervisor),
        ],
        extensionsOverride: prioritizeCompactionCancellation,
        noSkills: true,
        additionalSkillPaths: [],
        skillsOverride: applySkillSnapshotBaseDirs,
        systemPromptOverride: resolveSystemPrompt,
        appendSystemPromptOverride: (base) => binding!.appendSystemPrompt(base),
      }), { cwd: options.cwd, agentDir: deps.agentDir });
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
      const model = binding.model();
      if (options.reservation.description !== undefined && !options.resume && !options.restoreIdle) {
        assertModelRequestReady(binding.modelRuntime(), model);
        throwIfAuthorizationAborted(options.signal);
        const manager = sessionManager as { appendMessage(message: AgentMessage): string; appendSessionInfo(name: string): string };
        // The admitted input materializes JSONL before asynchronous Agent setup.
        // Its native classifier must already be buffered, including on setup failure.
        if (!options.reservation.continuation) manager.appendSessionInfo(sessionNameFor(currentAgent.name));
        manager.appendMessage({ role: "user", content: [{ type: "text", text: options.reservation.continuation
          ? options.task : `You are a subagent spawned by another session.\n${options.task}` }], timestamp: Date.now() });
      }
      const created = await deps.createAgentSession({
        cwd: options.cwd,
        agentDir: deps.agentDir,
        sessionManager,
        settingsManager,
        modelRuntime,
        resourceLoader,
        ...(model ? { model } : {}),
        thinkingLevel: binding.thinking(),
        excludeTools: excludedLocalShellTools(process.platform),
      });
      session = created.session;
      retryPolicy.attach(session as Parameters<typeof retryPolicy.attach>[0]);
      result.model = model ? `${model.provider}/${model.id}` : result.model;
      configureBatchedSteering(session);
      const sessionPath = session.sessionFile;
      if (!sessionPath) throw new Error("Stage AgentSession did not provide a persistent session path.");
      if (options.reservation.continuation) {
        if (session.sessionId !== options.reservation.childSessionId || sessionPath !== options.reservation.sessionPath) {
          throw new Error("Continued AgentSession identity does not match its reservation.");
        }
      } else {
        barrier = createSessionMaterializationBarrier({ sessionPath, continuation: options.reservation.description !== undefined });
        void barrier.materialized.catch(() => {});
      }

      result.sessionId = session.sessionId;
      result.sessionPath = sessionPath;
      const listeners = new Set<(event: SubagentProgressEvent) => void>();
      const pendingOwnerEvents: SubagentProgressEvent[] = [];
      let ownerSubscribed = false;
      let abortReapplied = false;
      let abortReason: string | undefined;
      let initialSessionAbortComplete = false;
      let compactionAbortComplete = false;
      let branchSummaryAbortComplete = false;
      let descendantAbortComplete = false;
      let reappliedSessionAbortRequired = false;
      let reappliedSessionAbortComplete = false;
      let abortOperation: Promise<void> | undefined;
      let completion!: Promise<StageRunResult>;
      let disposePromise: Promise<void> | undefined;
      let completionAwaited = false;
      let supervisorDisposed = false;
      let signalListenerRemoved = false;
      let sessionUnsubscribed = false;
      let barrierDisposed = false;
      let eventBuffersCleared = false;
      let sessionDisposed = false;
      let bindingDisposed = false;

      const attemptAbort = () => {
        if (abortOperation) return abortOperation;
        let tracked!: Promise<void>;
        const cancellations = [
          () => {
            if (!abortRequested || compactionAbortComplete) return;
            session!.abortCompaction();
            compactionAbortComplete = true;
          },
          () => {
            if (!abortRequested || branchSummaryAbortComplete) return;
            session!.abortBranchSummary();
            branchSummaryAbortComplete = true;
          },
          async () => {
            if (!abortRequested || initialSessionAbortComplete) return;
            await session!.abort();
            initialSessionAbortComplete = true;
          },
          async () => {
            if (!abortRequested || descendantAbortComplete) return;
            await supervisor!.abortAll(abortReason ?? "Stage AgentSession aborted.");
            descendantAbortComplete = true;
          },
        ];
        tracked = Promise.allSettled(cancellations.map(async (cancel) => cancel())).then((results) =>
          runCleanupSteps([
            ...results.map((result) => () => {
              if (result.status === "rejected") throw result.reason;
            }),
            async () => {
              if (!reappliedSessionAbortRequired || reappliedSessionAbortComplete) return;
              await runCleanupSteps([
                () => session!.abortCompaction(),
                () => session!.abortBranchSummary(),
                () => session!.abort(),
              ], "Stage reapplied abort failed.");
              reappliedSessionAbortComplete = true;
            },
          ], "Stage abort cleanup failed."),
        ).then(
          () => {
            if (abortOperation === tracked) abortOperation = undefined;
          },
          (error) => {
            if (abortOperation === tracked) abortOperation = undefined;
            throw error;
          },
        );
        abortOperation = tracked;
        pendingAbortOperation = tracked;
        void tracked.catch(() => {});
        return tracked;
      };
      const requestAbort = (reason?: string) => {
        recovery.cancel();
        if (!abortRequested) {
          abortRequested = true;
          abortReason = reason;
          result.wasAborted = true;
          result.exitCode = 1;
        }
        return attemptAbort();
      };
      const deliver = (listener: (event: SubagentProgressEvent) => void, event: SubagentProgressEvent) => {
        try {
          listener(event);
        } catch {
          // Progress observers never control Pi persistence or stage ownership.
        }
      };
      const publishOwnerEvent = (event: SubagentProgressEvent) => {
        if (event.type !== "llm_retry_state" && event.type !== "timeline_entry_appended" && event.type !== "subagent_supervisor") barrier!.observe(event);
        collectMessageEvent(result, event);
        if (!ownerSubscribed) pendingOwnerEvents.push(event);
        else for (const listener of listeners) deliver(listener, event);
      };
      publishTimelineEntry = (entry) => {
        publishOwnerEvent({ type: "entry_appended", entry } as JsonAgentSessionEvent);
      };
      for (const entry of pendingTimelineEntries.splice(0)) publishTimelineEntry(entry);

      unsubscribe = session.subscribe((rawEvent) => {
        const agentEvent = rawEvent as AgentSessionEvent;
        const event = toJsonSessionEvent(agentEvent);
        if (!event) return;
        if (abortRequested && !abortReapplied && event.type === "agent_start") {
          abortReapplied = true;
          reappliedSessionAbortRequired = true;
          void attemptAbort().catch(() => {});
        }
        publishOwnerEvent(event);
        publishPersistedUsageEntry(agentEvent, session!.sessionManager, (persistedEvent) => {
          publishOwnerEvent(persistedEvent as JsonAgentSessionEvent);
        });
      });
      recovery.attach(session as Parameters<typeof recovery.attach>[0], retryPolicy, async (signal) => {
        const release = await supervisor!.acquirePromptAdmission();
        try {
          const authorizationSignal = options.reservation.description === undefined && options.signal ? AbortSignal.any([options.signal, signal]) : signal;
          const generation = await authorizeOperation((currentGeneration) => currentGeneration, authorizationSignal);
          return {
            release,
            validate() {
              throwIfAuthorizationAborted(authorizationSignal);
              if (abortRequested) throw new LlmRetryError("LLM_RETRY_UNAVAILABLE");
              if (binding!.generation() !== generation || !options.liveConfiguration.isCurrent(generation)) {
                throw new LlmRetryError("LLM_RETRY_BUSY");
              }
            },
          };
        } catch (error) {
          release();
          if (error instanceof ModelRequestError || error instanceof ConfigurationUnavailableError || error instanceof LlmRetryError) throw error;
          throw new LlmRetryError(error instanceof AgentConfigurationChangedError ? "LLM_RETRY_BUSY" : "LLM_RETRY_UNAVAILABLE");
        }
      });
      releaseRecovery = options.coordinator.registerRecovery({
        sessionId: session.sessionId,
        sessionPath,
        ownerSessionId: options.reservation.ownerSessionId,
        launchId: options.reservation.launchId,
        recovery,
      });
      unsubscribeRecovery = recovery.subscribe(() => publishOwnerEvent(recovery.state()));
      supervisor.attach(session as unknown as SupervisableAgentSession, async () => {
        if (background) { await background.prepareWake(); background.begin(); return; }
        if (!session!.isIdle) await session!.waitForIdle();
        await binding!.ensureCurrent();
      }, () => abortRequested, () => recovery.holdsAutomaticWake()
        || (options.reservation.description !== undefined && !background?.isStarted()));
      await session.bindExtensions({
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session!.waitForIdle(),
          navigateTree: async (targetId: string, navigationOptions?: Record<string, unknown>) => {
            try {
              const navigated = await session!.navigateTree(targetId, navigationOptions);
              return { cancelled: navigated.cancelled };
            } finally { retryPolicy!.finishSummary(); }
          },
          reload: async () => {
            await session!.reload();
            configureBatchedSteering(session!);
            await binding!.ensureCurrent({
              activeBoundary: true,
              recaptureCompactionBase: true,
            });
          },
        },
      });
      await binding.attach({
        get isIdle() {
          return session!.isIdle;
        },
        get model() {
          return session!.model;
        },
        get thinkingLevel() {
          return session!.thinkingLevel;
        },
        reload: () => session!.reload(),
        toolSnapshot: () => ({
          tools: session!.getAllTools(),
          errors: observeToolDiagnostics(resourceLoader.getExtensions?.()),
        }),
        installToolPolicy: (agent, changed) => installAgentToolPolicy({
          resourceLoader, getAllTools: () => session!.getAllTools(),
        }, agent, changed),
        async abort() {
          recovery.blockCurrentRun();
          // Pi signals abort synchronously, then waits for this event drain to
          // reach agent_settled; do not deadlock the active-boundary handler.
          const operation = session!.abort();
          void operation.catch(() => {});
        },
        rebindModel: (selectedModel) => {
          session!.agent.state.model = selectedModel as Model<any>;
        },
        setThinkingLevel: (level) => session!.setThinkingLevel(level),
      });
      // Home and root lifecycle admission use this existing internal classifier.
      // Human task descriptions live in the coordinator's task/report metadata.
      if (!options.reservation.continuation && options.reservation.description === undefined) session.setSessionName(sessionNameFor(currentAgent.name));

      signalListener = () => {
        const signalReason = options.signal?.reason;
        void requestAbort(typeof signalReason === "string" ? signalReason : undefined);
      };
      if (options.signal?.aborted) signalListener();
      else if (options.reservation.description === undefined) options.signal?.addEventListener("abort", signalListener, { once: true });

      const authorizeOperation = async <T>(start: (generation: number) => T, signal = options.signal): Promise<T> => {
        let bindingMismatchRetries = 0;
        for (;;) {
          await binding!.ensureCurrent();
          let bindingMismatch = false;
          const authorized = await withCurrentAgentCatalog(
            options.liveConfiguration,
            options.cwd,
            ({ generation, agents }) => {
              const authorizedTarget = availableSubagentsForCaller(agents, options.callerAgent)
                .find((candidate) => candidate.name === (options.reservation.description === undefined ? options.agent.name : binding!.current().name));
              if (!authorizedTarget) throw new Error(SAFE_STAGE_AUTHORIZATION_ERROR);
              if (binding!.generation() !== generation) {
                bindingMismatch = true;
                return undefined;
              }
              const boundAgent = binding!.current();
              if (!boundAgent.enabled || boundAgent.name !== authorizedTarget.name) {
                throw new Error(SAFE_STAGE_AUTHORIZATION_ERROR);
              }
              throwIfAuthorizationAborted(signal);
              if (
                binding!.generation() !== generation
                || options.liveConfiguration.generation !== generation
              ) {
                bindingMismatch = true;
                return undefined;
              }
              result.agentSource = boundAgent.source;
              const currentModel = binding!.model();
              if (currentModel) result.model = `${currentModel.provider}/${currentModel.id}`;
              assertModelRequestReady(binding!.modelRuntime(), currentModel);
              throwIfAuthorizationAborted(signal);
              return { value: start(generation) };
            },
            { signal, maxGenerationRetries: 1 },
          );
          if (!bindingMismatch && authorized) return authorized.value;
          throwIfAuthorizationAborted(signal);
          if (bindingMismatchRetries >= 1) throw new AgentConfigurationChangedError();
          bindingMismatchRetries += 1;
        }
      };

      if (options.reservation.description !== undefined) {
        if (!options.restoreIdle) await authorizeOperation(() => undefined);
        background = createStageBackgroundController({ session, binding, supervisor, coordinator: options.coordinator,
          options, initialResult: result, disposeRecovery, recovery,
          shell: () => ({ path: (settingsManager as SettingsManager).getShellPath(), commandPrefix: (settingsManager as SettingsManager).getShellCommandPrefix() }),
          onResult: (period) => options.backgroundLifecycle?.settled(period) });
      }
      const releaseAdmission = background ? () => {} : await supervisor.acquirePromptAdmission();
      let prompt: Promise<void>;
      try {
        if (background) prompt = background.firstPeriod;
        else ({ prompt } = await authorizeOperation(() => ({
          prompt: session!.prompt(`Task: ${options.task}`, { preflightResult: releaseAdmission }),
        })));
      } catch (error) {
        releaseAdmission();
        throw error;
      }

      const finish = async (error?: unknown): Promise<StageRunResult> => {
        releaseAdmission();
        barrier!.settlePrompt(error);
        const activeAbort = abortOperation;
        if (activeAbort) await activeAbort.catch(() => {});
        let completionFailure: unknown;
        try {
          await runCleanupSteps([
            () => {
              if (error !== undefined) throw error;
            },
            async () => {
              if (background) return;
              let quiescence: Promise<void> | undefined;
              for (;;) {
                await recovery.waitForResolution();
                if (!quiescence) {
                  const waiting = supervisor!.waitForQuiescence();
                  quiescence = waiting.finally(() => { quiescence = undefined; });
                }
                await recovery.untilRecovery(quiescence);
                if (recovery.hasWork()) continue;
                await session!.waitForIdle();
                // A hidden completion wake can exhaust while the original run's
                // finish is waiting; recheck both owners after every idle boundary.
                if (!recovery.hasWork() && supervisor!.isQuiescent()) break;
              }
            },
          ], "Stage completion failed.");
        } catch (finishError) {
          completionFailure = finishError;
        }
        result.sessionPath = session!.sessionFile;
        if (completionFailure !== undefined) {
          result.exitCode = 1;
          result.errorMessage = describeError(completionFailure);
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
      completion = prompt.then(
        () => finish(),
        (error) => finish(error),
      );

      if (!barrier) throw new Error("Stage materialization barrier was not created.");
      const handle: StageLaunchHandle = {
        agentId: options.reservation.agentId,
        childSessionId: session.sessionId,
        sessionPath,
        materialized: barrier.materialized,
        completion,
        ...(background ? { background } : {}),
        subscribe(listener) {
          listeners.add(listener);
          if (!ownerSubscribed) {
            ownerSubscribed = true;
            for (const event of pendingOwnerEvents.splice(0)) deliver(listener, event);
          }
          return () => listeners.delete(listener);
        },
        abort(reason) {
          if (background) return background.cancel(reason);
          return requestAbort(reason);
        },
        dispose() {
          if (disposePromise) return disposePromise;
          const ownedAbort = abortRequested ? (abortOperation ?? attemptAbort()) : Promise.resolve();
          let tracked!: Promise<void>;
          tracked = runCleanupSteps([
            () => background?.dispose(),
            async () => {
              if (completionAwaited) return;
              await completion;
              completionAwaited = true;
            },
            () => ownedAbort,
            async () => {
              if (supervisorDisposed) return;
              await supervisor!.dispose();
              supervisorDisposed = true;
            },
            () => {
              if (signalListenerRemoved) return;
              if (signalListener) options.signal?.removeEventListener("abort", signalListener);
              signalListener = undefined;
              signalListenerRemoved = true;
            },
            () => {
              if (sessionUnsubscribed) return;
              unsubscribe?.();
              unsubscribe = undefined;
              sessionUnsubscribed = true;
            },
            () => {
              if (barrierDisposed) return;
              barrier!.dispose();
              barrierDisposed = true;
            },
            () => {
              if (eventBuffersCleared) return;
              listeners.clear();
              pendingOwnerEvents.length = 0;
              eventBuffersCleared = true;
            },
            async () => {
              if (sessionDisposed) return;
              await binding!.close();
              if (!sessionShutdownComplete) {
                await session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
                sessionShutdownComplete = true;
              }
              session!.dispose();
              sessionDisposed = true;
            },
            () => {
              if (!sessionDisposed) return;
              disposeRecovery();
            },
            async () => {
              if (bindingDisposed || !sessionDisposed) return;
              await binding!.dispose();
              bindingDisposed = true;
            },
          ], "Stage AgentSession cleanup failed.").then(undefined, (error) => {
            if (disposePromise === tracked) disposePromise = undefined;
            throw error;
          });
          disposePromise = tracked;
          return disposePromise;
        },
      };
      return handle;
    } catch (error) {
      try {
        await retrySetupCleanup();
      } catch (cleanupError) {
        throw new RetryableStageSessionCreationError(error, retrySetupCleanup, cleanupError);
      }
      throw error;
    }
  };
  return launchStage;
}

export async function launchStageSession(options: StageLaunchOptions): Promise<StageLaunchHandle> {
  return (await createDefaultStageSessionLauncher())(options);
}

export async function createDefaultStageSessionLauncher(
  networkRouter?: AgentSessionNetworkRouter,
): Promise<StageSessionLauncher> {
  const { join } = await import("node:path");
  const { importPi, getAgentDir } = await import("../runtime/pi-import");
  const pi = await importPi();
  const { assertSafeExtensionSources } = await import("../runtime/extensions-guard");
  const { createSearchExtensions } = await import("../extensions");
  const { createAgentDefinitionExtension } = await import("../extensions/agent-definition");
  const { createSubagentExtension } = await import("../extensions/subagent");
  const { createSshBashExtension } = await import("../extensions/ssh-bash");
  const { createSessionTimelineExtension } = await import("../extensions/session-timeline");
  const { createManagedShellExtension } = await import("../extensions/managed-shell");
  const { createModelsExtension } = await import("../extensions/models");
  const { SubagentSupervisor } = await import("./supervisor");
  const agentDir = getAgentDir();
  return createStageSessionLauncher({
    agentDir,
    networkRouter,
    beforeLaunch: ({ cwd }) => assertSafeExtensionSources({ cwd }),
    createSessionManager: (cwd) => pi.SessionManager.create(cwd),
    openSessionManager: (path) => pi.SessionManager.open(path),
    createSettingsManager: (cwd, root) => pi.SettingsManager.create(cwd, root),
    createModelRuntime: async (root) => {
      const modelsPath = join(root, "models.json");
      return createConfiguredModelRuntime(
        (candidatePath) => pi.ModelRuntime.create({
          authPath: join(root, "auth.json"),
          modelsPath: candidatePath,
          refreshOnCreate: false,
        }),
        modelsPath,
        (runtime) => networkRouter?.decorateModelRuntime(runtime) ?? runtime,
      );
    },
    createResourceLoader: (options) =>
      new pi.DefaultResourceLoader(options as ConstructorParameters<typeof pi.DefaultResourceLoader>[0]),
    createAgentSession: async (options) => {
      const created = await pi.createAgentSession(options as Parameters<typeof pi.createAgentSession>[0]);
      return { session: created.session as unknown as StageAgentSession };
    },
    createDirectChildSupervisor: (coordinator, launchStage) => new SubagentSupervisor({
      coordinator,
      launchStage,
    }),
    createExtensionFactories: ({
      binding,
      networkRouter: runtimeNetworkRouter,
      liveConfiguration,
      coordinator,
      supervisor,
      publishTimelineEntry,
      owner,
    }) => [
      { name: "models", factory: createModelsExtension({ modelRuntime: () => binding.modelRuntime(), model: () => binding.model() }) },
      ...(coordinator.getShellService()?.execute ? [{ name: "managed-shell", factory: createManagedShellExtension({
        manager: coordinator.getShellService() as import("../background/shell").ManagedShellService, owner,
      }) }] : []),
      { name: "ssh-bash", factory: (api: import("@earendil-works/pi-coding-agent").ExtensionAPI) => {
        if (binding.current().name === "experiment") return createSshBashExtension({
          allowConfigure: false,
          manager: coordinator.getShellService() as import("../background/shell").ManagedShellService | undefined,
          owner,
        })(api);
      } },
      {
        name: "agent-definition",
        factory: createAgentDefinitionExtension(binding),
      },
      {
        name: "subagent",
        factory: createSubagentExtension({
          binding,
          liveConfiguration,
          coordinator,
          supervisor,
        }),
      },
      { name: "session-timeline", factory: createSessionTimelineExtension(publishTimelineEntry) },
      ...createSearchExtensions(runtimeNetworkRouter),
    ],
    resolveAutomaticModel: async ({ cwd, modelRuntime, settingsManager }) => {
      return resolvePiDefaultModel({
        pi: pi as unknown as PiDefaultModelApi,
        cwd,
        agentDir,
        modelRuntime,
        settingsManager: settingsManager as object,
      });
    },
  });
}

function collectMessageEvent(result: StageRunResult, event: SubagentProgressEvent): void {
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
