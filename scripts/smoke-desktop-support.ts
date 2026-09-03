import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, posix, win32 } from "node:path";
import type { BuildArtifact } from "./build";
import type { DesktopTargetName } from "./build-desktop";
import { THIRD_PARTY_NOTICES_FILE } from "./third-party-notices";

const TRANSIENT_DESKTOP_SMOKE_CLEANUP_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const DESKTOP_SUCCESSOR_FAILURE_LOG = "Desktop smoke injected one successor startup failure.";

export interface NativeCommand {
  command: string;
  args: string[];
}

export interface DesktopSmokeOwnershipRecord {
  schema?: unknown;
  owner?: unknown;
  host?: unknown;
  pid?: unknown;
  port?: unknown;
  token?: unknown;
  runtimeId?: unknown;
}

export function verifyDesktopOwnershipSuccessor(
  initial: DesktopSmokeOwnershipRecord,
  successor: DesktopSmokeOwnershipRecord,
  initialOrigin: string,
  successorOrigin: string,
): void {
  if (
    typeof initial.token !== "string"
    || !initial.token
    || typeof successor.token !== "string"
    || !successor.token
    || successor.token === initial.token
  ) {
    throw new Error("Desktop successor did not use a fresh lifecycle credential.");
  }
  if (
    typeof initial.runtimeId !== "string"
    || !initial.runtimeId
    || successor.runtimeId !== initial.runtimeId
  ) {
    throw new Error("Desktop successor did not use the same accepted packaged runtime.");
  }
  for (const [record, origin] of [
    [initial, initialOrigin],
    [successor, successorOrigin],
  ] as const) {
    if (
      record.schema !== 1
      || record.owner !== "desktop"
      || record.host !== "127.0.0.1"
      || !Number.isSafeInteger(record.pid)
      || (record.pid as number) <= 0
      || !Number.isSafeInteger(record.port)
      || (record.port as number) <= 0
      || validateSmokeOrigin(origin) !== `http://127.0.0.1:${record.port as number}`
    ) {
      throw new Error("Desktop ownership record did not match its reported origin.");
    }
  }
}

export interface DesktopSmokeState {
  origin?: string;
  initialBootId?: string;
  initialSidecarPid?: number;
  failure?: string;
  loaded: boolean;
  stateVisible: boolean;
  agentRunning: boolean;
  restartAccepted: boolean;
  restartRequested: boolean;
  oldSidecarExited: boolean;
  successorStartFailed: boolean;
  restartRecoveryVisible: boolean;
  restartRecoveryLogged: boolean;
  successorRetryRequested: boolean;
  successorOrigin?: string;
  successorBootId?: string;
  successorSidecarPid?: number;
  rendererCredentialFresh: boolean;
  successorVisible: boolean;
  restoredHash?: string;
  hidden: boolean;
  sidecarPid?: number;
  exitStarted: boolean;
  stopped: boolean;
}

export interface DesktopSmokeEvidence {
  desktopLog?: string;
}

export interface PackagedDesktopProcessState {
  pid: number;
  exited: boolean;
  exitCode?: number;
  signal?: string;
}

export interface DesktopSmokeDiagnosticOptions {
  target: DesktopTargetName;
  phase: string;
  process?: PackagedDesktopProcessState;
  eventsPath: string;
  desktopLogPath: string;
  serverLogPath: string;
  agentDir: string;
  stdout: string;
  stderr: string;
  modelRequestActive: boolean;
  modelRequestAborted: boolean;
  maxTextCharacters?: number;
  isAlive?: (pid: number) => boolean;
}

