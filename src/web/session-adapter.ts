import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { BackgroundTask } from "../background/contracts";
import { ExecutionClaims, RESTART_NOTICE, RESTART_NOTICE_TYPE } from "../background/execution-claims";
import { installExecutionClaimBoundary, type ExecutionClaimBoundary } from "../background/execution-boundary";
import { BackgroundOwnerJournal } from "../background/root-recovery";
import { BACKGROUND_WAKE_TYPE, createBackgroundWakeExtension } from "../background/wake";
import { preserveBackgroundInputsWithoutWake, type BackgroundInboxJournal } from "../background/inbox";
import type { ManagedShellService, ShellNotification } from "../background/shell";
import { repairRecoveredShellCalls } from "../background/shell-repair";
import { RootBackgroundDelivery } from "./background-delivery";
import { RootSuspensionQueue } from "./root-suspension";
import { createLogger } from "../runtime/logger";
import type {
  AgentSessionEvent,
  SettingsManager,
  SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import { runCleanupSteps } from "../runtime/cleanup";
import { toJsonSessionEvent } from "../runtime/json-session-event";
import { excludedLocalShellTools } from "../runtime/platform-tools";
import { configureBatchedSteering, type RuntimeSteeringSession } from "../runtime/steering-mode";
import {
  createAgentRuntimeBinding,
  type AgentRuntimeBinding,
  type AgentRuntimeBindingSession,
  type AgentRuntimeModelRuntime,
} from "../runtime/agent-runtime-binding";
import { createProviderTimeoutExtension } from "../extensions/provider-timeout";
import { createFileWriteRecoveryExtension } from "../extensions/file-write-recovery";
import { createLlmRetryPolicyBinding } from "../runtime/llm-retry-policy";
import { createLlmRetryPolicyExtension } from "../extensions/llm-retry-policy";
import { disposeLlmRecoveryRuntime, isLlmRetryControl, LlmRecoveryController, LlmRetryError } from "../runtime/llm-recovery";
import { createLlmRecoveryExtension } from "../extensions/llm-recovery";
import {
  createCompactionPolicyBinding,
  DEFAULT_GLOBAL_COMPACTION_POLICY,
  type CompactionPolicySettingsManager,
} from "../runtime/compaction-policy";
import { resolvePiDefaultModel, type PiDefaultModelApi } from "../runtime/pi-default-model";
import { publishPersistedUsageEntry } from "../runtime/persisted-usage-event";
import { applySkillSnapshotBaseDirs } from "../runtime/resource-fingerprint";
import { assertModelRequestReady } from "../runtime/model-request-error";
import type { AgentSessionNetworkRouter } from "../runtime/network-routing";
import { createConfiguredModelRuntime } from "./auth-runtime";
import {
  ConfigurationUnavailableError,
  type LiveConfiguration,
} from "../runtime/live-configuration";
import type { CoordinatorSessionManager, SubagentCoordinator } from "../subagent/coordinator";
import { createCompactionCancellationExtension, prioritizeCompactionCancellation } from "../subagent/compaction-cancellation";
import { AGENT_STATUS_TYPE } from "../subagent/notifications";
import { createSubagentNotificationExtension, type SubagentSupervisor, type SupervisableAgentSession } from "../subagent/supervisor";
import type {
  ApiUsageRecordDto,
  CompactionPolicyDto,
  ContextUsageDto,
  TranscriptTimelineEntryDto,
  LlmRetryAcceptedDto,
  LlmRetryStateEventDto,
} from "./contracts";
import { projectSessionUsage } from "./api-usage";
import { projectSessionTimeline } from "./session-timeline";
import { SessionStatsNotifier } from "./session-stats";
import { ContextManagementError, RootContextManager, type ContextRuntime } from "./context-management";
import type { ContextEditRequestDto, ContextItemTextDto, ContextPreviewDto, ContextSnapshotDto } from "./context-contracts";
import {
  ManualCompactionController,
  type ManualCompactionAcceptedState,
  type ManualCompactionSession,
  type ManualCompactionState,
} from "./manual-compaction";

const SAFE_STOP_ABORT_ERROR = "Session stop could not abort active work. Retry stop.";
const INTERNAL_WEB_TREE_COMMAND = "web-tree";
const WEB_BUILTIN_COMMANDS: readonly WebSlashCommand[] = [
  { name: "name", description: "Rename the current session", source: "extension" },
  { name: "history", description: "Browse the current session tree", source: "extension" },
  { name: "compact", description: "Compact the current session context", source: "extension" },
  { name: "statistics", description: "Show API usage statistics", source: "extension" },
  { name: "context", description: "Inspect and edit the current model context", source: "extension" },
  { name: "settings", description: "Open settings", source: "extension" },
];

export interface StartSessionOptions {
  cwd: string;
  sessionPath?: string;
  thinking?: string;
}

export interface WebSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  requiresPrefix?: boolean;
}

export type WebTreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

export interface TreeNavigationOptions {
  summarize?: boolean;
  customInstructions?: string;
}

export interface TreeNavigationResult {
  cancelled: boolean;
  editorText?: string;
  leafId: string | null;
}

/** Options accepted by the Web prompt path. Web sends always queue as steers
 * while the agent is streaming (ADR-083); Pi ignores the option when idle. */
export interface SteerPromptOptions {
  streamingBehavior?: "steer" | "followUp";
  /** Called with `true` as soon as the prompt is accepted (queued as steer,
   * handled as an extension command, or about to start a run); called with
   * `false` only on preflight failure, which also rejects the prompt promise
   * (pi rpc-mode prompt contract, ADR-083). */
  preflightResult?: (success: boolean) => void;
}

export interface SessionState {
  model?: Model<any>;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  messageCount: number;
}

export interface InProcessAgentSession extends RuntimeSteeringSession {
  agent: RuntimeSteeringSession["agent"] & ManualCompactionSession["agent"] & {
    state: { model: Model<any> | undefined };
  };
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  readonly sessionName: string | undefined;
  readonly isStreaming: boolean;
  readonly isIdle: boolean;
  readonly isCompacting: boolean;
  readonly retryAttempt: number;
  readonly thinkingLevel: ThinkingLevel;
  readonly model: Model<any> | undefined;
  readonly messages: AgentMessage[];
  readonly promptTemplates: ReadonlyArray<{ name: string; description?: string }>;
  readonly modelRuntime: {
    getModel(provider: string, modelId: string): Model<any> | undefined;
    getAvailableSnapshot(): readonly { provider: string; id: string }[];
    getProvider(providerId: string): unknown;
    getProviderAuthStatus(providerId: string): { configured: boolean };
  };
  readonly resourceLoader: {
    getSkills(): {
      skills: ReadonlyArray<{ name: string; description?: string }>;
      diagnostics: readonly unknown[];
    };
  };
  readonly extensionRunner: {
    getRegisteredCommands(): ReadonlyArray<{ invocationName: string; description?: string }>;
    emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  };
  readonly settingsManager: {
    getTreeFilterMode(): string;
    getBranchSummarySkipPrompt(): boolean;
  };
  readonly sessionManager: {
    getTree(): SessionTreeNode[];
    getLeafId(): string | null;
    getEntries(): unknown[];
    getBranch(): unknown[];
  };
  getSessionStats(): { contextUsage?: ContextUsageDto };
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(message: string, options?: SteerPromptOptions): Promise<void>;
  sendCustomMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { deliverAs: "steer"; triggerTurn: boolean },
  ): Promise<void>;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<unknown>;
  abortCompaction(): void;
  abortBranchSummary(): void;
  setModel(model: Model<any>): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  setSessionName(name: string): void;
  navigateTree(
    entryId: string,
    options?: Record<string, unknown>,
  ): Promise<{ cancelled: boolean; editorText?: string }>;
  /** Read-only pending steer messages (ADR-083). */
  getSteeringMessages(): readonly string[];
  /** Drop undelivered queued messages (Pi's `clearQueue`), emitting a final
   * `queue_update` (ADR-083). */
  clearQueue(): { steering: string[]; followUp: string[] };
  dispose(): void;
}

export interface BindableAgentSession extends InProcessAgentSession {
  bindExtensions(bindings: unknown): Promise<void>;
  waitForIdle(): Promise<void>;
  reload(): Promise<void>;
}

class RetryableAgentSessionCreationError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly retryCleanup: () => Promise<void>,
    cleanupError: unknown,
  ) {
    super(
      originalError instanceof Error ? originalError.message : "AgentSession creation failed",
      { cause: cleanupError },
    );
    this.name = "RetryableAgentSessionCreationError";
  }
}

export interface ManagedAgentSession {
  session: BindableAgentSession;
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
  binding: AgentRuntimeBinding;
  compaction: ManualCompactionController;
  stats: SessionStatsNotifier;
  recovery?: LlmRecoveryController;
  retryPolicy?: ReturnType<typeof createLlmRetryPolicyBinding>;
  disposeRecovery?: () => void;
  cancelSessionTitle?: () => void;
  executionClaims?: ExecutionClaims;
  executionBoundary?: ExecutionClaimBoundary;
  resumeInterrupted?: boolean;
  prepareBackgroundHandoff?: () => Promise<void>;
  backgroundOwner?: BackgroundOwnerJournal;
  shellManager?: ManagedShellService;
  inboxJournal?: BackgroundInboxJournal;
  recoverBackground?: () => Promise<void>;
  finishBackgroundRecovery?: () => void;
  cancelSuspendedExecution?: () => Promise<void>;
  shellSettings?: () => { path?: string; commandPrefix?: string };
}

