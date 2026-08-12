import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getInternalPiInvocation } from "../runtime/internal-invocation";
import { createLogger, type Logger } from "../runtime/logger";
import { getAgentDir, importPi } from "../runtime/pi-import";
import { discoverAgents, type AgentConfig } from "./agents";
import { resolveModelForSpawn } from "./model-resolution";
import { readSubagentSessionLinks, sessionNameFor, type SubagentSessionLink } from "./session-links";
import { buildDefaultSkillArgs, readGlobalDotAgentsSkillSetting, resolveSkillDirectories } from "./skill-resolution";
import { releaseSubagentLock, tryAcquireSubagentLock } from "./serial";

/**
 * ADR-022: stage-agent runtimes mount the subagent-only extension so nested
 * dispatch (experiment/writing/figures → search) works.
 */
const SUBAGENT_EXTENSION_PATH = fileURLToPath(new URL("./subagent-extension.ts", import.meta.url));

/**
 * Pre-flight ruling (2026-08-08): `execute` runs inside the Web RPC child in
 * Web mode, so the module-scope logger is only created outside RPC children
 * (Constraint 4: RPC children never run their own logger).
 */
const subagentLogger: Logger | null =
  process.env.EASYRESEARCH_RPC_CHILD === "1" ? null : createLogger("subagent");

/** Environment variable carrying the caller's subagent allowlist (ADR-022). */
export const ALLOWLIST_ENV = "EASYRESEARCH_AGENTS_ALLOWLIST";

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  sessionId?: string;
}