export function readyPersistedSessionPath(
  snapshot: unknown,
  sentinels: { user: string; assistant: string },
): string | undefined {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined;
  const value = snapshot as { session?: unknown; timeline?: unknown; messages?: unknown };
  if (!value.session || typeof value.session !== "object" || Array.isArray(value.session)) return undefined;
  const session = value.session as {
    sessionFile?: unknown;
    status?: unknown;
    isStreaming?: unknown;
  };
  if (
    session.status !== "ready"
    || session.isStreaming !== false
    || typeof session.sessionFile !== "string"
    || !session.sessionFile
    || typeof sentinels.user !== "string"
    || !sentinels.user
    || typeof sentinels.assistant !== "string"
    || !sentinels.assistant
    || Object.hasOwn(value, "messages")
    || !Array.isArray(value.timeline)
  ) return undefined;

  let userObserved = false;
  let pairObserved = false;
  for (const entry of value.timeline) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const timelineEntry = entry as { kind?: unknown; message?: unknown };
    if (timelineEntry.kind === "compaction" || timelineEntry.kind === "branch-summary") continue;
    if (
      timelineEntry.kind !== "message"
      || !timelineEntry.message
      || typeof timelineEntry.message !== "object"
      || Array.isArray(timelineEntry.message)
    ) return undefined;

    const message = timelineEntry.message as { role?: unknown; content?: unknown };
    if (typeof message.role !== "string") return undefined;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = persistedMessageText(message.role, message.content);
    if (text === undefined) return undefined;
    if (message.role === "user" && text === sentinels.user) {
      userObserved = true;
    } else if (message.role === "assistant" && userObserved && text === sentinels.assistant) {
      pairObserved = true;
    }
  }
  return pairObserved ? session.sessionFile : undefined;
}

function persistedMessageText(role: "user" | "assistant", content: unknown): string | undefined {
  if (role === "user" && typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  let text = "";
  for (const block of content) {
    if (
      !block
      || typeof block !== "object"
      || Array.isArray(block)
      || (block as { type?: unknown }).type !== "text"
      || typeof (block as { text?: unknown }).text !== "string"
    ) return undefined;
    text += (block as { text: string }).text;
  }
  return text;
}

export function combineDesktopSmokeFailures(
  primary: Error | undefined,
  cleanupFailures: readonly Error[],
): Error | undefined {
  if (cleanupFailures.length === 0) return primary;
  const failures = primary ? [primary, ...cleanupFailures] : [...cleanupFailures];
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, "Desktop package smoke and cleanup failed.");
}

export function appendBoundedDiagnosticText(
  current: string,
  chunk: string,
  maxCharacters = 32_768,
): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) return "";
  const combined = `${current}${chunk}`;
  return combined.length <= maxCharacters ? combined : combined.slice(-maxCharacters);
}

export function assertPackagedDesktopRunning(
  phase: string,
  processState: PackagedDesktopProcessState,
  events: readonly Record<string, unknown>[],
): void {
  if (!processState.exited) return;
  const lastType = events.length > 0 && typeof events.at(-1)?.type === "string"
    ? events.at(-1)!.type
    : "none";
  throw new Error(
    `Packaged desktop exited during ${phase} (pid ${processState.pid}, code ${processState.exitCode ?? "unknown"}, signal ${processState.signal ?? "none"}, ${events.length} events, last ${lastType}).`,
  );
}

export function createDesktopSmokeDiagnosticReport(
  options: DesktopSmokeDiagnosticOptions,
): string {
  const isAlive = options.isAlive ?? defaultIsAlive;
  const maxTextCharacters = Math.min(options.maxTextCharacters ?? 8_192, 32_768);
  const events = safeEventEvidence(options.eventsPath);
  const serverRecord = safeRecordEvidence(join(options.agentDir, "server.pid"), isAlive);
  const serverLease = safeLeaseEvidence(join(options.agentDir, "server.lease"), isAlive);
  const transitionLease = safeLeaseEvidence(
    join(options.agentDir, "server.transition.lease"),
    isAlive,
  );
  return `${JSON.stringify({
    target: options.target,
    phase: options.phase,
    process: options.process
      ? { ...options.process, alive: isAlive(options.process.pid) }
      : { state: "not-started" },
    events,
    ownership: {
      serverRecord: serverRecord.summary,
      serverLease: serverLease.summary,
      transitionLease: transitionLease.summary,
      serverRecordTokenMatches: Boolean(
        serverRecord.token
        && serverLease.token
        && serverRecord.token === serverLease.token
      ),
    },
    modelRequestActive: options.modelRequestActive,
    modelRequestAborted: options.modelRequestAborted,
    desktopLog: safeTextEvidence(options.desktopLogPath, maxTextCharacters),
    serverLog: safeTextEvidence(options.serverLogPath, maxTextCharacters),
    stdout: redactDiagnosticText(appendBoundedDiagnosticText("", options.stdout, maxTextCharacters)),
    stderr: redactDiagnosticText(appendBoundedDiagnosticText("", options.stderr, maxTextCharacters)),
  }, null, 2)}\n`;
}