export type AgentSessionCreator = (
  options: StartSessionOptions,
  onApplied?: (generation: number) => void,
  publishTimelineEntry?: (entry: unknown) => void,
  onRuntimeCoherent?: () => void,
) => Promise<ManagedAgentSession>;

function createRuntimeSetupCleanup(
  session: Pick<InProcessAgentSession, "dispose" | "extensionRunner"> | undefined,
  compaction: Pick<ManualCompactionController, "dispose"> | undefined,
  supervisor: Pick<SubagentSupervisor, "dispose"> | undefined,
  binding: Pick<AgentRuntimeBinding, "close" | "dispose">,
  coordinatorUnsubscribe?: () => void,
  activityUnsubscribe?: () => void,
  compactionUnsubscribe?: () => void,
  sessionUnsubscribe?: () => void,
  disposeRecovery?: () => void,
): () => Promise<void> {
  let compactionDisposed = compaction === undefined;
  let supervisorDisposed = supervisor === undefined;
  let coordinatorUnsubscribed = coordinatorUnsubscribe === undefined;
  let activityUnsubscribed = activityUnsubscribe === undefined;
  let compactionUnsubscribed = compactionUnsubscribe === undefined;
  let sessionUnsubscribed = sessionUnsubscribe === undefined;
  let sessionDisposed = session === undefined;
  let sessionShutdownComplete = session === undefined;
  let bindingDisposed = false;
  let recoveryDisposed = disposeRecovery === undefined;
  return async () => {
    await runCleanupSteps([
      async () => {
        if (compactionDisposed) return;
        await compaction!.dispose();
        compactionDisposed = true;
      },
      async () => {
        if (supervisorDisposed) return;
        await supervisor!.dispose();
        supervisorDisposed = true;
      },
      () => {
        if (coordinatorUnsubscribed) return;
        coordinatorUnsubscribe!();
        coordinatorUnsubscribed = true;
      },
      () => {
        if (activityUnsubscribed) return;
        activityUnsubscribe!();
        activityUnsubscribed = true;
      },
      () => {
        if (compactionUnsubscribed) return;
        compactionUnsubscribe!();
        compactionUnsubscribed = true;
      },
      () => {
        if (sessionUnsubscribed) return;
        sessionUnsubscribe!();
        sessionUnsubscribed = true;
      },
      async () => {
        if (sessionDisposed) return;
        await binding.close();
        if (!sessionShutdownComplete) {
          await session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          sessionShutdownComplete = true;
        }
        session!.dispose();
        sessionDisposed = true;
      },
      () => {
        if (!sessionDisposed) return;
        if (!recoveryDisposed) {
          disposeRecovery!();
          recoveryDisposed = true;
        }
      },
      async () => {
        if (!sessionDisposed || bindingDisposed) return;
        await binding.dispose();
        bindingDisposed = true;
      },
    ], "Research Assistant runtime setup cleanup failed.");
  };
}

function combineSetupErrors(originalError: unknown, cleanupError: unknown): AggregateError {
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
  return new AggregateError(
    failures,
    `${originalError instanceof Error ? originalError.message : "AgentSession creation failed"}; runtime cleanup failed.`,
  );
}

function createBindingSession(session: BindableAgentSession, recovery?: LlmRecoveryController): AgentRuntimeBindingSession {
  return {
    get isIdle() {
      return session.isIdle;
    },
    get model() {
      return session.model;
    },
    get thinkingLevel() {
      return session.thinkingLevel;
    },
    async reload() {
      await session.reload();
      configureBatchedSteering(session);
    },
    async abort() {
      recovery?.blockCurrentRun();
      // Pi signals abort synchronously, but its promise waits for agent_settled,
      // which cannot occur until the current turn_end handler returns.
      const operation = session.abort();
      void operation.catch(() => {});
    },
    rebindModel: (model) => {
      session.agent.state.model = model;
    },
    setThinkingLevel: (level) => session.setThinkingLevel(level),
  };
}

interface ResourceLoaderLike {
  reload(options?: { resolveProjectTrust?: () => Promise<boolean> }): Promise<void>;
}

export interface PiRuntimeDependencies {
  /** Only the managed server holding the exclusive daemon lease grants this. */
  allowPreparedShellHandoff?: boolean;
  agentDir: string;
  liveConfiguration: LiveConfiguration;
  networkRouter?: AgentSessionNetworkRouter;
  createSessionManager(cwd: string): CoordinatorSessionManager;
  openSessionManager(path: string): CoordinatorSessionManager;
  createCoordinator(sessionManager: CoordinatorSessionManager): SubagentCoordinator;
  createShellManager?(input: { sessionID: string; cwd: string }): ManagedShellService;
  recoverSubagentTree(options: { coordinator: SubagentCoordinator; expectedCwd: string }): Promise<void>;
  createDirectChildSupervisor(coordinator: SubagentCoordinator): SubagentSupervisor;
  createExtensionFactories(runtime: {
    coordinator: SubagentCoordinator;
    supervisor: SubagentSupervisor;
    binding: AgentRuntimeBinding;
    networkRouter?: AgentSessionNetworkRouter;
    compaction: ManualCompactionController;
    stats: SessionStatsNotifier;
    publishTimelineEntry: (entry: unknown) => void;
    sessionTitleSignal?: AbortSignal;
    shellManager?: ManagedShellService;
    shellOwner?: () => { sessionID: string; cwd: string };
  }): unknown[];
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
    appendSystemPromptOverride(base: string[]): string[];
  }): ResourceLoaderLike;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: BindableAgentSession }>;
  resolveAutomaticModel(options: {
    cwd: string;
    agentDir: string;
    modelRuntime: AgentRuntimeModelRuntime;
    settingsManager: unknown;
  }): Promise<Model<any> | undefined>;
}

