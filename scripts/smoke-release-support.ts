import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { readFirstRunSetupEvidence } from "../src/runtime/first-run-setup-evidence";

export const FIRST_RUN_CEILING_MS = 720_000;

const PYTHON_CONTAMINATION_KEYS = new Set(["PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE"]);

export interface ResolveSmokePythonOptions {
  explicit?: string;
  which?: (name: string) => string | null | undefined;
  exists?: (path: string) => boolean;
}

export function resolveSmokePython(options: ResolveSmokePythonOptions = {}): string {
  const exists = options.exists ?? existsSync;
  if (options.explicit !== undefined) {
    if (!isAbsolute(options.explicit) || !exists(options.explicit)) {
      throw new Error(`EASYRESEARCH_SMOKE_PYTHON must name an existing absolute interpreter: ${options.explicit}`);
    }
    return options.explicit;
  }

  const which = options.which ?? Bun.which;
  for (const name of ["python3", "python"]) {
    const python = which(name);
    if (python && isAbsolute(python) && exists(python)) return python;
  }
  throw new Error("EASYRESEARCH_SMOKE_PYTHON is unset and no Python interpreter was found");
}

export function createCompiledChildEnv(options: {
  base: NodeJS.ProcessEnv;
  python: string;
  overrides?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = { ...options.base, ...options.overrides };
  const pythonDir = dirname(options.python);
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (normalized === "PATH" || PYTHON_CONTAMINATION_KEYS.has(normalized)) delete env[key];
  }
  env.PATH = pythonDir;
  env.PIP_RETRIES = "3";
  env.PIP_DEFAULT_TIMEOUT = "30";
  return env;
}

export function skillVenvPython(
  agentDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? win32.join(agentDir, "venv", "Scripts", "python.exe")
    : join(agentDir, "venv", "bin", "python");
}

export function writeVenvValidationScript(path: string): void {
  writeFileSync(path, `import os
import pathlib
import sys
import arxiv
import ddgr
import markitdown

expected = pathlib.Path(os.environ["EASYRESEARCH_VENV"]).resolve()
actual = pathlib.Path(sys.prefix).resolve()
if actual != expected:
    raise RuntimeError(f"wrong venv prefix: {actual} != {expected}")
print("easyresearch-venv-ok")
`);
}

export interface VenvValidationResult {
  stdout: string;
  stderr: string;
}

interface ValidationSpawnResult {
  status: number | null;
  stdout: string | Buffer | null;
  stderr: string | Buffer | null;
  error?: Error;
}

const VENV_SENTINEL = "easyresearch-venv-ok";
const STAGE_COMPLETION = "complete\nArtifacts: none\nGaps: none\nNext action: none";

export function assertPathFreeSessionEvent(event: unknown): string {
  const serialized = JSON.stringify(event);
  if (serialized === undefined) throw new Error("session SSE emitted an unserializable empty frame");
  if (serialized.includes("<agent_handoff>")) {
    throw new Error(`session SSE exposed a hidden handoff: ${serialized}`);
  }
  if (/"(?:sessionPath|session_path)"\s*:/u.test(serialized)) {
    throw new Error(`session SSE exposed a child session path: ${serialized}`);
  }
  return serialized;
}

