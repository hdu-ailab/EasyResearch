#!/usr/bin/env bun
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../runtime/pi-import";
import {
  bundledSourceRoot,
  defaultAgentDir,
  embeddedPackageVersion,
  isEmbeddedBuild,
} from "../runtime/bundled-assets";
import type { SetupResult } from "../setup-venv";
import {
  DESKTOP_OWNS_RUNTIME_MESSAGE,
  archiveDeadLegacyCliOwner,
  inspectServerProcess,
  serverLogFile,
  stopServerProcess,
} from "./server-process";
import { runServe } from "./commands/serve";
import { performFirstRunSetup } from "./first-run";
import { acquireTransitionLease, type RuntimeLease } from "./runtime-lease";
import { consumeDesktopServeRequest, runDesktopServe } from "./desktop-entry";
import {
  loadNetworkPolicy,
  reconstructChildEnvironment,
  restoreBunSandboxEnvironment,
  withTemporaryNetworkPolicyEnvironment,
  type BunSandboxEnvironmentOptions,
  type EnvironmentMap,
} from "../runtime/network-policy";
import { startCliDaemon } from "./daemon-spawn";
import { directLocalHttpFetch } from "./local-http";

export interface CliDependencies {
  serve: (host: string, port: number) => Promise<number>;
  openBrowser: (url: string) => Promise<boolean>;
  waitForReady: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
  withRuntimeTransition: <T>(
    agentDir: string,
    operation: (lease: RuntimeLease) => Promise<T>,
  ) => Promise<T>;
  spawnBackground: (
    host: string,
    port: number,
    environment: EnvironmentMap,
    transitionLease: RuntimeLease,
  ) => void | Promise<void>;
  inspectBackground: (
    agentDir: string,
    host: string,
    port: number,
  ) => Promise<"none" | "current" | "stale" | "desktop">;
  archiveDeadLegacyCliOwner: (agentDir: string) => boolean;
  stopBackground: (agentDir: string) => Promise<boolean>;
}

export interface CliOptions {
  agentDir?: string;
  /** Startup environment seam for compiled-sandbox tests. */
  environment?: EnvironmentMap;
  environmentRestore?: BunSandboxEnvironmentOptions;
  /** First-run bootstrap, injectable for tests. Defaults to ensureFirstRunSetup. */
  setup?: (agentDir: string, log: (msg: string) => void) => SetupResult | void;
  /** Non-mutating skipped-setup lookup, injectable for tests. */
  useExistingSetup?: (agentDir: string) => void;
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
export const READY_TIMEOUT_MS = 10_000;

export function writeVersionOutput(
  version: string,
  write: (output: string) => unknown = (output) => console.log(output),
): void {
  write(`easyresearch ${version}`);
}

export function writeHelpOutput(
  write: (output: string) => unknown = (output) => console.log(output),
): void {
  write(`easyresearch - Automated academic paper writing

Usage:
  easyresearch                start the Web service and open the browser
  easyresearch exit           stop the background service

Options:
  -p, --port <port>    port for the Web service (default 3000)
      --host <host>    host to bind (default 127.0.0.1)
      --no-open        do not open the browser
  -h, --help           show this help
  -v, --version        print the version`);
}

export function hasHelpFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "-h" || arg === "--help");
}

/**
 * Compiled binaries hold an exclusive lock on the executable file and
 * silently fail when they spawn a second instance of themselves. Work
 * around it by copying the binary under `<agentDir>/bin` and spawning the
 * copy. The copy is refreshed only when the source binary changes
 * (size + mtime stamp).
 */