export function createPiAgentSessionCreator(deps: PiRuntimeDependencies): AgentSessionCreator {
  return async (options, onApplied, publishTimelineEntry = () => {}, onRuntimeCoherent) => {
    const sessionManager = options.sessionPath
      ? deps.openSessionManager(options.sessionPath)
      : deps.createSessionManager(options.cwd);
    const coordinator = deps.createCoordinator(sessionManager);
    const shellManager = deps.createShellManager?.({ sessionID: sessionManager.getSessionId(), cwd: options.cwd });
    if (shellManager) coordinator.setShellService(shellManager);
    const executionClaims = new ExecutionClaims(sessionManager);
    // Charge the root before any recovered child can wake it.
    const resumeInterrupted = !!options.sessionPath && executionClaims.prepareResume();
    const settingsManager = deps.createSettingsManager(options.cwd, deps.agentDir);
    const automaticCompaction = createCompactionPolicyBinding(
      settingsManager as CompactionPolicySettingsManager,
    );
    const compaction = new ManualCompactionController();
    const stats = new SessionStatsNotifier();
    const sessionTitleCancellation = new AbortController();
    const binding = createAgentRuntimeBinding({
      live: deps.liveConfiguration,
      agentName: "research-assistant",
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
      onCompactionPolicyChanged: stats.notify,
      onRuntimeCoherent: () => {
        supervisor?.runtimeBecameCoherent();
        onRuntimeCoherent?.();
      },
      onApplied,
    });
    const retryPolicy = createLlmRetryPolicyBinding(settingsManager as SettingsManager);
    const recovery = new LlmRecoveryController();
    let executionBoundary: ExecutionClaimBoundary | undefined;
    let releaseRecovery: (() => void) | undefined;
    const disposeRecovery = () => {
      disposeLlmRecoveryRuntime(recovery, retryPolicy, releaseRecovery);
      executionBoundary?.dispose();
      releaseRecovery = undefined;
    };
    let supervisor: SubagentSupervisor | undefined;
    let session: BindableAgentSession | undefined;
    let backgroundRecoveryPending = !!options.sessionPath;
    try {
      await binding.ensureCurrent();
      await deps.recoverSubagentTree({ coordinator, expectedCwd: options.cwd });
      supervisor = deps.createDirectChildSupervisor(coordinator);
      const modelRuntime = binding.modelRuntime();
      const extensionFactories = deps.createExtensionFactories({
        coordinator,
        supervisor,
        binding,
        networkRouter: deps.networkRouter,
        compaction,
        stats,
        publishTimelineEntry,
        sessionTitleSignal: sessionTitleCancellation.signal,
        shellManager,
        shellOwner: () => ({ sessionID: session!.sessionId, cwd: options.cwd }),
      });
      const resourceLoader = deps.createResourceLoader({
        cwd: options.cwd,
        agentDir: deps.agentDir,
        settingsManager,
        extensionFactories: [
          { name: "background-wake", factory: createBackgroundWakeExtension() },
          createCompactionCancellationExtension(() => compaction.isCancelling(), () => session!.abortCompaction()),
          { name: "provider-timeout", factory: createProviderTimeoutExtension(settingsManager as SettingsManager, () => binding.providerTimeoutSettings()) },
          { name: "file-write-recovery", factory: createFileWriteRecoveryExtension() },
          { name: "llm-retry-policy", factory: createLlmRetryPolicyExtension(retryPolicy) },
          ...extensionFactories,
          { name: "llm-recovery", factory: createLlmRecoveryExtension(recovery) },
          createSubagentNotificationExtension(supervisor),
        ],
        extensionsOverride: prioritizeCompactionCancellation,
        noSkills: true,
        additionalSkillPaths: [],
        skillsOverride: applySkillSnapshotBaseDirs,
        appendSystemPromptOverride: (base) => binding.appendSystemPrompt(base),
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
      const model = binding.model();
      const createOptions: Record<string, unknown> = {
        cwd: options.cwd,
        agentDir: deps.agentDir,
        sessionManager,
        settingsManager,
        modelRuntime,
        resourceLoader,
        ...(model ? { model } : {}),
        thinkingLevel: binding.thinking(),
        excludeTools: excludedLocalShellTools(process.platform),
      };
      ({ session } = await deps.createAgentSession(createOptions));
      executionBoundary = installExecutionClaimBoundary(session as unknown as Parameters<typeof installExecutionClaimBoundary>[0], executionClaims);
      retryPolicy.attach(session as Parameters<typeof retryPolicy.attach>[0]);
      recovery.attach(session, retryPolicy, async (signal) => {
        const release = await supervisor!.acquirePromptAdmission();
        try {
          await binding.ensureCurrent();
          if (signal.aborted) throw new LlmRetryError("LLM_RETRY_UNAVAILABLE");
          assertModelRequestReady(session!.modelRuntime, session!.model);
          return { release };
        } catch (error) {
          release();
          throw error;
        }
      }, () => compaction.hasWork());
      releaseRecovery = coordinator.registerRecovery({
        sessionId: session.sessionId,
        sessionPath: session.sessionFile!,
        recovery,
      });
      compaction.attach(session);
      configureBatchedSteering(session);
      coordinator.bindResearchAssistantState({
        model: () => session?.model ? `${session.model.provider}/${session.model.id}` : undefined,
        thinking: () => session?.thinkingLevel,
      });
      supervisor.attach(session as unknown as SupervisableAgentSession, async () => {
        if (!session!.isIdle) await session!.waitForIdle();
        await binding.ensureCurrent();
      }, () => compaction.isCancelling(), () => recovery.holdsAutomaticWake()
        || executionClaims.current()?.outcome === "exhausted" || backgroundRecoveryPending);
      await session.bindExtensions({
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session!.waitForIdle(),
          navigateTree: async (targetId: string, navigationOptions?: Record<string, unknown>) => {
            try {
              const result = await session!.navigateTree(targetId, navigationOptions);
              return { cancelled: result.cancelled };
            } finally { retryPolicy.finishSummary(); }
          },
          reload: async () => {
            await session!.reload();
            configureBatchedSteering(session!);
            await binding.ensureCurrent({
              activeBoundary: true,
              recaptureCompactionBase: true,
            });
          },
        },
      });
      await binding.attach(createBindingSession(session, recovery));
      return { session, coordinator, supervisor, binding, compaction, stats, recovery, retryPolicy, disposeRecovery,
        executionClaims, executionBoundary, resumeInterrupted,
        backgroundOwner: new BackgroundOwnerJournal(sessionManager),
        inboxJournal: sessionManager,
        shellManager,
        shellSettings: () => ({
          path: (settingsManager as SettingsManager).getShellPath?.(),
          commandPrefix: (settingsManager as SettingsManager).getShellCommandPrefix?.(),
        }),
        prepareBackgroundHandoff: () => shellManager?.prepareHandoff() ?? Promise.resolve(),
        recoverBackground: async () => {
          if (!options.sessionPath) return;
          await shellManager?.recover({ allowPreparedHandoff: deps.allowPreparedShellHandoff === true, verifyPriorOwner: async (owner) => {
            if (owner.rootSessionID !== session!.sessionId) return false;
            if (owner.pid === process.pid) return true; // Registry admission excludes a second live writer in this process.
            try { process.kill(owner.pid, 0); return false; }
            catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
          } });
          if (shellManager) {
            const repaired = repairRecoveredShellCalls(sessionManager as unknown as Parameters<typeof repairRecoveredShellCalls>[0], shellManager.recoveredCalls());
            if (repaired) (session as unknown as { refreshContext(): void }).refreshContext();
          }
          await coordinator.prepareBackgroundRecovery(options.cwd, true);
          await supervisor!.recoverBackground({ cwd: options.cwd, liveConfiguration: deps.liveConfiguration, verifiedPriorOwnerDead: true });
        },
        finishBackgroundRecovery: () => { backgroundRecoveryPending = false; supervisor!.runtimeBecameCoherent(); },
        cancelSuspendedExecution: async () => {
          const path = session!.sessionFile;
          if (!path) return;
          const current = deps.openSessionManager(path);
          if (current.getSessionId() !== session!.sessionId || current.getSessionFile() !== path
            || (current as typeof current & { getCwd(): string }).getCwd() !== options.cwd) throw new Error("Suspended root identity changed.");
          await deps.createCoordinator(current).cancelSuspended();
          preserveBackgroundInputsWithoutWake(current);
          new ExecutionClaims(current).cancel();
          new BackgroundOwnerJournal(current).update(false);
        },
        cancelSessionTitle: () => sessionTitleCancellation.abort() };
    } catch (error) {
      recovery.cancel();
      const retryCleanup = createRuntimeSetupCleanup(session, compaction, supervisor, binding,
        undefined, undefined, undefined, undefined, disposeRecovery);
      try {
        await runCleanupSteps([retryCleanup, () => shellManager?.dispose()], "Agent setup cleanup failed.");
      } catch (cleanupError) {
        throw new RetryableAgentSessionCreationError(
          combineSetupErrors(error, cleanupError),
          retryCleanup,
          cleanupError,
        );
      }
      throw error;
    }
  };
}

export interface SessionAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  suspend?(): Promise<void>;
  revokeSuspension?(): Promise<void>;
  prompt(message: string, options?: SteerPromptOptions): Promise<void>;
  abort(): Promise<void>;
  retry?(targetSessionId: string, failureId: string): Promise<LlmRetryAcceptedDto>;
  getRetryState?(targetSessionId: string, launchId?: string): LlmRetryStateEventDto | undefined;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  getState(): Promise<SessionState>;
  getTranscriptSnapshot(): Promise<{
    timeline: TranscriptTimelineEntryDto[];
    inlineUsage: ApiUsageRecordDto[];
  }>;
  getCommands(): Promise<WebSlashCommand[]>;
  getTree(): Promise<{
    tree: SessionTreeNode[];
    leafId: string | null;
    filterMode: WebTreeFilterMode;
    skipBranchSummaryPrompt: boolean;
  }>;
  navigateTree(entryId: string, options?: TreeNavigationOptions): Promise<TreeNavigationResult>;
  compact(customInstructions?: string): Promise<{ state: ManualCompactionAcceptedState }>;
  getCompactionState(): ManualCompactionState;
  getCompactionPolicy(): CompactionPolicyDto;
  getContextUsage(): ContextUsageDto | undefined;
  getContext?(): Promise<ContextSnapshotDto>;
  getContextItem?(revision: string, itemId: string, view: "original" | "current", offset: number): Promise<ContextItemTextDto>;
  previewContext?(request: ContextEditRequestDto): Promise<ContextPreviewDto>;
  applyContext?(request: ContextEditRequestDto): Promise<ContextSnapshotDto>;
  getRuntimeConfigurationGeneration(): number;
  getSteeringMessages(): readonly string[];
  isSupervisorActive(): boolean;
  hasBackgroundWork(): boolean;
  getBackgroundTasks?(): BackgroundTask[];
  promoteBackground?(): Promise<void>;
  cancelBackground?(taskId: string): Promise<void>;
  onEvent(listener: (event: unknown) => void): () => void;
}