export async function fetchSessionEventsBeforeDeadline(options: {
  url: string;
  deadline: number;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}): Promise<Response> {
  const remaining = options.deadline - (options.now ?? Date.now)();
  const timeoutMessage = "session SSE subscription did not finish before the native smoke deadline";
  if (remaining <= 0) throw new Error(timeoutMessage);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);
  try {
    return await (options.fetch ?? globalThis.fetch)(options.url, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timeoutMessage, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function hasExactLine(text: string, expected: string): boolean {
  return text.split(/\r?\n/).some((line) => line === expected);
}

export function runVenvValidation(options: {
  python: string;
  script: string;
  exists?: (path: string) => boolean;
  spawn?: (
    command: string,
    args: readonly string[],
    options: { encoding: "utf8"; timeout: number },
  ) => ValidationSpawnResult;
}): VenvValidationResult {
  const failure = (reason: string, stdout = "", stderr = ""): never => {
    throw new Error(`${options.python} venv validation ${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  };
  const exists = options.exists ?? (options.spawn ? undefined : existsSync);
  if (exists && !exists(options.python)) failure("interpreter is missing");

  const result = (options.spawn ?? spawnSync)(options.python, ["-I", options.script], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  if (result.error) failure(`spawn failed: ${result.error.message}`, stdout, stderr);
  if (result.status !== 0) failure(`failed with status ${result.status ?? "unknown"}`, stdout, stderr);
  if (!hasExactLine(stdout, VENV_SENTINEL)) failure(`did not emit ${VENV_SENTINEL}`, stdout, stderr);
  return { stdout, stderr };
}

export function validateFirstRunVenv(options: {
  setupResultPath: string;
  setupRunId: string;
  python: string;
  script: string;
  readSetupResult?: (path: string) => string;
  exists?: (path: string) => boolean;
  spawn?: (
    command: string,
    args: readonly string[],
    options: { encoding: "utf8"; timeout: number },
  ) => ValidationSpawnResult;
}): VenvValidationResult {
  const evidence = readFirstRunSetupEvidence({
    path: options.setupResultPath,
    runId: options.setupRunId,
    read: options.readSetupResult,
  });
  if (!evidence.success) {
    throw new Error(`first-run skill venv setup returned success:false for run ${options.setupRunId}`);
  }
  return runVenvValidation(options);
}

/** Ensures the first-run writer exits before returning or reporting its deadline failure. */
export async function settleProcess(options: {
  pid: number;
  deadline: number;
  terminateImmediately?: boolean;
  terminationGraceMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  isAlive: (pid: number) => boolean;
  terminateTree: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<"exited" | "terminated"> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const terminationGraceMs = options.terminationGraceMs ?? 30_000;
  if (!options.isAlive(options.pid)) return "exited";

  let terminated = false;
  let exceededDeadline = false;
  let terminationDeadline = 0;
  const terminate = () => {
    options.terminateTree(options.pid);
    terminated = true;
    terminationDeadline = now() + terminationGraceMs;
  };

  if (options.terminateImmediately) terminate();
  while (options.isAlive(options.pid)) {
    const current = now();
    if (!terminated && current >= options.deadline) {
      exceededDeadline = true;
      terminate();
    } else if (terminated && current >= terminationDeadline) {
      throw new Error(`process ${options.pid} did not exit after tree termination`);
    }
    await sleep(pollIntervalMs);
  }

  if (exceededDeadline) {
    throw new Error(`process ${options.pid} exceeded first-run deadline and was terminated`);
  }
  return terminated ? "terminated" : "exited";
}

export async function readTextFileWithRetry(options: {
  path: string;
  attempts?: number;
  delayMs?: number;
  read?: (path: string) => string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const attempts = Math.max(1, options.attempts ?? 10);
  const read = options.read ?? ((path) => readFileSync(path, "utf8"));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let cause = "unknown read failure";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return read(options.path);
    } catch (error) {
      cause = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) await sleep(options.delayMs ?? 200);
    }
  }
  return `[capture unavailable: ${cause}]`;
}

export function collectLaunchOutput(options: {
  asynchronous: boolean;
  stdoutPath: string;
  stderrPath: string;
  read: (path: string) => string;
}): { stdout: string; stderr: string } {
  if (options.asynchronous) return { stdout: "", stderr: "" };
  return {
    stdout: options.read(options.stdoutPath),
    stderr: options.read(options.stderrPath),
  };
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildWindowsShutdownScript(options: {
  binary: string;
  args: readonly string[];
  stdoutPath: string;
  stderrPath: string;
  statusPath: string;
  powershellErrorPath: string;
}): string {
  const command = [options.binary, ...options.args].map(powershellQuote).join(" ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  & ${command} 1> ${powershellQuote(options.stdoutPath)} 2> ${powershellQuote(options.stderrPath)}`,
    "  $status = $LASTEXITCODE",
    `  Set-Content -LiteralPath ${powershellQuote(options.statusPath)} -Value ([string]$status) -Encoding ascii`,
    "  if ($status -ne 0) { throw \"Windows shutdown client exited with status $status\" }",
    "  exit 0",
    "} catch {",
    `  $_ | Out-File -FilePath ${powershellQuote(options.powershellErrorPath)} -Encoding utf8`,
    "  exit 99",
    "}",
  ].join("; ");
}

export function buildWindowsShutdownLauncherScript(options: {
  powershell: string;
  wrapperPath: string;
  pidPath: string;
  taskkill: string;
  powershellErrorPath: string;
}): string {
  const wrapperArgument = `"${options.wrapperPath}"`;
  const argumentList = ["-NoProfile", "-NonInteractive", "-File", wrapperArgument]
    .map(powershellQuote)
    .join(", ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$process = $null",
    "try {",
    `  $process = Start-Process -FilePath ${powershellQuote(options.powershell)} -ArgumentList @(${argumentList}) -WindowStyle Hidden -PassThru`,
    `  Set-Content -LiteralPath ${powershellQuote(options.pidPath)} -Value $process.Id -Encoding ascii`,
    "  if (-not $process.WaitForExit(30000)) {",
    `    & ${powershellQuote(options.taskkill)} /PID $($process.Id) /T /F | Out-Null`,
    "    throw 'Windows shutdown wrapper timed out after 30000ms'",
    "  }",
    "  exit 0",
    "} catch {",
    "  if ($null -ne $process) {",
    `    & ${powershellQuote(options.taskkill)} /PID $($process.Id) /T /F | Out-Null`,
    "  }",
    `  $_ | Out-File -FilePath ${powershellQuote(options.powershellErrorPath)} -Encoding utf8`,
    "  exit 99",
    "}",
  ].join("; ");
}

export function requireZeroProcessStatus(options: {
  label: string;
  statusText: string;
  stdout: string;
  stderr: string;
}): void {
  const text = options.statusText.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`${options.label} did not record a valid exit status: ${text || "missing"}`);
  }
  const status = Number(text);
  if (!Number.isSafeInteger(status)) {
    throw new Error(`${options.label} did not record a valid exit status: ${text}`);
  }
  if (status !== 0) {
    throw new Error(
      `${options.label} failed with status ${status}\nstdout:\n${options.stdout}\nstderr:\n${options.stderr}`,
    );
  }
}

type CleanupStep = () => void | Promise<void>;

export async function finishSmokeCleanup(options: {
  primaryError?: Error;
  shutdown: CleanupStep;
  stopAuxiliary: CleanupStep;
  verifyDaemonStopped: CleanupStep;
  removeRoot: CleanupStep;
}): Promise<void> {
  const failures: Array<{ label: string; error: Error }> = [];
  const attempt = async (label: string, step: CleanupStep): Promise<boolean> => {
    try {
      await step();
      return true;
    } catch (error) {
      failures.push({ label, error: error instanceof Error ? error : new Error(String(error)) });
      return false;
    }
  };

  await attempt("shutdown", options.shutdown);
  await attempt("auxiliary shutdown", options.stopAuxiliary);
  const daemonStopped = await attempt("daemon termination verification", options.verifyDaemonStopped);
  if (daemonStopped) {
    await attempt("temporary root removal", options.removeRoot);
  }

  if (failures.length === 0) {
    if (options.primaryError) throw options.primaryError;
    return;
  }
  const diagnostics = failures.map(({ label, error }) => `${label}: ${error.message}`).join("\n");
  if (options.primaryError) {
    options.primaryError.message = `${options.primaryError.message}\n\nCleanup diagnostics:\n${diagnostics}`;
    Object.defineProperty(options.primaryError, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: failures.map(({ error }) => error),
    });
    throw options.primaryError;
  }
  throw new AggregateError(
    failures.map(({ error }) => error),
    `native smoke cleanup failed:\n${diagnostics}`,
  );
}

