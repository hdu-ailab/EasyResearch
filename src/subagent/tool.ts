import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../runtime/logger";
import { getAgentDir, importPi } from "../runtime/pi-import";
import {
  AGENT_ALIAS_ENTRY,
  formatAgentId,
  isAgentId,
  nextAgentIndex,
  readAgentAliases,
  resolveAgentAlias,
} from "./agent-alias";
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
  mode: "single";
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

function makeDetails(_agents: AgentConfig[]): SubagentDetails {
  return { mode: "single", projectAgentsDir: getAgentDir(), results: [] };
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

/** Minimal duck-typed coordinator (main session) SessionManager surface used
 * for reading and appending agent-id aliases (ADR-084). */
export interface AliasSessionManager {
  getEntries(): unknown[];
  appendCustomEntry(customType: string, data?: unknown): string;
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

export interface ResolvedAgentTarget {
  /** Agent name to dispatch: the alias owner for an id-resume, else the bare name. */
  name: string;
  /** Child session file to resume (undefined = fresh child). */
  path?: string;
  /** Agent id of the resumed child, echoed in the output (ADR-084). */
  activeId?: string;
}

export type ResolveAgentTargetResult =
  | { ok: true; target: ResolvedAgentTarget }
  | { ok: false; reason: string };

/** ADR-086: the `subagent` tool has no `session` parameter. Continuation uses
 * the agent-id mechanism: an `agent` value that is an agent id (`<agent>_<seq>`
 * known to this main session) continues that mapped child; a bare agent name
 * starts a fresh dispatch. */
export function resolveAgentTarget(
  raw: string,
  coordinator: AliasSessionManager,
): ResolveAgentTargetResult {
  const trimmed = raw.trim();
  if (isAgentId(trimmed)) {
    const aliases = readAgentAliases(coordinator.getEntries());
    const alias = resolveAgentAlias(aliases, trimmed);
    if (!alias) {
      const known = aliases.map((candidate) => candidate.id).join(", ") || "none";
      return {
        ok: false,
        reason: `Unknown agent id "${trimmed}". Known agent ids in this session: ${known}.`,
      };
    }
    return { ok: true, target: { name: alias.agent, path: alias.sessionPath, activeId: alias.id } };
  }
  return { ok: true, target: { name: trimmed } };
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
  /** Agent id to echo and bind to the child session (ADR-084): the active id
   * for an id-resumed child, or the reserved id for a fresh child. */
  agentId?: string;
  coordinator?: AliasSessionManager;
  signal?: AbortSignal;
  step?: number;
  /** Complete latest-message callback (ADR-040): invoked on each child message_end. */
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
  onSessionHeader?: (header: { id: string; cwd: string }) => void;
  stageSessionRunner?: StageSessionRunner;
}

async function runSingleAgent(opts: RunSingleOptions): Promise<SingleResult> {
  const { defaultCwd, agents, agentName, task, cwd, model, thinking, sessionPath, agentId, coordinator, signal, step, onUpdate, onSessionHeader } = opts;
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
  const bindAlias = (header: { id: string; cwd: string; sessionPath?: string }) => {
    // ADR-084: persist the fresh child's agent id -> session file mapping on the
    // coordinator session immediately (before the child runs), so the next
    // agent_status snapshot and any resume-by-id resolve it. Resumed children
    // keep their existing alias entry.
    if (agentId && coordinator && !sessionPath && header.sessionPath) {
      coordinator.appendCustomEntry(AGENT_ALIAS_ENTRY, {
        id: agentId,
        agent: agentName,
        sessionId: header.id,
        sessionPath: header.sessionPath,
      });
    }
    onSessionHeader?.(header);
  };
  const result = await runner({
    agent,
    task,
    cwd: cwd ?? defaultCwd,
    model,
    thinking,
    sessionPath,
    ownerSessionManager: coordinator,
    signal,
    step,
    onSessionHeader: (header) => {
      liveSessionId = header.id;
      bindAlias(header);
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
  result.agentId = agentId;
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

function formatSessionHistory(results: readonly SingleResult[]): string {
  const persisted = results.filter((result) => result.sessionPath);
  if (persisted.length === 0) return "";
  const entries = persisted.map((result) =>
    [result.agentId === undefined ? "" : `Agent id: ${result.agentId}`, `Session history JSONL: ${result.sessionPath}`]
      .filter(Boolean)
      .join("\n"),
  );
  const instruction = 'Inspect this file from the bottom for the latest saved progress. To continue this agent, pass its agent id as the agent parameter (e.g. agent: "search_0").';
  return [...entries, instruction].join("\n");
}

function appendSessionHistory(output: string, results: readonly SingleResult[]): string {
  const history = formatSessionHistory(results);
  return history ? `${output}\n\n${history}` : output;
}

function formatSingleSuccess(result: SingleResult): string {
  return appendSessionHistory(getFinalOutput(result.messages) || "(no output)", [result]);
}

function formatSingleFailure(result: SingleResult): string {
  return appendSessionHistory(`Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}`, [result]);
}

/** ADR-084: the subagent tool's description lists only the caller's available
 * subagents; the list is resolved per session from the caller's allowlist. */
export function formatSubagentDescription(available: readonly string[]): string {
  const names = available.length > 0 ? available.join(", ") : "none";
  return [
    "Delegate tasks to specialized subagents with isolated context.",
    "Sub agents run in the exact project directory.",
    `Available subagents: ${names}.`,
  ].join("\n");
}

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({
    description: "Name of the agent to invoke, or its agent id (e.g. 'search_0') to continue that child of this session",
  })),
  task: Type.Optional(Type.String({ description: "Task to delegate" })),
});

export function createSubagentTool(options: {
  persistSessionLink?: (link: SubagentSessionLink) => void;
  agentProvider?: (cwd: string) => Promise<AgentConfig[]>;
  stageSessionRunner?: StageSessionRunner;
  /** Coordinator (main session) SessionManager for agent-id aliases; defaults
   * to the executing session's own manager (ADR-084). */
  coordinator?: unknown;
  /** Three-line tool description; the third line lists the caller's available
   * subagents (ADR-084). Pass `formatSubagentDescription(names)` from the
   * caller's allowlist; defaults to an empty list. */
  description?: string;
} = {}) {
  let active = false;
  return defineTool({
    name: "subagent",
  label: "Subagent",
  description: options.description ?? formatSubagentDescription([]),
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
      const coordinator = (options.coordinator ?? ctx.sessionManager) as AliasSessionManager;
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

      if (!(params.agent && params.task)) {
        const agents = await agentsForCwd(ctx.cwd);
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        throw new SubagentExecutionError(
          `Invalid parameters. Provide agent and task.\nAvailable agents: ${available}`,
          { ...makeDetails(agents), results: [] },
        );
      }

      if (params.agent && params.task) {
        const effectiveCwd = ctx.cwd;
        const agentTarget = resolveAgentTarget(params.agent, coordinator);
        if (!agentTarget.ok) {
          throw new SubagentExecutionError(
            agentTarget.reason!,
            { ...makeDetails([]), results: [] },
          );
        }
        const dispatchAgent = agentTarget.target.name;
        const agents = await agentsForCwd(effectiveCwd);
        if (agents.length === 0) {
          throw new SubagentExecutionError(
            "No agents are available in this runtime.",
            { ...makeDetails(agents), results: [] },
          );
        }
        const sessionPath = agentTarget.target.path;
        const agentId = sessionPath !== undefined
          ? agentTarget.target.activeId
          : formatAgentId(dispatchAgent, nextAgentIndex(readAgentAliases(coordinator.getEntries()), dispatchAgent));
        const model = await resolveModelForSpawn(
          { cwd: effectiveCwd, sessionManager: ctx.sessionManager },
          dispatchAgent,
          fallbackModel,
        );
        subagentLogger?.debug("subagent model resolved", { agent: dispatchAgent, model: model ?? "" });
        const thinking = await resolveThinkingForSpawn(
          { cwd: effectiveCwd, sessionManager: ctx.sessionManager },
          dispatchAgent,
          fallbackThinking,
        );
        subagentLogger?.debug("subagent thinking resolved", { agent: dispatchAgent, thinking });
        const result = await runSingleAgent({
          defaultCwd: ctx.cwd,
          agents,
          agentName: dispatchAgent,
          task: params.task,
          cwd: effectiveCwd,
          model,
          thinking,
          sessionPath,
          agentId,
          coordinator,
          signal,
          onUpdate,
          onSessionHeader: (header) => persistSessionLink(dispatchAgent, undefined, header.id),
          stageSessionRunner: options.stageSessionRunner,
        });
        if (isFailedResult(result)) {
          throw new SubagentExecutionError(
            formatSingleFailure(result),
            { ...makeDetails(agents), results: [result] },
          );
        }
        return {
          content: [{ type: "text", text: formatSingleSuccess(result) }],
          details: { ...makeDetails(agents), results: [result] },
        };
      }

      const agents = await agentsForCwd(ctx.cwd);
      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      throw new SubagentExecutionError(
        `Invalid parameters. Available agents: ${available}`,
        { ...makeDetails(agents), results: [] },
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
