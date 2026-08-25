import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

export type SshAuthType = "password" | "private-key";

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  hostFingerprint: string;
  authType: SshAuthType;
  credentialFile: string;
  passphraseFile?: string;
  remoteExperimentRoot: string;
  localMountPath: string;
}

export interface SshExecutionRequest {
  config: SshConnectionConfig;
  command: string;
  timeoutSeconds: number;
  signal: AbortSignal;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  onUpdate?: (text: string) => void;
}

export interface SshExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SshBashRuntimeDependencies {
  execute(request: SshExecutionRequest): Promise<SshExecutionResult>;
  configDirName?: string;
  pinConfiguration?: boolean;
}

export interface SshBashRuntime {
  configure(cwd: string, config: SshConnectionConfig, signal: AbortSignal): Promise<void>;
  test(cwd: string, signal: AbortSignal): Promise<SshExecutionResult>;
  run(
    cwd: string,
    command: string,
    timeoutSeconds: number,
    signal: AbortSignal,
    onUpdate?: (text: string) => void,
  ): Promise<SshExecutionResult>;
}

const CONFIG_KEYS = new Set([
  "host",
  "port",
  "username",
  "hostFingerprint",
  "authType",
  "credentialFile",
  "passphraseFile",
  "remoteExperimentRoot",
  "localMountPath",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`easyresearch.ssh.${field} must be a non-empty string`);
  }
  if (/[\0\r\n]/u.test(value)) throw new Error(`easyresearch.ssh.${field} contains a control character`);
  return value;
}

export function parseSshConnectionConfig(value: unknown, cwd: string): SshConnectionConfig {
  if (!isRecord(value)) throw new Error("easyresearch.ssh must be an object");
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`easyresearch.ssh contains unsupported field ${key}`);
  }
  const host = requiredString(value.host, "host");
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/u.test(host)) throw new Error("easyresearch.ssh.host is invalid");
  if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) {
    throw new Error("easyresearch.ssh.port must be an integer from 1 through 65535");
  }
  const username = requiredString(value.username, "username");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(username)) throw new Error("easyresearch.ssh.username is invalid");
  const hostFingerprint = requiredString(value.hostFingerprint, "hostFingerprint");
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/u.test(hostFingerprint)) {
    throw new Error("easyresearch.ssh.hostFingerprint must use OpenSSH SHA256 base64 format");
  }
  if (value.authType !== "password" && value.authType !== "private-key") {
    throw new Error("easyresearch.ssh.authType must be password or private-key");
  }
  const configuredCredentialFile = requiredString(value.credentialFile, "credentialFile");
  if (!isAbsolute(configuredCredentialFile)) throw new Error("easyresearch.ssh.credentialFile must be absolute");
  const credentialFile = canonicalOutsideProject(configuredCredentialFile, cwd, "credentialFile");
  const configuredPassphraseFile = value.passphraseFile === undefined
    ? undefined
    : requiredString(value.passphraseFile, "passphraseFile");
  let passphraseFile: string | undefined;
  if (configuredPassphraseFile !== undefined) {
    if (!isAbsolute(configuredPassphraseFile)) throw new Error("easyresearch.ssh.passphraseFile must be absolute");
    passphraseFile = canonicalOutsideProject(configuredPassphraseFile, cwd, "passphraseFile");
    if (value.authType !== "private-key") {
      throw new Error("easyresearch.ssh.passphraseFile is valid only for private-key authentication");
    }
  }
  const remoteExperimentRoot = requiredString(value.remoteExperimentRoot, "remoteExperimentRoot");
  const remoteSegments = remoteExperimentRoot.split("/").filter(Boolean);
  if (
    !/^\/?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\/?$/u.test(remoteExperimentRoot)
    || remoteSegments.includes(".")
    || remoteSegments.includes("..")
  ) {
    throw new Error(
      "easyresearch.ssh.remoteExperimentRoot must be a conservative absolute or home-relative POSIX path",
    );
  }
  const localMountPath = requiredString(value.localMountPath, "localMountPath");
  if (!isAbsolute(localMountPath)) throw new Error("easyresearch.ssh.localMountPath must be absolute");
  return {
    host,
    port: value.port as number,
    username,
    hostFingerprint,
    authType: value.authType,
    credentialFile,
    ...(passphraseFile ? { passphraseFile } : {}),
    remoteExperimentRoot,
    localMountPath,
  };
}

function canonicalOutsideProject(path: string, cwd: string, field: string): string {
  let physicalProject: string;
  let physicalPath: string;
  try {
    physicalProject = realpathSync(cwd);
    physicalPath = realpathSync(path);
  } catch {
    throw new Error(`easyresearch.ssh.${field} must name an existing readable file`);
  }
  const rel = relative(physicalProject, physicalPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`easyresearch.ssh.${field} must stay outside the paper project`);
  }
  return physicalPath;
}

function settingsPath(cwd: string, configDirName: string): string {
  return join(cwd, configDirName, "settings.json");
}