export interface SessionFactory {
  create(options: StartSessionOptions): SessionAdapter;
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export class PiSessionFactory implements SessionFactory {
  constructor(
    private readonly createAgentSession: AgentSessionCreator,
    private readonly estimateTokens?: (message: AgentMessage) => number,
  ) {}

  static async resolve(
    liveConfiguration?: LiveConfiguration,
    networkRouter?: AgentSessionNetworkRouter,
    allowPreparedShellHandoff = false,
  ): Promise<PiSessionFactory> {
    if (!liveConfiguration) {
      return new PiSessionFactory(async () => {
        throw new ConfigurationUnavailableError();
      });
    }
    const { join } = await import("node:path");
    const { importPi, getAgentDir } = await import("../runtime/pi-import");
    const { bootstrapBundledResources } = await import("../bootstrap/resources");
    await bootstrapBundledResources();
    const pi = await importPi();
    const { createResearchAssistantExtensions } = await import("../extensions");
    const { SubagentCoordinator } = await import("../subagent/coordinator");
    const { recoverSubagentTree } = await import("../subagent/recovery");
    const { SubagentSupervisor } = await import("../subagent/supervisor");
    const { createDefaultStageSessionLauncher } = await import("../subagent/stage-session");
    const { createSubagentRecoverySessionStore } = await import("./subagent-sessions");
    const { createManagedShellManager } = await import("../background/shell");
    const agentDir = getAgentDir();
    const shellLogger = createLogger("background-shell");
    const launchStage = await createDefaultStageSessionLauncher(networkRouter);
    const creator = createPiAgentSessionCreator({
      agentDir,
      liveConfiguration,
      networkRouter,
      allowPreparedShellHandoff,
      createSessionManager: (cwd) => pi.SessionManager.create(cwd),
      openSessionManager: (path) => pi.SessionManager.open(path),
      createCoordinator: (sessionManager) => new SubagentCoordinator(sessionManager),
      createShellManager: ({ sessionID, cwd }) => createManagedShellManager({ agentDir, rootSessionID: sessionID, cwd,
        // Exception messages may contain command output or third-party secrets.
        onError: () => shellLogger.error("Managed shell persistence or notification delivery failed."),
      }),
      recoverSubagentTree: async ({ coordinator, expectedCwd }) => {
        await recoverSubagentTree({
          coordinator,
          expectedCwd,
          store: createSubagentRecoverySessionStore({
            rootSession: coordinator.getRootSessionManager() as ReturnType<typeof pi.SessionManager.open>,
            open: (path) => pi.SessionManager.open(path),
          }),
        });
      },
      createDirectChildSupervisor: (coordinator) => new SubagentSupervisor({
        coordinator,
        launchStage,
      }),
      createExtensionFactories: (runtime) =>
        createResearchAssistantExtensions({ ...runtime, liveConfiguration,
          sessionTitleEnabled: () => liveConfiguration.sessionTitleSettings.autoSessionTitle })
          .map(({ name, factory }) => ({ name, factory })),
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
        const result = await pi.createAgentSession(options as Parameters<typeof pi.createAgentSession>[0]);
        return { session: result.session as unknown as BindableAgentSession };
      },
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
    return new PiSessionFactory(creator, pi.estimateTokens);
  }

  create(options: StartSessionOptions): SessionAdapter {
    return new DirectSessionAdapter(this.createAgentSession, options, this.estimateTokens);
  }
}

class DirectSessionAdapter implements SessionAdapter {
  private managed: ManagedAgentSession | undefined;
  private session: InProcessAgentSession | undefined;
  private binding: AgentRuntimeBinding | undefined;
  private lastCompactionPolicy: CompactionPolicyDto = {
    triggerPercent: DEFAULT_GLOBAL_COMPACTION_POLICY.triggerPercent,
    enabled: DEFAULT_GLOBAL_COMPACTION_POLICY.globalEnabled,
  };
  private startCleanup: (() => Promise<void>) | undefined;
  private unsubscribe: (() => void) | undefined;
  private coordinatorUnsubscribe: (() => void) | undefined;
  private activityUnsubscribe: (() => void) | undefined;
  private compactionUnsubscribe: (() => void) | undefined;
  private startPending = false;
  private runCancellationPending = false;
  private resumeSteeringAfterInterrupt = false;
  private treeCleanupPending = false;
  private stopPending = false;
  private runCancellationPromise: Promise<void> | undefined;
  private treeCleanupPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopRequested = false;
  private suspending = false;
  private suspendedRuntime?: ManagedAgentSession;
  private stopped = false;
  private coordinatorClosingComplete = false;
  private queueClearComplete = false;
  private sessionAbortComplete = false;
  private supervisorAbortComplete = false;
  private notificationFlushComplete = false;
  private supervisorDisposeComplete = false;
  private compactionDisposeComplete = false;
  private coordinatorUnsubscribeComplete = false;
  private activityUnsubscribeComplete = false;
  private compactionUnsubscribeComplete = false;
  private unsubscribeComplete = false;
  private sessionDisposeComplete = false;
  private sessionShutdownComplete = false;
  private bindingDisposeComplete = false;
  private recoveryDisposeComplete = false;
  private readonly promptOperations = new Set<Promise<void>>();
  private treeNavigationOperation: Promise<unknown> | undefined;
  private contextManager: RootContextManager | undefined;
  private contextOperation: Promise<ContextSnapshotDto> | undefined;
  private contextAdmissionHeld = false;
  private contextCommitting = false;
  private readonly stopAbortOperations = new Set<Promise<void>>();
  private readonly stopAbortErrors: unknown[] = [];
  private readonly stopAbortProgressWaiters = new Set<() => void>();
  private stopAbortSequence = 0;
  private stopAbortSuccessSequence = 0;
  private stopAbortFailureSequence = 0;
  private runtimeConfigurationGeneration = 0;
  private backgroundTasksSignature = "[]";
  private backgroundDelivery?: RootBackgroundDelivery;
  private shellUnsubscribe?: () => void;
  private releaseShellOwner?: () => void;
  private recoveringBackground = false;
  private backgroundRetryOperation?: Promise<void>;
  private readonly suspensionQueue = new RootSuspensionQueue();
  private suspensionQueueComplete = false;
  private handoffAttempted = false;
  private handoffPrepared = false;
  private readonly listeners = new Set<(event: unknown) => void>();

  constructor(
    private readonly createAgentSession: AgentSessionCreator,
    private readonly options: StartSessionOptions,
    private readonly estimateTokens?: (message: AgentMessage) => number,
  ) {}

  async start(): Promise<void> {
    if (this.session) throw new Error("Session already started");
    if (this.stopRequested) throw new Error("Session already stopped");
    if (this.startCleanup) {
      await this.startCleanup();
      this.startCleanup = undefined;
    }
    this.startPending = true;
    try {
      let created: ManagedAgentSession;
      try {
        created = await this.createAgentSession(
          this.options,
          (generation) => this.applyRuntimeConfigurationGeneration(generation),
          (entry) => this.publishEvent({ type: "entry_appended", entry }),
          () => this.retryBackgroundDelivery(),
        );
      } catch (error) {
        if (error instanceof RetryableAgentSessionCreationError) {
          this.startCleanup = error.retryCleanup;
          throw error.originalError;
        }
        throw error;
      }
      this.managed = created;
      this.session = created.session;
      this.binding = created.binding;
      this.lastCompactionPolicy = created.binding.compactionPolicy();
      let coordinatorUnsubscribe: (() => void) | undefined;
      let activityUnsubscribe: (() => void) | undefined;
      let compactionUnsubscribe: (() => void) | undefined;
      let sessionUnsubscribe: (() => void) | undefined;
      try {
        created.supervisor.attach(created.session as unknown as SupervisableAgentSession, undefined,
          () => this.runCancellationPending || this.stopRequested || created.compaction.isCancelling());
        coordinatorUnsubscribe = created.coordinator.subscribe((event) => {
          this.publishEvent(event);
          if (!event.event || event.event.type === "agent_settled") this.publishBackgroundTasks();
        });
        activityUnsubscribe = created.supervisor.subscribeActivity((active) => {
          this.publishEvent({ type: "session_activity_changed", active });
          this.publishBackgroundTasks();
        });
        sessionUnsubscribe = created.session.subscribe((event) => {
          const agentEvent = event as AgentSessionEvent;
          if (agentEvent.type === "compaction_start") created.compaction.observeNativeCompaction("start");
          if (agentEvent.type === "compaction_end") created.compaction.observeNativeCompaction("end");
          if (agentEvent.type === "agent_start" && (this.runCancellationPending || this.stopRequested)) {
            this.requestStopAbort(created.session);
          }
          if (agentEvent.type === "queue_update" && this.runCancellationPending && agentEvent.steering.length > 0) {
            this.resumeSteeringAfterInterrupt = true;
          }
          if (agentEvent.type === "message_end" && agentEvent.message.role === "custom") {
            const details = agentEvent.message.details as { inputID?: unknown } | undefined;
            if (typeof details?.inputID === "string") this.backgroundDelivery?.observe(details.inputID);
          }
          publishPersistedUsageEntry(agentEvent, created.session.sessionManager, (persistedEvent) => {
            if (isHiddenStatusEntry(persistedEvent.entry)) {
              const completion = projectSessionTimeline([persistedEvent.entry])[0];
              if (completion) this.publishEvent({ type: "timeline_entry_appended", entry: completion });
            } else {
              this.publishEvent(persistedEvent);
            }
          });
          if (isHiddenStatusEvent(agentEvent)) return;
          const jsonEvent = toJsonSessionEvent(agentEvent);
          if (!jsonEvent) return;
          const publicEvent = jsonEvent.type === "agent_end"
            ? { ...jsonEvent, messages: jsonEvent.messages.filter((message) => !isHiddenStatusMessage(message)) }
            : jsonEvent.type === "queue_update"
              ? { ...jsonEvent, steering: jsonEvent.steering.filter((message) => !isHiddenStatusContent(message)) }
              : jsonEvent;
          this.publishEvent(publicEvent);
          if (agentEvent.type === "agent_settled" && created.executionBoundary?.failure()) {
            this.publishEvent({ type: "error", error: "Execution history could not be persisted. Reopen the session to retry." });
          }
        });
        const unsubscribeCompactionState = created.compaction.subscribe((state) => {
          this.publishEvent({ type: "compaction_state_changed", state });
        });
        const unsubscribeStats = created.stats.subscribe(() => {
          const contextUsage = this.readContextUsage(created.session);
          this.lastCompactionPolicy = created.binding.compactionPolicy();
          const event = {
            type: "session_stats_changed",
            ...(contextUsage !== undefined ? { contextUsage } : {}),
            compactionPolicy: { ...this.lastCompactionPolicy },
          };
          this.publishEvent(event);
        });
        const unsubscribeRecovery = created.recovery?.subscribe(() => {
          this.publishEvent(created.recovery!.state());
          this.publishEvent({ type: "session_activity_changed", active: this.isSupervisorActive() });
          if (!created.recovery!.holdsAutomaticWake()) this.retryBackgroundDelivery();
        });
        compactionUnsubscribe = () => {
          try {
            unsubscribeCompactionState();
          } finally {
            unsubscribeStats();
            unsubscribeRecovery?.();
          }
        };
      } catch (error) {
        const retryCleanup = createRuntimeSetupCleanup(
          created.session,
          created.compaction,
          created.supervisor,
          created.binding,
          coordinatorUnsubscribe,
          activityUnsubscribe,
          compactionUnsubscribe,
          sessionUnsubscribe,
          created.disposeRecovery,
        );
        this.managed = undefined;
        this.session = undefined;
        this.binding = undefined;
        try {
          await retryCleanup();
        } catch (cleanupError) {
          this.startCleanup = retryCleanup;
          throw combineSetupErrors(error, cleanupError);
        }
        throw error;
      }
      this.coordinatorUnsubscribe = coordinatorUnsubscribe;
      this.activityUnsubscribe = activityUnsubscribe;
      this.compactionUnsubscribe = compactionUnsubscribe;
      this.unsubscribe = sessionUnsubscribe;
      if (created.inboxJournal) {
        this.backgroundDelivery = new RootBackgroundDelivery({
          journal: created.inboxJournal, session: created.session,
          acquire: () => created.supervisor.acquirePromptAdmission(),
          ready: async () => { await created.binding.ensureCurrent(); assertModelRequestReady(created.session.modelRuntime, created.session.model); },
          canWake: () => !this.recoveringBackground && !this.runCancellationPending
            && !created.recovery?.holdsAutomaticWake() && created.executionClaims?.current()?.outcome !== "exhausted",
          stopped: () => this.stopRequested,
          own: (operation) => this.ownBackgroundOperation(operation),
          changed: () => this.publishBackgroundTasks(),
          onError: (error) => this.publishEvent({ type: "error", error: error instanceof Error ? error.message : "Background notification delivery failed." }),
        });
      }
      this.recoveringBackground = true;
      try {
        await created.recoverBackground?.();
        if (created.shellManager) {
          this.releaseShellOwner = created.shellManager.attachOwner({
            sessionID: created.session.sessionId, cwd: this.options.cwd,
            shell: created.shellSettings,
            notify: (notice: ShellNotification) => this.backgroundDelivery!.admit({
              id: notice.id, content: notice.content, customType: "easyresearch:background_result", wake: notice.wake,
            }),
          });
          this.shellUnsubscribe = created.shellManager.subscribe(() => {
            this.publishBackgroundTasks();
            this.publishEvent({ type: "session_activity_changed", active: this.isSupervisorActive() });
          });
          await created.shellManager.flushNotifications(created.session.sessionId);
        }
      } finally { this.recoveringBackground = false; }
      if (created.resumeInterrupted) this.resumeInterruptedRun(created);
      created.finishBackgroundRecovery?.();
      await this.backgroundDelivery?.drain();
      this.publishBackgroundTasks();
    } finally {
      this.startPending = false;
    }
  }

  stop(): Promise<void> { return this.close(false); }

  suspend(): Promise<void> { return this.close(true); }

  async revokeSuspension(): Promise<void> {
    const runtime = this.suspendedRuntime;
    if (!runtime) return;
    await runCleanupSteps([
      () => runtime.shellManager?.revokeHandoff(),
      () => runtime.cancelSuspendedExecution?.(),
    ], "Suspended background cancellation failed.");
    this.suspendedRuntime = undefined;
  }

  private async close(suspend: boolean): Promise<void> {
    if (this.stopped) return;
    if (this.stopPromise) return this.stopPromise;
    this.suspending = suspend;
    this.stopRequested = true;
    this.managed?.cancelSessionTitle?.();
    this.managed?.recovery?.cancel();
    if (suspend) this.managed?.executionClaims?.suspend();
    const session = this.session;
    const supervisor = this.managed?.supervisor;
    const compaction = this.managed?.compaction;
    const binding = this.binding;
    if (!session && !binding && !this.startCleanup) {
      this.stopped = true;
      return;
    }
    this.stopPending = true;
    let tracked!: Promise<void>;
    tracked = runCleanupSteps([
      () => { if (!this.suspending) this.managed?.executionClaims?.cancel(); },
      async () => {
        if (this.suspending) {
          this.handoffAttempted = true;
          await this.managed?.prepareBackgroundHandoff?.();
          this.handoffPrepared = true;
        } else if (this.handoffAttempted) await this.managed?.shellManager?.revokeHandoff();
      },
      async () => { await this.contextOperation?.catch(() => {}); },
      async () => {
        const activeCancellation = this.runCancellationPromise;
        if (!activeCancellation) return;
        try {
          await activeCancellation;
        } catch {
          // Terminal teardown retries every ownership step below.
        }
      },
      () => session ? this.cleanupTree("Research Assistant session stopped.") : undefined,
      async () => {
        // A failed queue write must retain its native session and owned append
        // progress. Other cancellation steps still run, but disposal waits for retry.
        if (this.suspending && (!this.suspensionQueueComplete || !this.handoffPrepared)) return;
        await runCleanupSteps([
          () => this.backgroundDelivery?.close({ terminal: !this.suspending }),
          async () => {
            this.releaseShellOwner?.(); this.releaseShellOwner = undefined;
            await this.managed?.shellManager?.dispose({ handoff: this.suspending });
            this.shellUnsubscribe?.(); this.shellUnsubscribe = undefined;
            if (!this.suspending) this.managed?.backgroundOwner?.update(false);
          },
          async () => {
            if (!supervisor || this.supervisorDisposeComplete) return;
            await supervisor.dispose();
            this.supervisorDisposeComplete = true;
          },
          () => {
            if (this.coordinatorUnsubscribeComplete) return;
            this.coordinatorUnsubscribe?.();
            this.coordinatorUnsubscribe = undefined;
            this.coordinatorUnsubscribeComplete = true;
          },
          () => {
            if (this.activityUnsubscribeComplete) return;
            this.activityUnsubscribe?.();
            this.activityUnsubscribe = undefined;
            this.activityUnsubscribeComplete = true;
          },
          () => {
            if (this.compactionUnsubscribeComplete) return;
            this.compactionUnsubscribe?.();
            this.compactionUnsubscribe = undefined;
            this.compactionUnsubscribeComplete = true;
          },
          () => {
            if (this.unsubscribeComplete) return;
            this.unsubscribe?.();
            this.unsubscribe = undefined;
            this.unsubscribeComplete = true;
          },
          async () => {
            if (!this.startCleanup) return;
            await this.startCleanup();
            this.startCleanup = undefined;
          },
          async () => {
            if (!compaction || this.compactionDisposeComplete) return;
            await compaction.dispose();
            this.compactionDisposeComplete = true;
          },
          async () => {
            if (!session || this.sessionDisposeComplete) return;
            await binding?.close();
            if (!this.sessionShutdownComplete) {
              await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
              this.sessionShutdownComplete = true;
            }
            session.dispose();
            this.sessionDisposeComplete = true;
          },
          () => {
            if (session && !this.sessionDisposeComplete) return;
            if (!this.recoveryDisposeComplete) {
              this.managed?.disposeRecovery?.();
              this.recoveryDisposeComplete = true;
            }
          },
          async () => {
            if (this.bindingDisposeComplete) return;
            if (!binding) {
              this.bindingDisposeComplete = true;
              return;
            }
            if (session && !this.sessionDisposeComplete) return;
            await binding.dispose();
            this.bindingDisposeComplete = true;
          },
          async () => {
            // A terminal retry after partial suspension must also revoke children
            // already released from the live supervisor. This is the last writer:
            // the callback reopens the root only after its old runtime has closed.
            if (!this.suspending && this.handoffAttempted && this.sessionDisposeComplete) {
              await this.managed?.cancelSuspendedExecution?.();
            }
          },
        ], "Research Assistant disposal failed.");
      },
    ], "Research Assistant runtime cleanup failed.").then(
      () => {
        this.stopped = true;
        if (this.suspending) this.suspendedRuntime = this.managed;
        this.session = undefined;
        this.binding = undefined;
        this.managed = undefined;
      },
      (error) => {
        if (this.stopPromise === tracked) this.stopPromise = undefined;
        throw error;
      },
    ).finally(() => {
      this.stopPending = false;
    });
    this.stopPromise = tracked;
    return tracked;
  }

  async prompt(message: string, options?: SteerPromptOptions): Promise<void> {
    if (this.contextOperation) throw new ContextManagementError("CONTEXT_BUSY");
    if (/^\/(?:context|settings)(?:\s|$)/.test(message.trimStart())) throw new ContextManagementError("CONTEXT_INVALID");
    // Mirror Pi's rpc-mode prompt contract (ADR-083): fire the prompt without
    // awaiting the whole agent run and resolve as soon as it is accepted
    // (queued steer, handled extension command, or preflight success). Pi's
    // AgentSession.prompt otherwise blocks until agent_end, which would keep
    // the Web POST pending for the run's entire duration and disable the
    // composer. Preflight failures reject through the prompt promise.
    const session = this.requiredSession();
    const binding = this.requiredBinding();
    const isRunningCommand = (text: string): boolean => {
      if (!session.isStreaming || !text.startsWith("/")) return false;
      // Match Pi's command parser, not Skill aliases or general whitespace.
      const spaceIndex = text.indexOf(" ");
      const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
      return session.extensionRunner.getRegisteredCommands().some((command) => command.invocationName === name);
    };
    let accepted = false;
    let resolveAccepted!: () => void;
    let rejectAccepted!: (error: Error) => void;
    const acceptedPromise = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const operation = (async () => {
      let releaseAdmission: (() => void) | undefined;
      try {
        if (!isRunningCommand(message)) {
          releaseAdmission = await this.managed!.supervisor.acquirePromptAdmission();
        }
        await binding.ensureCurrent();
        // A run may settle or reload its commands while preparation is pending.
        if (!releaseAdmission && !isRunningCommand(message)) {
          releaseAdmission = await this.managed!.supervisor.acquirePromptAdmission();
          await binding.ensureCurrent();
        }
        if (this.stopRequested) throw new Error("Session has stopped");
        assertModelRequestReady(session.modelRuntime, session.model);
        if (/^\/web-tree(?:\s|$)/.test(message.trimStart())) {
          throw new Error("The /web-tree command is not available in chat.");
        }
        let promptMessage = message;
        const skillContext = /^@skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(message);
        if (skillContext && session.resourceLoader.getSkills().skills.some((skill) => skill.name === skillContext[1])) {
          // Context selection is a normal prompt, not an extension-command action.
          // Pi remains the only implementation of Skill content expansion.
          promptMessage = `/skill:${skillContext[1]}${skillContext[2] ? ` ${skillContext[2]}` : ""}`;
        }
        const friendlySkill = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/.exec(message);
        if (friendlySkill && !message.startsWith("/skill:")) {
          const name = friendlySkill[1]!;
          const commandOwnsName = session.extensionRunner
            .getRegisteredCommands()
            .some((command) => command.invocationName === name)
            || session.promptTemplates.some((template) => template.name === name);
          const skillExists = session.resourceLoader.getSkills().skills.some((skill) => skill.name === name);
          if (!commandOwnsName && skillExists) {
            promptMessage = `/skill:${name}${message.slice(name.length + 1)}`;
          }
        }
        // Commands may await this run's idle boundary. They cannot own the LLM
        // preflight gate that the boundary needs to drain completed handoffs.
        if (isRunningCommand(promptMessage)) releaseAdmission?.();
        const invoke = () => session.prompt(promptMessage, {
          streamingBehavior: "steer",
          ...options,
          preflightResult: (didSucceed) => {
            releaseAdmission?.();
            if (!accepted && didSucceed) {
              accepted = true;
              void this.managed?.shellManager?.promote(session.sessionId).catch((error) => this.publishEvent({ type: "error", error: String(error) }));
              this.retryBackgroundDelivery();
              resolveAccepted();
            }
          },
        });
        await (this.managed?.executionBoundary ? this.managed.executionBoundary.observe(invoke) : invoke());
        // Defensive: a prompt that settles without a preflight callback (e.g.
        // an extension command) is treated as accepted rather than leaving the
        // HTTP request pending forever.
        if (!accepted) {
          accepted = true;
          resolveAccepted();
        }
      } catch (error) {
        if (!accepted) {
          accepted = true;
          rejectAccepted(error instanceof Error ? error : new Error(String(error)));
        } else if (this.managed?.executionBoundary?.failure()) {
          this.publishEvent({ type: "error", error: "Execution history could not be persisted. Reopen the session to retry." });
        }
      } finally {
        releaseAdmission?.();
      }
    })();
    this.promptOperations.add(operation);
    void operation.finally(() => {
      this.promptOperations.delete(operation);
      this.publishEvent({ type: "session_activity_changed", active: this.isSupervisorActive() });
    });
    await acceptedPromise;
  }

  abort(): Promise<void> {
    const session = this.requiredSession();
    const managed = this.managed;
    if (!managed) return Promise.reject(new Error("Session has not started"));
    if (this.runCancellationPromise) return this.runCancellationPromise;

    this.runCancellationPending = true;
    this.resumeSteeringAfterInterrupt = session.getSteeringMessages().length > 0
      || managed.supervisor.hasPendingNotifications?.() === true || this.backgroundDelivery?.hasWakePending() === true;
    managed.cancelSessionTitle?.();
    managed.recovery?.cancel();
    let interrupted = false;
    let tracked!: Promise<void>;
    tracked = runCleanupSteps([
      () => managed.executionClaims?.cancel(),
      () => managed.compaction.cancel(),
      () => this.abortSessionAndSettlePrompts(session),
    ], "Research Assistant run cancellation failed.")
      .then(() => {
        managed.compaction.finishCancellation();
        managed.recovery?.finishCancellation();
        interrupted = true;
      })
      .finally(() => {
        if (this.runCancellationPromise === tracked) this.runCancellationPromise = undefined;
        this.runCancellationPending = false;
        this.publishEvent({ type: "session_activity_changed", active: this.isSupervisorActive() });
        const resume = this.resumeSteeringAfterInterrupt || session.getSteeringMessages().length > 0
          || managed.supervisor.hasPendingNotifications?.();
        this.resumeSteeringAfterInterrupt = false;
        if (interrupted && !this.stopRequested && resume) {
          this.resumeInterruptedRun(managed, true);
        }
        if (interrupted && !this.stopRequested) {
          this.retryBackgroundDelivery();
          managed.supervisor.runtimeBecameCoherent?.();
        }
      });
    this.runCancellationPromise = tracked;
    return tracked;
  }

  private resumeInterruptedRun(managed: ManagedAgentSession, steeringOnly = false): void {
    const operation = (async () => {
      const release = await managed.supervisor.acquirePromptAdmission();
      let run: Promise<void> | undefined;
      try {
        await managed.binding.ensureCurrent();
        if (this.stopRequested || this.runCancellationPending) return;
        assertModelRequestReady(managed.session.modelRuntime, managed.session.model);
        const invoke = () => managed.session.sendCustomMessage({
          customType: steeringOnly ? BACKGROUND_WAKE_TYPE : RESTART_NOTICE_TYPE,
          content: steeringOnly ? "" : RESTART_NOTICE,
          display: false,
          details: { periodId: managed.executionClaims?.current()?.periodId },
        }, { deliverAs: "steer", triggerTurn: true });
        run = managed.executionBoundary ? managed.executionBoundary.observe(invoke) : invoke();
      } finally { release(); }
      await run;
    })().catch((error) => {
      // Keep the claim when preflight cannot run; a later explicit prompt can recover.
      this.publishEvent({ type: "error", error: error instanceof Error ? error.message : "Unable to resume interrupted work." });
    });
    this.promptOperations.add(operation);
    void operation.finally(() => {
      this.promptOperations.delete(operation);
      this.publishEvent({ type: "session_activity_changed", active: this.isSupervisorActive() });
    });
  }

  private retryBackgroundDelivery(): void {
    const managed = this.managed;
    const delivery = this.backgroundDelivery;
    if (!managed || !delivery || this.stopRequested || this.startPending || this.recoveringBackground || this.backgroundRetryOperation) return;
    try {
      if (!managed.shellManager?.hasWork(managed.session.sessionId) && !delivery.hasPending()) return;
    } catch {
      this.publishEvent({ type: "error", error: "Background notification history is unavailable." });
      return;
    }
    // Retry only at explicit user/runtime/recovery boundaries. An outbox record may
    // still be pending before inbox admission, so draining the inbox alone is not enough.
    const operation = Promise.resolve().then(async () => {
      if (this.stopRequested) return;
      await managed.shellManager?.flushNotifications(managed.session.sessionId);
      if (!this.stopRequested) await delivery.drain();
    }).catch(() => {
      this.publishEvent({ type: "error", error: "Background notification delivery failed. Retry after the underlying error is resolved." });
    });
    this.backgroundRetryOperation = operation;
    this.ownBackgroundOperation(operation);
    void operation.finally(() => {
      if (this.backgroundRetryOperation === operation) this.backgroundRetryOperation = undefined;
    });
  }

  private ownBackgroundOperation(operation: Promise<void>): void {
    if (this.managed?.executionBoundary) operation = this.managed.executionBoundary.observe(operation).catch(() => {
      this.publishEvent({ type: "error", error: "Execution history could not be persisted. Reopen the session to retry." });
    });
    this.promptOperations.add(operation);
    void operation.finally(() => {
      this.promptOperations.delete(operation);
      this.publishEvent({ type: "session_activity_changed", active: this.isSupervisorActive() });
    }).catch(() => {});
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    if (this.contextOperation) throw new ContextManagementError("CONTEXT_BUSY");
    const session = this.requiredSession();
    const model = session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
    await session.setModel(model);
  }

  retry(targetSessionId: string, failureId: string): Promise<LlmRetryAcceptedDto> {
    if (this.contextOperation) throw new ContextManagementError("CONTEXT_BUSY");
    if (!this.session || !this.managed || this.stopRequested) throw new LlmRetryError("LLM_RETRY_UNAVAILABLE");
    if (this.runCancellationPending || this.treeNavigationOperation) throw new LlmRetryError("LLM_RETRY_BUSY");
    if (targetSessionId === this.session.sessionId && this.promptOperations.size) throw new LlmRetryError("LLM_RETRY_BUSY");
    return this.managed!.coordinator.retry(targetSessionId, failureId);
  }

  getRetryState(targetSessionId: string, launchId?: string): LlmRetryStateEventDto | undefined {
    return this.managed?.coordinator.retryState?.(targetSessionId, launchId);
  }

  async setThinkingLevel(level: string): Promise<void> {
    if (this.contextOperation) throw new ContextManagementError("CONTEXT_BUSY");
    if (!THINKING_LEVELS.has(level as ThinkingLevel)) throw new Error(`Invalid thinking level: ${level}`);
    this.requiredSession().setThinkingLevel(level as ThinkingLevel);
  }

  async compact(customInstructions?: string): Promise<{ state: ManualCompactionAcceptedState }> {
    if (this.contextOperation) throw new ContextManagementError("CONTEXT_BUSY");
    const managed = this.managed;
    if (!managed) throw new Error("Session has not started");
    return managed.compaction.request(customInstructions);
  }

  getCompactionState(): ManualCompactionState {
    return this.managed?.compaction.state() ?? "idle";
  }

  getCompactionPolicy(): CompactionPolicyDto {
    const policy = this.binding?.compactionPolicy() ?? this.lastCompactionPolicy;
    this.lastCompactionPolicy = { ...policy };
    return { ...this.lastCompactionPolicy };
  }

  getContextUsage(): ContextUsageDto | undefined {
    return this.readContextUsage(this.requiredSession());
  }

  async getContext(): Promise<ContextSnapshotDto> {
    return (await this.getContextManager()).snapshot();
  }

  async getContextItem(revision: string, itemId: string, view: "original" | "current", offset: number): Promise<ContextItemTextDto> {
    return (await this.getContextManager()).item(revision, itemId, view, offset);
  }

  async previewContext(request: ContextEditRequestDto): Promise<ContextPreviewDto> {
    return (await this.getContextManager()).preview(request);
  }

  applyContext(request: ContextEditRequestDto): Promise<ContextSnapshotDto> {
    if (this.contextOperation || this.contextBusy()) return Promise.reject(new ContextManagementError("CONTEXT_BUSY"));
    const operation = Promise.resolve().then(async () => {
      const manager = await this.getContextManager();
      if (this.contextBusy(false)) throw new ContextManagementError("CONTEXT_BUSY");
      const release = await this.managed!.supervisor.acquirePromptAdmission();
      this.contextAdmissionHeld = true;
      try {
        await this.requiredBinding().ensureCurrent();
        if (this.contextBusy(false)) throw new ContextManagementError("CONTEXT_BUSY");
        this.contextCommitting = true;
        return manager.apply(request);
      } finally {
        this.contextCommitting = false;
        this.contextAdmissionHeld = false;
        release();
      }
    }).catch((error) => {
      if (error instanceof ContextManagementError) throw error;
      throw new ContextManagementError("CONTEXT_UNAVAILABLE");
    });
    this.contextOperation = operation;
    void operation.finally(() => {
      if (this.contextOperation === operation) this.contextOperation = undefined;
      this.publishEvent({ type: "session_activity_changed", active: this.isSupervisorActive() });
    }).catch(() => {});
    return operation;
  }

  private contextBusy(includeMutation = true): boolean {
    const session = this.session;
    if (includeMutation && this.contextOperation) return true;
    if (!session || this.stopRequested || !session.isIdle || session.isStreaming || session.isCompacting
      || this.startPending || this.startCleanup || this.promptOperations.size || this.treeNavigationOperation
      || this.runCancellationPending || this.treeCleanupPending || this.stopPending
      || this.managed?.compaction.hasWork() || this.managed?.recovery?.hasWork()) return true;
    return this.contextAdmissionHeld
      ? !!(this.managed?.supervisor.hasRunningChildren() || this.managed?.supervisor.hasPendingNotifications())
      : this.isSupervisorActive();
  }

  private async getContextManager(): Promise<RootContextManager> {
    const session = this.requiredSession();
    if (!this.contextManager) {
      const { importPi } = await import("../runtime/pi-import");
      const pi = await importPi();
      const ai = await import("@earendil-works/pi-ai");
      if (this.stopRequested || this.session !== session) throw new ContextManagementError("CONTEXT_UNAVAILABLE");
      this.contextManager ??= new RootContextManager(session as unknown as ContextRuntime, pi,
        () => this.contextBusy(!this.contextCommitting), () => this.managed?.stats.notify(), () => this.runtimeConfigurationGeneration, ai);
    }
    return this.contextManager;
  }

  private readContextUsage(session: InProcessAgentSession): ContextUsageDto | undefined {
    const usage = session.getSessionStats().contextUsage;
    if (usage?.tokens !== null || !this.estimateTokens) return usage;
    if (!Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return usage;
    try {
      let tokens = 0;
      // Match Pi's post-compaction heuristic without reusing retained messages' old usage.
      for (const message of session.messages) {
        const count = this.estimateTokens(message);
        if (!Number.isSafeInteger(count) || count < 0) return usage;
        tokens += count;
        if (!Number.isSafeInteger(tokens)) return usage;
      }
      const percent = tokens / usage.contextWindow * 100;
      return Number.isFinite(percent) ? { tokens, contextWindow: usage.contextWindow, percent, estimated: true } : usage;
    } catch {
      return usage;
    }
  }

  getRuntimeConfigurationGeneration(): number {
    return this.runtimeConfigurationGeneration;
  }

  async getState(): Promise<SessionState> {
    const session = this.requiredSession();
    return {
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      messageCount: session.messages.length,
    };
  }

  async getTranscriptSnapshot(): Promise<{
    timeline: TranscriptTimelineEntryDto[];
    inlineUsage: ApiUsageRecordDto[];
  }> {
    const session = this.requiredSession();
    const branch = session.sessionManager.getBranch();
    return {
      timeline: projectSessionTimeline(branch),
      inlineUsage: projectSessionUsage(
        session.sessionId,
        session.sessionManager.getEntries(),
        branch,
      ).inlineUsage,
    };
  }

  async getCommands(): Promise<WebSlashCommand[]> {
    const session = this.requiredSession();
    const registeredCommands = session.extensionRunner.getRegisteredCommands();
    const reservedNames = new Set(WEB_BUILTIN_COMMANDS.map((command) => command.name));
    const commandOwnedNames = new Set([
      ...reservedNames,
      ...registeredCommands.map((command) => command.invocationName),
      ...session.promptTemplates.map((prompt) => prompt.name),
    ]);
    const extensions = registeredCommands
      .filter(
        (command) => command.invocationName !== INTERNAL_WEB_TREE_COMMAND && !reservedNames.has(command.invocationName),
      )
      .map((command) => ({
        name: command.invocationName,
        description: command.description,
        source: "extension" as const,
      }));
    const prompts = session.promptTemplates
      .filter((prompt) => prompt.name !== INTERNAL_WEB_TREE_COMMAND && !reservedNames.has(prompt.name))
      .map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        source: "prompt" as const,
      }));
    const skills = session.resourceLoader.getSkills().skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill" as const,
      ...(commandOwnedNames.has(skill.name) ? { requiresPrefix: true } : {}),
    }));
    return [...WEB_BUILTIN_COMMANDS, ...extensions, ...prompts, ...skills];
  }

  async getTree(): Promise<{
    tree: SessionTreeNode[];
    leafId: string | null;
    filterMode: WebTreeFilterMode;
    skipBranchSummaryPrompt: boolean;
  }> {
    const { sessionManager, settingsManager } = this.requiredSession();
    const configuredFilter = settingsManager.getTreeFilterMode();
    const filterMode: WebTreeFilterMode = isWebTreeFilterMode(configuredFilter) ? configuredFilter : "default";
    return {
      tree: sessionManager.getTree(),
      leafId: sessionManager.getLeafId(),
      filterMode,
      skipBranchSummaryPrompt: settingsManager.getBranchSummarySkipPrompt(),
    };
  }

  async navigateTree(entryId: string, options?: TreeNavigationOptions): Promise<TreeNavigationResult> {
    const session = this.requiredSession();
    if (this.hasBackgroundWork()) {
      throw new Error("Wait for active work to finish before navigating the session tree.");
    }
    const operation = session.navigateTree(entryId, options ? { ...options } : undefined);
    this.treeNavigationOperation = operation;
    this.publishEvent({ type: "session_activity_changed", active: this.isSupervisorActive() });
    try {
      const result = await operation;
      return {
        cancelled: result.cancelled,
        ...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
        leafId: session.sessionManager.getLeafId(),
      };
    } finally {
      this.treeNavigationOperation = undefined;
      this.managed?.retryPolicy?.finishSummary();
      this.publishEvent({ type: "session_activity_changed", active: this.isSupervisorActive() });
    }
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSteeringMessages(): readonly string[] {
    return this.requiredSession().getSteeringMessages().filter((message) => !isHiddenStatusContent(message));
  }

  hasBackgroundWork(): boolean {
    if (
      this.startPending
      || this.contextOperation !== undefined
      || this.startCleanup !== undefined
      || this.promptOperations.size > 0
      || this.treeNavigationOperation !== undefined
      || this.runCancellationPending
      || this.treeCleanupPending
      || this.stopPending
      || this.managed?.compaction.hasWork()
      || this.managed?.recovery?.hasWork()
    ) return true;
    return this.isSupervisorActive();
  }

  isSupervisorActive(): boolean {
    if (this.managed?.shellManager?.hasWork() || this.backgroundDelivery?.hasPending()) return true;
    const supervisor = this.managed?.supervisor;
    if (!supervisor) return false;
    try {
      return !supervisor.isQuiescent();
    } catch {
      return true;
    }
  }

  private requiredSession(): InProcessAgentSession {
    if (!this.session) throw new Error("Session has not started");
    if (this.stopRequested) throw new Error("Session has stopped");
    return this.session;
  }

  private requiredBinding(): AgentRuntimeBinding {
    if (!this.binding) throw new Error("Session has not started");
    if (this.stopRequested) throw new Error("Session has stopped");
    return this.binding;
  }

  private applyRuntimeConfigurationGeneration(generation: number): void {
    if (
      !Number.isSafeInteger(generation)
      || generation <= 0
      || generation <= this.runtimeConfigurationGeneration
    ) return;
    this.runtimeConfigurationGeneration = generation;
    const event = { type: "runtime_configuration_applied", generation } as const;
    this.publishEvent(event);
  }

  private publishEvent(event: unknown): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Session subscribers observe state; they never control runtime ownership.
      }
    }
  }

  private publishBackgroundTasks(): void {
    const tasks = this.getBackgroundTasks();
    // Suspension leaves the last durable owner hint intact for the successor.
    // Prompt/context admission itself is not background work and must not move the
    // native branch while a context-edit revision is being validated.
    if (!this.suspending) this.managed?.backgroundOwner?.update(tasks.some((task) => task.status === "running")
      || this.managed?.supervisor.hasPendingNotifications?.() === true || this.managed?.shellManager?.hasWork() === true
      || this.backgroundDelivery?.hasPending() === true);
    const signature = JSON.stringify(tasks);
    if (signature === this.backgroundTasksSignature) return;
    this.backgroundTasksSignature = signature;
    this.publishEvent({ type: "background_tasks_changed", tasks });
  }

  getBackgroundTasks(): BackgroundTask[] {
    return [...this.managed?.coordinator.backgroundTasks?.() ?? [],
      ...this.managed?.shellManager?.tasks().filter((task) => task.status === "running") ?? []];
  }

  async promoteBackground(): Promise<void> {
    const session = this.requiredSession();
    await this.managed?.shellManager?.promote(session.sessionId);
    this.publishBackgroundTasks();
  }

  async cancelBackground(taskId: string): Promise<void> {
    this.requiredSession();
    const task = this.getBackgroundTasks().find((item) => item.id === taskId);
    if (!task) throw new Error("Unknown background task");
    if (task.kind === "shell") await this.managed!.shellManager!.cancel(taskId);
    else await this.managed!.coordinator.cancelTask(taskId);
    this.publishBackgroundTasks();
  }

  private cleanupTree(reason: string): Promise<void> {
    if (this.treeCleanupPromise) return this.treeCleanupPromise;
    const session = this.session;
    const managed = this.managed;
    if (!session || !managed) return Promise.resolve();

    this.treeCleanupPending = true;
    let tracked!: Promise<void>;
    tracked = runCleanupSteps([
      () => {
        if (this.coordinatorClosingComplete) return;
        managed.coordinator.beginClosing();
        this.coordinatorClosingComplete = true;
      },
      () => managed.compaction.cancel(),
      () => {
        if (this.queueClearComplete) return;
        if (this.suspending) return;
        session.clearQueue();
        this.queueClearComplete = true;
      },
      async () => {
        if (this.sessionAbortComplete) return;
        await this.abortSessionAndSettlePrompts(session);
        this.sessionAbortComplete = true;
      },
      () => {
        if (!this.suspending || this.suspensionQueueComplete) return;
        this.suspensionQueue.preserve(managed.session as unknown as Parameters<RootSuspensionQueue["preserve"]>[0]);
        this.suspensionQueueComplete = true;
        this.queueClearComplete = true;
      },
      async () => {
        if (this.supervisorAbortComplete) return;
        if (this.suspending) await managed.supervisor.suspendAll(reason);
        else await managed.supervisor.abortAll(reason);
        this.supervisorAbortComplete = true;
      },
      async () => {
        if (this.notificationFlushComplete) return;
        await managed.supervisor.flushNotifications({ triggerTurn: false });
        this.notificationFlushComplete = true;
      },
    ], "Research Assistant tree cleanup failed.").catch((error) => {
      if (this.treeCleanupPromise === tracked) this.treeCleanupPromise = undefined;
      throw error;
    }).finally(() => {
      this.treeCleanupPending = false;
    });
    this.treeCleanupPromise = tracked;
    return tracked;
  }

  private async abortSessionAndSettlePrompts(session: InProcessAgentSession): Promise<void> {
    this.requestStopAbort(session);
    while (this.promptOperations.size > 0) {
      while (this.stopAbortOperations.size > 0) {
        await Promise.allSettled([...this.stopAbortOperations]);
      }
      this.throwIfStopAbortFailed();
      if (this.promptOperations.size > 0) await this.waitForStopProgress();
    }
    while (this.stopAbortOperations.size > 0) {
      await Promise.allSettled([...this.stopAbortOperations]);
    }
    this.throwIfStopAbortFailed();
    await this.managed?.recovery?.settleOperations();
    await this.treeNavigationOperation?.catch(() => {});
    this.stopAbortErrors.splice(0);
  }

  private requestStopAbort(session: InProcessAgentSession): void {
    const sequence = ++this.stopAbortSequence;
    const operation = runCleanupSteps([
      () => session.abortBranchSummary(),
      () => session.abort(),
    ], SAFE_STOP_ABORT_ERROR);
    this.stopAbortOperations.add(operation);
    void operation
      .then(() => {
        this.stopAbortSuccessSequence = Math.max(this.stopAbortSuccessSequence, sequence);
      }, (error: unknown) => {
        this.stopAbortFailureSequence = Math.max(this.stopAbortFailureSequence, sequence);
        this.stopAbortErrors.push(error);
      })
      .finally(() => {
        this.stopAbortOperations.delete(operation);
        for (const settle of [...this.stopAbortProgressWaiters]) settle();
      });
  }

  private throwIfStopAbortFailed(): void {
    if (this.stopAbortFailureSequence <= this.stopAbortSuccessSequence) return;
    const failureCount = Math.max(1, this.stopAbortErrors.splice(0).length);
    if (failureCount === 1) throw new Error(SAFE_STOP_ABORT_ERROR);
    throw new AggregateError(
      Array.from({ length: failureCount }, () => new Error(SAFE_STOP_ABORT_ERROR)),
      SAFE_STOP_ABORT_ERROR,
    );
  }

  private waitForStopProgress(): Promise<void> {
    const prompts = [...this.promptOperations];
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.stopAbortProgressWaiters.delete(finish);
        resolve();
      };
      this.stopAbortProgressWaiters.add(finish);
      void Promise.all(prompts).then(finish, finish);
    });
  }
}

function isWebTreeFilterMode(value: string): value is WebTreeFilterMode {
  return value === "default"
    || value === "no-tools"
    || value === "user-only"
    || value === "labeled-only"
    || value === "all";
}

function isHiddenStatusMessage(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && "role" in value
    && value.role === "custom"
    && "customType" in value
    && (value.customType === AGENT_STATUS_TYPE || isLlmRetryControl(value) || ("display" in value && value.display === false));
}

function isHiddenStatusEntry(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && "customType" in value
    && (value.customType === AGENT_STATUS_TYPE || isLlmRetryControl(value) || ("display" in value && value.display === false));
}

function isHiddenStatusContent(value: string): boolean {
  const content = value.trim();
  return content.startsWith("<agent_status>\n")
    && content.includes("\n</agent_status>\n<agent_handoff>\n")
    && content.endsWith("\n</agent_handoff>");
}

function isHiddenStatusEvent(event: AgentSessionEvent): boolean {
  if (event.type === "message_start" || event.type === "message_end") {
    return isHiddenStatusMessage(event.message);
  }
  if (event.type === "entry_appended") return isHiddenStatusEntry(event.entry);
  return false;
}
