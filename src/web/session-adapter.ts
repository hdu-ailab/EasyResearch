import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  SessionTreeNode,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { runCleanupSteps } from "../runtime/cleanup";
import { toJsonSessionEvent } from "../runtime/json-session-event";
import { configureBatchedSteering, type RuntimeSteeringSession } from "../runtime/steering-mode";
import {
  createAgentRuntimeBinding,
  type AgentRuntimeBinding,
  type AgentRuntimeBindingSession,
  type AgentRuntimeModelRuntime,
} from "../runtime/agent-runtime-binding";
import { createSessionSettingsFacade } from "../runtime/session-settings-facade";
import {
  createCompactionPolicyBinding,
  DEFAULT_GLOBAL_COMPACTION_POLICY,
  type CompactionPolicySettingsManager,
} from "../runtime/compaction-policy";
import { resolvePiDefaultModel, type PiDefaultModelApi } from "../runtime/pi-default-model";
import {
  ConfigurationUnavailableError,
  type LiveConfiguration,
} from "../runtime/live-configuration";
import type { AgentConfig } from "../subagent/agents";
import type { CoordinatorSessionManager, SubagentCoordinator } from "../subagent/coordinator";
import { AGENT_STATUS_TYPE } from "../subagent/notifications";
import type { SubagentSupervisor, SupervisableAgentSession } from "../subagent/supervisor";
import type { ApiUsageRecordDto, CompactionPolicyDto, ContextUsageDto } from "./contracts";
import { attachMessageEntryIds, projectSessionUsage } from "./api-usage";
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
  agent: RuntimeSteeringSession["agent"] & ManualCompactionSession["agent"];
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  readonly sessionName: string | undefined;
  readonly isStreaming: boolean;
  readonly isIdle: boolean;
  readonly isCompacting: boolean;
  readonly thinkingLevel: ThinkingLevel;
  readonly model: Model<any> | undefined;
  readonly messages: AgentMessage[];
  readonly promptTemplates: ReadonlyArray<{ name: string; description?: string }>;
  readonly modelRuntime: {
    getModel(provider: string, modelId: string): Model<any> | undefined;
  };
  readonly resourceLoader: {
    getSkills(): {
      skills: ReadonlyArray<{ name: string; description?: string }>;
      diagnostics: readonly unknown[];
    };
  };
  readonly extensionRunner: {
    getRegisteredCommands(): ReadonlyArray<{ invocationName: string; description?: string }>;
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
}

export type AgentSessionCreator = (options: StartSessionOptions) => Promise<ManagedAgentSession>;

function createRuntimeSetupCleanup(
  session: Pick<InProcessAgentSession, "dispose"> | undefined,
  compaction: Pick<ManualCompactionController, "dispose"> | undefined,
  supervisor: Pick<SubagentSupervisor, "dispose"> | undefined,
  binding: Pick<AgentRuntimeBinding, "dispose">,
  coordinatorUnsubscribe?: () => void,
  compactionUnsubscribe?: () => void,
  sessionUnsubscribe?: () => void,
): () => Promise<void> {
  let compactionDisposed = compaction === undefined;
  let supervisorDisposed = supervisor === undefined;
  let coordinatorUnsubscribed = coordinatorUnsubscribe === undefined;
  let compactionUnsubscribed = compactionUnsubscribe === undefined;
  let sessionUnsubscribed = sessionUnsubscribe === undefined;
  let sessionDisposed = session === undefined;
  let bindingDisposed = false;
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
        if (compactionUnsubscribed) return;
        compactionUnsubscribe!();
        compactionUnsubscribed = true;
      },
      () => {
        if (sessionUnsubscribed) return;
        sessionUnsubscribe!();
        sessionUnsubscribed = true;
      },
      () => {
        if (sessionDisposed) return;
        session!.dispose();
        sessionDisposed = true;
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

function createBindingSession(session: BindableAgentSession): AgentRuntimeBindingSession {
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
    setModel: (model) => session.setModel(model),
    setThinkingLevel: (level) => session.setThinkingLevel(level),
  };
}

