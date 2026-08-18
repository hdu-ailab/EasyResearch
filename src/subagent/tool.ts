import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../runtime/logger";
import { getAgentDir, importPi } from "../runtime/pi-import";
import { discoverAgents, PAPER_ASSISTANT_AGENT, type AgentConfig } from "./agents";
import { resolveModelForSpawn } from "./model-resolution";
import { resolveThinkingForSpawn } from "./thinking-resolution";
import type { SubagentSessionLink } from "./session-links";
import {
  runStageSession,
  type StageRunResult,
  type StageSessionRunner,
  type StageUsageStats,
} from "./stage-session";

const subagentLogger = createLogger("subagent");

type UsageStats = StageUsageStats;

export interface SingleResult extends StageRunResult {}

export interface SubagentDetails {
  mode: "single" | "chain";
  projectAgentsDir: string | null;
  results: SingleResult[];
  /** Live progress from the running subagent child (ADR-040). */
  subagent?: SubagentStreamUpdate;
}

export class SubagentExecutionError extends Error {
  constructor(
    message: string,
    readonly details: SubagentDetails,
  ) {
    super(message);
    this.name = "SubagentExecutionError";
  }
}

/** Complete latest-message payload streamed via the tool update callback (ADR-040). */
export interface SubagentStreamUpdate {
  agent: string;
  step?: number;
  status: "running";
  sessionId?: string;
  latestMessage?: string;
  event?: JsonAgentSessionEvent;
}

const CHILD_LIFECYCLE_EVENTS = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function progressFromMessage(
  agent: string,
  step: number | undefined,
  message: Message,
): SubagentStreamUpdate | undefined {
  if (message.role !== "assistant") return undefined;
  const latestMessage = getMessageText(message);
  return latestMessage ? { agent, step, status: "running", latestMessage } : undefined;
}

function getMessageText(message: Message): string {
  const rawContent: unknown = message.content;
  const content: unknown[] = typeof rawContent === "string" ? [rawContent] : Array.isArray(rawContent) ? rawContent : [];
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part === null || typeof part !== "object" || !("type" in part) || part.type !== "text") return "";
      return "text" in part && typeof part.text === "string" ? part.text : "";
    })
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant") {
      const text = getMessageText(msg);
      if (text) return text;
    }
  }
  return "";
}

function isFailedResult(result: SingleResult): boolean {
  return result.wasAborted === true || result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    if (result.wasAborted) return "Subagent was aborted";
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

function makeDetails(mode: "single" | "chain", _agents: AgentConfig[]): SubagentDetails {
  return { mode, projectAgentsDir: getAgentDir(), results: [] };
}

/**
 * ADR-022: filter enabled specialists by a caller and optional allowlist. The
 * main Assistant is never a recursive dispatch target.
 */
export function filterAgentsByAllowlist(
  agents: AgentConfig[],
  allowlistEnv?: string,
  callerAgent?: string,
): AgentConfig[] {
  agents = agents.filter((agent) => agent.enabled && agent.name !== PAPER_ASSISTANT_AGENT && agent.name !== callerAgent);
  if (allowlistEnv === undefined) return agents;
  const allowed = new Set(allowlistEnv.split(",").map((s) => s.trim()).filter(Boolean));
  return agents.filter((a) => allowed.has(a.name));
}

export interface ResolveSessionArgResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

/**
 * ADR-082: a non-empty `session` value is an explicit transcript JSONL path
 * (absolute or exact-cwd relative) that resumes an existing child session.
 * Empty/whitespace means "start a fresh child". The coordinator's own session
 * file is refused to prevent resuming the parent as a subagent.
 */
export function resolveSessionArg(
  cwd: string,
  raw: string,
  parentSessionFile?: string,
  exists: (path: string) => boolean = existsSync,
): ResolveSessionArgResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true };
  const resolved = resolve(cwd, trimmed);
  if (!exists(resolved)) {
    return { ok: false, reason: `Session file does not exist: ${resolved}` };
  }
  if (parentSessionFile && resolved === resolve(cwd, parentSessionFile)) {
    return { ok: false, reason: "Refusing to resume the coordinator's own session file" };
  }
  return { ok: true, path: resolved };
}

