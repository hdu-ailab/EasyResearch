#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  TARGETS,
  type BuildManifest,
  buildManifestPath,
  platformBinaryName,
  platformPackageDir,
  releaseDir,
  repoPackageVersion,
} from "./build";
import {
  assertNativeDesktopHost,
  desktopTarget,
  type DesktopBuildManifest,
  type DesktopTargetName,
} from "./build-desktop";
import { resolveSmokePython } from "./smoke-release-support";
import {
  SMOKE_SETUP_RESULT_PATH_ENV,
  SMOKE_SETUP_RUN_ID_ENV,
} from "../src/runtime/first-run-setup-evidence";
import { DESKTOP_SMOKE_USER_DATA_ENV } from "../src/desktop/contracts";
import { THIRD_PARTY_NOTICES_FILE } from "./third-party-notices";
import {
  appendBoundedDiagnosticText,
  assertPackagedDesktopRunning,
  combineDesktopSmokeFailures,
  createDesktopSmokeDiagnosticReport,
  dmgAttachCommand,
  dmgDetachCommand,
  nsisInstallCommand,
  packagedApplicationPaths,
  pollDesktopSmokeEvents,
  readyPersistedSessionPath,
  readDesktopSmokeEvents,
  removeDesktopSmokeRoot,
  reduceDesktopSmokeEvents,
  verifyDesktopSidecarIdentity,
  verifyDesktopOwnershipSuccessor,
  verifyPackagedNotice,
  verifyPackagedSidecar,
  type NativeCommand,
} from "./smoke-desktop-support";
import { serverLogFile } from "../src/cli/server-process";

