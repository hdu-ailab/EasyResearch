import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const UPDATE_WORKER_TOKEN_ENV = "EASYRESEARCH_DESKTOP_UPDATE_WORKER_TOKEN";
export const UPDATE_SUCCESSOR_ENV = "EASYRESEARCH_DESKTOP_UPDATE_SUCCESSOR";
export const UPDATE_WORKER_ENTRY = "--desktop-update-worker";
export const UPDATE_EVENT_PREFIX = "@easyresearch-update ";

export interface DesktopUpdateHandoff {
  schema: 1;
  token: string;
  operationId: string;
  hostPid: number;
  hostPath: string;
  userDataDir: string;
  agentDir: string;
  directory: string;
  currentVersion: string;
  version: string;
  installerName: string;
  installerSize: number;
  installerSha256: string;
  helperSha256: string;
  oldHostSha256: string;
  oldAppSha256: string;
  oldSidecarSha256: string;
  oldBootId: string;
  route: string;
  expiresAt: number;
}
export interface InstalledDesktopIdentity { hostSha256: string; appSha256: string; sidecarSha256: string }
export interface DesktopUpdateOutcome {
  installerAdmitted: boolean;
  hostExited: boolean;
  rollback: "not-required" | "pending" | "complete";
  recoveryComplete: boolean;
}
export interface DesktopUpdateSuccessor {
  directory: string;
  token: string;
  workerPid: number;
}

export interface DesktopRecoveryTicket {
  schema: 1;
  purpose: "recover-installed-host";
  operationId: string;
  workerPid: number;
  successorToken: string;
  sourceHandoffSha256: string;
  version: string;
  identity: InstalledDesktopIdentity;
  issuedAt: number;
  expiresAt: number;
}

export function createDesktopRecoveryTicket(handoff: DesktopUpdateHandoff, identity: InstalledDesktopIdentity, context: DesktopUpdateSuccessor, sourceHandoffSha256: string, now = Date.now()): DesktopRecoveryTicket {
  const ticket: DesktopRecoveryTicket = { schema: 1, purpose: "recover-installed-host", operationId: handoff.operationId,
    workerPid: context.workerPid, successorToken: context.token, sourceHandoffSha256, version: handoff.currentVersion,
    identity: { ...identity }, issuedAt: now, expiresAt: now + 120_000 };
  validateDesktopRecoveryTicket(ticket, handoff, identity, context, sourceHandoffSha256, now);
  return ticket;
}

export function validateDesktopRecoveryTicket(raw: unknown, handoff: DesktopUpdateHandoff, identity: InstalledDesktopIdentity, context: DesktopUpdateSuccessor, sourceHandoffSha256: string, now = Date.now()): asserts raw is DesktopRecoveryTicket {
  validateUpdateHandoff(handoff, now, true);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid recovery handoff.");
  const ticket = raw as DesktopRecoveryTicket;
  const keys = ["schema", "purpose", "operationId", "workerPid", "successorToken", "sourceHandoffSha256", "version", "identity", "issuedAt", "expiresAt"];
  if (Object.keys(ticket).length !== keys.length || Object.keys(ticket).some((key) => !keys.includes(key))
    || ticket.schema !== 1 || ticket.purpose !== "recover-installed-host" || ticket.operationId !== handoff.operationId
    || !Number.isSafeInteger(ticket.workerPid) || ticket.workerPid <= 0 || ticket.workerPid !== context.workerPid
    || !validToken(ticket.successorToken) || ticket.successorToken === handoff.token || ticket.successorToken !== context.token
    || context.directory !== handoff.directory || !validDigest(sourceHandoffSha256) || ticket.sourceHandoffSha256 !== sourceHandoffSha256
    || ticket.version !== handoff.currentVersion || !Number.isSafeInteger(ticket.issuedAt) || !Number.isSafeInteger(ticket.expiresAt)
    || ticket.issuedAt > now || ticket.expiresAt <= now || ticket.expiresAt - ticket.issuedAt !== 120_000
    || !ticket.identity || Object.keys(ticket.identity).length !== 3
    || ticket.identity.hostSha256 !== handoff.oldHostSha256 || ticket.identity.appSha256 !== handoff.oldAppSha256
    || ticket.identity.sidecarSha256 !== handoff.oldSidecarSha256
    || identity.hostSha256 !== ticket.identity.hostSha256 || identity.appSha256 !== ticket.identity.appSha256
    || identity.sidecarSha256 !== ticket.identity.sidecarSha256) throw new Error("Invalid recovery handoff.");
}
export interface DesktopUpdateReceipt {
  phase: "prepared" | "installing" | "verifying" | "recovering" | "complete" | "failed" | "cancelled";
  version: string;
  operationId: string;
  workerPid: number;
  successorToken?: string;
  identity?: InstalledDesktopIdentity;
  message?: string;
  recovery?: true;
  installerGuardPid?: number;
  installerSettled?: true;
  custodyUnresolved?: true;
  outcome?: DesktopUpdateOutcome;
  failure?: DesktopUpdateFailure;
}

