import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { toJsonSessionEvent } from "../runtime/json-session-event";

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
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  setModel(model: Model<any>): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  setSessionName(name: string): void;
  navigateTree(entryId: string, options?: Record<string, unknown>): Promise<{ cancelled: boolean }>;
  dispose(): void;
}

export type AgentSessionCreator = (options: StartSessionOptions) => Promise<InProcessAgentSession>;

interface BindableAgentSession extends InProcessAgentSession {
  bindExtensions(bindings: unknown): Promise<void>;
  waitForIdle(): Promise<void>;
  reload(): Promise<void>;
}

interface ResourceLoaderLike {
  reload(options?: { resolveProjectTrust?: () => Promise<boolean> }): Promise<void>;
}

export interface PiRuntimeDependencies {
  agentDir: string;
  extensionFactories: unknown[];
  createSessionManager(cwd: string): unknown;
  openSessionManager(path: string): unknown;
  createSettingsManager(cwd: string, agentDir: string): unknown;
  createModelRuntime(agentDir: string): Promise<unknown>;
  createResourceLoader(options: {
    cwd: string;
    agentDir: string;
    settingsManager: unknown;
    extensionFactories: unknown[];
    noSkills: boolean;
    additionalSkillPaths: string[];
  }): ResourceLoaderLike;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: BindableAgentSession }>;
  resolveModel(cwd: string, modelRuntime: unknown): Promise<Model<any> | undefined>;
  resolveSkillPaths(cwd: string, agentDir: string): Promise<string[]>;
}

export function createPiAgentSessionCreator(deps: PiRuntimeDependencies): AgentSessionCreator {
  return async (options) => {
    const sessionManager = options.sessionPath
      ? deps.openSessionManager(options.sessionPath)
      : deps.createSessionManager(options.cwd);
    const settingsManager = deps.createSettingsManager(options.cwd, deps.agentDir);
    const modelRuntime = await deps.createModelRuntime(deps.agentDir);
    const skillPaths = await deps.resolveSkillPaths(options.cwd, deps.agentDir);
    const resourceLoader = deps.createResourceLoader({
      cwd: options.cwd,
      agentDir: deps.agentDir,
      settingsManager,
      extensionFactories: deps.extensionFactories,
      noSkills: true,
      additionalSkillPaths: skillPaths,
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => true });
    const model = await deps.resolveModel(options.cwd, modelRuntime);
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
    const { session } = await deps.createAgentSession(createOptions);
    await session.bindExtensions({
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        navigateTree: async (targetId: string, navigationOptions?: Record<string, unknown>) => {
          const result = await session.navigateTree(targetId, navigationOptions);
          return { cancelled: result.cancelled };
        },
        reload: () => session.reload(),
      },
    });
    return session;
  };
}

export interface SessionAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  getState(): Promise<SessionState>;
  getMessages(): Promise<AgentMessage[]>;
  getCommands(): Promise<WebSlashCommand[]>;
  getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }>;
  navigateTree(entryId: string): Promise<void>;
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
    const { assistantExtensions } = await import("../extensions");
    const { discoverAgents, PAPER_ASSISTANT_AGENT } = await import("../subagent/agents");
    const { splitModelRef } = await import("./agent-models");
    const agentDir = getAgentDir();
    const creator = createPiAgentSessionCreator({
      agentDir,
      extensionFactories: assistantExtensions.map(({ name, factory }) => ({ name, factory })),
      createSessionManager: (cwd) => pi.SessionManager.create(cwd),
      openSessionManager: (path) => pi.SessionManager.open(path),
      createSettingsManager: (cwd, root) => pi.SettingsManager.create(cwd, root),
      createModelRuntime: (root) =>
        pi.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") }),
      createResourceLoader: (options) =>
        new pi.DefaultResourceLoader(options as ConstructorParameters<typeof pi.DefaultResourceLoader>[0]),
      createAgentSession: async (options) => {
        const result = await pi.createAgentSession(options as Parameters<typeof pi.createAgentSession>[0]);
        return { session: result.session as unknown as BindableAgentSession };
      },
      resolveModel: async (cwd, runtime) => {
        const configured = (await discoverAgents({ cwd, agentDir })).agents.find(
          (agent) => agent.name === PAPER_ASSISTANT_AGENT,
        )?.model;
        if (!configured) return undefined;
        const { provider, modelId } = splitModelRef(configured);
        return (runtime as { getModel(provider: string, modelId: string): Model<any> | undefined }).getModel(
          provider,
          modelId,
        );
      },
      resolveSkillPaths: async (cwd) => {
        const { resolveAgentSkillDirectories, isDotAgentsSkillEnabled } = await import("../subagent/skill-resolution");
        const settingsManager = pi.SettingsManager.create(cwd, agentDir);
        const assistant = (await discoverAgents({ cwd, agentDir })).agents.find(
          (agent) => agent.name === PAPER_ASSISTANT_AGENT,
        );
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
  private session: InProcessAgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;
  private readonly listeners = new Set<(event: unknown) => void>();

  constructor(
    private readonly createAgentSession: AgentSessionCreator,
    private readonly options: StartSessionOptions,
  ) {}

  async start(): Promise<void> {
    if (this.session) throw new Error("Session already started");
    if (this.stopped) throw new Error("Session already stopped");
    this.session = await this.createAgentSession(this.options);
    this.unsubscribe = this.session.subscribe((event) => {
      const jsonEvent = toJsonSessionEvent(event as AgentSessionEvent);
      for (const listener of this.listeners) listener(jsonEvent);
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const session = this.session;
    if (!session) return;
    if (session.isStreaming) await session.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    session.dispose();
  }

  async prompt(message: string): Promise<void> {
    await this.requiredSession().prompt(message);
  }

  async abort(): Promise<void> {
    await this.requiredSession().abort();
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
    return [...this.requiredSession().messages];
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

  private requiredSession(): InProcessAgentSession {
    if (!this.session) throw new Error("Session has not started");
    if (this.stopped) throw new Error("Session has stopped");
    return this.session;
  }
}