const targetArgument = process.argv[2];
if (!targetArgument || process.argv.length !== 3) {
  throw new Error("Usage: bun scripts/smoke-desktop.ts <windows-x64|darwin-arm64>");
}
const target = desktopTarget(targetArgument);
const targetName: DesktopTargetName = target.name;
assertNativeDesktopHost(targetName);
const version = repoPackageVersion();
const persistedHistorySentinels = {
  user: "desktop smoke persisted history",
  assistant: "desktop smoke persisted response",
};
const root = mkdtempSync(join(tmpdir(), "easyresearch-desktop-smoke-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const project = join(root, "project");
const smokeDir = join(root, "smoke-control");
const electronUserData = join(root, "electron-user-data");
const desktopLogPath = join(electronUserData, "logs", "desktop.log");
const installRoot = join(root, "installed");
const mountRoot = join(root, "mounted");
for (const path of [home, agentDir, project, electronUserData, installRoot, mountRoot]) {
  mkdirSync(path, { recursive: true });
}
mkdirSync(smokeDir, { recursive: true, mode: 0o700 });

const desktopManifest = JSON.parse(readFileSync(
  join(releaseDir(), `desktop-manifest-${targetName}.json`),
  "utf8",
)) as DesktopBuildManifest;
if (desktopManifest.version !== version || desktopManifest.target !== targetName) {
  throw new Error(`Desktop manifest does not match ${targetName}@${version}.`);
}
const packagePath = join(releaseDir(), "desktop", desktopManifest.package.fileName);
if (!existsSync(packagePath)) throw new Error(`Desktop package is missing: ${packagePath}`);
const packageBytes = readFileSync(packagePath);
if (
  packageBytes.byteLength !== desktopManifest.package.size
  || createHash("sha256").update(packageBytes).digest("hex") !== desktopManifest.package.sha256
) {
  throw new Error("Desktop package bytes do not match the desktop build manifest.");
}
const nativeManifest = JSON.parse(readFileSync(buildManifestPath(targetName), "utf8")) as BuildManifest;
const nativeArtifact = nativeManifest.artifacts.find((artifact) => artifact.target === targetName);
if (!nativeArtifact) throw new Error(`Native manifest has no ${targetName} artifact.`);
const nativeTarget = TARGETS.find((candidate) => candidate.name === targetName)!;
const nativeBinary = resolve(
  platformPackageDir(targetName),
  "bin",
  platformBinaryName(nativeTarget),
);

let mounted = false;
let installed = false;
let desktopProcess: ReturnType<typeof Bun.spawn> | undefined;
let desktopStdout = "";
let desktopStderr = "";
let desktopExited = false;
let desktopExitCode: number | undefined;
let desktopOutputTasks: Promise<void>[] = [];
let smokePhase = "package preparation";
let cliPort = 0;
let modelRequestActive = false;
let modelRequestAborted = false;
let primaryError: Error | undefined;

const modelServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const payload = await request.json() as { messages?: unknown };
    const serializedMessages = JSON.stringify(payload.messages ?? []);
    if (serializedMessages.includes(persistedHistorySentinels.user)) {
      return completedModelResponse(persistedHistorySentinels.assistant);
    }
    if (!serializedMessages.includes("Keep this deterministic desktop smoke request active")) {
      return new Response("Unexpected desktop smoke model request.", { status: 400 });
    }
    modelRequestActive = true;
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const markAborted = () => {
      modelRequestAborted = true;
      try {
        controller?.close();
      } catch {
        // The client may have already cancelled the stream.
      }
    };
    request.signal.addEventListener("abort", markAborted, { once: true });
    const body = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
        nextController.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            id: "desktop-smoke",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "smoke-model",
            choices: [{ index: 0, delta: { role: "assistant", content: "running" }, finish_reason: null }],
          })}\n\n`,
        ));
      },
      cancel() {
        modelRequestAborted = true;
      },
    });
    return new Response(body, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  },
});

try {
  const appPaths = installOrMountPackage();
  verifyPackagedSidecar(appPaths.sidecar, nativeArtifact, version);
  verifyDesktopSidecarIdentity(desktopManifest.sidecar, nativeArtifact);
  verifyPackagedNotice(
    appPaths.notices,
    join(platformPackageDir(targetName), THIRD_PARTY_NOTICES_FILE),
  );

  const systemPython = resolveSmokePython({ explicit: process.env.EASYRESEARCH_SMOKE_PYTHON });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    EASYRESEARCH_CODING_AGENT_DIR: agentDir,
    PIP_RETRIES: "3",
    PIP_DEFAULT_TIMEOUT: "30",
    PATH: `${dirname(systemPython)}${delimiter}${process.env.PATH ?? ""}`,
  };
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      smoke: {
        baseUrl: `http://127.0.0.1:${modelServer.port}/v1`,
        api: "openai-completions",
        apiKey: "desktop-smoke-key",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{
          id: "smoke-model",
          name: "Smoke Model",
          contextWindow: 32_000,
          maxTokens: 2_048,
        }],
      },
    },
  }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "smoke",
    defaultModel: "smoke-model",
    easyresearch: {
      agentDefaults: {
        "research-assistant": { model: "smoke/smoke-model", thinking: "off" },
      },
    },
  }));
  const smokeAgent = "smoke-reviewer";
  const smokeAgentContent = [
    "---",
    `name: ${smokeAgent}`,
    "description: Desktop smoke persisted Agent",
    "enable: true",
    "tools: []",
    "skills: []",
    "subagents: []",
    "---",
    "",
    "DESKTOP_SMOKE_PERSISTED_AGENT",
    "",
  ].join("\n");

  const probe = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  if (!probe.port) throw new Error("Desktop smoke could not reserve a CLI port.");
  cliPort = probe.port;
  probe.stop(true);
  const initialClient = await runProcess(nativeBinary, ["--no-open", "--port", String(cliPort)], {
    env,
    cwd: project,
    timeoutMs: 15 * 60_000,
  });
  if (initialClient.exitCode !== 0) {
    throw new Error(`Initial CLI startup failed (${initialClient.exitCode}).\n${initialClient.stdout}\n${initialClient.stderr}`);
  }
  const cliOrigin = `http://127.0.0.1:${cliPort}`;
  await waitFor("CLI daemon readiness", async () => {
    try {
      return (await fetch(`${cliOrigin}/api/status`, { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
      return false;
    }
  }, 60_000);
  await requestJson(cliOrigin, "/api/agent-resources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: smokeAgent }),
  });
  await requestJson(cliOrigin, `/api/agent-resources/${encodeURIComponent(smokeAgent)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: smokeAgentContent }),
  });
  const created = await requestJson(cliOrigin, "/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: project }),
  }) as { id?: unknown };
  if (typeof created.id !== "string" || !created.id) {
    throw new Error("CLI daemon returned an invalid persisted session id.");
  }
  await requestJson(cliOrigin, `/api/sessions/${encodeURIComponent(created.id)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: persistedHistorySentinels.user }),
  });
  let expectedSessionPath: string | undefined;
  await waitFor("CLI-created persisted session", async () => {
    try {
      const snapshot = await requestJson(
        cliOrigin,
        `/api/sessions/${encodeURIComponent(created.id as string)}/snapshot`,
      );
      const sessionPath = readyPersistedSessionPath(snapshot, persistedHistorySentinels);
      if (!sessionPath || !existsSync(sessionPath)) return false;
      expectedSessionPath = sessionPath;
      return true;
    } catch {
      return false;
    }
  }, 60_000);
  if (!expectedSessionPath) throw new Error("CLI daemon did not materialize persisted history.");
  const originalRecord = JSON.parse(readFileSync(join(agentDir, "server.pid"), "utf8")) as {
    pid?: number;
    owner?: string;
  };
  if (!Number.isSafeInteger(originalRecord.pid) || (originalRecord.owner ?? "cli") !== "cli") {
    throw new Error("Initial CLI daemon did not publish CLI ownership.");
  }

  const desktopEnv: NodeJS.ProcessEnv = {
    ...env,
    EASYRESEARCH_DESKTOP_SMOKE_DIR: smokeDir,
    EASYRESEARCH_DESKTOP_SMOKE_PROJECT: project,
    EASYRESEARCH_DESKTOP_SMOKE_SESSION_PATH: expectedSessionPath,
    EASYRESEARCH_DESKTOP_SMOKE_AGENT: smokeAgent,
    EASYRESEARCH_DESKTOP_SMOKE_PROXY: `http://127.0.0.1:${modelServer.port}`,
    [DESKTOP_SMOKE_USER_DATA_ENV]: electronUserData,
  };
  desktopProcess = Bun.spawn([appPaths.executable], {
    env: desktopEnv,
    cwd: project,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  void desktopProcess.exited.then((code) => {
    desktopExited = true;
    desktopExitCode = code;
  });
  const stdoutTask = captureStreamText(desktopProcess.stdout, (chunk) => {
    desktopStdout = appendBoundedDiagnosticText(desktopStdout, chunk);
  });
  const stderrTask = captureStreamText(desktopProcess.stderr, (chunk) => {
    desktopStderr = appendBoundedDiagnosticText(desktopStderr, chunk);
  });
  desktopOutputTasks = [stdoutTask, stderrTask];

  let runningState: ReturnType<typeof reduceDesktopSmokeEvents> | undefined;
  await waitFor("packaged desktop active Agent before restart", () => {
    const state = currentDesktopSmokeState(join(smokeDir, "events.jsonl"));
    if (!state) return false;
    if (state.agentRunning && state.stateVisible && !state.restartAccepted) runningState = state;
    return runningState !== undefined && modelRequestActive;
  }, 120_000);
  const origin = runningState?.origin;
  if (!origin) throw new Error("Packaged desktop smoke did not report its origin.");
  if (isProcessAlive(originalRecord.pid as number)) {
    throw new Error("Desktop startup did not stop the previous CLI daemon.");
  }
  const desktopRecord = JSON.parse(readFileSync(join(agentDir, "server.pid"), "utf8")) as {
    schema?: number;
    pid?: number;
    host?: string;
    owner?: string;
    port?: number;
    token?: string;
    runtimeId?: string;
  };
  if (
    desktopRecord.schema !== 1
    || desktopRecord.owner !== "desktop"
    || !Number.isSafeInteger(desktopRecord.pid)
    || typeof desktopRecord.token !== "string"
    || !desktopRecord.token
    || typeof desktopRecord.runtimeId !== "string"
    || !desktopRecord.runtimeId
    || origin !== `http://127.0.0.1:${desktopRecord.port}`
  ) {
    throw new Error("Packaged app did not publish matching desktop ownership.");
  }
  if (
    runningState?.initialSidecarPid !== desktopRecord.pid
    || !isProcessAlive(desktopRecord.pid as number)
    || modelRequestAborted
  ) {
    throw new Error("Desktop pre-restart smoke did not preserve its live sidecar and active model request.");
  }
  const unauthorized = await fetch(`${origin}/api/status`);
  if (unauthorized.status !== 401) {
    throw new Error(`Unauthenticated desktop request returned HTTP ${unauthorized.status}, expected 401.`);
  }

  const refusedSetupEvidence = join(root, "refused-cli-first-run.json");
  const refusedEnv = {
    ...env,
    [SMOKE_SETUP_RESULT_PATH_ENV]: refusedSetupEvidence,
    [SMOKE_SETUP_RUN_ID_ENV]: "desktop-owner-refusal",
  };
  for (const args of [["--no-open"], ["exit"]]) {
    const refused = await runProcess(nativeBinary, args, {
      env: refusedEnv,
      cwd: project,
      timeoutMs: 30_000,
    });
    if (refused.exitCode === 0) {
      throw new Error(`npm CLI ${args.join(" ")} was not rejected during desktop ownership.`);
    }
    if (process.platform !== "win32" && !`${refused.stdout}\n${refused.stderr}`.match(/tray|menu bar/i)) {
      throw new Error(`npm CLI refusal lacked desktop recovery guidance: ${refused.stdout}\n${refused.stderr}`);
    }
  }
  if (existsSync(refusedSetupEvidence)) {
    throw new Error("Rejected npm CLI startup mutated first-run setup state during desktop ownership.");
  }
  if (modelRequestAborted || !isProcessAlive(desktopRecord.pid as number)) {
    throw new Error("CLI refusal disturbed the active desktop Agent or sidecar.");
  }

  writeFileSync(join(smokeDir, "successor-start-failure-request"), "fail-once\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(join(smokeDir, "restart-request"), "restart\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await waitFor("packaged desktop successor failure recovery", () => {
    const state = currentDesktopSmokeState(join(smokeDir, "events.jsonl"));
    return state?.successorStartFailed === true
      && state.restartRecoveryVisible === true
      && state.restartRecoveryLogged === true
      && state.successorRetryRequested === false
      && state.successorOrigin === undefined;
  }, 120_000);
  if (!desktopProcess || !isProcessAlive(desktopProcess.pid)) {
    throw new Error("Packaged desktop host exited before successor failure recovery could be retried.");
  }
  if (
    existsSync(join(agentDir, "server.pid"))
    || existsSync(join(agentDir, "server.lease"))
    || existsSync(join(agentDir, "server.transition.lease"))
  ) {
    throw new Error("Desktop successor failure recovery retained an old or partial runtime owner.");
  }
  writeFileSync(join(smokeDir, "successor-retry-request"), "retry\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  let successorState: ReturnType<typeof reduceDesktopSmokeEvents> | undefined;
  await waitFor("packaged desktop expected restart and hidden successor", () => {
    const state = currentDesktopSmokeState(join(smokeDir, "events.jsonl"));
    if (!state) return false;
    if (
      state.restartAccepted
      && state.restartRequested
      && state.oldSidecarExited
      && state.successorVisible
      && state.hidden
    ) {
      successorState = state;
    }
    return successorState !== undefined;
  }, 120_000);
  const acceptedSuccessorState = successorState;
  const successorOrigin = acceptedSuccessorState?.successorOrigin;
  if (!acceptedSuccessorState || !successorOrigin) {
    throw new Error("Packaged desktop smoke did not report its successor origin.");
  }
  await waitFor("forced active model request cancellation", () => modelRequestAborted, 30_000);
  const successorRecord = JSON.parse(readFileSync(join(agentDir, "server.pid"), "utf8")) as {
    schema?: number;
    pid?: number;
    host?: string;
    owner?: string;
    port?: number;
    token?: string;
    runtimeId?: string;
  };
  verifyDesktopOwnershipSuccessor(desktopRecord, successorRecord, origin, successorOrigin);
  verifyPackagedSidecar(appPaths.sidecar, nativeArtifact, version);
  if (
    acceptedSuccessorState.successorSidecarPid !== successorRecord.pid
    || acceptedSuccessorState.sidecarPid !== successorRecord.pid
    || !isProcessAlive(successorRecord.pid as number)
  ) {
    throw new Error("Desktop successor close did not preserve its live owned sidecar.");
  }
  const successorUnauthorized = await fetch(`${successorOrigin}/api/status`);
  if (successorUnauthorized.status !== 401) {
    throw new Error(
      `Unauthenticated desktop successor request returned HTTP ${successorUnauthorized.status}, expected 401.`,
    );
  }
  const eventsPath = join(smokeDir, "events.jsonl");
  const eventCountBeforeQuietWindow = readDesktopSmokeEvents(eventsPath).length;
  await Bun.sleep(500);
  const eventsAfterQuietWindow = readDesktopSmokeEvents(eventsPath);
  reduceDesktopSmokeEvents(eventsAfterQuietWindow, {
    desktopLog: existsSync(desktopLogPath) ? readFileSync(desktopLogPath, "utf8") : "",
  });
  if (eventsAfterQuietWindow.length !== eventCountBeforeQuietWindow) {
    throw new Error("Desktop expected restart did not stabilize after one successor.");
  }

  const successorToken = `desktop-smoke-successor-${Date.now()}`;
  writeFileSync(join(agentDir, "server.pid"), `${JSON.stringify({
    ...successorRecord,
    token: successorToken,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(smokeDir, "exit-request"), "exit\n", { encoding: "utf8", mode: 0o600 });
  const finalDesktopExitCode = await waitForProcess(desktopProcess, 60_000);
  if (!await outputTasksSettle([stdoutTask, stderrTask], 2_000)) {
    throw new Error("Packaged desktop stdio remained open after host exit.");
  }
  if (finalDesktopExitCode !== 0) {
    throw new Error(`Packaged desktop exited ${finalDesktopExitCode}.\n${desktopStdout}\n${desktopStderr}`);
  }
  await waitFor("terminal desktop milestones", () => {
    const state = currentDesktopSmokeState(join(smokeDir, "events.jsonl"));
    return state?.stopped ?? false;
  }, 30_000, { allowDesktopExit: true });
  if (existsSync(join(agentDir, "server.lease"))) {
    throw new Error("Desktop Exit left its live-server lease behind.");
  }
  const preservedRecord = JSON.parse(readFileSync(join(agentDir, "server.pid"), "utf8")) as {
    token?: unknown;
  };
  if (preservedRecord.token !== successorToken) {
    throw new Error("Desktop Exit erased a successor ownership token during cleanup.");
  }
  try {
    await fetch(`${successorOrigin}/api/status`, { signal: AbortSignal.timeout(1_000) });
    throw new Error("Desktop origin remained reachable after terminal Exit.");
  } catch (error) {
    if (error instanceof Error && error.message === "Desktop origin remained reachable after terminal Exit.") throw error;
  }
  console.log(`[desktop-smoke] ${targetName} passed`);
} catch (error) {
  primaryError = error instanceof Error ? error : new Error(String(error));
  console.error(`[desktop-smoke] failure: ${primaryError.stack ?? primaryError.message}`);
  try {
    const report = createDesktopSmokeDiagnosticReport({
      target: targetName,
      phase: smokePhase,
      process: desktopProcess ? {
        pid: desktopProcess.pid,
        exited: desktopExited,
        ...(desktopExitCode !== undefined ? { exitCode: desktopExitCode } : {}),
      } : undefined,
      eventsPath: join(smokeDir, "events.jsonl"),
      desktopLogPath,
      serverLogPath: serverLogFile(agentDir),
      agentDir,
      stdout: desktopStdout,
      stderr: desktopStderr,
      modelRequestActive,
      modelRequestAborted,
    });
    const diagnosticsDirectory = join(releaseDir(), "desktop-smoke-diagnostics");
    mkdirSync(diagnosticsDirectory, { recursive: true });
    const reportPath = join(diagnosticsDirectory, `${targetName}.json`);
    writeFileSync(reportPath, report, { encoding: "utf8", mode: 0o600 });
    console.error(`[desktop-smoke] sanitized diagnostics: ${reportPath}\n${report}`);
  } catch (diagnosticError) {
    console.error(
      `[desktop-smoke] sanitized diagnostic collection failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`,
    );
  }
} finally {
  const cleanupFailures: Error[] = [];
  try {
    writeFileSync(join(smokeDir, "exit-request"), "exit\n");
  } catch {
    // The app may never have reached smoke initialization.
  }
  if (desktopProcess && isProcessAlive(desktopProcess.pid)) {
    desktopProcess.kill("SIGKILL");
    try {
      await waitForProcess(desktopProcess, 10_000);
    } catch (error) {
      cleanupFailures.push(new Error("Packaged desktop process cleanup failed.", { cause: error }));
    }
  }
  if (desktopOutputTasks.length > 0) {
    await Promise.race([
      Promise.allSettled(desktopOutputTasks),
      Bun.sleep(1_000),
    ]);
  }
  if (cliPort > 0) {
    try {
      const cleanup = await runProcess(nativeBinary, ["exit"], { env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(root, "appdata"),
        LOCALAPPDATA: join(root, "localappdata"),
        EASYRESEARCH_CODING_AGENT_DIR: agentDir,
      }, cwd: project, timeoutMs: 30_000 });
      if (
        cleanup.exitCode !== 0
        && (existsSync(join(agentDir, "server.pid")) || existsSync(join(agentDir, "server.lease")))
      ) {
        cleanupFailures.push(new Error(
          `Native ownership cleanup failed (${cleanup.exitCode}).\n${cleanup.stdout}\n${cleanup.stderr}`,
        ));
      }
    } catch (error) {
      cleanupFailures.push(new Error("Native ownership cleanup failed.", { cause: error }));
    }
  }
  modelServer.stop(true);
  try {
    cleanupPackage();
  } catch (error) {
    cleanupFailures.push(new Error("Desktop package cleanup failed.", { cause: error }));
  }
  primaryError = combineDesktopSmokeFailures(primaryError, cleanupFailures);
  if (primaryError && cleanupFailures.length > 0) {
    console.error(`[desktop-smoke] preserved cleanup diagnostics root: ${root}`);
  }
  if (!primaryError) await removeDesktopSmokeRoot(root);
}

if (primaryError) throw primaryError;

function completedModelResponse(text: string): Response {
  const id = "desktop-smoke-persisted";
  const created = Math.floor(Date.now() / 1000);
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: "smoke-model",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: "smoke-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

async function requestJson(
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Desktop smoke request ${path} returned HTTP ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) as unknown : undefined;
}

function installOrMountPackage(): ReturnType<typeof packagedApplicationPaths> {
  if (targetName === "windows-x64") {
    runNative(nsisInstallCommand(packagePath, installRoot), "NSIS installation");
    installed = true;
    return packagedApplicationPaths(targetName, installRoot);
  }
  runNative(dmgAttachCommand(packagePath, mountRoot), "DMG attach");
  mounted = true;
  return packagedApplicationPaths(targetName, mountRoot);
}

function cleanupPackage(): void {
  if (installed) {
    const uninstaller = packagedApplicationPaths("windows-x64", installRoot).uninstaller;
    if (uninstaller && existsSync(uninstaller)) runNative({ command: uninstaller, args: ["/S"] }, "NSIS uninstall");
  }
  if (mounted) runNative(dmgDetachCommand(mountRoot), "DMG detach");
}

function runNative(command: NativeCommand, label: string): void {
  const result = spawnSync(command.command, command.args, { encoding: "utf8", timeout: 180_000 });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed (${result.status ?? "no status"}): ${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn([command, ...args], {
    env: options.env,
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = streamText(process.stdout);
  const stderr = streamText(process.stderr);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let exitCode: number;
  try {
    exitCode = await Promise.race([
      process.exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          process.kill("SIGKILL");
          reject(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms.`));
        }, options.timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return { exitCode, stdout: await stdout, stderr: await stderr };
}

async function waitForProcess(
  process: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          process.kill("SIGKILL");
          reject(new Error(`Packaged desktop process timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function streamText(stream: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
  return stream instanceof ReadableStream ? new Response(stream).text() : "";
}

async function captureStreamText(
  stream: ReadableStream<Uint8Array> | number | undefined,
  receive: (chunk: string) => void,
): Promise<void> {
  if (!(stream instanceof ReadableStream)) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) receive(text);
    }
    const trailing = decoder.decode();
    if (trailing) receive(trailing);
  } finally {
    reader.releaseLock();
  }
}

async function outputTasksSettle(
  tasks: readonly Promise<void>[],
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all(tasks).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitFor(
  label: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  options: { allowDesktopExit?: boolean } = {},
): Promise<void> {
  smokePhase = label;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!options.allowDesktopExit) assertCurrentDesktopProcess(label);
    if (await condition()) return;
    await Bun.sleep(100);
  }
  if (!options.allowDesktopExit) assertCurrentDesktopProcess(label);
  throw new Error(`${label} did not complete within ${timeoutMs}ms.`);
}

function currentDesktopSmokeState(
  eventsPath: string,
): ReturnType<typeof reduceDesktopSmokeEvents> | undefined {
  const polled = pollDesktopSmokeEvents(eventsPath);
  if (polled.status !== "complete") return undefined;
  const state = reduceDesktopSmokeEvents(polled.events, {
    desktopLog: existsSync(desktopLogPath) ? readFileSync(desktopLogPath, "utf8") : "",
  });
  if (state.failure) {
    throw new Error(`Packaged desktop host reported failure: ${state.failure}`);
  }
  return state;
}

function assertCurrentDesktopProcess(label: string): void {
  if (!desktopProcess) return;
  const polled = pollDesktopSmokeEvents(join(smokeDir, "events.jsonl"));
  assertPackagedDesktopRunning(label, {
    pid: desktopProcess.pid,
    exited: desktopExited,
    ...(desktopExitCode !== undefined ? { exitCode: desktopExitCode } : {}),
  }, polled.events);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
