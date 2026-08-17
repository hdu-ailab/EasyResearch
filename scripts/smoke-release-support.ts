import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, win32 } from "node:path";

export interface ResolveSmokePythonOptions {
  explicit?: string;
  which?: (name: string) => string | null | undefined;
  exists?: (path: string) => boolean;
}

export function resolveSmokePython(options: ResolveSmokePythonOptions = {}): string {
  const exists = options.exists ?? existsSync;
  if (options.explicit !== undefined) {
    if (!isAbsolute(options.explicit) || !exists(options.explicit)) {
      throw new Error(`EASYRESEARCH_SMOKE_PYTHON must name an existing absolute interpreter: ${options.explicit}`);
    }
    return options.explicit;
  }

  const which = options.which ?? Bun.which;
  for (const name of ["python3", "python"]) {
    const python = which(name);
    if (python && isAbsolute(python) && exists(python)) return python;
  }
  throw new Error("EASYRESEARCH_SMOKE_PYTHON is unset and no Python interpreter was found");
}

export function createCompiledChildEnv(options: {
  base: NodeJS.ProcessEnv;
  python: string;
  overrides?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = { ...options.base, ...options.overrides };
  const pythonDir = dirname(options.python);
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") env[key] = pythonDir;
  }
  env.PATH = pythonDir;
  env.PIP_RETRIES = "3";
  env.PIP_DEFAULT_TIMEOUT = "30";
  return env;
}

export function skillVenvPython(
  agentDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? win32.join(agentDir, "venv", "Scripts", "python.exe")
    : join(agentDir, "venv", "bin", "python");
}

export function writeVenvValidationScript(path: string): void {
  writeFileSync(path, `import os
import pathlib
import sys
import arxiv
import ddgr
import markitdown

expected = pathlib.Path(os.environ["EASYRESEARCH_VENV"]).resolve()
actual = pathlib.Path(sys.prefix).resolve()
if actual != expected:
    raise RuntimeError(f"wrong venv prefix: {actual} != {expected}")
print("easyresearch-venv-ok")
`);
}

export interface VenvValidationResult {
  stdout: string;
  stderr: string;
}

interface ValidationSpawnResult {
  status: number | null;
  stdout: string | Buffer | null;
  stderr: string | Buffer | null;
  error?: Error;
}

const VENV_SENTINEL = "easyresearch-venv-ok";
const STAGE_COMPLETION = "complete\nArtifacts: none\nGaps: none\nNext action: none";

function hasExactLine(text: string, expected: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === expected);
}

function isSuccessfulStageHandoff(text: string): boolean {
  const normalized = text.replaceAll("\r\n", "\n").trim();
  return normalized === STAGE_COMPLETION
    || normalized.startsWith(`${STAGE_COMPLETION}\n\nSession history JSONL:`);
}

export function runVenvValidation(options: {
  python: string;
  script: string;
  exists?: (path: string) => boolean;
  spawn?: (
    command: string,
    args: readonly string[],
    options: { encoding: "utf8"; timeout: number },
  ) => ValidationSpawnResult;
}): VenvValidationResult {
  const failure = (reason: string, stdout = "", stderr = ""): never => {
    throw new Error(`${options.python} venv validation ${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  };
  const exists = options.exists ?? (options.spawn ? undefined : existsSync);
  if (exists && !exists(options.python)) failure("interpreter is missing");

  const result = (options.spawn ?? spawnSync)(options.python, [options.script], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  if (result.error) failure(`spawn failed: ${result.error.message}`, stdout, stderr);
  if (result.status !== 0) failure(`failed with status ${result.status ?? "unknown"}`, stdout, stderr);
  if (!hasExactLine(stdout, VENV_SENTINEL)) failure(`did not emit ${VENV_SENTINEL}`, stdout, stderr);
  return { stdout, stderr };
}

export function venvToolCommand(platform: NodeJS.Platform, scriptPath: string): string {
  if (platform === "win32") {
    return `"%EASYRESEARCH_VENV%\\Scripts\\python.exe" "${scriptPath.replaceAll('"', '""')}"`;
  }
  const quotedScript = scriptPath.replace(/["\\`$]/g, "\\$&");
  return `"$EASYRESEARCH_VENV/bin/python" "${quotedScript}"`;
}

export type SmokeModelAction =
  | { kind: "tool"; id: string; name: "subagent" | "bash"; arguments: string }
  | { kind: "text"; text: string };

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(messageContentText).join("\n");
  if (content && typeof content === "object" && "text" in content) {
    return messageContentText((content as { text?: unknown }).text);
  }
  return "";
}

export function selectSmokeModelAction(
  request: {
    tools?: Array<{ function?: { name?: string } }>;
    messages?: Array<{ role?: string; content?: unknown }>;
  },
  toolCommand: string,
): SmokeModelAction {
  const toolNames = new Set(request.tools?.map((tool) => tool.function?.name));
  const toolResult = request.messages?.findLast((message) => message.role === "tool");

  if (toolNames.has("subagent")) {
    if (toolResult) {
      const content = messageContentText(toolResult.content);
      if (!isSuccessfulStageHandoff(content)) {
        throw new Error(`subagent tool result did not contain a successful deterministic handoff: ${content}`);
      }
      return { kind: "text", text: "Parent smoke run complete." };
    }
    return {
      kind: "tool",
      id: "call_native_stage",
      name: "subagent",
      arguments: JSON.stringify({
        agent: "search",
        task: "Run the native venv validation command with the bash tool and return a complete handoff.",
      }),
    };
  }

  if (toolNames.has("bash")) {
    if (!toolResult) {
      return {
        kind: "tool",
        id: "call_native_venv",
        name: "bash",
        arguments: JSON.stringify({ command: toolCommand, timeout: 60 }),
      };
    }
    const content = messageContentText(toolResult.content);
    if (!hasExactLine(content, VENV_SENTINEL)) {
      throw new Error(`bash tool result did not contain an exact ${VENV_SENTINEL} line: ${content}`);
    }
    return { kind: "text", text: STAGE_COMPLETION };
  }

  throw new Error("native smoke request did not expose subagent or bash");
}