export interface SubagentDetails {
  mode: "single" | "chain";
  projectAgentsDir: string | null;
  results: SingleResult[];
  /** Live progress from the running subagent child (ADR-040). */
  subagent?: SubagentStreamUpdate;
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

/** Per-child-line dispatch targets used by {@link handleChildLine}. */
export interface ChildLineHandlers {
  onSessionHeader?: (header: { id: string; cwd: string }) => void;
  onEvent?: (event: JsonAgentSessionEvent) => void;
  onMessageEnd: (message: Message) => void;
  onToolResultEnd: (message: Message) => void;
  onProgress?: (progress: SubagentStreamUpdate) => void;
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

/**
 * ADR-040: parse one child stdout JSONL line and dispatch. Completed assistant
 * `message_end` lines emit their complete text as live progress when an
 * `onProgress` handler is wired; malformed lines are ignored. Pure and
 * DI-friendly so the update-callback contract is testable without spawning a
 * child process.
 */
export function handleChildLine(
  line: string,
  agentName: string,
  step: number | undefined,
  handlers: ChildLineHandlers,
): void {
  if (!line.trim()) return;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!isObject(event)) return;
  if (event.type === "session") {
    if (typeof event.id === "string" && event.id.trim() && typeof event.cwd === "string" && event.cwd.trim()) {
      handlers.onSessionHeader?.({ id: event.id, cwd: event.cwd });
    }
    return;
  }
  if (typeof event.type === "string" && CHILD_LIFECYCLE_EVENTS.has(event.type)) {
    handlers.onEvent?.(event as unknown as JsonAgentSessionEvent);
  }
  if (!isObject(event.message)) return;
  if (event.type === "message_end") {
    const msg = event.message as unknown as Message;
    handlers.onMessageEnd(msg);
    if (handlers.onProgress) {
      const progress = progressFromMessage(agentName, step, msg);
      if (progress) handlers.onProgress(progress);
    }
  }
  if (event.type === "tool_result_end") {
    handlers.onToolResultEnd(event.message as unknown as Message);
  }
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
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

function makeDetails(mode: "single" | "chain", agents: AgentConfig[]): SubagentDetails {
  return { mode, projectAgentsDir: getAgentDir(), results: [] };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<string> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "easyresearch-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return filePath;
}

/**
 * ADR-022: filter agents by the caller's allowlist. The assistant runtime
 * has no allowlist env and sees all agents; stage runtimes receive their
 * allowlist from `subagents:` frontmatter via the spawn environment.
 */
export function filterAgentsByAllowlist(agents: AgentConfig[], allowlistEnv?: string): AgentConfig[] {
  agents = agents.filter((agent) => agent.enabled || agent.name === "assistant");
  if (allowlistEnv === undefined) return agents;
  const allowed = new Set(allowlistEnv.split(",").map((s) => s.trim()).filter(Boolean));
  return agents.filter((a) => allowed.has(a.name));
}

/**
 * ADR-044: resolve an explicitly requested inherited child from the current
 * parent's persisted UUID links. A repeatable child display name is not enough
 * to establish ownership because multiple parent sessions share a cwd.
 */
export async function resolveInheritedSession(
  cwd: string,
  agentName: string,
  sessionDir?: string,
  parentEntries: readonly unknown[] = [],
): Promise<string | undefined> {
  const { SessionManager } = await importPi();
  const links = readSubagentSessionLinks(parentEntries).filter((link) => link.agent === agentName);
  const link = links[links.length - 1];
  if (!link) return undefined;
  const sessions = await SessionManager.list(cwd, sessionDir);
  return sessions.find((session) => session.id === link.childSessionId)?.path;
}

export function buildPiArgs(
  agent: AgentConfig,
  model: string | undefined,
  task: string,
  sessionPath?: string,
  skillDeps?: { cwd: string; agentDir: string; homeDir?: string; enableDotAgentsSkill?: boolean },
): string[] {
  const args: string[] = ["--mode", "json", "-p"];
  if (model) args.push("--model", model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
  if (agent.skills && agent.skills.length > 0 && skillDeps) {
    args.push("--no-skills");
    for (const dir of resolveSkillDirectories(agent.skills, skillDeps) ?? []) args.push("--skill", dir);
  } else if (skillDeps) {
    args.push(...buildDefaultSkillArgs(skillDeps));
  }
  // ADR-022: nested dispatch needs the subagent tool inside stage runtimes.
  args.push("--extension", SUBAGENT_EXTENSION_PATH);
  args.push("--name", sessionNameFor(agent.name));
  if (sessionPath) args.push("--session", sessionPath);
  return args;
}

export interface RunSingleOptions {
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  cwd?: string;
  /** Effective model to spawn the agent with (ADR-008 superseded: resolved upstream). */
  model?: string;
  sessionPath?: string;
  signal?: AbortSignal;
  step?: number;
  /** Complete latest-message callback (ADR-040): invoked on each child message_end. */
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
  onSessionHeader?: (header: { id: string; cwd: string }) => void;
}

async function runSingleAgent(opts: RunSingleOptions): Promise<SingleResult> {
  const { defaultCwd, agents, agentName, task, cwd, model, sessionPath, signal, step, onUpdate, onSessionHeader } = opts;
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

  const result: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage,
    model,
    step,
  };

  let tmpPromptPath: string | null = null;
  try {
    const enableDotAgentsSkill = await readGlobalDotAgentsSkillSetting(cwd ?? defaultCwd, getAgentDir());
    const args = buildPiArgs(agent, model, task, sessionPath, {
      cwd: cwd ?? defaultCwd,
      agentDir: getAgentDir(),
      enableDotAgentsSkill,
    });
    if (agent.systemPrompt.trim()) {
      tmpPromptPath = await writePromptToTempFile(agent.name, agent.systemPrompt);
      args.push("--append-system-prompt", tmpPromptPath);
    }
    args.push(`Task: ${task}`);

    let wasAborted = false;
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation();
      const {
        EASYRESEARCH_AGENT_TOOLS: _parentTools,
        [ALLOWLIST_ENV]: _parentAllowlist,
        ...baseEnv
      } = process.env;
      const proc = spawn(invocation.command, [...invocation.args, ...args], {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...baseEnv,
          ...(agent.tools === undefined ? { EASYRESEARCH_AGENT_TOOLS: "all" } : {}),
          ...(agent.subagents ? { [ALLOWLIST_ENV]: agent.subagents.join(",") } : {}),
        },
      });
      let buffer = "";

      const processLine = (line: string) => {
        handleChildLine(line, agentName, step, {
          onSessionHeader: (header) => {
            result.sessionId = header.id;
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
            const progress: SubagentStreamUpdate = {
              agent: agentName,
              step,
              status: "running",
              ...(result.sessionId ? { sessionId: result.sessionId } : {}),
              event,
            };
            if (event.type === "message_end") {
              const completed = progressFromMessage(agentName, step, event.message as unknown as Message);
              if (completed?.latestMessage) progress.latestMessage = completed.latestMessage;
            }
            onUpdate?.({ content: [], details: { ...detailsBase, subagent: progress } });
          },
          onMessageEnd: (msg) => {
            result.messages.push(msg);
            if (msg.role === "assistant") {
              result.usage.turns++;
              const usage = msg.usage;
              if (usage) {
                result.usage.input += usage.input || 0;
                result.usage.output += usage.output || 0;
                result.usage.cacheRead += usage.cacheRead || 0;
                result.usage.cacheWrite += usage.cacheWrite || 0;
                result.usage.cost += usage.cost?.total || 0;
                result.usage.contextTokens = usage.totalTokens || 0;
              }
              if (!result.model && msg.model) result.model = msg.model;
              if (msg.stopReason) result.stopReason = msg.stopReason;
              if (msg.errorMessage) result.errorMessage = msg.errorMessage;
            }
          },
          onToolResultEnd: (msg) => {
            result.messages.push(msg);
          },
        });
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        result.stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      proc.on("error", () => resolve(1));

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    result.exitCode = exitCode;
    if (wasAborted) throw new Error("Subagent was aborted");
    return result;
  } finally {
    if (tmpPromptPath) {
      try {
        fs.unlinkSync(tmpPromptPath);
        fs.rmdirSync(path.dirname(tmpPromptPath));
      } catch {
        /* ignore */
      }
    }
  }
}

function getPiInvocation(): { command: string; args: string[] } {
  // Subagents always enter Pi through the private bootstrap entry, which
  // applies the temporary PI_PACKAGE_DIR initialization before main() runs.
  return getInternalPiInvocation();
}

const SessionMode = Type.Union([Type.Literal("inherit"), Type.Literal("new")], {
  description: "inherit resumes this parent session's mapped child; new starts a fresh one (default: new)",
});

const SingleParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke" })),
  task: Type.Optional(Type.String({ description: "Task to delegate" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  session: Type.Optional(SessionMode),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  session: Type.Optional(SessionMode),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
  session: Type.Optional(SessionMode),
});

export function createSubagentTool(options: {
  persistSessionLink?: (link: SubagentSessionLink) => void;
  agentProvider?: (cwd: string) => Promise<AgentConfig[]>;
} = {}) {
  return defineTool({
    name: "subagent",
  label: "Subagent",
  description: [
    "Delegate tasks to specialized subagents with isolated context.",
    "Modes: single (agent + task) or chain (sequential with {previous} placeholder).",
    "Invocations are strictly serial: while one subagent runs, further calls return an error.",
    "session defaults to new: each call gets a fresh child; use session=inherit only to resume this parent session's mapped child.",
    "Available agents are defined in the config root agents dir.",
  ].join(" "),
  parameters: SubagentParams,

  async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
    if (!tryAcquireSubagentLock()) {
      return {
        content: [
          {
            type: "text",
            text: "Another subagent is still running. Subagent invocations are strictly serial; wait for it to complete and call this tool again.",
          },
        ],
        details: { mode: "single", projectAgentsDir: getAgentDir(), results: [] },
        isError: true,
      };
    }
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
      const discoveredAgents = options.agentProvider
        ? await options.agentProvider(ctx.cwd)
        : (await discoverAgents({ cwd: ctx.cwd })).agents;
      const agents = filterAgentsByAllowlist(
        discoveredAgents,
        options.agentProvider ? undefined : process.env[ALLOWLIST_ENV],
      );
      const fallbackModel = describeModel(ctx);
      const detailsBase = (mode: "single" | "chain") => makeDetails(mode, agents);

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasSingle);

      if (agents.length === 0) {
        return {
          content: [{ type: "text", text: "No agents are available in this runtime." }],
          details: { ...detailsBase("single"), results: [] },
          isError: true,
        };
      }

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }],
          details: { ...detailsBase("single"), results: [] },
        };
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";
        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i]!;
          const sessionPath =
            step.session === "inherit"
              ? await resolveInheritedSession(step.cwd ?? ctx.cwd, step.agent, undefined, ctx.sessionManager.getEntries())
              : undefined;
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const model = await resolveModelForSpawn(ctx, step.agent, fallbackModel);
          subagentLogger?.debug("subagent model resolved", { agent: step.agent, model: model ?? "" });
          const result = await runSingleAgent({
            defaultCwd: ctx.cwd,
            agents,
            agentName: step.agent,
            task: taskWithContext,
            cwd: step.cwd,
            model,
            sessionPath,
            signal,
            step: i + 1,
            onUpdate,
            onSessionHeader: (header) => persistSessionLink(step.agent, i + 1, header.id),
          });
          results.push(result);
          if (isFailedResult(result)) {
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` }],
              details: { ...detailsBase("chain"), results },
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [{ type: "text", text: getFinalOutput(results[results.length - 1]!.messages) || "(no output)" }],
          details: { ...detailsBase("chain"), results },
        };
      }

      if (params.agent && params.task) {
        const sessionPath = params.session === "inherit"
          ? await resolveInheritedSession(params.cwd ?? ctx.cwd, params.agent, undefined, ctx.sessionManager.getEntries())
          : undefined;
        const model = await resolveModelForSpawn(ctx, params.agent, fallbackModel);
        subagentLogger?.debug("subagent model resolved", { agent: params.agent, model: model ?? "" });
        const result = await runSingleAgent({
          defaultCwd: ctx.cwd,
          agents,
          agentName: params.agent,
          task: params.task,
          cwd: params.cwd,
          model,
          sessionPath,
          signal,
          onUpdate,
          onSessionHeader: (header) => persistSessionLink(params.agent!, undefined, header.id),
        });
        if (isFailedResult(result)) {
          return {
            content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
            details: { ...detailsBase("single"), results: [result] },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
          details: { ...detailsBase("single"), results: [result] },
        };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return {
        content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
        details: { ...detailsBase("single"), results: [] },
      };
    } finally {
      releaseSubagentLock();
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

export type { AgentToolResult };