export type DesktopUpdateOperation = "verify-registry" | "verify-version" | "verify-files" | "rollback-stop"
  | "rollback-lease" | "rollback-server" | "rollback-quarantine" | "rollback-remove-current" | "rollback-restore-files"
  | "rollback-registry" | "rollback-verify" | "recovery-verify" | "recovery-version" | "recovery-launch";
export interface DesktopUpdateFailure {
  operation: DesktopUpdateOperation; code: string;
  childExitCode?: number; childSignal?: string; stderr?: string;
}
export function desktopUpdateFailure(operation: DesktopUpdateOperation, error: unknown): DesktopUpdateFailure {
  const value = error as { code?: unknown; childExitCode?: unknown; childSignal?: unknown; stderr?: unknown; stderrTruncated?: unknown } | null;
  const code = value?.code;
  const failure: DesktopUpdateFailure = { operation, code: typeof code === "string" && ["EPERM", "EACCES", "ENOENT", "EBUSY", "ENOTEMPTY", "EEXIST", "ETIMEDOUT", "EINVAL", "EIO", "UPDATE_PROCESS_EXIT"].includes(code) ? code : "FAILED" };
  if (code === "UPDATE_PROCESS_EXIT") {
    if (typeof value?.childExitCode === "number" && Number.isSafeInteger(value.childExitCode) && Math.abs(value.childExitCode) <= 0xffffffff) failure.childExitCode = value.childExitCode;
    if (typeof value?.childSignal === "string" && /^SIG[A-Z0-9]{1,10}$/u.test(value.childSignal)) failure.childSignal = value.childSignal;
    if (typeof value?.stderr === "string") {
      const input = Buffer.from(value.stderr);
      let start = Math.max(0, input.length - 8192);
      if (start || value.stderrTruncated === true) {
        const newline = input.indexOf(10, start);
        start = newline < 0 ? input.length : newline + 1;
      }
      const text = input.subarray(start).toString("utf8").split(/\r?\n/u).map(line =>
        /(?:authorization|cookie|api[-_]?key|password|secret|token|credential)\s*["']?\s*[:=]|\b(?:Bearer|Basic)\s+\S+/iu.test(line)
          ? "[redacted credential-bearing line]" : line.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gu, "[redacted]")
      ).join("\n");
      const output = Buffer.from(text); start = Math.max(0, output.length - 4096);
      while (start < output.length && (output[start]! & 0xc0) === 0x80) start += 1;
      failure.stderr = output.subarray(start).toString("utf8");
    }
  }
  return failure;
}