export async function resolveSessionPath(
  cwd: string,
  sessionId: string,
  sessionDir?: string,
): Promise<string | undefined> {
  const { SessionManager } = await importPi();
  const sessions = await SessionManager.list(cwd, sessionDir);
  return sessions.find((session) => session.id === sessionId)?.path;
}

export interface RunSingleOptions {
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  cwd?: string;
  /** Effective model to spawn the agent with (ADR-008 superseded: resolved upstream). */
  model?: string;
  /** Effective thinking level to spawn the agent with. */
  thinking?: string;
  sessionPath?: string;
  signal?: AbortSignal;
  step?: number;
  /** Complete latest-message callback (ADR-040): invoked on each child message_end. */
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
  onSessionHeader?: (header: { id: string; cwd: string }) => void;
  stageSessionRunner?: StageSessionRunner;
}

async function runSingleAgent(opts: RunSingleOptions): Promise<SingleResult> {
  const { defaultCwd, agents, agentName, task, cwd, model, thinking, sessionPath, signal, step, onUpdate, onSessionHeader } = opts;
  const agent = agents.find((a) => a.name === agentName);
  const detailsBase = { mode: "single" as const, projectAgentsDir: getAgentDir(), results: [] };

  const emptyUsage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage,
      step,
    };
  }

  const runner = opts.stageSessionRunner ?? runStageSession;
  let liveSessionId: string | undefined;
  const result = await runner({
    agent,
    task,
    cwd: cwd ?? defaultCwd,
    model,
    thinking,
    sessionPath,
    signal,
    step,
    onSessionHeader: (header) => {
      liveSessionId = header.id;
      onSessionHeader?.(header);
      onUpdate?.({
        content: [],
        details: {
          ...detailsBase,
          subagent: { agent: agentName, step, status: "running", sessionId: header.id },
        },
      });
    },
    onEvent: (event) => {
      if (!isObject(event) || typeof event.type !== "string" || !CHILD_LIFECYCLE_EVENTS.has(event.type)) return;
      const jsonEvent = event as unknown as JsonAgentSessionEvent;
      const progress: SubagentStreamUpdate = {
        agent: agentName,
        step,
        status: "running",
        ...(liveSessionId ? { sessionId: liveSessionId } : {}),
        event: jsonEvent,
      };
      if (jsonEvent.type === "message_end") {
        const completed = progressFromMessage(agentName, step, jsonEvent.message as unknown as Message);
        if (completed?.latestMessage) progress.latestMessage = completed.latestMessage;
      }
      onUpdate?.({ content: [], details: { ...detailsBase, subagent: progress } });
    },
  });
  if (sessionPath) {
    result.sessionPath = sessionPath;
  } else if (!result.sessionPath && result.sessionId) {
    try {
      result.sessionPath = await resolveSessionPath(cwd ?? defaultCwd, result.sessionId);
    } catch {
      // Session-history metadata must not replace the stage outcome.
    }
  }
  return result;
}

function formatSessionHistory(results: readonly SingleResult[], mode: "single" | "chain"): string {
  const persisted = results.filter((result) => result.sessionPath);
  if (persisted.length === 0) return "";
  const paths = mode === "single"
    ? [`Session history JSONL: ${persisted[0]!.sessionPath}`]
    : persisted.map((result) =>
      `Session history JSONL (step ${result.step}, ${result.agent}): ${result.sessionPath}`);
  const instruction = persisted.length === 1
    ? 'Inspect this file from the bottom for the latest saved progress. To continue this agent, pass that child\'s transcript JSONL path in session.'
    : 'Inspect these files from the bottom for the latest saved progress. To continue an agent, pass that child\'s transcript JSONL path in session.';
  return [...paths, instruction].join("\n");
}

function appendSessionHistory(output: string, results: readonly SingleResult[], mode: "single" | "chain"): string {
  const history = formatSessionHistory(results, mode);
  return history ? `${output}\n\n${history}` : output;
}