export async function removeDesktopSmokeRoot(
  path: string,
  options: {
    remove?: (path: string) => void;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<void> {
  const remove = options.remove ?? ((target) => rmSync(target, { recursive: true, force: true }));
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolveWait) => setTimeout(resolveWait, delayMs)));
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      remove(path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!TRANSIENT_DESKTOP_SMOKE_CLEANUP_CODES.has(code ?? "") || attempt === 20) throw error;
      await wait(250);
    }
  }
}

export function verifyPackagedSidecar(
  packagedPath: string,
  nativeArtifact: BuildArtifact,
  version: string,
): void {
  if (nativeArtifact.version !== version) {
    throw new Error("Packaged sidecar native manifest version mismatch.");
  }
  const size = statSync(packagedPath).size;
  if (size !== nativeArtifact.size) {
    throw new Error(
      `Packaged sidecar size mismatch: expected ${nativeArtifact.size}, received ${size}.`,
    );
  }
  const sha256 = createHash("sha256").update(readFileSync(packagedPath)).digest("hex");
  if (sha256 !== nativeArtifact.sha256) {
    throw new Error("Packaged sidecar SHA-256 mismatch.");
  }
}

export function verifyPackagedNotice(packagedPath: string, acceptedPath: string): void {
  const accepted = readFileSync(acceptedPath);
  const packaged = readFileSync(packagedPath);
  if (!packaged.equals(accepted)) {
    throw new Error("Packaged third-party notices do not match the accepted native package.");
  }
}

export function verifyDesktopSidecarIdentity(
  desktopArtifact: BuildArtifact,
  nativeArtifact: BuildArtifact,
): void {
  const keys = ["version", "target", "binaryName", "size", "sha256", "builtAt"] as const;
  if (keys.some((key) => desktopArtifact[key] !== nativeArtifact[key])) {
    throw new Error("Desktop manifest sidecar does not match the accepted native manifest.");
  }
}

export function nsisInstallCommand(installer: string, installDir: string): NativeCommand {
  return { command: installer, args: ["/S", `/D=${installDir}`] };
}

export function dmgAttachCommand(dmg: string, mountPoint: string): NativeCommand {
  return {
    command: "/usr/bin/hdiutil",
    args: ["attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mountPoint],
  };
}

export function dmgDetachCommand(mountPoint: string): NativeCommand {
  return {
    command: "/usr/bin/hdiutil",
    args: ["detach", mountPoint, "-force"],
  };
}

export function packagedApplicationPaths(
  target: DesktopTargetName,
  root: string,
): { executable: string; sidecar: string; notices: string; uninstaller?: string } {
  if (target === "windows-x64") {
    return {
      executable: win32.join(root, "EasyResearch.exe"),
      sidecar: win32.join(root, "resources", "sidecar", "easyresearch.exe"),
      notices: win32.join(root, "resources", "sidecar", THIRD_PARTY_NOTICES_FILE),
      uninstaller: win32.join(root, "Uninstall EasyResearch.exe"),
    };
  }
  return {
    executable: posix.join(root, "EasyResearch.app", "Contents", "MacOS", "EasyResearch"),
    sidecar: posix.join(
      root,
      "EasyResearch.app",
      "Contents",
      "Resources",
      "sidecar",
      "easyresearch",
    ),
    notices: posix.join(
      root,
      "EasyResearch.app",
      "Contents",
      "Resources",
      "sidecar",
      THIRD_PARTY_NOTICES_FILE,
    ),
  };
}

export function readDesktopSmokeEvents(path: string): Array<Record<string, unknown>> {
  const content = readFileSync(path, "utf8");
  if (!content) return [];
  if (!content.endsWith("\n")) throw new Error("Invalid desktop smoke event: partial JSONL record.");
  return parseDesktopSmokeEventContent(content);
}

export function pollDesktopSmokeEvents(path: string): {
  status: "missing" | "partial" | "complete";
  events: Array<Record<string, unknown>>;
} {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", events: [] };
    }
    throw error;
  }
  if (content && !content.endsWith("\n")) {
    const completeEnd = content.lastIndexOf("\n");
    return {
      status: "partial",
      events: completeEnd < 0
        ? []
        : parseDesktopSmokeEventContent(content.slice(0, completeEnd + 1)),
    };
  }
  return { status: "complete", events: parseDesktopSmokeEventContent(content) };
}