export function daemonBinaryPath(agentDir: string): string {
  const source = process.execPath;
  const binDir = join(agentDir, "bin");
  mkdirSync(binDir, { recursive: true });
  copyPiRuntimeAssets(agentDir);
  const target = join(binDir, process.platform === "win32" ? "easyresearch-daemon.exe" : "easyresearch-daemon");
  const stampPath = join(binDir, ".daemon-source-stamp");
  try {
    const srcStat = statSync(source);
    const stamp = existsSync(stampPath) ? readFileSync(stampPath, "utf8") : "";
    if (stamp === `${srcStat.size}:${srcStat.mtimeMs}` && existsSync(target)) return target;
    try {
      copyFileSync(source, target);
    } catch {
      // A running daemon copy may hold the target inode, making an in-place
      // overwrite fail. Replace it by inode: unlink (legal on POSIX even for
      // running executables) then copy fresh.
      rmSync(target, { force: true });
      copyFileSync(source, target);
    }
    chmodSync(target, 0o755);
    writeFileSync(stampPath, `${srcStat.size}:${srcStat.mtimeMs}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to prepare the daemon executable at ${target}: ${message}`);
  }
  return target;
}

export function daemonRuntimeId(
  source = process.execPath,
  version = embeddedPackageVersion(),
): string {
  const sourceStat = statSync(source);
  return `${version}:${sourceStat.size}:${sourceStat.mtimeMs}`;
}

