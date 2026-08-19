import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { runCleanupSteps } from "../runtime/cleanup";
import { toJsonSessionEvent } from "../runtime/json-session-event";
import type { AgentConfig } from "../subagent/agents";
import type { CoordinatorSessionManager, SubagentCoordinator } from "../subagent/coordinator";
import { AGENT_STATUS_TYPE } from "../subagent/notifications";
import type { SubagentSupervisor, SupervisableAgentSession } from "../subagent/supervisor";

export interface StartSessionOptions {
  cwd: string;
  sessionPath?: string;
  thinking?: string;
}

export interface WebSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
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

export interface InProcessAgentSession {
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  readonly sessionName: string | undefined;
  readonly isStreaming: boolean;
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
  readonly sessionManager: {
    getTree(): SessionTreeNode[];
    getLeafId(): string | null;
  };
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(message: string, options?: SteerPromptOptions): Promise<void>;
  sendCustomMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options: { deliverAs: "steer"; triggerTurn: boolean },
  ): Promise<void>;
  abort(): Promise<void>;
  setModel(model: Model<any>): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  setSessionName(name: string): void;
  navigateTree(entryId: string, options?: Record<string, unknown>): Promise<{ cancelled: boolean }>;
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

export interface ManagedAgentSession {
  session: BindableAgentSession;
  coordinator: SubagentCoordinator;
  supervisor: SubagentSupervisor;
}

export type AgentSessionCreator = (options: StartSessionOptions) => Promise<ManagedAgentSession>;

interface ResourceLoaderLike {
  reload(options?: { resolveProjectTrust?: () => Promise<boolean> }): Promise<void>;
}

export interface PiRuntimeDependencies {
  agentDir: string;
  createSessionManager(cwd: string): CoordinatorSessionManager;
  openSessionManager(path: string): CoordinatorSessionManager;
  createCoordinator(sessionManager: CoordinatorSessionManager): SubagentCoordinator;
  recoverSubagentTree(options: { coordinator: SubagentCoordinator; expectedCwd: string }): Promise<void>;
  createDirectChildSupervisor(coordinator: SubagentCoordinator): SubagentSupervisor;
  createExtensionFactories(runtime: {
    coordinator: SubagentCoordinator;
    supervisor: SubagentSupervisor;
  }): unknown[];
  createSettingsManager(cwd: string, agentDir: string): unknown;
  createModelRuntime(agentDir: string): Promise<unknown>;
  createResourceLoader(options: {
    cwd: string;
    agentDir: string;
    settingsManager: unknown;
    extensionFactories: unknown[];
    noSkills: boolean;
    additionalSkillPaths: string[];
    appendSystemPrompt: string[];
  }): ResourceLoaderLike;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: BindableAgentSession }>;
  resolveAssistant(cwd: string, agentDir: string): Promise<AgentConfig>;
  resolveModel(assistant: AgentConfig, modelRuntime: unknown): Promise<Model<any> | undefined>;
  resolveSkillPaths(assistant: AgentConfig, cwd: string, agentDir: string): Promise<string[]>;
}