interface ResourceLoaderLike {
  reload(options?: { resolveProjectTrust?: () => Promise<boolean> }): Promise<void>;
}

export interface PiRuntimeDependencies {
  agentDir: string;
  liveConfiguration: LiveConfiguration;
  createSessionManager(cwd: string): CoordinatorSessionManager;
  openSessionManager(path: string): CoordinatorSessionManager;
  createCoordinator(sessionManager: CoordinatorSessionManager): SubagentCoordinator;
  recoverSubagentTree(options: { coordinator: SubagentCoordinator; expectedCwd: string }): Promise<void>;
  createDirectChildSupervisor(coordinator: SubagentCoordinator): SubagentSupervisor;
  createExtensionFactories(runtime: {
    coordinator: SubagentCoordinator;
    supervisor: SubagentSupervisor;
    binding: AgentRuntimeBinding;
    compaction: ManualCompactionController;
  }): unknown[];
  createSettingsManager(cwd: string, agentDir: string): unknown;
  createModelRuntime(agentDir: string): Promise<AgentRuntimeModelRuntime>;
  createResourceLoader(options: {
    cwd: string;
    agentDir: string;
    settingsManager: unknown;
    extensionFactories: unknown[];
    noSkills: boolean;
    additionalSkillPaths: string[];
    appendSystemPromptOverride(base: string[]): string[];
  }): ResourceLoaderLike;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: BindableAgentSession }>;
  resolveAutomaticModel(options: {
    cwd: string;
    agentDir: string;
    modelRuntime: AgentRuntimeModelRuntime;
    settingsManager: unknown;
  }): Promise<Model<any> | undefined>;
  resolveSkillPaths(agent: AgentConfig, cwd: string, agentDir: string, settingsManager: unknown): string[];
}