function parseDesktopSmokeEventContent(content: string): Array<Record<string, unknown>> {
  if (!content) return [];
  return content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        return parsed as Record<string, unknown>;
      } catch (error) {
        throw new Error("Invalid desktop smoke event JSON.", { cause: error });
      }
    });
}

function safeEventEvidence(path: string): Record<string, unknown> {
  try {
    const result = pollDesktopSmokeEvents(path);
    return {
      status: result.status,
      count: result.events.length,
      lastType: typeof result.events.at(-1)?.type === "string"
        ? result.events.at(-1)!.type
        : undefined,
    };
  } catch (error) {
    return {
      status: "invalid",
      error: error instanceof Error ? error.message : "unknown event read failure",
    };
  }
}

function safeRecordEvidence(
  path: string,
  isAlive: (pid: number) => boolean,
): { summary: Record<string, unknown>; token?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { summary: { status: "missing" } };
    }
    return { summary: { status: "invalid" } };
  }
  return summarizeOwnershipRecord(parsed, "file", isAlive);
}

function safeLeaseEvidence(
  path: string,
  isAlive: (pid: number) => boolean,
): { summary: Record<string, unknown>; token?: string } {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { summary: { status: "missing" } }
      : { summary: { status: "invalid" } };
  }
  if (stat.isFile()) {
    const record = safeRecordEvidence(path, isAlive);
    return { ...record, summary: { ...record.summary, status: "legacy-file" } };
  }
  if (!stat.isDirectory()) return { summary: { status: "invalid" } };
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return { summary: { status: "invalid" } };
  }
  if (entries.length === 0) return { summary: { status: "empty-directory" } };
  if (entries.length !== 1) return { summary: { status: "invalid-directory" } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(path, entries[0]!), "utf8"));
  } catch {
    return { summary: { status: "invalid-directory" } };
  }
  return summarizeOwnershipRecord(parsed, "directory", isAlive);
}

function summarizeOwnershipRecord(
  value: unknown,
  status: string,
  isAlive: (pid: number) => boolean,
): { summary: Record<string, unknown>; token?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { summary: { status: "invalid" } };
  }
  const record = value as DesktopSmokeOwnershipRecord & { kind?: unknown };
  const pid = Number.isSafeInteger(record.pid) && (record.pid as number) > 0
    ? record.pid as number
    : undefined;
  const token = typeof record.token === "string" && record.token ? record.token : undefined;
  return {
    summary: {
      status,
      schema: Number.isSafeInteger(record.schema) ? record.schema : "invalid",
      ...(record.kind === "server" || record.kind === "transition" ? { kind: record.kind } : {}),
      owner: record.owner === "cli" || record.owner === "desktop" ? record.owner : "invalid",
      pid,
      ...(pid ? { pidAlive: isAlive(pid) } : {}),
      ...(record.host === "127.0.0.1" ? { host: record.host } : {}),
      ...(Number.isSafeInteger(record.port) ? { port: record.port } : {}),
      runtimeIdPresent: typeof record.runtimeId === "string" && record.runtimeId.length > 0,
      tokenPresent: token !== undefined,
    },
    token,
  };
}