export function createPiAgentSessionCreator(deps: PiRuntimeDependencies): AgentSessionCreator {
  return async (options) => {
    const sessionManager = options.sessionPath
      ? deps.openSessionManager(options.sessionPath)
      : deps.createSessionManager(options.cwd);
    const coordinator = deps.createCoordinator(sessionManager);
    await deps.recoverSubagentTree({ coordinator, expectedCwd: options.cwd });
    const supervisor = deps.createDirectChildSupervisor(coordinator);
    let session: BindableAgentSession | undefined;
    try {
      const extensionFactories = deps.createExtensionFactories({ coordinator, supervisor });
      const settingsManager = deps.createSettingsManager(options.cwd, deps.agentDir);
      const modelRuntime = await deps.createModelRuntime(deps.agentDir);
      const assistant = await deps.resolveAssistant(options.cwd, deps.agentDir);
      const skillPaths = await deps.resolveSkillPaths(assistant, options.cwd, deps.agentDir);
      const resourceLoader = deps.createResourceLoader({
        cwd: options.cwd,
        agentDir: deps.agentDir,
        settingsManager,
        extensionFactories,
        noSkills: true,
        additionalSkillPaths: skillPaths,
        appendSystemPrompt: assistant.systemPrompt.trim() ? [assistant.systemPrompt] : [],
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
      const model = await deps.resolveModel(assistant, modelRuntime);
      const createOptions: Record<string, unknown> = {
        cwd: options.cwd,
        agentDir: deps.agentDir,
        sessionManager,
        settingsManager,
        modelRuntime,
        resourceLoader,
        ...(model ? { model } : {}),
        ...(!options.sessionPath && options.thinking ? { thinkingLevel: options.thinking } : {}),
      };
      ({ session } = await deps.createAgentSession(createOptions));
      coordinator.bindPaperAssistantState({
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
          reload: () => session!.reload(),
        },
      });
      return { session, coordinator, supervisor };
    } catch (error) {
      await runCleanupSteps([
        () => { throw error; },
        () => supervisor.dispose(),
        () => session?.dispose(),
      ], "Paper Assistant runtime setup cleanup failed.");
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
  getCommands(): Promise<WebSlashCommand[]>;
  getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }>;
  navigateTree(entryId: string): Promise<void>;
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

  static async resolve(): Promise<PiSessionFactory> {
    const { join } = await import("node:path");
    const { importPi, getAgentDir } = await import("../runtime/pi-import");
    const { bootstrapBundledResources } = await import("../bootstrap/resources");
    await bootstrapBundledResources();
    const pi = await importPi();
    const { createAssistantExtensions } = await import("../extensions");
    const { discoverAgents, PAPER_ASSISTANT_AGENT } = await import("../subagent/agents");
    const { SubagentCoordinator } = await import("../subagent/coordinator");
    const { recoverSubagentTree } = await import("../subagent/recovery");
    const { SubagentSupervisor } = await import("../subagent/supervisor");
    const { launchStageSession } = await import("../subagent/stage-session");
    const { createSubagentRecoverySessionStore } = await import("./subagent-sessions");
    const { splitModelRef } = await import("./agent-models");
    const agentDir = getAgentDir();
    const creator = createPiAgentSessionCreator({
      agentDir,
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
        createAssistantExtensions(runtime).map(({ name, factory }) => ({ name, factory })),
      createSettingsManager: (cwd, root) => pi.SettingsManager.create(cwd, root),
      createModelRuntime: (root) =>
        pi.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") }),
      createResourceLoader: (options) =>
        new pi.DefaultResourceLoader(options as ConstructorParameters<typeof pi.DefaultResourceLoader>[0]),
      createAgentSession: async (options) => {
        const result = await pi.createAgentSession(options as Parameters<typeof pi.createAgentSession>[0]);
        return { session: result.session as unknown as BindableAgentSession };
      },
      resolveAssistant: async (cwd) => {
        const assistant = (await discoverAgents({ cwd, agentDir })).agents.find(
          (agent) => agent.name === PAPER_ASSISTANT_AGENT,
        );
        if (!assistant) throw new Error("Missing valid Paper Assistant definition");
        return assistant;
      },
      resolveModel: async (assistant, runtime) => {
        const configured = assistant.model;
        if (!configured) return undefined;
        const { provider, modelId } = splitModelRef(configured);
        return (runtime as { getModel(provider: string, modelId: string): Model<any> | undefined }).getModel(
          provider,
          modelId,
        );
      },
      resolveSkillPaths: async (assistant, cwd) => {
        const { resolveAgentSkillDirectories, isDotAgentsSkillEnabled } = await import("../subagent/skill-resolution");
        const settingsManager = pi.SettingsManager.create(cwd, agentDir);
        return resolveAgentSkillDirectories(assistant, {
          cwd,
          agentDir,
          enableDotAgentsSkill: isDotAgentsSkillEnabled(settingsManager.getGlobalSettings()),
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
  private unsubscribe: (() => void) | undefined;
  private coordinatorUnsubscribe: (() => void) | undefined;
  private startPending = false;
  private treeCleanupPending = false;
  private stopPending = false;
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
  private coordinatorUnsubscribeComplete = false;
  private unsubscribeComplete = false;
  private sessionDisposeComplete = false;
  private readonly listeners = new Set<(event: unknown) => void>();

  constructor(
    private readonly createAgentSession: AgentSessionCreator,
    private readonly options: StartSessionOptions,
  ) {}

  async start(): Promise<void> {
    if (this.session) throw new Error("Session already started");
    if (this.stopRequested) throw new Error("Session already stopped");
    this.startPending = true;
    try {
      this.managed = await this.createAgentSession(this.options);
      this.session = this.managed.session;
      this.coordinatorUnsubscribe = this.managed.coordinator.subscribe((event) => {
        for (const listener of this.listeners) listener(event);
      });
      this.unsubscribe = this.session.subscribe((event) => {
        const agentEvent = event as AgentSessionEvent;
        if (isHiddenStatusEvent(agentEvent)) return;
        const jsonEvent = toJsonSessionEvent(agentEvent);
        const publicEvent = jsonEvent.type === "agent_end"
          ? { ...jsonEvent, messages: jsonEvent.messages.filter((message) => !isHiddenStatusMessage(message)) }
          : jsonEvent.type === "queue_update"
            ? { ...jsonEvent, steering: jsonEvent.steering.filter((message) => !isHiddenStatusContent(message)) }
          : jsonEvent;
        for (const listener of this.listeners) listener(publicEvent);
      });
    } finally {
      this.startPending = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    const session = this.session;
    if (!session) {
      this.stopped = true;
      return;
    }
    const supervisor = this.managed?.supervisor;
    this.stopPending = true;
    let tracked!: Promise<void>;
    tracked = runCleanupSteps([
      () => this.cleanupTree("Paper Assistant session stopped."),
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
        if (this.unsubscribeComplete) return;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.unsubscribeComplete = true;
      },
      () => {
        if (this.sessionDisposeComplete) return;
        session.dispose();
        this.sessionDisposeComplete = true;
      },
    ], "Paper Assistant runtime cleanup failed.").then(
      () => {
        this.stopped = true;
        this.session = undefined;
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
    let accepted = false;
    await new Promise<void>((resolve, reject) => {
      void session
        .prompt(message, {
          streamingBehavior: "steer",
          ...options,
          preflightResult: (didSucceed) => {
            if (accepted) return;
            if (didSucceed) {
              accepted = true;
              resolve();
            }
          },
        })
        .then(() => {
          // Defensive: a prompt that settles without a preflight callback (e.g.
          // the run ended before acceptance) is treated as accepted rather than
          // leaving the HTTP request pending forever.
          if (!accepted) {
            accepted = true;
            resolve();
          }
        })
        .catch((error: unknown) => {
          if (accepted) return;
          accepted = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  async abort(): Promise<void> {
    this.requiredSession();
    await this.cleanupTree("Paper Assistant stopped.");
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
    return this.requiredSession().messages.filter((message) => !isHiddenStatusMessage(message));
  }

  async getCommands(): Promise<WebSlashCommand[]> {
    const session = this.requiredSession();
    const extensions = session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      description: command.description,
      source: "extension" as const,
    }));
    const prompts = session.promptTemplates.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      source: "prompt" as const,
    }));
    const skills = session.resourceLoader.getSkills().skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill" as const,
    }));
    return [...extensions, ...prompts, ...skills];
  }

  async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
    const { sessionManager } = this.requiredSession();
    return { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() };
  }

  async navigateTree(entryId: string): Promise<void> {
    await this.requiredSession().navigateTree(entryId);
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSteeringMessages(): readonly string[] {
    return this.requiredSession().getSteeringMessages().filter((message) => !isHiddenStatusContent(message));
  }

  hasBackgroundWork(): boolean {
    if (this.startPending || this.treeCleanupPending || this.stopPending) return true;
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
      () => {
        if (this.queueClearComplete) return;
        session.clearQueue();
        this.queueClearComplete = true;
      },
      async () => {
        if (this.sessionAbortComplete) return;
        await session.abort();
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
    ], "Paper Assistant tree cleanup failed.").catch((error) => {
      if (this.treeCleanupPromise === tracked) this.treeCleanupPromise = undefined;
      throw error;
    }).finally(() => {
      this.treeCleanupPending = false;
    });
    this.treeCleanupPromise = tracked;
    return tracked;
  }
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
  return value.includes("<agent_status>")
    && value.includes("</agent_status>")
    && value.includes("<agent_handoff>")
    && value.includes("</agent_handoff>");
}

function isHiddenStatusEvent(event: AgentSessionEvent): boolean {
  if (event.type === "message_start" || event.type === "message_end") {
    return isHiddenStatusMessage(event.message);
  }
  if (event.type === "entry_appended") return isHiddenStatusEntry(event.entry);
  return false;
}
