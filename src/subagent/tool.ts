import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getInternalPiInvocation } from "../runtime/internal-invocation";
import { getAgentDir, importPi } from "../runtime/pi-import";
import { discoverAgents, type AgentConfig } from "./agents";
import { resolveModelForSpawn } from "./model-resolution";
import { releaseSubagentLock, tryAcquireSubagentLock } from "./serial";

/**
 * ADR-022: stage-agent runtimes mount the subagent-only extension so nested
 * dispatch (experiment/writing/figures → search) works.
 */
const SUBAGENT_EXTENSION_PATH = fileURLToPath(new URL("./subagent-extension.ts", import.meta.url));

/** ADR-022: named session line per (pipeline cwd, agent). */
export const SUBAGENT_SESSION_PREFIX = "lazyresearch:";

/** Environment variable carrying the caller's subagent allowlist (ADR-022). */
export const ALLOWLIST_ENV = "LAZYRESEARCH_AGENTS_ALLOWLIST";

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
}

export interface SubagentDetails {
  mode: "single" | "chain";
  projectAgentsDir: string | null;
  results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant") {
      for (const part of msg.content) {
        const text = typeof part === "string" ? part : part.type === "text" ? part.text : undefined;
        if (text) return text;
      }
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
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lazyresearch-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return filePath;
}

/** ADR-022: named session line for an agent, e.g. `lazyresearch:search`. */
export function sessionNameFor(agentName: string): string {
  return `${SUBAGENT_SESSION_PREFIX}${agentName}`;
}

/**
 * ADR-022: filter agents by the caller's allowlist. The orchestrator runtime
 * has no allowlist env and sees all agents; stage runtimes receive their
 * allowlist from `subagents:` frontmatter via the spawn environment.
 */
export function filterAgentsByAllowlist(agents: AgentConfig[], allowlistEnv?: string): AgentConfig[] {
  if (allowlistEnv === undefined) return agents;
  const allowed = new Set(allowlistEnv.split(",").map((s) => s.trim()).filter(Boolean));
  return agents.filter((a) => allowed.has(a.name));
}

/**
 * ADR-022: resolve the agent's most recent named session line under `cwd` so
 * the call can inherit its previous context. Returns undefined when no such
 * session exists yet (the call then starts a fresh named session).
 */
export async function resolveInheritedSession(
  cwd: string,
  agentName: string,
  sessionDir?: string,
): Promise<string | undefined> {
  const { SessionManager } = await importPi();
  const sessions = await SessionManager.list(cwd, sessionDir);
  const target = sessionNameFor(agentName);
  const matches = sessions.filter((s) => s.name === target);
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return matches[0]!.path;
}

export function buildPiArgs(
  agent: AgentConfig,
  model: string | undefined,
  task: string,
  sessionPath?: string,
): string[] {
  const args: string[] = ["--mode", "json", "-p"];
  if (model) args.push("--model", model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
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
}

async function runSingleAgent(opts: RunSingleOptions): Promise<SingleResult> {
  const { defaultCwd, agents, agentName, task, cwd, model, sessionPath, signal, step } = opts;
  const agent = agents.find((a) => a.name === agentName);

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
    const args = buildPiArgs(agent, model, task, sessionPath);
    if (agent.systemPrompt.trim()) {
      tmpPromptPath = await writePromptToTempFile(agent.name, agent.systemPrompt);
      args.push("--append-system-prompt", tmpPromptPath);
    }
    args.push(`Task: ${task}`);

    let wasAborted = false;
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation();
      const proc = spawn(invocation.command, [...invocation.args, ...args], {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // ADR-022: the child runtime filters its available agents through this.
        env: agent.subagents ? { ...process.env, [ALLOWLIST_ENV]: agent.subagents.join(",") } : undefined,
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
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
        }
        if (event.type === "tool_result_end" && event.message) {
          result.messages.push(event.message as Message);
        }
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
  description: "inherit resumes the agent's previous session line; new starts a fresh one (default: inherit)",
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

export const subagentTool = defineTool({
  name: "subagent",
  label: "Subagent",
  description: [
    "Delegate tasks to specialized subagents with isolated context.",
    "Modes: single (agent + task) or chain (sequential with {previous} placeholder).",
    "Invocations are strictly serial: while one subagent runs, further calls return an error.",
    "session defaults to inherit: the agent resumes its previous session line and remembers its prior work; use session=new for a fresh line.",
    "Available agents are defined in the config root agents dir.",
  ].join(" "),
  parameters: SubagentParams,

  async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
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
      const agents = filterAgentsByAllowlist(discoverAgents().agents, process.env[ALLOWLIST_ENV]);
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
            step.session === "new" ? undefined : await resolveInheritedSession(ctx.cwd, step.agent);
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const model = await resolveModelForSpawn(ctx, step.agent, fallbackModel);
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
        const sessionPath = params.session === "new" ? undefined : await resolveInheritedSession(ctx.cwd, params.agent);
        const model = await resolveModelForSpawn(ctx, params.agent, fallbackModel);
        const result = await runSingleAgent({
          defaultCwd: ctx.cwd,
          agents,
          agentName: params.agent,
          task: params.task,
          cwd: params.cwd,
          model,
          sessionPath,
          signal,
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

export function describeModel(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  if (!model) return undefined;
  return `${model.provider}/${model.id}`;
}

export type { AgentToolResult };
