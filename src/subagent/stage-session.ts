import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { toJsonSessionEvent } from "../runtime/json-session-event";
import type { AgentConfig } from "./agents";
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
  wasAborted?: boolean;
}

export interface StageRunOptions {
  agent: AgentConfig;
  task: string;
  cwd: string;
  model?: string;
  thinking?: string;
  sessionPath?: string;
  signal?: AbortSignal;
  step?: number;
  onSessionHeader?: (header: { id: string; cwd: string }) => void;
  onEvent?: (event: unknown) => void;
}

export type StageSessionRunner = (options: StageRunOptions) => Promise<StageRunResult>;

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

export interface StageSessionDependencies {
  agentDir: string;
  createSessionManager(cwd: string): unknown;
  openSessionManager(path: string): unknown;
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
  createExtensionFactories(agent: AgentConfig): unknown[];
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

export function createStageSessionRunner(deps: StageSessionDependencies): StageSessionRunner {
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
      step: options.step,
      sessionPath: options.sessionPath,
    };
    let session: StageAgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let abortListener: (() => void) | undefined;
    let abortPromise: Promise<void> | undefined;
    const abortSession = () => {
      abortPromise = session?.abort().catch(() => {});
    };
    try {
      const sessionManager = options.sessionPath
        ? deps.openSessionManager(options.sessionPath)
        : deps.createSessionManager(options.cwd);
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
        extensionFactories: deps.createExtensionFactories(options.agent),
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
      unsubscribe = session.subscribe((event) => {
        if (result.wasAborted && (event as { type?: unknown }).type === "agent_start") abortSession();
        options.onEvent?.(toJsonSessionEvent(event as AgentSessionEvent));
        collectMessageEvent(result, event);
      });
      await session.bindExtensions({ mode: "rpc" });
      if (!options.agent.tools || options.agent.tools.length === 0) {
        session.setActiveToolsByName(session.getAllTools().map(({ name }) => name));
      }
      session.setSessionName(sessionNameFor(options.agent.name));
      result.sessionId = session.sessionId;
      result.sessionPath = session.sessionFile;
      options.onSessionHeader?.({ id: session.sessionId, cwd: options.cwd });

      abortListener = () => {
        result.wasAborted = true;
        abortSession();
      };
      if (options.signal?.aborted) {
        abortListener();
        result.exitCode = 1;
      } else {
        options.signal?.addEventListener("abort", abortListener, { once: true });
        await session.prompt(`Task: ${options.task}`);
      }
      await abortPromise;
      result.sessionPath = session.sessionFile;
      if (result.wasAborted) result.exitCode = 1;
      return result;
    } catch (error) {
      result.exitCode = 1;
      result.errorMessage = error instanceof Error ? error.message : String(error);
      result.stderr = result.errorMessage;
      return result;
    } finally {
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
      unsubscribe?.();
      session?.dispose();
    }
  };
}

let defaultRunner: Promise<StageSessionRunner> | undefined;

export async function runStageSession(options: StageRunOptions): Promise<StageRunResult> {
  const { assertSafeExtensionSources } = await import("../runtime/extensions-guard");
  assertSafeExtensionSources({ cwd: options.cwd });
  defaultRunner ??= resolveDefaultStageSessionRunner();
  return (await defaultRunner)(options);
}

async function resolveDefaultStageSessionRunner(): Promise<StageSessionRunner> {
  const { join } = await import("node:path");
  const { importPi, getAgentDir } = await import("../runtime/pi-import");
  const pi = await importPi();
  const { createSubagentExtension } = await import("../extensions/subagent");
  const { default: webSearchExtension } = await import("../extensions/web-search");
  const { default: webFetchExtension } = await import("../extensions/webfetch");
  const {
    defaultSkillDirectories,
    isDotAgentsSkillEnabled,
    resolveSkillDirectories,
  } = await import("./skill-resolution");
  const agentDir = getAgentDir();
  return createStageSessionRunner({
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
    createExtensionFactories: (agent) => [
      {
        name: "subagent",
        factory: createSubagentExtension({
          callerAgent: agent.name,
          allowedSubagents: agent.subagents,
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
      return agent.skills && agent.skills.length > 0
        ? (resolveSkillDirectories(agent.skills, deps) ?? [])
        : defaultSkillDirectories(deps);
    },
  });
}

function collectMessageEvent(result: StageRunResult, event: unknown): void {
  if (!event || typeof event !== "object") return;
  const candidate = event as { type?: string; message?: AgentMessage };
  if (candidate.type !== "message_end" || !candidate.message) return;
  const message = candidate.message;
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
