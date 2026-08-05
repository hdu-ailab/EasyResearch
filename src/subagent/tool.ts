import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getInternalPiInvocation } from "../runtime/internal-invocation";
import { getAgentDir } from "../runtime/pi-import";
import { discoverAgents, type AgentConfig } from "./agents";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

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
  mode: "single" | "parallel" | "chain";
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

function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

function makeDetails(mode: "single" | "parallel" | "chain", agents: AgentConfig[]): SubagentDetails {
  return { mode, projectAgentsDir: getAgentDir(), results: [] };
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      const item = items[current]!;
      results[current] = await fn(item, current);
    }
  });
  await Promise.all(workers);
  return results;
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

export function buildPiArgs(agent: AgentConfig, fallbackModel: string | undefined, task: string): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) {
    args.push("--model", agent.model);
  } else if (fallbackModel) {
    // ADR-008: subagents without a model fall back to the orchestrator's model.
    args.push("--model", fallbackModel);
  }
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
  return args;
}

export interface RunSingleOptions {
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  cwd?: string;
  fallbackModel?: string;
  signal?: AbortSignal;
  step?: number;
}

async function runSingleAgent(opts: RunSingleOptions): Promise<SingleResult> {
  const { defaultCwd, agents, agentName, task, cwd, fallbackModel, signal, step } = opts;
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
    model: agent.model,
    step,
  };

  let tmpPromptPath: string | null = null;
  try {
    const args = buildPiArgs(agent, fallbackModel, task);
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

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export const subagentTool = defineTool({
  name: "subagent",
  label: "Subagent",
  description: [
    "Delegate tasks to specialized subagents with isolated context.",
    "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
    "Available agents are defined in the config root agents dir plus bundled agents.",
  ].join(" "),
  parameters: SubagentParams,

  async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
    const agents = discoverAgents().agents;
    const fallbackModel = describeModel(ctx);
    const detailsBase = (mode: "single" | "parallel" | "chain") => makeDetails(mode, agents);

    const hasChain = (params.chain?.length ?? 0) > 0;
    const hasTasks = (params.tasks?.length ?? 0) > 0;
    const hasSingle = Boolean(params.agent && params.task);
    const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

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
        const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
        const result = await runSingleAgent({
          defaultCwd: ctx.cwd,
          agents,
          agentName: step.agent,
          task: taskWithContext,
          cwd: step.cwd,
          fallbackModel,
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

    if (params.tasks && params.tasks.length > 0) {
      if (params.tasks.length > MAX_PARALLEL_TASKS) {
        return {
          content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
          details: { ...detailsBase("parallel"), results: [] },
        };
      }
      const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, (t, index) =>
        runSingleAgent({
          defaultCwd: ctx.cwd,
          agents,
          agentName: t.agent,
          task: t.task,
          cwd: t.cwd,
          fallbackModel,
          signal,
          step: index + 1,
        }),
      );
      const successCount = results.filter((r) => !isFailedResult(r)).length;
      const summaries = results.map((r) => {
        const output = truncateParallelOutput(getResultOutput(r));
        const status = isFailedResult(r) ? "failed" : "completed";
        return `### [${r.agent}] ${status}\n\n${output}`;
      });
      return {
        content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
        details: { ...detailsBase("parallel"), results },
      };
    }

    if (params.agent && params.task) {
      const result = await runSingleAgent({
        defaultCwd: ctx.cwd,
        agents,
        agentName: params.agent,
        task: params.task,
        cwd: params.cwd,
        fallbackModel,
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
  },
});

export function describeModel(ctx: ExtensionContext): string | undefined {
  const model = ctx.model;
  if (!model) return undefined;
  return `${model.provider}/${model.id}`;
}

export type { AgentToolResult };
