import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dayStamp, resolveLogConfig } from "../runtime/logger";

export function serverPidPath(agentDir: string): string {
  return join(agentDir, "server.pid");
}

export function serverLogPath(agentDir: string): string {
  return join(agentDir, "server.log");
}

/**
 * The file the web-server logger actually writes to: the configured log dir
 * (default <agentDir>/logs) plus the per-day `easyresearch-<date>.log` name.
 */
export function serverLogFile(agentDir: string): string {
  return join(resolveLogConfig(agentDir).logDir, `easyresearch-${dayStamp()}.log`);
}

export function readServerPid(agentDir: string): number | undefined {
  const path = serverPidPath(agentDir);
  if (!existsSync(path)) return undefined;
  const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function writeServerPid(agentDir: string, pid: number): void {
  const path = serverPidPath(agentDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${pid}\n`, "utf8");
  renameSync(tmp, path);
}

export function removeServerPid(agentDir: string): void {
  const path = serverPidPath(agentDir);
  if (existsSync(path)) unlinkSync(path);
}

export async function stopServerProcess(agentDir: string): Promise<boolean> {
  const pid = readServerPid(agentDir);
  if (pid === undefined || !isProcessAlive(pid)) {
    removeServerPid(agentDir);
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    removeServerPid(agentDir);
    return false;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removeServerPid(agentDir);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  removeServerPid(agentDir);
  return true;
}