function readSettings(cwd: string, configDirName: string): Record<string, unknown> {
  const path = settingsPath(cwd, configDirName);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Cannot read valid project settings at ${path}`);
  }
  if (!isRecord(parsed)) throw new Error(`Project settings at ${path} must be an object`);
  return parsed;
}

export function readProjectSshConfig(cwd: string, configDirName = ".easyresearch"): SshConnectionConfig {
  const settings = readSettings(cwd, configDirName);
  const easyresearch = settings.easyresearch;
  if (!isRecord(easyresearch)) throw new Error("Project settings do not contain easyresearch.ssh");
  if (easyresearch.sshProfiles !== undefined) {
    throw new Error("easyresearch.sshProfiles is not supported; configure the single easyresearch.ssh server");
  }
  return parseSshConnectionConfig(easyresearch.ssh, cwd);
}

function writeProjectSshConfig(cwd: string, config: SshConnectionConfig, configDirName: string): void {
  const settings = readSettings(cwd, configDirName);
  if (settings.easyresearch !== undefined && !isRecord(settings.easyresearch)) {
    throw new Error("Project settings easyresearch namespace must be an object");
  }
  const easyresearch = isRecord(settings.easyresearch) ? { ...settings.easyresearch } : {};
  if (easyresearch.sshProfiles !== undefined) {
    throw new Error("easyresearch.sshProfiles is not supported; remove it before configuring easyresearch.ssh");
  }
  easyresearch.ssh = config;
  const next = { ...settings, easyresearch };
  const path = settingsPath(cwd, configDirName);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readCredential(
  config: SshConnectionConfig,
  cwd: string,
): Pick<SshExecutionRequest, "password" | "privateKey" | "passphrase"> {
  canonicalOutsideProject(config.credentialFile, cwd, "credentialFile");
  assertCredentialFile(
    config.credentialFile,
    "credentialFile",
    config.authType === "password" ? 16 * 1024 : 1024 * 1024,
  );
  const credential = readFileSync(config.credentialFile, "utf8");
  if (config.authType === "password") {
    const password = firstLine(credential);
    if (!password) throw new Error("The configured password file is empty");
    return { password };
  }
  if (!credential.trim()) throw new Error("The configured private-key file is empty");
  if (!config.passphraseFile) return { privateKey: credential };
  canonicalOutsideProject(config.passphraseFile, cwd, "passphraseFile");
  assertCredentialFile(config.passphraseFile, "passphraseFile", 16 * 1024);
  const passphrase = firstLine(readFileSync(config.passphraseFile, "utf8"));
  if (!passphrase) throw new Error("The configured passphrase file is empty");
  return { privateKey: credential, passphrase };
}

function assertCredentialFile(path: string, field: string, maxBytes: number): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`The configured SSH ${field} is not readable`);
  }
  if (!stat.isFile()) throw new Error(`The configured SSH ${field} must be a regular file`);
  if (stat.size > maxBytes) throw new Error(`The configured SSH ${field} is too large`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`The configured SSH ${field} must not be accessible by group or other users`);
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u, 1)[0] ?? "";
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function assertSuccessful(result: SshExecutionResult): void {
  if (result.exitCode === 0) return;
  const diagnostic = result.stderr.trim() || `SSH command exited with status ${result.exitCode}`;
  throw new Error(diagnostic);
}

export function createSshBashRuntime(deps: SshBashRuntimeDependencies): SshBashRuntime {
  const configDirName = deps.configDirName ?? ".easyresearch";
  let pinnedConfiguration: string | undefined;
  const execute = async (
    cwd: string,
    command: string,
    timeoutSeconds: number,
    signal: AbortSignal,
    onUpdate?: (text: string) => void,
  ): Promise<SshExecutionResult> => {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) {
      throw new Error("ssh-bash timeout must be an integer from 1 through 7200 seconds");
    }
    if (signal.aborted) throw abortError("ssh-bash operation aborted");
    const config = readProjectSshConfig(cwd, configDirName);
    const serializedConfig = JSON.stringify(config);
    if (deps.pinConfiguration) {
      if (pinnedConfiguration !== undefined && pinnedConfiguration !== serializedConfig) {
        throw new Error("easyresearch.ssh changed while this Experiment session was active");
      }
      pinnedConfiguration ??= serializedConfig;
    }
    return deps.execute({
      config,
      command,
      timeoutSeconds,
      signal,
      onUpdate,
      ...readCredential(config, cwd),
    });
  };
  return {
    async configure(cwd, input, signal) {
      if (signal.aborted) throw abortError("ssh-bash operation aborted");
      const config = parseSshConnectionConfig(input, cwd);
      const result = await deps.execute({
        config,
        command: "true",
        timeoutSeconds: 30,
        signal,
        ...readCredential(config, cwd),
      });
      assertSuccessful(result);
      writeProjectSshConfig(cwd, config, configDirName);
    },
    async test(cwd, signal) {
      const result = await execute(cwd, "true", 30, signal);
      assertSuccessful(result);
      return result;
    },
    run: execute,
  };
}