export function createPiAgentSessionCreator(deps: PiRuntimeDependencies): AgentSessionCreator {
  return async (options) => {
    const sessionManager = options.sessionPath
      ? deps.openSessionManager(options.sessionPath)
      : deps.createSessionManager(options.cwd);
    const coordinator = deps.createCoordinator(sessionManager);
    const settingsManager = createSessionSettingsFacade(
      deps.createSettingsManager(options.cwd, deps.agentDir) as object,
    );
    const automaticCompaction = createCompactionPolicyBinding(
      settingsManager as CompactionPolicySettingsManager,
    );
    const compaction = new ManualCompactionController();
    const binding = createAgentRuntimeBinding({
      live: deps.liveConfiguration,
      agentName: "research-assistant",
      cwd: options.cwd,
      createModelRuntime: async () =>
        await deps.createModelRuntime(deps.agentDir) as AgentRuntimeModelRuntime,
      resolveAutomaticModel: (modelRuntime) => deps.resolveAutomaticModel({
        cwd: options.cwd,
        agentDir: deps.agentDir,
        modelRuntime,
        settingsManager,
      }),
      resolveSkillPaths: (agent) => deps.resolveSkillPaths(
        agent,
        options.cwd,
        deps.agentDir,
        settingsManager,
      ),
      compaction: automaticCompaction,
      onCompactionPolicyChanged: () => compaction.notifyStatsChanged(),
    });
    let supervisor: SubagentSupervisor | undefined;
    let session: BindableAgentSession | undefined;
    try {
      await binding.ensureCurrent();
      await deps.recoverSubagentTree({ coordinator, expectedCwd: options.cwd });
      supervisor = deps.createDirectChildSupervisor(coordinator);
      const modelRuntime = binding.modelRuntime();
      const extensionFactories = deps.createExtensionFactories({ coordinator, supervisor, binding, compaction });
      const resourceLoader = deps.createResourceLoader({
        cwd: options.cwd,
        agentDir: deps.agentDir,
        settingsManager,
        extensionFactories,
        noSkills: true,
        additionalSkillPaths: [],
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
      };
      ({ session } = await deps.createAgentSession(createOptions));
      compaction.attach(session);
      configureBatchedSteering(session);
      coordinator.bindResearchAssistantState({
        model: () => session?.model ? `${session.model.provider}/${session.model.id}` : undefined,
        thinking: () => session?.thinkingLevel,
      });
      supervisor.attach(session as unknown as SupervisableAgentSession);
      await session.bindExtensions({
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session!.waitForIdle(),
          navigateTree: async (targetId: string, navigationOptions?: Record<string, unknown>) => {
            const result = await session!.navigateTree(targetId, navigationOptions);
            return { cancelled: result.cancelled };
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
      await binding.attach(createBindingSession(session));
      return { session, coordinator, supervisor, binding, compaction };
    } catch (error) {
      const retryCleanup = createRuntimeSetupCleanup(session, compaction, supervisor, binding);
      try {
        await retryCleanup();
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
  prompt(message: string, options?: SteerPromptOptions): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  getState(): Promise<SessionState>;
  getMessages(): Promise<AgentMessage[]>;
  getInlineUsage(): ApiUsageRecordDto[];
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
  getSteeringMessages(): readonly string[];
  hasBackgroundWork(): boolean;
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
  constructor(private readonly createAgentSession: AgentSessionCreator) {}

  static async resolve(liveConfiguration?: LiveConfiguration): Promise<PiSessionFactory> {
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
    const { launchStageSession } = await import("../subagent/stage-session");
    const { resolveAgentSkillDirectories, isDotAgentsSkillEnabled } = await import("../subagent/skill-resolution");
    const { createSubagentRecoverySessionStore } = await import("./subagent-sessions");
    const agentDir = getAgentDir();
    const creator = createPiAgentSessionCreator({
      agentDir,
      liveConfiguration,
      createSessionManager: (cwd) => pi.SessionManager.create(cwd),
      openSessionManager: (path) => pi.SessionManager.open(path),
      createCoordinator: (sessionManager) => new SubagentCoordinator(sessionManager),
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
        launchStage: launchStageSession,
      }),
      createExtensionFactories: (runtime) =>
        createResearchAssistantExtensions({ ...runtime, liveConfiguration })
          .map(({ name, factory }) => ({ name, factory })),
      createSettingsManager: (cwd, root) => pi.SettingsManager.create(cwd, root),
      createModelRuntime: (root) =>
        pi.ModelRuntime.create({
          authPath: join(root, "auth.json"),
          modelsPath: join(root, "models.json"),
          refreshOnCreate: false,
        }),
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
      resolveSkillPaths: (agent, cwd, root, settingsManager) => {
        return resolveAgentSkillDirectories(agent, {
          cwd,
          agentDir: root,
          enableDotAgentsSkill: isDotAgentsSkillEnabled(
            (settingsManager as SettingsManager).getGlobalSettings(),
          ),
        });
      },
    });
    return new PiSessionFactory(creator);
  }

  create(options: StartSessionOptions): SessionAdapter {
    return new DirectSessionAdapter(this.createAgentSession, options);
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
  private compactionUnsubscribe: (() => void) | undefined;
  private startPending = false;
  private runCancellationPending = false;
  private treeCleanupPending = false;
  private stopPending = false;
  private runCancellationPromise: Promise<void> | undefined;
  private treeCleanupPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopRequested = false;
  private stopped = false;
  private coordinatorClosingComplete = false;
  private queueClearComplete = false;
  private sessionAbortComplete = false;
  private supervisorAbortComplete = false;
  private notificationFlushComplete = false;
  private supervisorDisposeComplete = false;
  private compactionDisposeComplete = false;
  private coordinatorUnsubscribeComplete = false;
  private compactionUnsubscribeComplete = false;
  private unsubscribeComplete = false;
  private sessionDisposeComplete = false;
  private bindingDisposeComplete = false;
  private readonly promptOperations = new Set<Promise<void>>();
  private readonly stopAbortOperations = new Set<Promise<void>>();
  private readonly stopAbortErrors: unknown[] = [];
  private readonly stopAbortProgressWaiters = new Set<() => void>();
  private stopAbortSequence = 0;
  private stopAbortSuccessSequence = 0;
  private stopAbortFailureSequence = 0;
  private readonly listeners = new Set<(event: unknown) => void>();

  constructor(
    private readonly createAgentSession: AgentSessionCreator,
    private readonly options: StartSessionOptions,
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
        created = await this.createAgentSession(this.options);
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
      let compactionUnsubscribe: (() => void) | undefined;
      let sessionUnsubscribe: (() => void) | undefined;
      try {
        coordinatorUnsubscribe = created.coordinator.subscribe((event) => {
          for (const listener of this.listeners) listener(event);
        });
        sessionUnsubscribe = created.session.subscribe((event) => {
          const agentEvent = event as AgentSessionEvent;
          if (agentEvent.type === "compaction_start") created.compaction.observeNativeCompaction("start");
          if (agentEvent.type === "compaction_end") created.compaction.observeNativeCompaction("end");
          if (agentEvent.type === "agent_start" && (this.runCancellationPending || this.stopRequested)) {
            this.requestStopAbort(created.session);
          }
          if (isHiddenStatusEvent(agentEvent)) return;
          const jsonEvent = toJsonSessionEvent(agentEvent);
          const publicEvent = jsonEvent.type === "agent_end"
            ? { ...jsonEvent, messages: jsonEvent.messages.filter((message) => !isHiddenStatusMessage(message)) }
            : jsonEvent.type === "queue_update"
              ? { ...jsonEvent, steering: jsonEvent.steering.filter((message) => !isHiddenStatusContent(message)) }
              : jsonEvent;
          for (const listener of this.listeners) listener(publicEvent);
        });
        const unsubscribeCompactionState = created.compaction.subscribe((state) => {
          for (const listener of this.listeners) listener({ type: "compaction_state_changed", state });
        });
        const unsubscribeStats = created.compaction.subscribeStats(() => {
          const contextUsage = created.session.getSessionStats().contextUsage;
          this.lastCompactionPolicy = created.binding.compactionPolicy();
          const event = {
            type: "session_stats_changed",
            ...(contextUsage !== undefined ? { contextUsage } : {}),
            compactionPolicy: { ...this.lastCompactionPolicy },
          };
          for (const listener of this.listeners) listener(event);
        });
        compactionUnsubscribe = () => {
          try {
            unsubscribeCompactionState();
          } finally {
            unsubscribeStats();
          }
        };
      } catch (error) {
        const retryCleanup = createRuntimeSetupCleanup(
          created.session,
          created.compaction,
          created.supervisor,
          created.binding,
          coordinatorUnsubscribe,
          compactionUnsubscribe,
          sessionUnsubscribe,
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
      this.compactionUnsubscribe = compactionUnsubscribe;
      this.unsubscribe = sessionUnsubscribe;
    } finally {
      this.startPending = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
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
      () => {
        if (!session || this.sessionDisposeComplete) return;
        session.dispose();
        this.sessionDisposeComplete = true;
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
    ], "Research Assistant runtime cleanup failed.").then(
      () => {
        this.stopped = true;
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
    // Mirror Pi's rpc-mode prompt contract (ADR-083): fire the prompt without
    // awaiting the whole agent run and resolve as soon as it is accepted
    // (queued steer, handled extension command, or preflight success). Pi's
    // AgentSession.prompt otherwise blocks until agent_end, which would keep
    // the Web POST pending for the run's entire duration and disable the
    // composer. Preflight failures reject through the prompt promise.
    const session = this.requiredSession();
    const binding = this.requiredBinding();
    let accepted = false;
    let resolveAccepted!: () => void;
    let rejectAccepted!: (error: Error) => void;
    const acceptedPromise = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const operation = (async () => {
      try {
        await binding.ensureCurrent();
        if (this.stopRequested) throw new Error("Session has stopped");
        if (/^\/web-tree(?:\s|$)/.test(message.trimStart())) {
          throw new Error("The /web-tree command is not available in chat.");
        }
        let promptMessage = message;
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
        await session.prompt(promptMessage, {
          streamingBehavior: "steer",
          ...options,
          preflightResult: (didSucceed) => {
            if (!accepted && didSucceed) {
              accepted = true;
              resolveAccepted();
            }
          },
        });
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
        }
      }
    })();
    this.promptOperations.add(operation);
    void operation.finally(() => {
      this.promptOperations.delete(operation);
    });
    await acceptedPromise;
  }

  abort(): Promise<void> {
    const session = this.requiredSession();
    const managed = this.managed;
    if (!managed) return Promise.reject(new Error("Session has not started"));
    if (this.runCancellationPromise) return this.runCancellationPromise;

    this.runCancellationPending = true;
    let tracked!: Promise<void>;
    tracked = runCleanupSteps([
      () => managed.coordinator.beginCancellation(),
      () => managed.compaction.cancel(),
      () => session.clearQueue(),
      () => this.abortSessionAndSettlePrompts(session),
      () => managed.supervisor.cancelAll("Research Assistant stopped."),
    ], "Research Assistant run cancellation failed.")
      .then(() => managed.coordinator.finishCancellation())
      .finally(() => {
        if (this.runCancellationPromise === tracked) this.runCancellationPromise = undefined;
        this.runCancellationPending = false;
      });
    this.runCancellationPromise = tracked;
    return tracked;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const session = this.requiredSession();
    const model = session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown model: ${provider}/${modelId}`);
    await session.setModel(model);
  }

  async setThinkingLevel(level: string): Promise<void> {
    if (!THINKING_LEVELS.has(level as ThinkingLevel)) throw new Error(`Invalid thinking level: ${level}`);
    this.requiredSession().setThinkingLevel(level as ThinkingLevel);
  }

  async compact(customInstructions?: string): Promise<{ state: ManualCompactionAcceptedState }> {
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
    return this.requiredSession().getSessionStats().contextUsage;
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

  async getMessages(): Promise<AgentMessage[]> {
    const session = this.requiredSession();
    return attachMessageEntryIds(
      session.messages.filter((message) => !isHiddenStatusMessage(message)),
      session.sessionManager.getBranch(),
    );
  }

  getInlineUsage(): ApiUsageRecordDto[] {
    const session = this.requiredSession();
    return projectSessionUsage(
      session.sessionId,
      session.sessionManager.getEntries(),
      session.sessionManager.getBranch(),
    ).inlineUsage;
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
    const result = await session.navigateTree(entryId, options ? { ...options } : undefined);
    return {
      cancelled: result.cancelled,
      ...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
      leafId: session.sessionManager.getLeafId(),
    };
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
      || this.startCleanup !== undefined
      || this.promptOperations.size > 0
      || this.runCancellationPending
      || this.treeCleanupPending
      || this.stopPending
      || this.managed?.compaction.hasWork()
    ) return true;
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
        session.clearQueue();
        this.queueClearComplete = true;
      },
      async () => {
        if (this.sessionAbortComplete) return;
        await this.abortSessionAndSettlePrompts(session);
        this.sessionAbortComplete = true;
      },
      async () => {
        if (this.supervisorAbortComplete) return;
        await managed.supervisor.abortAll(reason);
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
    this.stopAbortErrors.splice(0);
  }

  private requestStopAbort(session: InProcessAgentSession): void {
    const sequence = ++this.stopAbortSequence;
    let operation: Promise<void>;
    try {
      operation = session.abort();
    } catch (error) {
      this.stopAbortFailureSequence = Math.max(this.stopAbortFailureSequence, sequence);
      this.stopAbortErrors.push(error);
      for (const settle of [...this.stopAbortProgressWaiters]) settle();
      return;
    }
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
    && value.customType === AGENT_STATUS_TYPE;
}

function isHiddenStatusEntry(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && "customType" in value
    && value.customType === AGENT_STATUS_TYPE;
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