export function canReclaimDesktopUpdateReceipt(receipt: DesktopUpdateReceipt): boolean {
  const outcome = receipt.outcome;
  if (!outcome || typeof outcome.installerAdmitted !== "boolean" || typeof outcome.hostExited !== "boolean"
    || typeof outcome.recoveryComplete !== "boolean" || !["not-required", "pending", "complete"].includes(outcome.rollback)
    || receipt.custodyUnresolved || (outcome.installerAdmitted && receipt.installerSettled !== true)
    || (receipt.installerGuardPid && !receipt.installerSettled)) return false;
  if (receipt.phase === "complete") return outcome.installerAdmitted && outcome.hostExited && outcome.rollback === "not-required";
  if (receipt.phase === "cancelled") return !outcome.installerAdmitted && !outcome.hostExited && outcome.rollback === "not-required";
  if (receipt.phase !== "failed") return false;
  if (!outcome.installerAdmitted) return outcome.rollback === "not-required";
  return outcome.hostExited && outcome.recoveryComplete && outcome.rollback === "complete";
}

export function validateUpdateHandoff(value: unknown, now = Date.now(), allowExpired = false): DesktopUpdateHandoff {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid update handoff.");
  const h = value as DesktopUpdateHandoff;
  const keys = ["schema", "token", "operationId", "hostPid", "hostPath", "userDataDir", "agentDir", "directory", "currentVersion", "version", "installerName", "installerSize", "installerSha256", "helperSha256", "oldHostSha256", "oldAppSha256", "oldSidecarSha256", "oldBootId", "route", "expiresAt"];
  if (Object.keys(h).some((key) => !keys.includes(key)) || Object.keys(h).length !== keys.length || h.schema !== 1
    || !validToken(h.token) || !/^[a-f0-9-]{36}$/u.test(h.operationId)
    || !Number.isSafeInteger(h.hostPid) || h.hostPid <= 0
    || !validVersion(h.currentVersion) || !validVersion(h.version)
    || !Number.isSafeInteger(h.expiresAt) || (!allowExpired && h.expiresAt < now) || h.expiresAt > now + 20 * 60_000
    || !Number.isSafeInteger(h.installerSize) || h.installerSize <= 0 || h.installerSize > 2 * 1024 ** 3
    || ![h.installerSha256, h.helperSha256, h.oldHostSha256, h.oldAppSha256, h.oldSidecarSha256].every(validDigest)
    || typeof h.oldBootId !== "string" || h.oldBootId.length < 1 || h.oldBootId.length > 200
    || typeof h.route !== "string" || !h.route.startsWith("#/") || h.route.length > 8192 || /[\r\n\0]/u.test(h.route)) throw new Error("Invalid update handoff.");
  for (const path of [h.hostPath, h.agentDir, h.directory, h.userDataDir]) {
    if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || /[\r\n\0"]/u.test(path) || resolve(path) !== path) throw new Error("Invalid update path.");
  }
  if (basename(h.hostPath) !== "EasyResearch.exe" || dirname(h.directory) !== join(h.userDataDir, "updates")
    || !/^update-[A-Za-z0-9]+$/u.test(basename(h.directory))
    || h.installerName !== `EasyResearch-${h.version}-windows-x64.exe`
    || h.directory.startsWith(`${dirname(h.hostPath)}/`) || h.directory.startsWith(`${dirname(h.hostPath)}\\`)) throw new Error("Invalid update installation layout.");
  return h;
}

export function validToken(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value); }
export function validDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function validVersion(value: unknown): value is string { return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value) && value.length <= 80; }

export function windowsNsisArguments(directory: string): string[] {
  if (!directory || /[\0\r\n"]/u.test(directory)) throw new Error("Invalid installation directory.");
  // NSIS consumes the entire final /D= suffix. Node quoting changes the directory.
  return ["/S", "/currentuser", "--updated", `/D=${directory}`];
}

/** reg.exe exports UTF-16; decoding its localized console output as UTF-8 loses paths. */
export function windowsInstallationLocation(bytes: Uint8Array): string {
  if (bytes.length > 64 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xfe || bytes.length % 2 !== 0) throw new Error("Invalid installation registry export.");
  const values = [...Buffer.from(bytes).toString("utf16le").matchAll(/^"InstallLocation"="((?:[^"\\\r\n]|\\["\\])*)"\r?$/gmu)];
  if (values.length !== 1) throw new Error("Invalid installation registry location.");
  return values[0]![1]!.replace(/\\(["\\])/gu, "$1");
}
