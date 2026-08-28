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
  combineDesktopSmokeFailures,
  dmgAttachCommand,
  dmgDetachCommand,
  nsisInstallCommand,
  packagedApplicationPaths,
  readDesktopSmokeEvents,
  removeDesktopSmokeRoot,
  reduceDesktopSmokeEvents,
  verifyDesktopSidecarIdentity,
  verifyPackagedNotice,
  verifyPackagedSidecar,
  type NativeCommand,
} from "./smoke-desktop-support";

const targetArgument = process.argv[2];
if (!targetArgument || process.argv.length !== 3) {
  throw new Error("Usage: bun scripts/smoke-desktop.ts <windows-x64|darwin-arm64>");
}
const target = desktopTarget(targetArgument);
const targetName: DesktopTargetName = target.name;
assertNativeDesktopHost(targetName);
const version = repoPackageVersion();
const root = mkdtempSync(join(tmpdir(), "easyresearch-desktop-smoke-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const project = join(root, "project");
const smokeDir = join(root, "smoke-control");
const electronUserData = join(root, "electron-user-data");
const installRoot = join(root, "installed");
const mountRoot = join(root, "mounted");
for (const path of [home, agentDir, project, smokeDir, electronUserData, installRoot, mountRoot]) {
  mkdirSync(path, { recursive: true });
}

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
let cliPort = 0;
let modelRequestActive = false;
let modelRequestAborted = false;
let primaryError: Error | undefined;

const modelServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const payload = await request.json() as { messages?: unknown };
    const serializedMessages = JSON.stringify(payload.messages ?? []);
    if (serializedMessages.includes("desktop smoke persisted history")) {
      return completedModelResponse("desktop smoke persisted response");
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
    body: JSON.stringify({ message: "desktop smoke persisted history" }),
  });
  let expectedSessionPath: string | undefined;
  await waitFor("CLI-created persisted session", async () => {
    try {
      const snapshot = await requestJson(
        cliOrigin,
        `/api/sessions/${encodeURIComponent(created.id as string)}/snapshot`,
      ) as {
        session?: { sessionFile?: unknown; status?: unknown; isStreaming?: unknown };
        messages?: unknown[];
      };
      if (
        snapshot.session?.status !== "ready"
        || snapshot.session.isStreaming !== false
        || typeof snapshot.session.sessionFile !== "string"
        || !Array.isArray(snapshot.messages)
        || snapshot.messages.length < 2
      ) {
        return false;
      }
      expectedSessionPath = snapshot.session.sessionFile;
      return existsSync(expectedSessionPath);
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
    [DESKTOP_SMOKE_USER_DATA_ENV]: electronUserData,
  };
  desktopProcess = Bun.spawn([appPaths.executable], {
    env: desktopEnv,
    cwd: project,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutTask = streamText(desktopProcess.stdout).then((value) => { desktopStdout = value; });
  const stderrTask = streamText(desktopProcess.stderr).then((value) => { desktopStderr = value; });

  let runningState: ReturnType<typeof reduceDesktopSmokeEvents> | undefined;
  await waitFor("packaged desktop active Agent and hidden window", () => {
    try {
      const eventsPath = join(smokeDir, "events.jsonl");
      if (!existsSync(eventsPath)) return false;
      const state = reduceDesktopSmokeEvents(readDesktopSmokeEvents(eventsPath));
      if (state.hidden && state.agentRunning && state.stateVisible) runningState = state;
      return runningState !== undefined && modelRequestActive;
    } catch {
      return false;
    }
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
    runningState?.sidecarPid !== desktopRecord.pid
    || !isProcessAlive(desktopRecord.pid as number)
    || modelRequestAborted
  ) {
    throw new Error("Desktop close did not preserve its live sidecar and active model request.");
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

  const successorToken = `desktop-smoke-successor-${Date.now()}`;
  writeFileSync(join(agentDir, "server.pid"), `${JSON.stringify({
    ...desktopRecord,
    token: successorToken,
  })}\n`, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(smokeDir, "exit-request"), "exit\n");
  const desktopExitCode = await waitForProcess(desktopProcess, 60_000);
  await Promise.all([stdoutTask, stderrTask]);
  if (desktopExitCode !== 0) {
    throw new Error(`Packaged desktop exited ${desktopExitCode}.\n${desktopStdout}\n${desktopStderr}`);
  }
  await waitFor("terminal desktop milestones", () => {
    try {
      const state = reduceDesktopSmokeEvents(readDesktopSmokeEvents(join(smokeDir, "events.jsonl")));
      return state.stopped;
    } catch {
      return false;
    }
  }, 30_000);
  await waitFor("model request cancellation", () => modelRequestAborted, 30_000);
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
    await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(1_000) });
    throw new Error("Desktop origin remained reachable after terminal Exit.");
  } catch (error) {
    if (error instanceof Error && error.message === "Desktop origin remained reachable after terminal Exit.") throw error;
  }
  console.log(`[desktop-smoke] ${targetName} passed`);
} catch (error) {
  primaryError = error instanceof Error ? error : new Error(String(error));
  console.error(`[desktop-smoke] failure: ${primaryError.stack ?? primaryError.message}`);
  console.error(`[desktop-smoke] preserved diagnostics root: ${root}`);
  if (desktopStdout) console.error(`[desktop-smoke] desktop stdout:\n${desktopStdout}`);
  if (desktopStderr) console.error(`[desktop-smoke] desktop stderr:\n${desktopStderr}`);
  const eventsPath = join(smokeDir, "events.jsonl");
  if (existsSync(eventsPath)) console.error(`[desktop-smoke] events:\n${readFileSync(eventsPath, "utf8")}`);
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

async function waitFor(
  label: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(100);
  }
  throw new Error(`${label} did not complete within ${timeoutMs}ms.`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
