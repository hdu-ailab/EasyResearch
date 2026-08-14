#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../runtime/pi-import";
import { injectSkillVenvEnv } from "../runtime/venv-env";
import {
  isProcessAlive,
  readServerPid,
  removeServerPid,
  serverLogFile,
  stopServerProcess,
  writeServerPid,
} from "./server-process";
import { runServe } from "./commands/serve";

export interface CliDependencies {
  serve: (host: string, port: number) => Promise<number>;
  openBrowser: (url: string) => Promise<boolean>;
  waitForReady: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
  spawnBackground: (host: string, port: number) => void;
}

export interface CliOptions {
  agentDir?: string;
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
export const READY_TIMEOUT_MS = 10_000;

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  return new Promise((resolve) => {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function waitForReady(
  host: string,
  port: number,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<boolean> {
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${probeHost}:${port}/api/status`);
      if (response.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function parsePort(value: string): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

export async function runCli(
  argv: string[],
  deps: CliDependencies,
  options: CliOptions = {},
): Promise<number> {
  injectSkillVenvEnv();
  const agentDir = options.agentDir ?? getAgentDir();

  try {
    if (argv.length === 1 && argv[0] === "exit") {
      const stopped = await stopServerProcess(agentDir);
      console.log(stopped ? "EasyResearch service stopped." : "EasyResearch service is not running.");
      return 0;
    }

    let host = DEFAULT_HOST;
    let port = DEFAULT_PORT;
    let open = true;
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === "-p" || arg === "--port") {
        const value = argv[i + 1];
        const parsed = value === undefined ? undefined : parsePort(value);
        if (parsed === undefined) {
          console.error("Usage: easyresearch [-p <port>] [--host <host>] [--no-open] [exit]");
          return 1;
        }
        port = parsed;
        i += 1;
      } else if (arg === "--host" || arg === "-h") {
        const value = argv[i + 1];
        if (value === undefined) {
          console.error("Usage: easyresearch [-p <port>] [--host <host>] [--no-open] [exit]");
          return 1;
        }
        host = value;
        i += 1;
      } else if (arg === "--no-open") {
        open = false;
      } else {
        console.error("Usage: easyresearch [-p <port>] [--host <host>] [--no-open] [exit]");
        return 1;
      }
    }

    const existing = readServerPid(agentDir);
    if (existing !== undefined && isProcessAlive(existing)) {
      const ready = await deps.waitForReady(host, port);
      if (!ready) {
        console.error(`No service is listening on port ${port}.`);
        return 1;
      }
      const url = `http://${host}:${port}`;
      console.log(`EasyResearch: ${url}`);
      if (open && isLoopbackHost(host)) await deps.openBrowser(url);
      return 0;
    }
    if (existing !== undefined) removeServerPid(agentDir);

    deps.spawnBackground(host, port);
    const ready = await deps.waitForReady(host, port);
    if (!ready) {
      console.error(`EasyResearch failed to start within ${READY_TIMEOUT_MS}ms. See ${serverLogFile(agentDir)}.`);
      return 1;
    }

    const url = `http://${host}:${port}`;
    console.log(`EasyResearch: ${url}`);
    if (!isLoopbackHost(host)) {
      console.warn(`Warning: EasyResearch is listening on ${host}. Web config editing trusts the local OS user. Make sure the network is trusted before exposing it.`);
    }
    if (open && isLoopbackHost(host)) await deps.openBrowser(url);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 3 && args[0] === "--serve") {
    const host = args[1] as string;
    const port = parsePort(args[2] as string);
    if (port === undefined) {
      console.error("Usage: easyresearch [-p <port>] [--host <host>] [--no-open] [exit]");
      process.exit(1);
    }
    process.exit(await runServe(host, port));
  }
  process.exit(await runCli(args, {
    serve: runServe,
    openBrowser,
    waitForReady,
    spawnBackground: (host, port) => {
      const cliPath = fileURLToPath(import.meta.url);
      const child = spawn(process.execPath, [cliPath, "--serve", host, String(port)], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
    },
  }));
}