/** Pi's compiled asset getters resolve beside process.execPath. */
export function copyPiRuntimeAssets(agentDir: string, source = join(bundledSourceRoot(), "pi")): void {
  const binDir = join(agentDir, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    cpSync(join(source, entry.name), join(binDir, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
    });
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function browserOpenCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export async function openBrowser(url: string): Promise<boolean> {
  const { command, args } = browserOpenCommand(process.platform, url);
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
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
      const response = await directLocalHttpFetch(`http://${probeHost}:${port}/api/status`, {
        signal: AbortSignal.timeout(2_000),
      });
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
  if (hasHelpFlag(argv)) {
    writeHelpOutput();
    return 0;
  }
  const environment = options.environment ?? process.env;
  restoreBunSandboxEnvironment(environment, options.environmentRestore);
  const agentDir = options.agentDir ?? getAgentDir();

  try {
    if (argv.length === 1 && argv[0] === "exit") {
      return await deps.withRuntimeTransition(agentDir, async () => {
        const background = await deps.inspectBackground(agentDir, DEFAULT_HOST, DEFAULT_PORT);
        if (background === "desktop") throw new DesktopOwnsRuntimeError();
        const stopped = await deps.stopBackground(agentDir);
        console.log(stopped ? "EasyResearch service stopped." : "EasyResearch service is not running.");
        return 0;
      });
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
          console.error("Usage: easyresearch [-p <port>] [--host <host>] [--no-open] [exit]\nRun 'easyresearch --help' for details.");
          return 1;
        }
        port = parsed;
        i += 1;
      } else if (arg === "--host") {
        const value = argv[i + 1];
        if (value === undefined) {
          console.error("Usage: easyresearch [-p <port>] [--host <host>] [--no-open] [exit]\nRun 'easyresearch --help' for details.");
          return 1;
        }
        host = value;
        i += 1;
      } else if (arg === "--no-open") {
        open = false;
      } else {
        console.error("Usage: easyresearch [-p <port>] [--host <host>] [--no-open] [exit]\nRun 'easyresearch --help' for details.");
        return 1;
      }
    }

    return await deps.withRuntimeTransition(agentDir, async (transitionLease) => {
      const background = await deps.inspectBackground(agentDir, host, port);
      if (background === "desktop") throw new DesktopOwnsRuntimeError();
      if (background === "none" && deps.archiveDeadLegacyCliOwner(agentDir)) {
        console.log("[easyresearch] Archived a dead legacy daemon owner before upgrade startup.");
      }

      const { baseline, policy } = loadNetworkPolicy(agentDir, environment, options.environmentRestore);
      withTemporaryNetworkPolicyEnvironment(policy, baseline, environment, () => {
        performFirstRunSetup(agentDir, {
          setup: options.setup,
          useExistingSetup: options.useExistingSetup,
          log: (message) => console.log(`[easyresearch] ${message}`),
        });
      });

      if (background === "current") {
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
      if (background === "stale") {
        console.log("[easyresearch] Runtime changed — restarting the background service…");
        await deps.stopBackground(agentDir);
      }

      try {
        await deps.spawnBackground(
          host,
          port,
          reconstructChildEnvironment(environment, baseline),
          transitionLease,
        );
      } catch (error) {
        throw new Error(
          `EasyResearch failed authenticated startup within ${READY_TIMEOUT_MS}ms. See ${serverLogFile(agentDir)}.`,
          { cause: error },
        );
      }
      const url = `http://${host}:${port}`;
      console.log(`EasyResearch: ${url}`);
      if (!isLoopbackHost(host)) {
        console.warn(`Warning: EasyResearch is listening on ${host}. Web config editing trusts the local OS user. Make sure the network is trusted before exposing it.`);
      }
      if (open && isLoopbackHost(host)) await deps.openBrowser(url);
      return 0;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (!(error instanceof DesktopOwnsRuntimeError)) {
      try {
        writeFileSync(join(agentDir, "cli-error.log"), `${message}\n${(error as Error).stack ?? ""}\n`);
      } catch {
        // Best-effort diagnostics only.
      }
    }
    return 1;
  }
}

class DesktopOwnsRuntimeError extends Error {
  constructor() {
    super(DESKTOP_OWNS_RUNTIME_MESSAGE);
  }
}

async function runRuntimeEntry(args: string[]): Promise<void> {
  restoreBunSandboxEnvironment(process.env);
  let desktopRequest: ReturnType<typeof consumeDesktopServeRequest> | undefined;
  if (args[0] === "--desktop-serve") {
    try {
      desktopRequest = consumeDesktopServeRequest(args, process.env);
    } catch {
      console.error("Invalid EasyResearch desktop launch contract.");
      process.exitCode = 1;
      return;
    }
  }
  // Standalone binaries must statically register pi's lazy-loaded modules:
  // their variable-specifier dynamic imports cannot resolve inside $bunfs.
  // pi's own compiled entry (pi-coding-agent dist/bun/cli.js) does the same
  // two registrations; without them provider auth flows and the bedrock
  // implementation fail at runtime in compiled builds.
  const { registerBunOAuthFlows } = await import("@earendil-works/pi-ai/bun-oauth");
  registerBunOAuthFlows();
  const { bedrockProviderModule } = await import("@earendil-works/pi-ai/bedrock-provider");
  const { setBedrockProviderModule } = await import("@earendil-works/pi-ai/compat");
  setBedrockProviderModule(bedrockProviderModule);
  if (desktopRequest) {
    process.exitCode = await runDesktopServe(desktopRequest);
    return;
  }
  if (args.length === 3 && args[0] === "--serve") {
    const host = args[1] as string;
    const port = parsePort(args[2] as string);
    if (port === undefined) {
      console.error("Usage: easyresearch [-p <port>] [--host <host>] [--no-open] [exit]\nRun 'easyresearch --help' for details.");
      process.exitCode = 1;
      return;
    }
    process.exitCode = await runServe(host, port);
    return;
  }
  const runtimeId = daemonRuntimeId();
  process.exitCode = await runCli(args, {
    serve: runServe,
    openBrowser,
    waitForReady,
    withRuntimeTransition: async (agentDir, operation) => {
      const lease = await acquireTransitionLease(agentDir, "cli");
      try {
        return await operation(lease);
      } finally {
        if (lease.held && !lease.release()) {
          throw new Error("EasyResearch lost ownership of its runtime transition lease.");
        }
      }
    },
    inspectBackground: (agentDir, host, port) =>
      inspectServerProcess(agentDir, runtimeId, host, port),
    archiveDeadLegacyCliOwner,
    stopBackground: stopServerProcess,
    spawnBackground: async (host, port, environment, transitionLease) => {
      const agentDir = defaultAgentDir();
      const daemon = daemonBinaryPath(agentDir);
      await startCliDaemon({
        agentDir,
        daemonExecutable: daemon,
        sourceExecutable: process.execPath,
        sourceEntry: fileURLToPath(import.meta.url),
        embedded: isEmbeddedBuild(),
        platform: process.platform,
        host,
        port,
        runtimeId,
        environment,
        transitionLease,
      });
    },
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    writeHelpOutput();
  } else if (args[0] === "--version" || args[0] === "-v") {
    writeVersionOutput(embeddedPackageVersion());
  } else {
    await runRuntimeEntry(args);
  }
}
