#!/usr/bin/env bun
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../runtime/pi-import";
import { writeFirstRunSetupEvidence } from "../runtime/first-run-setup-evidence";
import { injectSkillVenvEnv } from "../runtime/venv-env";
import {
  bundledSourceRoot,
  defaultAgentDir,
  embeddedPackageVersion,
  isEmbeddedBuild,
  materializeBundledIfNeeded,
  useExistingMaterializedBundle,
} from "../runtime/bundled-assets";
import { ensureSkillVenv, type SetupResult } from "../setup-venv";
import { renameSameNameToBak } from "../setup-resources";
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

export function isSkipSetupEnabled(): boolean {
  const value = process.env.EASYRESEARCH_SKIP_SETUP;
  return value === "1" || value === "true" || value === "yes";
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

/**
 * First-run bootstrap: materialize embedded bundled assets (compiled builds
 * only), create the skill Python venv with live progress, and migrate
 * same-name user agents/skills to current bundled versions. Resource
 * extraction is required; optional setup phases report failures independently.
 */
export function ensureFirstRunSetup(agentDir: string, log: (msg: string) => void): SetupResult {
  const version = embeddedPackageVersion();
  materializeBundledIfNeeded(agentDir, version, log);
  let skillVenvResult: SetupResult;
  try {
    skillVenvResult = ensureSkillVenv(agentDir, { stream: true, log });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`Skill environment setup failed: ${reason}`);
    skillVenvResult = { venvDir: join(agentDir, "venv"), success: false, reason };
  }
  try {
    retireBundledResourcesOnce(agentDir, version, () => {
      const bundledRoot = bundledSourceRoot();
      const retired = renameSameNameToBak({
        agentDir,
        bundledAgentsDir: join(bundledRoot, "agents"),
        bundledSkillsDir: join(bundledRoot, "skills"),
        log,
      });
      const count = retired.entries.filter((entry) => entry.renamed).length;
      if (count > 0) log(`Retired ${count} same-name user resources to .bak backups`);
    });
  } catch (error) {
    log(`Bundled resource retirement failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return skillVenvResult;
}

export function retireBundledResourcesOnce(agentDir: string, version: string, retire: () => void): boolean {
  const marker = join(agentDir, ".easyresearch-resource-retirement-version");
  try {
    if (readFileSync(marker, "utf8") === version) return false;
  } catch {
    // Missing/unreadable marker means this version has not completed retirement.
  }
  retire();
  mkdirSync(agentDir, { recursive: true });
  const temporary = `${marker}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, version);
  renameSync(temporary, marker);
  return true;
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
      const response = await fetch(`http://${probeHost}:${port}/api/status`, {
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
  const agentDir = options.agentDir ?? getAgentDir();

  try {
    if (hasHelpFlag(argv)) {
      writeHelpOutput();
      return 0;
    }
    if (argv.length === 1 && argv[0] === "exit") {
      const stopped = await stopServerProcess(agentDir);
      console.log(stopped ? "EasyResearch service stopped." : "EasyResearch service is not running.");
      return 0;
    }

    const setup = options.setup ?? ensureFirstRunSetup;
    if (isSkipSetupEnabled()) {
      const useExistingSetup = options.useExistingSetup
        ?? ((root: string) => useExistingMaterializedBundle(root, embeddedPackageVersion()));
      useExistingSetup(agentDir);
    } else {
      const log = (msg: string) => console.log(`[easyresearch] ${msg}`);
      const setupResult = setup(agentDir, log);
      if (setupResult !== undefined) {
        try {
          writeFirstRunSetupEvidence(setupResult);
        } catch (error) {
          log(`First-run setup evidence could not be written: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    injectSkillVenvEnv();

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
    try {
      writeFileSync(join(agentDir, "ready-marker-before.txt"), "1");
    } catch {
      // diagnostics only
    }
    const ready = await deps.waitForReady(host, port);
    try {
      writeFileSync(join(agentDir, "ready-marker-after.txt"), "1");
    } catch {
      // diagnostics only
    }
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
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    try {
      writeFileSync(join(agentDir, "cli-error.log"), `${message}\n${(error as Error).stack ?? ""}\n`);
    } catch {
      // Best-effort diagnostics only.
    }
    return 1;
  }
}

async function runRuntimeEntry(args: string[]): Promise<void> {
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
  process.exitCode = await runCli(args, {
    serve: runServe,
    openBrowser,
    waitForReady,
    spawnBackground: (host, port) => {
      const agentDir = defaultAgentDir();
      const daemon = daemonBinaryPath(agentDir);
      const stderrPath = join(agentDir, "logs", "daemon-stderr.log");
      mkdirSync(dirname(stderrPath), { recursive: true });
      const stderrFd = openSync(stderrPath, "a");
      if (isEmbeddedBuild() && process.platform === "win32") {
        // Bun's Windows `child_process.spawn` does not release the child
        // handle on unref, so the CLI would never exit while the daemon lives.
        // Bun's native spawn detaches the daemon correctly.
        Bun.spawn([daemon, "--serve", host, String(port)], {
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          env: process.env,
        }).unref();
        return;
      }
      const options: Parameters<typeof spawn>[2] = {
        detached: true,
        stdio: ["ignore", "ignore", stderrFd],
        env: process.env,
      };
      const child = isEmbeddedBuild()
        ? spawn(daemon, ["--serve", host, String(port)], options)
        : spawn(process.execPath, [fileURLToPath(import.meta.url), "--serve", host, String(port)], options);
      child.on("error", (error) => {
        try {
          writeFileSync(stderrPath, `[daemon spawn error] ${error.message}\n`, { flag: "a" });
        } catch {
          // Best-effort diagnostics only.
        }
      });
      child.unref();
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
