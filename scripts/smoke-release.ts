#!/usr/bin/env bun
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { TARGETS, platformBinaryName, platformPackageDir, repoPackageVersion } from "./build";
import { validateNativeVersionOutput } from "./release";

const targetName = process.argv[2];
const target = TARGETS.find((candidate) => candidate.name === targetName);
if (!target) throw new Error(`unknown smoke target: ${targetName}`);
const versionVerifiedByRunner = process.argv[3] === "--version-verified-by-runner";
if (process.argv.length > (versionVerifiedByRunner ? 4 : 3)) throw new Error("unexpected native smoke arguments");
if (versionVerifiedByRunner && target.name !== "windows-x64") {
  throw new Error("runner-verified version is reserved for Windows native smoke");
}

const binary = resolve(platformPackageDir(target.name), "bin", platformBinaryName(target));
const root = mkdtempSync(join(tmpdir(), "easyresearch-native-smoke-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const project = join(root, "project");
const emptyPath = join(root, "empty-path");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(emptyPath, { recursive: true });
mkdirSync(agentDir, { recursive: true });
let modelRequests = 0;
const modelServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.json() as {
      model?: string;
      messages?: Array<{ role?: string }>;
      tools?: Array<{ function?: { name?: string } }>;
    };
    modelRequests += 1;
    const hasSubagent = body.tools?.some((tool) => tool.function?.name === "subagent") ?? false;
    const hasToolResult = body.messages?.some((message) => message.role === "tool") ?? false;
    if (hasSubagent && !hasToolResult) {
      return openAiStream({
        toolCall: {
          id: "call_native_stage",
          name: "subagent",
          arguments: JSON.stringify({ agent: "search", task: "Return a complete smoke-test handoff without using tools." }),
        },
      });
    }
    return openAiStream({ text: hasSubagent ? "Parent smoke run complete." : "complete\nArtifacts: none\nGaps: none\nNext action: none" });
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

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: join(root, "localappdata"),
  EASYRESEARCH_CODING_AGENT_DIR: agentDir,
  PATH: emptyPath,
};

function run(args: string[]): { stdout: string; stderr: string } {
  const stdoutPath = join(root, "run-stdout.txt");
  const stderrPath = join(root, "run-stderr.txt");
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  let result: ReturnType<typeof spawnSync>;
  try {
    if (process.platform === "win32") {
      // Bun 1.3.14 spawnSync silently fails to start compiled executables on
      // Windows, and PowerShell's Start-Process -Wait waits on the whole
      // process tree (the live daemon) and never returns. Launch the CLI
      // without waiting; readiness is polled by the smoke script instead.
      const nul = openSync("NUL", "w");
      try {
        const script = [
          "$ErrorActionPreference = 'Stop'",
          "try {",
          `  Start-Process -FilePath '${binary}' -ArgumentList @(${args.map((arg) => `'${arg}'`).join(", ")}) -WindowStyle Hidden`,
          "  exit 0",
          "} catch {",
          `  $_ | Out-File -FilePath '${join(root, "ps-error.txt")}' -Encoding utf8`,
          "  exit 99",
          "}",
        ].join("; ");
        result = spawnSync(
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { env, stdio: ["ignore", nul, nul], timeout: 180_000 },
        );
      } finally {
        closeSync(nul);
      }
    } else {
      result = spawnSync(binary, args, { env, stdio: ["ignore", stdoutFd, stderrFd], timeout: 180_000 });
    }
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const stdout = readFileSync(stdoutPath, "utf8");
  const stderr = readFileSync(stderrPath, "utf8");
  if (result.error || result.status !== 0) {
    const cause = result.error ? `${result.error.name}: ${result.error.message}` : "no spawn error";
    throw new Error(`${binary} ${args.join(" ")} failed (${result.status ?? "no status"}; ${cause}):\n${stdout}\n${stderr}`);
  }
  return { stdout, stderr };
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

function dumpServerLogs(): void {
  for (const capture of ["run-stdout.txt", "run-stderr.txt", "ps-error.txt"]) {
    const path = join(root, capture);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    console.log(`[smoke] --- ${capture} (${content.length} bytes) ---`);
    console.log(content.slice(-4000));
  }
  console.log(`[smoke] agentDir exists: ${existsSync(agentDir)}`);
  const agentFiles = treeFiles(agentDir);
  console.log(`[smoke] agentDir files: ${agentFiles.length}`);
  if (existsSync(agentDir)) {
    const topLevel = readdirSync(agentDir).filter((entry) => !agentFiles.includes(`/${entry}`));
    console.log(`[smoke] agentDir dirs: ${topLevel.join(", ")}`);
  }
  for (const file of agentFiles.slice(0, 40)) console.log(`[smoke]   /agent${file}`);
  const cliError = join(agentDir, "cli-error.log");
  if (existsSync(cliError)) {
    console.log(`[smoke] --- cli-error.log ---`);
    console.log(readFileSync(cliError, "utf8").slice(-4000));
  }
  try {
    const logsDir = join(agentDir, "logs");
    if (!existsSync(logsDir)) {
      console.log("[smoke] no server logs directory");
      return;
    }
    for (const entry of readdirSync(logsDir)) {
      const path = join(logsDir, entry);
      const content = readFileSync(path, "utf8");
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

try {
  const version = repoPackageVersion();
  if (!versionVerifiedByRunner) validateNativeVersionOutput(0, runVersion(), version, target.name);
  const treeBefore = treeFiles(root);
  run(["--no-open", "--port", String(port)]);
  const materializedDir = join(agentDir, "bundled");
  const materializeDeadline = Date.now() + 180_000;
  while (Date.now() < materializeDeadline) {
    if (existsSync(materializedDir)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const createdFiles = treeFiles(root).filter((file) => !treeBefore.includes(file));
  console.log(`[smoke] files created by CLI run: ${createdFiles.length}`);
  for (const file of createdFiles.slice(0, 60)) console.log(`[smoke]   ${file}`);
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
  if (!existsSync(daemonBinary)) throw new Error(`daemon binary copy missing: ${daemonBinary}`);
  const base = `http://127.0.0.1:${port}`;
  let status: Response | undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
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
    body: JSON.stringify({ message: "Run the deterministic native subagent smoke test." }),
  }), "stage dispatch");
  if (modelRequests < 3) throw new Error(`stage dispatch did not complete the parent/stage loop (${modelRequests} requests)`);

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
  console.log(`[smoke] ${target.name} passed`);
} catch (error) {
  dumpServerLogs();
  throw error;
} finally {
  try {
    run(["exit"]);
  } catch {
    // The primary smoke failure is more useful than shutdown cleanup output.
  }
  modelServer.stop(true);
  rmSync(root, { recursive: true, force: true });
}