function formatSingleSuccess(result: SingleResult): string {
  return appendSessionHistory(getFinalOutput(result.messages) || "(no output)", [result], "single");
}

function formatChainSuccess(results: readonly SingleResult[]): string {
  return appendSessionHistory(
    getFinalOutput(results[results.length - 1]!.messages) || "(no output)",
    results,
    "chain",
  );
}

function formatSingleFailure(result: SingleResult): string {
  return appendSessionHistory(
    `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}`,
    [result],
    "single",
  );
}

function formatChainFailure(result: SingleResult, results: readonly SingleResult[]): string {
  return appendSessionHistory(
    `Chain stopped at step ${result.step} (${result.agent}): ${getResultOutput(result)}`,
    results,
    "chain",
  );
}

const SessionPath = Type.Optional(
  Type.String({
    description: "Transcript JSONL path to resume (absolute or exact-cwd relative); empty/omitted starts a fresh child session.",
  }),
);

const SingleParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke" })),
  task: Type.Optional(Type.String({ description: "Task to delegate" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent runtime" })),
  session: SessionPath,
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent runtime" })),
  session: SessionPath,
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent runtime (single mode)" })),
  session: SessionPath,
});

export function createSubagentTool(options: {
  persistSessionLink?: (link: SubagentSessionLink) => void;
  agentProvider?: (cwd: string) => Promise<AgentConfig[]>;
  stageSessionRunner?: StageSessionRunner;
} = {}) {
  let active = false;
  return defineTool({
    name: "subagent",
  label: "Subagent",
  description: [
    "Delegate tasks to specialized subagents with isolated context.",
    "Modes: single (agent + task) or chain (sequential with {previous} placeholder).",
    "Invocations are strictly serial: while one subagent runs, further calls return an error.",
    "session is a transcript JSONL path to resume (omitted/empty starts a fresh child).",
    "Available agents are defined in the config root agents dir.",
  ].join(" "),
  parameters: SubagentParams,

  async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
    if (active) {
      throw new SubagentExecutionError(
        "Another subagent is still running. Subagent invocations are strictly serial; wait for it to complete and call this tool again.",
        { mode: "single", projectAgentsDir: getAgentDir(), results: [] },
      );
    }
    active = true;
    try {
      const persistedSessionLinks = new Set<string>();
      const persistSessionLink = (agent: string, step: number | undefined, childSessionId: string) => {
        const key = JSON.stringify([toolCallId, step ?? null, childSessionId]);
        if (persistedSessionLinks.has(key)) return;
        persistedSessionLinks.add(key);
        options.persistSessionLink?.(step === undefined
          ? { toolCallId, childSessionId, agent }
          : { toolCallId, childSessionId, agent, step });
      };
      const fallbackModel = describeModel(ctx);
      const fallbackThinking = describeThinking(ctx);
      const agentsForCwd = async (cwd: string) => {
        const discovered = options.agentProvider
          ? await options.agentProvider(cwd)
          : (await discoverAgents({ cwd })).agents;
        return filterAgentsByAllowlist(discovered);
      };
      const detailsBase = (mode: "single" | "chain", agents: AgentConfig[]) => makeDetails(mode, agents);

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasSingle);

      if (modeCount !== 1) {
        const agents = await agentsForCwd(ctx.cwd);
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        throw new SubagentExecutionError(
          `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
          { ...detailsBase("single", agents), results: [] },
        );
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";
        let lastAgents: AgentConfig[] = [];
        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i]!;
          const effectiveCwd = step.cwd ?? ctx.cwd;
          const agents = await agentsForCwd(effectiveCwd);
          lastAgents = agents;
          if (agents.length === 0) {
            throw new SubagentExecutionError(
              "No agents are available in this runtime.",
              { ...detailsBase("chain", agents), results },
            );
          }
          const sessionArg = step.session !== undefined
            ? resolveSessionArg(effectiveCwd, step.session, ctx.sessionManager.getSessionFile?.())
            : { ok: true };
          if (!sessionArg.ok) {
            throw new SubagentExecutionError(
              sessionArg.reason!,
              { ...detailsBase("chain", agents), results },
            );
          }
          const sessionPath = sessionArg.path;
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const model = await resolveModelForSpawn(
            { cwd: effectiveCwd, sessionManager: ctx.sessionManager },
            step.agent,
            fallbackModel,
          );
          subagentLogger?.debug("subagent model resolved", { agent: step.agent, model: model ?? "" });
          const thinking = await resolveThinkingForSpawn(
            { cwd: effectiveCwd, sessionManager: ctx.sessionManager },
            step.agent,
            fallbackThinking,
          );
          subagentLogger?.debug("subagent thinking resolved", { agent: step.agent, thinking });
          const result = await runSingleAgent({
            defaultCwd: ctx.cwd,
            agents,
            agentName: step.agent,
            task: taskWithContext,
            cwd: step.cwd,
            model,
            thinking,
            sessionPath,
            signal,
            step: i + 1,
            onUpdate,
            onSessionHeader: (header) => persistSessionLink(step.agent, i + 1, header.id),
            stageSessionRunner: options.stageSessionRunner,
          });
          results.push(result);
          if (isFailedResult(result)) {
            throw new SubagentExecutionError(
              formatChainFailure(result, results),
              { ...detailsBase("chain", agents), results },
            );
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [{ type: "text", text: formatChainSuccess(results) }],
          details: { ...detailsBase("chain", lastAgents), results },
        };
      }

      if (params.agent && params.task) {
        const effectiveCwd = params.cwd ?? ctx.cwd;
        const agents = await agentsForCwd(effectiveCwd);
        if (agents.length === 0) {
          throw new SubagentExecutionError(
            "No agents are available in this runtime.",
            { ...detailsBase("single", agents), results: [] },
          );
        }
        const sessionArg = params.session !== undefined
          ? resolveSessionArg(effectiveCwd, params.session, ctx.sessionManager.getSessionFile?.())
          : { ok: true };
        if (!sessionArg.ok) {
          throw new SubagentExecutionError(
            sessionArg.reason!,
            { ...detailsBase("single", agents), results: [] },
          );
        }
        const sessionPath = sessionArg.path;
        const model = await resolveModelForSpawn(
          { cwd: effectiveCwd, sessionManager: ctx.sessionManager },
          params.agent,
          fallbackModel,
        );
        subagentLogger?.debug("subagent model resolved", { agent: params.agent, model: model ?? "" });
        const thinking = await resolveThinkingForSpawn(
          { cwd: effectiveCwd, sessionManager: ctx.sessionManager },
          params.agent,
          fallbackThinking,
        );
        subagentLogger?.debug("subagent thinking resolved", { agent: params.agent, thinking });
        const result = await runSingleAgent({
          defaultCwd: ctx.cwd,
          agents,
          agentName: params.agent,
          task: params.task,
          cwd: params.cwd,
          model,
          thinking,
          sessionPath,
          signal,
          onUpdate,
          onSessionHeader: (header) => persistSessionLink(params.agent!, undefined, header.id),
          stageSessionRunner: options.stageSessionRunner,
        });
        if (isFailedResult(result)) {
          throw new SubagentExecutionError(
            formatSingleFailure(result),
            { ...detailsBase("single", agents), results: [result] },
          );
        }
        return {
          content: [{ type: "text", text: formatSingleSuccess(result) }],
          details: { ...detailsBase("single", agents), results: [result] },
        };
      }

      const agents = await agentsForCwd(ctx.cwd);
      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      throw new SubagentExecutionError(
        `Invalid parameters. Available agents: ${available}`,
        { ...detailsBase("single", agents), results: [] },
      );
    } finally {
      active = false;
    }
  },
  });
}

export const subagentTool = createSubagentTool();

export function describeModel(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  if (!model) return undefined;
  return `${model.provider}/${model.id}`;
}

export function describeThinking(ctx: ExtensionContext): string | undefined {
  return ctx.thinkingLevel;
}

export type { AgentToolResult };
