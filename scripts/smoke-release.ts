#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { TARGETS, platformBinaryName, platformPackageDir, repoPackageVersion } from "./build";
import { validateNativeVersionOutput } from "./release";
import {
  FIRST_RUN_CEILING_MS,
  buildWindowsShutdownLauncherScript,
  buildWindowsShutdownScript,
  collectLaunchOutput,
  createCompiledChildEnv,
  finishSmokeCleanup,
  readTextFileWithRetry,
  requireZeroProcessStatus,
  resolveSmokePython,
  selectSmokeModelAction,
  type SmokeModelState,
  skillVenvPython,
  settleProcess,
  validateFirstRunVenv,
  venvToolCommand,
  writeVenvValidationScript,
} from "./smoke-release-support";
import {
  SMOKE_SETUP_RESULT_PATH_ENV,
  SMOKE_SETUP_RUN_ID_ENV,
} from "../src/runtime/first-run-setup-evidence";

const targetName = process.argv[2];
const target = TARGETS.find((candidate) => candidate.name === targetName);
if (!target) throw new Error(`unknown smoke target: ${targetName}`);
const versionVerifiedByRunner = process.argv[3] === "--version-verified-by-runner";
if (process.argv.length > (versionVerifiedByRunner ? 4 : 3)) throw new Error("unexpected native smoke arguments");
if (versionVerifiedByRunner && target.name !== "windows-x64") {
  throw new Error("runner-verified version is reserved for Windows native smoke");
}

const binary = resolve(platformPackageDir(target.name), "bin", platformBinaryName(target));
const systemPython = resolveSmokePython({ explicit: process.env.EASYRESEARCH_SMOKE_PYTHON });
const root = mkdtempSync(join(tmpdir(), "easyresearch-native-smoke-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const project = join(root, "project");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const venvPython = skillVenvPython(agentDir, process.platform);
const validationScript = join(root, "validate-easyresearch-venv.py");
const setupRunId = randomUUID();
const setupResultPath = join(root, "first-run-setup-result.json");
const firstRunStdoutPath = join(root, "first-run-stdout.txt");
const firstRunStderrPath = join(root, "first-run-stderr.txt");
const firstRunPidPath = join(root, "first-run-client.pid");
const shutdownWrapperPath = join(root, "shutdown-wrapper.ps1");
const shutdownWrapperPidPath = join(root, "shutdown-wrapper.pid");
const shutdownStatusPath = join(root, "shutdown-status.txt");
const daemonPidPath = join(agentDir, "server.pid");
writeVenvValidationScript(validationScript);
let systemPythonVersionOutput = "not checked";
let validationStdout = "not run";
let validationStderr = "not run";
let firstRunClientPid: number | undefined;
let firstRunLaunchAttempted = false;
let firstRunDeadline = 0;
let daemonPid: number | undefined;
let modelRequests = 0;
let venvToolResults = 0;
let smokeModelState: SmokeModelState = {
  phase: "awaiting-parent-subagent-call",
  completedRequests: 0,
};
const modelServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.json() as {
      model?: string;
      messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    modelRequests += 1;
    const transition = selectSmokeModelAction(
      body,
      venvToolCommand(process.platform, validationScript),
      smokeModelState,
    );
    smokeModelState = transition.state;
    if (transition.validatedVenvResult) venvToolResults += 1;
    const action = transition.action;
    return action.kind === "tool"
      ? openAiStream({ toolCall: { id: action.id, name: action.name, arguments: action.arguments } })
      : openAiStream({ text: action.text });
  },
});
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: {
    smoke: {
      baseUrl: `http://127.0.0.1:${modelServer.port}/v1`,
      api: "openai-completions",
      apiKey: "smoke-key",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [{ id: "smoke-model", name: "Smoke Model", contextWindow: 32000, maxTokens: 2048 }],
    },
  },
}));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
  defaultProvider: "smoke",
  defaultModel: "smoke-model",
}));
const portProbe = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
const port = portProbe.port;
portProbe.stop(true);

const env = createCompiledChildEnv({
  base: process.env,
  python: systemPython,
  overrides: {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(root, "localappdata"),
    EASYRESEARCH_CODING_AGENT_DIR: agentDir,
    [SMOKE_SETUP_RESULT_PATH_ENV]: setupResultPath,
    [SMOKE_SETUP_RUN_ID_ENV]: setupRunId,
  },
});