function safeTextEvidence(path: string, maxCharacters: number): Record<string, unknown> {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const maxBytes = Math.max(4, maxCharacters * 4);
    const offset = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    fd = openSync(path, "r");
    const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, offset);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    return {
      status: "present",
      bytes: size,
      tail: redactDiagnosticText(appendBoundedDiagnosticText("", content, maxCharacters)),
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing" }
      : { status: "unreadable" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/("[^"\r\n]*token[^"\r\n]*"\s*:\s*)"[^"\r\n]*"/giu, "$1\"[REDACTED]\"")
    .replace(/\b(token|authorization|x-easyresearch-[a-z-]+)=([^\s]+)/giu, "$1=[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@");
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function reduceDesktopSmokeEvents(
  events: readonly Record<string, unknown>[],
  evidence: DesktopSmokeEvidence = {},
): DesktopSmokeState {
  const state: DesktopSmokeState = {
    loaded: false,
    stateVisible: false,
    agentRunning: false,
    restartAccepted: false,
    restartRequested: false,
    oldSidecarExited: false,
    successorStartFailed: false,
    restartRecoveryVisible: false,
    restartRecoveryLogged: false,
    successorRetryRequested: false,
    rendererCredentialFresh: false,
    successorVisible: false,
    hidden: false,
    exitStarted: false,
    stopped: false,
  };
  for (const event of events) {
    switch (event.type) {
      case "desktop-smoke.sidecar-ready": {
        if (typeof event.origin !== "string") {
          throw new Error("Invalid desktop sidecar readiness milestone.");
        }
        const origin = validateSmokeOrigin(event.origin);
        if (state.origin === undefined) {
          requireMilestone(
            typeof event.bootId === "string" && event.bootId.length > 0,
            "Desktop readiness did not report a boot identity.",
          );
          requireMilestone(
            Number.isSafeInteger(event.sidecarPid) && (event.sidecarPid as number) > 0,
            "Desktop readiness did not report a valid sidecar process.",
          );
          state.origin = origin;
          state.initialBootId = event.bootId;
          state.initialSidecarPid = event.sidecarPid as number;
          break;
        }
        requireMilestone(
          state.oldSidecarExited && state.restartRequested,
          "Successor became ready before the validated old-sidecar exit.",
        );
        requireMilestone(
          state.successorOrigin === undefined,
          "Desktop smoke observed a restart loop with duplicate successor readiness.",
        );
        requireMilestone(
          !state.successorStartFailed || state.successorRetryRequested,
          "Desktop successor started before the requested failure recovery retry.",
        );
        requireMilestone(
          typeof event.bootId === "string"
            && event.bootId.length > 0
            && event.bootId !== state.initialBootId,
          "Desktop successor did not report a fresh boot id.",
        );
        requireMilestone(
          Number.isSafeInteger(event.sidecarPid) && (event.sidecarPid as number) > 0,
          "Desktop successor did not report a valid sidecar process.",
        );
        requireMilestone(
          event.rendererCredentialFresh === true,
          "Desktop successor did not use a fresh renderer credential.",
        );
        state.successorOrigin = origin;
        state.successorBootId = event.bootId;
        state.successorSidecarPid = event.sidecarPid as number;
        state.rendererCredentialFresh = true;
        break;
      }
      case "desktop-smoke.window-loaded":
        requireMilestone(state.origin !== undefined, "Window loaded before sidecar readiness.");
        state.loaded = true;
        break;
      case "desktop-smoke.state-visible":
        requireMilestone(state.loaded, "Shared state was checked before the window loaded.");
        state.stateVisible = true;
        break;
      case "desktop-smoke.agent-running":
        requireMilestone(state.stateVisible, "Agent started before shared state validation.");
        state.agentRunning = true;
        break;
      case "desktop-smoke.restart-api-accepted":
        requireMilestone(state.agentRunning, "Runtime restart was accepted before an Agent was running.");
        requireMilestone(!state.restartAccepted, "Invalid duplicate desktop restart API acceptance.");
        requireMilestone(
          typeof event.bootId === "string" && event.bootId === state.initialBootId,
          "Runtime restart acceptance did not match the old boot.",
        );
        requireMilestone(
          typeof event.hash === "string" && event.hash.startsWith("#/work/"),
          "Runtime restart did not capture a canonical Work hash.",
        );
        requireMilestone(
          state.restoredHash === undefined || state.restoredHash === event.hash,
          "Runtime restart and successor Work hashes did not match.",
        );
        state.restartAccepted = true;
        state.restoredHash = event.hash;
        break;
      case "desktop-smoke.restart-requested":
        requireMilestone(state.agentRunning, "Desktop restart event arrived before an Agent was running.");
        requireMilestone(!state.restartRequested, "Invalid duplicate desktop restart event.");
        requireMilestone(
          typeof event.bootId === "string" && event.bootId === state.initialBootId,
          "Desktop restart event did not match the old boot.",
        );
        state.restartRequested = true;
        break;
      case "desktop-smoke.old-sidecar-exited":
        requireMilestone(
          state.restartRequested,
          "Old sidecar exited before the validated restart event.",
        );
        requireMilestone(
          event.clean === true
            && typeof event.bootId === "string"
            && event.bootId === state.initialBootId,
          "Old desktop sidecar did not exit cleanly from the expected boot.",
        );
        state.oldSidecarExited = true;
        break;
      case "desktop-smoke.successor-start-failed":
        requireMilestone(
          state.oldSidecarExited && state.restartRequested,
          "Desktop successor failure was injected before the validated old-sidecar exit.",
        );
        requireMilestone(
          !state.successorStartFailed && state.successorOrigin === undefined,
          "Invalid duplicate desktop successor-start failure.",
        );
        requireMilestone(
          typeof event.hash === "string" && event.hash.startsWith("#/work/"),
          "Desktop successor-start failure did not retain a canonical Work hash.",
        );
        requireMilestone(
          state.restoredHash === undefined || state.restoredHash === event.hash,
          "Desktop successor-start failure did not retain the restart Work hash.",
        );
        state.restoredHash = event.hash;
        state.successorStartFailed = true;
        break;
      case "desktop-smoke.restart-recovery-visible":
        requireMilestone(
          state.successorStartFailed && !state.restartRecoveryVisible,
          "Desktop restart recovery appeared without one successor-start failure.",
        );
        requireMilestone(
          event.hash === state.restoredHash,
          "Desktop restart recovery did not retain the failed Work hash.",
        );
        requireMilestone(
          (evidence.desktopLog?.split(DESKTOP_SUCCESSOR_FAILURE_LOG).length ?? 1) - 1 === 1,
          "Desktop restart recovery requires exactly one packaged-host successor failure in the desktop log evidence.",
        );
        state.restartRecoveryVisible = true;
        state.restartRecoveryLogged = true;
        break;
      case "desktop-smoke.successor-retry-requested":
        requireMilestone(
          state.restartRecoveryVisible && !state.successorRetryRequested,
          "Invalid duplicate or premature desktop successor retry.",
        );
        requireMilestone(
          event.hash === state.restoredHash,
          "Desktop successor retry did not retain the failed Work hash.",
        );
        state.successorRetryRequested = true;
        break;
      case "desktop-smoke.successor-visible":
        requireMilestone(state.successorBootId !== undefined, "Successor state was checked before readiness.");
        requireMilestone(
          event.bootId === state.successorBootId
            && typeof event.hash === "string"
            && event.hash.startsWith("#/work/")
            && event.authenticated === true
            && event.persistedSessionVisible === true,
          "Desktop successor did not restore authenticated persisted Work state.",
        );
        requireMilestone(
          state.restoredHash === undefined || state.restoredHash === event.hash,
          "Runtime restart and successor Work hashes did not match.",
        );
        state.restoredHash = event.hash;
        state.successorVisible = true;
        break;
      case "desktop-smoke.failure":
        if (typeof event.message !== "string" || event.message.trim().length === 0) {
          throw new Error("Invalid desktop smoke failure message.");
        }
        state.failure = event.message;
        return state;
      case "desktop-smoke.unexpected-exit":
        requireMilestone(
          typeof event.bootId === "string"
            && event.bootId === (state.successorBootId ?? state.initialBootId),
          "Unexpected-exit recovery did not match the current desktop boot.",
        );
        state.failure = "Desktop smoke entered the unexpected-exit recovery path.";
        return state;
      case "desktop-smoke.window-hidden":
        requireMilestone(
          state.restartAccepted ? state.successorVisible : state.agentRunning,
          "Window hid before accepted desktop state was visible.",
        );
        requireMilestone(event.hidden === true, "Desktop close did not hide the window.");
        requireMilestone(
          Number.isSafeInteger(event.sidecarPid) && (event.sidecarPid as number) > 0,
          "Desktop close did not report a valid sidecar process.",
        );
        state.hidden = true;
        state.sidecarPid = event.sidecarPid as number;
        break;
      case "desktop-smoke.exit-started":
        requireMilestone(state.hidden, "Desktop Exit started before close-to-tray validation.");
        state.exitStarted = true;
        break;
      case "desktop-smoke.sidecar-stopped":
        requireMilestone(state.exitStarted, "Sidecar stopped before terminal Exit began.");
        state.stopped = true;
        break;
      default:
        throw new Error(`Invalid desktop smoke event type: ${String(event.type)}`);
    }
  }
  return state;
}

function validateSmokeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("Desktop smoke did not receive an exact loopback origin.", { cause: error });
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error("Desktop smoke did not receive an exact loopback origin.");
  }
  return url.origin;
}

function requireMilestone(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