export function venvToolCommand(platform: NodeJS.Platform, scriptPath: string): string {
  const quotedScript = scriptPath.replace(/["\\`$]/g, "\\$&");
  const python = platform === "win32"
    ? "${EASYRESEARCH_VENV}/Scripts/python.exe"
    : "$EASYRESEARCH_VENV/bin/python";
  return `"${python}" "${quotedScript}"`;
}

export type SmokeModelAction =
  | { kind: "tool"; id: string; name: "write" | "subagent" | "bash"; arguments: string }
  | { kind: "text"; text: string };

export interface SmokeModelScenario {
  toolCommand: string;
  agentName: string;
  agentPath: string;
  agentContent: string;
  agentPromptMarker: string;
}

export interface SmokeModelState {
  agentWriteIssued: boolean;
  agentWriteObserved: boolean;
  customDispatchIssued: boolean;
  parentWorkingObserved: boolean;
  stageBashIssued: boolean;
  venvValidated: boolean;
  stageCompleted: boolean;
  terminalHandoffObserved: boolean;
  complete: boolean;
  completedRequests: number;
}

export interface SmokeModelTransition {
  action: SmokeModelAction;
  state: SmokeModelState;
  validatedVenvResult: boolean;
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(messageContentText).join("\n");
  if (content && typeof content === "object" && "text" in content) {
    return messageContentText((content as { text?: unknown }).text);
  }
  return "";
}

function hasSuccessfulTerminalHandoff(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
  agentId: string,
): boolean {
  const terminalMessages = messages
    ?.filter((message) => message.role === "user")
    .map((message) => messageContentText(message.content))
    .filter((content) => content.includes("<agent_status>") || content.includes("<agent_handoff>"))
    ?? [];
  if (terminalMessages.length === 0) return false;
  if (terminalMessages.length !== 1) {
    throw new Error(`native smoke expected exactly one atomic terminal notification, received ${terminalMessages.length}`);
  }

  const normalized = terminalMessages[0]!.replaceAll("\r\n", "\n").trim();
  const match = normalized.match(
    /^<agent_status>\n([\s\S]*?)\n<\/agent_status>\n<agent_handoff>\n([\s\S]*?)\n<\/agent_handoff>$/u,
  );
  const status = match?.[1];
  const handoff = match?.[2];
  const completeLines = status
    ?.split("\n")
    .filter((line) => line.trim() === `Complete subagent:${agentId}`)
    ?? [];
  if (
    completeLines.length !== 1
    || status?.includes("session_path")
    || handoff?.trim() !== `Agent: ${agentId}\nResult: ${STAGE_COMPLETION}`
  ) {
    throw new Error(`native smoke received a malformed atomic terminal notification: ${normalized}`);
  }
  return true;
}

export function selectSmokeModelAction(
  request: {
    tools?: Array<{ function?: { name?: string; description?: string } }>;
    messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
  },
  scenario: SmokeModelScenario,
  state: SmokeModelState,
): SmokeModelTransition {
  if (!isAbsolute(scenario.agentPath)) {
    throw new Error(`native smoke custom Agent path must be absolute: ${scenario.agentPath}`);
  }
  if (!scenario.agentContent.includes(scenario.agentPromptMarker)) {
    throw new Error("native smoke custom Agent content is missing its role-prompt marker");
  }
  const tools = request.tools ?? [];
  const toolNames = new Set(tools.map((tool) => tool.function?.name));
  if (state.complete) throw new Error("native smoke model sequence is already complete");
  const agentId = `${scenario.agentName}_0`;

  const transition = (
    action: SmokeModelAction,
    updates: Partial<SmokeModelState>,
    validatedVenvResult = false,
  ): SmokeModelTransition => ({
    action,
    state: { ...state, ...updates, completedRequests: state.completedRequests + 1 },
    validatedVenvResult,
  });
  const expectedToolResult = (toolCallId: string): string => {
    const matches = request.messages?.filter(
      (message) => message.role === "tool" && message.tool_call_id === toolCallId,
    ) ?? [];
    if (matches.length !== 1) {
      throw new Error(`native smoke expected exactly one tool result for ${toolCallId}, received ${matches.length}`);
    }
    return messageContentText(matches[0]?.content);
  };
  const subagentDescription = (): string => {
    const matches = tools.filter((tool) => tool.function?.name === "subagent");
    if (matches.length !== 1) {
      throw new Error(`native smoke expected exactly one subagent tool, received ${matches.length}`);
    }
    const description = matches[0]?.function?.description;
    if (typeof description !== "string") {
      throw new Error("native smoke subagent tool had no description");
    }
    return description;
  };
  const descriptionListsAgent = (description: string): boolean => {
    const prefix = "Available subagents: ";
    const line = description.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
    if (!line?.endsWith(".")) return false;
    return line
      .slice(prefix.length, -1)
      .split(", ")
      .includes(scenario.agentName);
  };

  if (toolNames.has("write")) {
    const description = subagentDescription();
    if (!state.agentWriteIssued) {
      if (descriptionListsAgent(description)) {
        throw new Error(`native smoke custom Agent ${scenario.agentName} existed before its write tool call`);
      }
      return transition({
        kind: "tool",
        id: "call_native_agent_write",
        name: "write",
        arguments: JSON.stringify({ path: scenario.agentPath, content: scenario.agentContent }),
      }, { agentWriteIssued: true });
    }

    if (!state.agentWriteObserved) {
      const actualWriteResult = expectedToolResult("call_native_agent_write");
      const expectedWriteResult = `Successfully wrote ${scenario.agentContent.length} bytes to ${scenario.agentPath}`;
      if (actualWriteResult !== expectedWriteResult) {
        throw new Error(`native smoke custom Agent write result was not exact: ${actualWriteResult}`);
      }
      if (!descriptionListsAgent(description)) {
        throw new Error(`native smoke next parent request did not expose ${scenario.agentName} in the subagent schema`);
      }
      return transition({
        kind: "tool",
        id: "call_native_reviewer",
        name: "subagent",
        arguments: JSON.stringify({
          agent: scenario.agentName,
          task: "Run the native venv validation command with the bash tool and return a complete handoff.",
        }),
      }, { agentWriteObserved: true, customDispatchIssued: true });
    }

    if (!state.customDispatchIssued) {
      throw new Error("native smoke parent observed the custom Agent write without issuing its dispatch");
    }
    if (!descriptionListsAgent(description)) {
      throw new Error(`native smoke parent lost ${scenario.agentName} from the refreshed subagent schema`);
    }
    const working = expectedToolResult("call_native_reviewer");
    if (working !== `${agentId} is working.`) {
      throw new Error(`subagent tool result was not exactly ${agentId} is working.: ${working}`);
    }
    const terminalHandoffObserved = hasSuccessfulTerminalHandoff(request.messages, agentId);
    if (!terminalHandoffObserved) {
      return transition(
        { kind: "text", text: "Parent waiting for supervised completion." },
        { parentWorkingObserved: true },
      );
    }
    if (!state.venvValidated || !state.stageCompleted) {
      throw new Error("native smoke received the terminal handoff before successful stage validation");
    }
    return transition(
      { kind: "text", text: "Parent smoke run complete." },
      { parentWorkingObserved: true, terminalHandoffObserved: true, complete: true },
    );
  }

  if (toolNames.has("bash")) {
    if (!state.customDispatchIssued) {
      throw new Error("native smoke custom child ran before the parent dispatch");
    }
    const configuredTools = tools.map((tool) => tool.function?.name);
    if (configuredTools.length !== 1 || configuredTools[0] !== "bash") {
      throw new Error(`native smoke custom child did not receive only its configured tools: ${configuredTools.join(", ")}`);
    }
    const systemPrompt = request.messages
      ?.filter((message) => message.role === "system")
      .map((message) => messageContentText(message.content))
      .join("\n")
      ?? "";
    if (!systemPrompt.includes(scenario.agentPromptMarker)) {
      throw new Error("native smoke custom child did not receive its current role prompt");
    }
    if (!state.stageBashIssued) {
      return transition({
        kind: "tool",
        id: "call_native_venv",
        name: "bash",
        arguments: JSON.stringify({ command: scenario.toolCommand, timeout: 60 }),
      }, { stageBashIssued: true });
    }
    if (state.stageCompleted) {
      throw new Error("native smoke stage model sequence is already complete");
    }
    const content = expectedToolResult("call_native_venv");
    const sentinelLines = content
      .split(/\r?\n/u)
      .filter((line) => line === VENV_SENTINEL);
    if (sentinelLines.length !== 1) {
      throw new Error(`bash tool result did not contain exactly one ${VENV_SENTINEL} line: ${content}`);
    }
    return transition(
      { kind: "text", text: STAGE_COMPLETION },
      { venvValidated: true, stageCompleted: true },
      true,
    );
  }

  throw new Error("native smoke model request exposed neither the parent write tool nor the custom child bash tool");
}