function safeReadText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return `[capture unavailable: ${cause}]`;
  }
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function recordedPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function run(args: string[], captureName: "first-run" | "shutdown"): { stdout: string; stderr: string; pid?: number } {
  const stdoutPath = captureName === "first-run" ? firstRunStdoutPath : join(root, `${captureName}-stdout.txt`);
  const stderrPath = captureName === "first-run" ? firstRunStderrPath : join(root, `${captureName}-stderr.txt`);
  const powershellErrorPath = join(root, `${captureName}-powershell-error.txt`);
  const timeout = captureName === "first-run" ? FIRST_RUN_CEILING_MS : 180_000;
  const asynchronous = process.platform === "win32" && captureName === "first-run";
  let result: ReturnType<typeof spawnSync>;
  if (process.platform === "win32") {
    // Bun 1.3.14 spawnSync silently fails to start compiled executables on
    // Windows. Launch first run without waiting because Start-Process -Wait
    // waits on the live daemon; readiness is polled by the smoke script.
    // Start-Process owns those capture paths so Node must not open them first.
    const nul = openSync("NUL", "w");
    try {
      const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      let script: string;
      if (asynchronous) {
        script = [
          "$ErrorActionPreference = 'Stop'",
          "$process = $null",
          "try {",
          `  $process = Start-Process -FilePath ${powershellQuote(binary)} -ArgumentList @(${args.map(powershellQuote).join(", ")}) -WindowStyle Hidden -RedirectStandardOutput ${powershellQuote(stdoutPath)} -RedirectStandardError ${powershellQuote(stderrPath)} -PassThru`,
          `  Set-Content -LiteralPath ${powershellQuote(firstRunPidPath)} -Value $process.Id -Encoding ascii`,
          "  exit 0",
          "} catch {",
          "  if ($null -ne $process) {",
          `    & ${powershellQuote(taskkill)} /PID $($process.Id) /T /F | Out-Null`,
          "  }",
          `  $_ | Out-File -FilePath ${powershellQuote(powershellErrorPath)} -Encoding utf8`,
          "  exit 99",
          "}",
        ].join("; ");
      } else {
        writeFileSync(shutdownWrapperPath, buildWindowsShutdownScript({
          binary,
          args,
          stdoutPath,
          stderrPath,
          statusPath: shutdownStatusPath,
          powershellErrorPath,
        }));
        script = buildWindowsShutdownLauncherScript({
          powershell,
          wrapperPath: shutdownWrapperPath,
          pidPath: shutdownWrapperPidPath,
          taskkill,
          powershellErrorPath,
        });
      }
      result = spawnSync(
        powershell,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { env, stdio: ["ignore", nul, nul], timeout },
      );
    } finally {
      closeSync(nul);
    }
  } else {
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    try {
      result = spawnSync(binary, args, { env, stdio: ["ignore", stdoutFd, stderrFd], timeout });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  }
  const { stdout, stderr } = collectLaunchOutput({
    asynchronous,
    stdoutPath,
    stderrPath,
    read: safeReadText,
  });
  if (result.error || result.status !== 0) {
    const cause = result.error ? `${result.error.name}: ${result.error.message}` : "no spawn error";
    const powershellError = process.platform === "win32" ? `\n${safeReadText(powershellErrorPath)}` : "";
    const childStatus = process.platform === "win32" && captureName === "shutdown"
      ? `\nshutdown client status: ${safeReadText(shutdownStatusPath)}`
      : "";
    throw new Error(`${binary} ${args.join(" ")} failed (${result.status ?? "no status"}; ${cause}):\n${stdout}\n${stderr}${powershellError}${childStatus}`);
  }
  if (process.platform === "win32" && captureName === "shutdown") {
    requireZeroProcessStatus({
      label: "Windows shutdown client",
      statusText: safeReadText(shutdownStatusPath),
      stdout,
      stderr,
    });
  }
  const pid = asynchronous ? recordedPid(firstRunPidPath) : undefined;
  if (process.platform === "win32" && captureName === "first-run" && pid === undefined) {
    throw new Error(`Windows first-run client did not record a valid PID at ${firstRunPidPath}`);
  }
  return { stdout, stderr, pid };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function terminateWindowsProcessTree(pid: number): void {
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error || (result.status !== 0 && isProcessAlive(pid))) {
    const cause = result.error ? `${result.error.name}: ${result.error.message}` : `status ${result.status ?? "unknown"}`;
    throw new Error(`failed to terminate Windows process tree ${pid} (${cause}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
}

function terminateProcessTree(pid: number): void {
  if (process.platform === "win32") {
    terminateWindowsProcessTree(pid);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function settleWindowsFirstRun(terminateImmediately: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  const pid = firstRunClientPid ?? recordedPid(firstRunPidPath);
  if (pid === undefined) return;
  firstRunClientPid = pid;
  await settleProcess({
    pid,
    deadline: firstRunDeadline,
    terminateImmediately,
    isAlive: isProcessAlive,
    terminateTree: terminateWindowsProcessTree,
  });
}

async function verifyDaemonStopped(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  try {
    await settleProcess({
      pid,
      deadline: Date.now() + 30_000,
      isAlive: isProcessAlive,
      terminateTree: terminateProcessTree,
    });
  } catch (error) {
    throw new Error(`daemon process ${pid} did not terminate cleanly: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function removeSmokeRoot(): Promise<void> {
  let cause = "root still exists";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      if (!existsSync(root)) return;
    } catch (error) {
      cause = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`failed to remove smoke root ${root}: ${cause}`);
}

function requireCommandUnavailable(command: "node" | "bun"): void {
  const result = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 30_000 });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    console.log(`[smoke] child ${command}: unavailable (expected)`);
    return;
  }
  const cause = result.error ? `${result.error.name}: ${result.error.message}` : `status ${result.status ?? "unknown"}`;
  throw new Error(`child environment unexpectedly resolved ${command} (${cause}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function inspectSystemPython(): void {
  const result = spawnSync(systemPython, ["--version"], { env, encoding: "utf8", timeout: 30_000 });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  systemPythonVersionOutput = output || "no version output";
  console.log(`[smoke] system Python: ${systemPython}`);
  console.log(`[smoke] system Python --version: ${systemPythonVersionOutput}`);
  if (result.error || result.status !== 0) {
    const cause = result.error ? `${result.error.name}: ${result.error.message}` : `status ${result.status ?? "unknown"}`;
    throw new Error(`system Python version probe failed (${cause}): ${systemPythonVersionOutput}`);
  }
}

function runVersion(): string {
  const outputPath = join(root, "version-output.txt");
  const outputFd = openSync(outputPath, "w");
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(binary, ["--version"], {
      env,
      stdio: ["ignore", outputFd, outputFd],
      timeout: 180_000,
    });
  } finally {
    closeSync(outputFd);
  }
  const output = readFileSync(outputPath, "utf8");
  if (result.error || result.status !== 0) {
    const cause = result.error ? `${result.error.name}: ${result.error.message}` : "no spawn error";
    throw new Error(`${binary} --version failed (${result.status ?? "no status"}; ${cause}):\n${output}`);
  }
  return output;
}

function treeFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const entries: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) entries.push(...treeFiles(join(dir, entry.name), rel));
    else entries.push(rel);
  }
  return entries.sort();
}

async function requireOk(response: Response, label: string): Promise<any> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function dumpServerLogs(): Promise<void> {
  console.log(`[smoke] system Python: ${systemPython}`);
  console.log(`[smoke] system Python --version: ${systemPythonVersionOutput}`);
  console.log(`[smoke] expected venv Python: ${venvPython}`);
  console.log(`[smoke] expected venv Python exists: ${existsSync(venvPython)}`);
  console.log(`[smoke] first-run setup result: ${safeReadText(setupResultPath)}`);
  console.log(`[smoke] --- venv validation stdout (${validationStdout.length} bytes) ---`);
  console.log(validationStdout.slice(-4000));
  console.log(`[smoke] --- venv validation stderr (${validationStderr.length} bytes) ---`);
  console.log(validationStderr.slice(-4000));
  for (const capture of ["first-run-stdout.txt", "first-run-stderr.txt"]) {
    const content = await readTextFileWithRetry({
      path: join(root, capture),
      attempts: firstRunLaunchAttempted ? 10 : 1,
    });
    console.log(`[smoke] --- ${capture} (${content.length} bytes) ---`);
    console.log(content.slice(-4000));
  }
  for (const capture of [
    "first-run-powershell-error.txt",
    "shutdown-stdout.txt",
    "shutdown-stderr.txt",
    "shutdown-status.txt",
    "shutdown-wrapper.pid",
    "shutdown-powershell-error.txt",
  ]) {
    const path = join(root, capture);
    if (!existsSync(path)) continue;
    const content = safeReadText(path);
    console.log(`[smoke] --- ${capture} (${content.length} bytes) ---`);
    console.log(content.slice(-4000));
  }
  console.log(`[smoke] agentDir exists: ${existsSync(agentDir)}`);
  let agentFiles: string[] = [];
  try {
    agentFiles = treeFiles(agentDir);
  } catch (error) {
    console.log(`[smoke] failed to inspect agentDir: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`[smoke] agentDir files: ${agentFiles.length}`);
  if (existsSync(agentDir)) {
    try {
      const topLevel = readdirSync(agentDir).filter((entry) => !agentFiles.includes(`/${entry}`));
      console.log(`[smoke] agentDir dirs: ${topLevel.join(", ")}`);
    } catch (error) {
      console.log(`[smoke] failed to inspect agentDir top level: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const file of agentFiles.slice(0, 40)) console.log(`[smoke]   /agent${file}`);
  const cliError = join(agentDir, "cli-error.log");
  if (existsSync(cliError)) {
    console.log(`[smoke] --- cli-error.log ---`);
    console.log(safeReadText(cliError).slice(-4000));
  }
  try {
    const logsDir = join(agentDir, "logs");
    if (!existsSync(logsDir)) {
      console.log("[smoke] no server logs directory");
      return;
    }
    for (const entry of readdirSync(logsDir)) {
      const path = join(logsDir, entry);
      const content = safeReadText(path);
      console.log(`[smoke] --- ${entry} (${content.length} bytes) ---`);
      console.log(content.slice(-4000));
    }
  } catch (error) {
    console.log(`[smoke] failed to dump server logs: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function openAiStream(input: {
  text?: string;
  toolCall?: { id: string; name: string; arguments: string };
}): Response {
  const id = `chatcmpl-${modelRequests}`;
  const created = Math.floor(Date.now() / 1000);
  const firstDelta = input.toolCall
    ? {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: input.toolCall.id,
          type: "function",
          function: { name: input.toolCall.name, arguments: input.toolCall.arguments },
        }],
      }
    : { role: "assistant", content: input.text ?? "" };
  const finishReason = input.toolCall ? "tool_calls" : "stop";
  const chunks = [
    { id, object: "chat.completion.chunk", created, model: "smoke-model", choices: [{ index: 0, delta: firstDelta, finish_reason: null }] },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: "smoke-model",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

let primaryError: Error | undefined;
try {
  inspectSystemPython();
  requireCommandUnavailable("node");
  requireCommandUnavailable("bun");
  const version = repoPackageVersion();
  if (!versionVerifiedByRunner) validateNativeVersionOutput(0, runVersion(), version, target.name);
  const treeBefore = treeFiles(root);
  firstRunDeadline = Date.now() + FIRST_RUN_CEILING_MS;
  firstRunLaunchAttempted = true;
  firstRunClientPid = run(["--no-open", "--port", String(port)], "first-run").pid;
  const materializedDir = join(agentDir, "bundled");
  while (Date.now() < firstRunDeadline) {
    if (existsSync(materializedDir)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const bundledCandidates = [
    join(agentDir, "bundled"),
    join(home, ".easyresearch", "agent", "bundled"),
    join(process.env.APPDATA ?? "", ".easyresearch", "agent", "bundled"),
    join(process.env.LOCALAPPDATA ?? "", ".easyresearch", "agent", "bundled"),
  ];
  for (const candidate of bundledCandidates) {
    console.log(`[smoke] bundled candidate: ${candidate} -> ${existsSync(candidate)}`);
  }
  const bundledDir = join(agentDir, "bundled");
  if (!existsSync(bundledDir)) throw new Error("CLI did not materialize bundled resources (did the CLI actually run?)");
  const daemonBinary = join(agentDir, "bin", target.os[0] === "win32" ? "easyresearch-daemon.exe" : "easyresearch-daemon");
  while (Date.now() < firstRunDeadline) {
    if (existsSync(daemonBinary)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!existsSync(daemonBinary)) throw new Error(`daemon binary copy missing: ${daemonBinary}`);
  const base = `http://127.0.0.1:${port}`;
  let status: Response | undefined;
  while (Date.now() < firstRunDeadline) {
    try {
      const probe = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(3_000) });
      if (probe.ok) {
        status = probe;
        break;
      }
    } catch {
      // daemon still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!status) throw new Error(`daemon did not become ready at ${base}`);
  await requireOk(status, "status probe");
  daemonPid = recordedPid(daemonPidPath);
  if (daemonPid === undefined) throw new Error(`daemon did not record a valid PID at ${daemonPidPath}`);
  await settleWindowsFirstRun(false);
  if (!existsSync(venvPython)) {
    throw new Error(`first-run skill venv missing interpreter: ${venvPython}`);
  }
  validateFirstRunVenv({
    setupResultPath,
    setupRunId,
    python: venvPython,
    script: validationScript,
    spawn: (command, args, options) => {
      const result = spawnSync(command, [...args], {
        ...options,
        env: { ...env, EASYRESEARCH_VENV: join(agentDir, "venv") },
      });
      validationStdout = result.stdout?.toString() ?? "";
      validationStderr = result.stderr?.toString() ?? "";
      return result;
    },
  });
  const createdFiles = treeFiles(root).filter((file) => !treeBefore.includes(file));
  console.log(`[smoke] files created by CLI run: ${createdFiles.length}`);
  for (const file of createdFiles.slice(0, 60)) console.log(`[smoke]   ${file}`);
  const auth = await requireOk(await fetch(`${base}/api/auth/providers`), "OAuth provider probe");
  if (!Array.isArray(auth.providers) || !auth.providers.some(
    (provider: { authMethods?: string[] }) => provider.authMethods?.includes("oauth"),
  )) {
    throw new Error("compiled OAuth providers were not registered");
  }
  const created = await requireOk(await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: project }),
  }), "session create");
  await requireOk(await fetch(`${base}/api/sessions/${created.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Dispatch search and require it to execute only the deterministic bash venv-validation tool call. Do not use network tools.",
    }),
  }), "stage dispatch");
  const stageDeadline = Math.min(firstRunDeadline, Date.now() + 180_000);
  while (Date.now() < stageDeadline && smokeModelState.phase !== "complete") {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (modelRequests !== 4 || smokeModelState.phase !== "complete" || smokeModelState.completedRequests !== 4) {
    throw new Error(
      `stage tool sequence incomplete (${modelRequests} requests; ${smokeModelState.completedRequests} accepted; phase ${smokeModelState.phase})`,
    );
  }
  if (venvToolResults !== 1) throw new Error(`venv tool sentinel count was ${venvToolResults}`);

  process.env.EASYRESEARCH_CODING_AGENT_DIR = agentDir;
  const { importPi } = await import("../src/runtime/pi-import");
  const pi = await importPi();
  const history = pi.SessionManager.create(project);
  history.appendMessage({ role: "user", content: "native smoke history", timestamp: Date.now() });
  history.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "native smoke response" }],
    api: "openai-completions",
    provider: "smoke",
    model: "smoke",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionPath = history.getSessionFile();
  if (!sessionPath) throw new Error("failed to persist smoke history");
  const historyStatus = await requireOk(await fetch(`${base}/api/status`), "history status probe");
  if (historyStatus.agentDir !== agentDir || !historyStatus.sessions.some((session: { path: string }) => session.path === sessionPath)) {
    throw new Error(`persisted smoke history was not discovered: ${JSON.stringify({ agentDir, sessionPath, historyStatus })}`);
  }
  await requireOk(await fetch(`${base}/api/sessions/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: sessionPath }),
  }), "session resume");
} catch (error) {
  primaryError = error instanceof Error ? error : new Error(String(error));
  try {
    await settleWindowsFirstRun(true);
  } catch (settlementError) {
    console.log(`[smoke] failed to settle Windows first-run client: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`);
  }
  try {
    await dumpServerLogs();
  } catch (dumpError) {
    console.log(`[smoke] failed to dump smoke diagnostics: ${dumpError instanceof Error ? dumpError.message : String(dumpError)}`);
  }
}

const cleanupDaemonPid = daemonPid ?? recordedPid(daemonPidPath);
await finishSmokeCleanup({
  primaryError,
  shutdown: () => { run(["exit"], "shutdown"); },
  stopAuxiliary: () => { modelServer.stop(true); },
  verifyDaemonStopped: () => verifyDaemonStopped(cleanupDaemonPid),
  removeRoot: removeSmokeRoot,
});
console.log(`[smoke] ${target.name} passed`);
