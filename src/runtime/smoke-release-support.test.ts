import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_RUN_CEILING_MS,
  collectLaunchOutput,
  createCompiledChildEnv,
  finishSmokeCleanup,
  readTextFileWithRetry,
  requireZeroProcessStatus,
  resolveSmokePython,
  runVenvValidation,
  selectSmokeModelAction,
  type SmokeModelState,
  settleProcess,
  skillVenvPython,
  validateFirstRunVenv,
  venvToolCommand,
  writeVenvValidationScript,
} from "../../scripts/smoke-release-support";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "smoke-release-support-"));
  tempDirs.push(dir);
  return dir;
}

function findPythonOnPath(): string | undefined {
  for (const name of ["python3", "python"]) {
    const executable = process.platform === "win32" ? `${name}.exe` : name;
    const found = process.env.PATH?.split(delimiter)
      .map((dir) => join(dir, executable))
      .find(existsSync);
    if (found) return found;
  }
  return undefined;
}

const systemPython = findPythonOnPath();

function validationFixture(python: string): { python: string; script: string; prefix: string; root: string } {
  const root = tempDir();
  for (const module of ["arxiv", "ddgr", "markitdown"]) writeFileSync(join(root, `${module}.py`), "");
  const script = join(root, "validate.py");
  writeVenvValidationScript(script);
  const prefixResult = spawnSync(python, ["-c", "import sys; print(sys.prefix)"], { encoding: "utf8" });
  if (prefixResult.status !== 0) throw new Error(`failed to inspect Python prefix: ${prefixResult.stderr}`);
  return { python, script, prefix: prefixResult.stdout.trim(), root };
}

describe("resolveSmokePython", () => {
  it("prefers an explicit absolute smoke Python", () => {
    expect(resolveSmokePython({
      explicit: "/toolcache/python/bin/python",
      which: () => undefined,
      exists: () => true,
    })).toBe("/toolcache/python/bin/python");
  });

  it("falls back from python3 to python", () => {
    expect(resolveSmokePython({
      which: (name) => name === "python" ? "/python/python" : undefined,
      exists: () => true,
    })).toBe("/python/python");
  });

  it.each([undefined, "python3"])(
    "rejects an absent or relative explicit interpreter (%s)",
    (explicit) => {
      expect(() => resolveSmokePython({
        explicit,
        which: () => undefined,
        exists: () => false,
      })).toThrow("EASYRESEARCH_SMOKE_PYTHON");
    },
  );
});

describe("createCompiledChildEnv", () => {
  it("constructs a Python-only child PATH with bounded pip retries", () => {
    const env = createCompiledChildEnv({
      base: { PATH: "/node:/bun", SECRET: "kept" },
      python: "/toolcache/python/bin/python",
    });

    expect(env.PATH).toBe("/toolcache/python/bin");
    expect(env.PIP_RETRIES).toBe("3");
    expect(env.PIP_DEFAULT_TIMEOUT).toBe("30");
    expect(env.PATH).not.toContain("node");
    expect(env.PATH).not.toContain("bun");
    expect(env.SECRET).toBe("kept");
  });

  it("keeps the effective mixed-case path key consistent with PATH", () => {
    const env = createCompiledChildEnv({
      base: { Path: "/node:/bun" },
      python: "/toolcache/python/bin/python",
      overrides: { SMOKE_OVERRIDE: "kept" },
    });

    expect(env.Path).toBe("/toolcache/python/bin");
    expect(env.PATH).toBe(env.Path);
    expect(env.SMOKE_OVERRIDE).toBe("kept");
  });

  it("removes ambient Python import contamination case-insensitively", () => {
    const env = createCompiledChildEnv({
      base: {
        PYTHONPATH: "/ambient/modules",
        PythonHome: "/ambient/python",
        SAFE_VALUE: "kept",
      },
      python: "/toolcache/python/bin/python",
      overrides: { PYTHONUSERBASE: "/ambient/user-site" },
    });

    expect(Object.keys(env).map((key) => key.toUpperCase())).not.toEqual(
      expect.arrayContaining(["PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE"]),
    );
    expect(env.SAFE_VALUE).toBe("kept");
  });
});

describe("skillVenvPython", () => {
  it("uses the POSIX venv interpreter", () => {
    expect(skillVenvPython("/agent", "linux")).toBe("/agent/venv/bin/python");
  });

  it("uses the Windows venv interpreter", () => {
    expect(skillVenvPython("C:\\agent", "win32")).toBe("C:\\agent\\venv\\Scripts\\python.exe");
  });
});

describe("runVenvValidation", () => {
  it("accepts only the sentinel from the expected venv prefix", () => {
    const result = runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      spawn: () => ({ status: 0, stdout: "easyresearch-venv-ok\n", stderr: "" }),
    });

    expect(result.stdout).toContain("easyresearch-venv-ok");
  });

  it("runs Python in isolated mode", () => {
    let actualArgs: readonly string[] = [];
    runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      spawn: (_command, args) => {
        actualArgs = args;
        return { status: 0, stdout: "easyresearch-venv-ok\n", stderr: "" };
      },
    });

    expect(actualArgs).toEqual(["-I", "/tmp/validate.py"]);
  });

  it("rejects a missing interpreter with its path and stderr", () => {
    const python = join(tempDir(), "missing", "python");
    expect(() => runVenvValidation({
      python,
      script: "/tmp/validate.py",
      exists: () => false,
      spawn: () => ({ status: 0, stdout: "", stderr: "not started" }),
    })).toThrow(new RegExp(`${python}.*stderr`, "s"));
  });

  it("reports spawn errors with the interpreter path and captured stderr", () => {
    expect(() => runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      exists: () => true,
      spawn: () => ({
        status: null,
        stdout: "partial output",
        stderr: "spawn stderr",
        error: new Error("spawn failed"),
      }),
    })).toThrow(/\/agent\/venv\/bin\/python.*spawn stderr/s);
  });

  it("reports non-zero status with the interpreter path and captured stderr", () => {
    expect(() => runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      exists: () => true,
      spawn: () => ({ status: 9, stdout: "", stderr: "import failed" }),
    })).toThrow(/\/agent\/venv\/bin\/python.*import failed/s);
  });

  it("rejects successful output without the sentinel and includes stderr", () => {
    expect(() => runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      exists: () => true,
      spawn: () => ({ status: 0, stdout: "unexpected", stderr: "validation warning" }),
    })).toThrow(/\/agent\/venv\/bin\/python.*validation warning/s);
  });

  it("rejects a near-match sentinel line", () => {
    expect(() => runVenvValidation({
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      exists: () => true,
      spawn: () => ({ status: 0, stdout: "easyresearch-venv-ok-invalid\n", stderr: "near match" }),
    })).toThrow(/\/agent\/venv\/bin\/python.*near match/s);
  });
});

describe("validateFirstRunVenv", () => {
  function passingValidationSpawn() {
    return vi.fn(() => ({ status: 0, stdout: "easyresearch-venv-ok\n", stderr: "" }));
  }

  it("rejects success:false setup evidence even when import validation would pass", () => {
    const resultPath = join(tempDir(), "setup-result.json");
    writeFileSync(resultPath, JSON.stringify({ runId: "current-run", success: false }));
    const spawn = passingValidationSpawn();

    expect(() => validateFirstRunVenv({
      setupResultPath: resultPath,
      setupRunId: "current-run",
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      spawn,
    })).toThrow("success:false");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects stale success evidence from a different first-run invocation", () => {
    const resultPath = join(tempDir(), "setup-result.json");
    writeFileSync(resultPath, JSON.stringify({ runId: "old-run", success: true }));
    const spawn = passingValidationSpawn();

    expect(() => validateFirstRunVenv({
      setupResultPath: resultPath,
      setupRunId: "new-run",
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      spawn,
    })).toThrow("does not match the current run");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts matching success evidence before validating imports", () => {
    const resultPath = join(tempDir(), "setup-result.json");
    writeFileSync(resultPath, JSON.stringify({ runId: "current-run", success: true }));
    const spawn = passingValidationSpawn();

    expect(validateFirstRunVenv({
      setupResultPath: resultPath,
      setupRunId: "current-run",
      python: "/agent/venv/bin/python",
      script: "/tmp/validate.py",
      spawn,
    }).stdout).toContain("easyresearch-venv-ok");
    expect(spawn).toHaveBeenCalledOnce();
  });
});

describe.skipIf(systemPython === undefined)(
  "writeVenvValidationScript (skipped: no Python interpreter on PATH)",
  () => {
    it("imports the skill packages and emits the sentinel for the expected prefix", () => {
      const fixture = validationFixture(systemPython!);
      const result = spawnSync(fixture.python, [fixture.script], {
        encoding: "utf8",
        env: {
          ...process.env,
          EASYRESEARCH_VENV: fixture.prefix,
          PYTHONPATH: fixture.root,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("easyresearch-venv-ok");
    });

    it("rejects packages supplied only through ambient PYTHONPATH", () => {
      const fixture = validationFixture(systemPython!);
      const contaminatedEnv = {
        ...process.env,
        EASYRESEARCH_VENV: fixture.prefix,
        PYTHONPATH: fixture.root,
      };
      const ambientResult = spawnSync(fixture.python, [fixture.script], {
        encoding: "utf8",
        env: contaminatedEnv,
      });
      expect(ambientResult.status, ambientResult.stderr).toBe(0);

      expect(() => runVenvValidation({
        python: fixture.python,
        script: fixture.script,
        spawn: (command, args, options) => spawnSync(command, [...args], {
          ...options,
          env: contaminatedEnv,
        }),
      })).toThrow(/No module named/u);
    });

    it("rejects packages supplied only through the ambient Python user site", () => {
      const fixture = validationFixture(systemPython!);
      const userBase = join(fixture.root, "user-base");
      const userSiteResult = spawnSync(fixture.python, ["-c", "import site; print(site.getusersitepackages())"], {
        encoding: "utf8",
        env: { ...process.env, PYTHONUSERBASE: userBase },
      });
      if (userSiteResult.status !== 0) throw new Error(`failed to inspect Python user site: ${userSiteResult.stderr}`);
      const userSite = userSiteResult.stdout.trim();
      mkdirSync(userSite, { recursive: true });
      for (const module of ["arxiv", "ddgr", "markitdown"]) writeFileSync(join(userSite, `${module}.py`), "");
      const contaminatedEnv = {
        ...process.env,
        EASYRESEARCH_VENV: fixture.prefix,
        PYTHONUSERBASE: userBase,
      };
      const ambientResult = spawnSync(fixture.python, [fixture.script], {
        encoding: "utf8",
        env: contaminatedEnv,
      });
      expect(ambientResult.status, ambientResult.stderr).toBe(0);

      expect(() => runVenvValidation({
        python: fixture.python,
        script: fixture.script,
        spawn: (command, args, options) => spawnSync(command, [...args], {
          ...options,
          env: contaminatedEnv,
        }),
      })).toThrow(/No module named/u);
    });

    it("rejects a Python process outside EASYRESEARCH_VENV", () => {
      const fixture = validationFixture(systemPython!);
      const result = spawnSync(fixture.python, [fixture.script], {
        encoding: "utf8",
        env: {
          ...process.env,
          EASYRESEARCH_VENV: join(fixture.root, "another-venv"),
          PYTHONPATH: fixture.root,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("wrong venv prefix");
    });
  },
);

describe("first-run process support", () => {
  it("allows the 600-second setup child timeout to return first", () => {
    expect(FIRST_RUN_CEILING_MS).toBeGreaterThan(600_000);
  });

  it("waits for a process to exit without terminating it", async () => {
    let checks = 0;
    let terminateCalls = 0;

    await expect(settleProcess({
      pid: 42,
      deadline: 100,
      now: () => 0,
      isAlive: () => ++checks < 3,
      terminateTree: () => { terminateCalls += 1; },
      sleep: async () => {},
    })).resolves.toBe("exited");
    expect(terminateCalls).toBe(0);
  });

  it("terminates and settles a process that reaches its deadline", async () => {
    let alive = true;
    let terminateCalls = 0;

    await expect(settleProcess({
      pid: 42,
      deadline: 100,
      now: () => 100,
      isAlive: () => alive,
      terminateTree: () => {
        terminateCalls += 1;
        alive = false;
      },
      sleep: async () => {},
    })).rejects.toThrow("exceeded first-run deadline");
    expect(terminateCalls).toBe(1);
    expect(alive).toBe(false);
  });

  it("terminates immediately after an earlier smoke failure", async () => {
    let alive = true;

    await expect(settleProcess({
      pid: 42,
      deadline: 100,
      terminateImmediately: true,
      now: () => 0,
      isAlive: () => alive,
      terminateTree: () => { alive = false; },
      sleep: async () => {},
    })).resolves.toBe("terminated");
    expect(alive).toBe(false);
  });
});

describe("readTextFileWithRetry", () => {
  it("retries a transient capture-file lock", async () => {
    let reads = 0;
    let sleeps = 0;

    const content = await readTextFileWithRetry({
      path: "/tmp/first-run-stdout.txt",
      attempts: 3,
      read: () => {
        reads += 1;
        if (reads < 3) throw new Error("file is locked");
        return "pip output";
      },
      sleep: async () => { sleeps += 1; },
    });

    expect(content).toBe("pip output");
    expect(reads).toBe(3);
    expect(sleeps).toBe(2);
  });

  it("returns the final capture error after the bounded attempts", async () => {
    let reads = 0;
    const content = await readTextFileWithRetry({
      path: "/tmp/first-run-stderr.txt",
      attempts: 2,
      read: () => {
        reads += 1;
        throw new Error("still locked");
      },
      sleep: async () => {},
    });

    expect(content).toContain("capture unavailable");
    expect(content).toContain("still locked");
    expect(reads).toBe(2);
  });
});

describe("collectLaunchOutput", () => {
  it("does not read captures for an asynchronous launch", () => {
    const reads: string[] = [];

    const output = collectLaunchOutput({
      asynchronous: true,
      stdoutPath: "/tmp/first-run-stdout.txt",
      stderrPath: "/tmp/first-run-stderr.txt",
      read: (path) => {
        reads.push(path);
        throw new Error("async capture is still owned by the client");
      },
    });

    expect(output).toEqual({ stdout: "", stderr: "" });
    expect(reads).toEqual([]);
  });

  it("reads both captures after a synchronous launch", () => {
    const reads: string[] = [];

    const output = collectLaunchOutput({
      asynchronous: false,
      stdoutPath: "/tmp/first-run-stdout.txt",
      stderrPath: "/tmp/first-run-stderr.txt",
      read: (path) => {
        reads.push(path);
        return path.endsWith("stdout.txt") ? "setup stdout" : "setup stderr";
      },
    });

    expect(output).toEqual({ stdout: "setup stdout", stderr: "setup stderr" });
    expect(reads).toEqual(["/tmp/first-run-stdout.txt", "/tmp/first-run-stderr.txt"]);
  });
});

describe("requireZeroProcessStatus", () => {
  it("accepts a durable zero exit status", () => {
    expect(() => requireZeroProcessStatus({
      label: "Windows shutdown client",
      statusText: "0\r\n",
      stdout: "service stopped",
      stderr: "",
    })).not.toThrow();
  });

  it("reports a nonzero exit status with captured diagnostics", () => {
    expect(() => requireZeroProcessStatus({
      label: "Windows shutdown client",
      statusText: "7",
      stdout: "partial output",
      stderr: "shutdown failed",
    })).toThrow(/Windows shutdown client.*status 7.*partial output.*shutdown failed/s);
  });

  it("rejects a missing timeout/status result", () => {
    expect(() => requireZeroProcessStatus({
      label: "Windows shutdown client",
      statusText: "timeout",
      stdout: "",
      stderr: "",
    })).toThrow(/valid exit status/);
  });
});

describe("finishSmokeCleanup", () => {
  function successfulCleanup(overrides: Partial<Parameters<typeof finishSmokeCleanup>[0]> = {}) {
    return {
      shutdown: vi.fn(),
      stopAuxiliary: vi.fn(),
      verifyDaemonStopped: vi.fn(),
      removeRoot: vi.fn(),
      ...overrides,
    };
  }

  it("waits for shutdown and daemon verification before deleting the root", async () => {
    const order: string[] = [];
    await finishSmokeCleanup(successfulCleanup({
      shutdown: () => { order.push("shutdown"); },
      stopAuxiliary: () => { order.push("auxiliary"); },
      verifyDaemonStopped: () => { order.push("daemon-stopped"); },
      removeRoot: () => { order.push("root-removed"); },
    }));

    expect(order).toEqual(["shutdown", "auxiliary", "daemon-stopped", "root-removed"]);
  });

  it("does not silently accept a cleanup failure", async () => {
    await expect(finishSmokeCleanup(successfulCleanup({
      removeRoot: () => { throw new Error("root is still locked"); },
    }))).rejects.toThrow(/temporary root removal.*root is still locked/);
  });

  it("preserves the primary failure and attaches cleanup diagnostics", async () => {
    const primary = new Error("stage dispatch failed");
    let thrown: unknown;
    try {
      await finishSmokeCleanup(successfulCleanup({
        primaryError: primary,
        shutdown: () => { throw new Error("exit client timed out"); },
      }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(primary);
    expect(primary.message).toMatch(/^stage dispatch failed/);
    expect(primary.message).toContain("shutdown: exit client timed out");
    expect(primary.stack).toContain("Cleanup diagnostics");
  });

  it("rethrows the primary failure after otherwise successful cleanup", async () => {
    const primary = new Error("model request failed");
    await expect(finishSmokeCleanup(successfulCleanup({ primaryError: primary }))).rejects.toBe(primary);
  });

  it("does not delete the root when daemon termination was not verified", async () => {
    const removeRoot = vi.fn();
    await expect(finishSmokeCleanup(successfulCleanup({
      verifyDaemonStopped: () => { throw new Error("daemon 42 is still alive"); },
      removeRoot,
    }))).rejects.toThrow("daemon 42 is still alive");
    expect(removeRoot).not.toHaveBeenCalled();
  });
});

describe("venvToolCommand", () => {
  it("uses the runtime POSIX venv interpreter", () => {
    const command = venvToolCommand("linux", "/tmp/native validate.py");
    expect(command).toContain("$EASYRESEARCH_VENV/bin/python");
    expect(command).toContain('"/tmp/native validate.py"');
    expect(command).not.toContain("/agent/venv");
  });

  it("uses the runtime Windows venv interpreter", () => {
    const command = venvToolCommand("win32", "C:\\temp\\native validate.py");
    expect(command).toContain("${EASYRESEARCH_VENV}/Scripts/python.exe");
    expect(command).toContain('"C:\\\\temp\\\\native validate.py"');
    expect(command).not.toContain("%EASYRESEARCH_VENV%");
    expect(command).not.toContain("C:\\agent\\venv");
  });
});

describe("selectSmokeModelAction", () => {
  const tool = (name: string) => ({ function: { name } });
  const completedStage = "complete\nArtifacts: none\nGaps: none\nNext action: none";
  const state = (phase: SmokeModelState["phase"], completedRequests: number): SmokeModelState => ({
    phase,
    completedRequests,
  });
  const toolResult = (toolCallId: string | undefined, content: unknown) => ({
    role: "tool" as const,
    ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    content,
  });

  it("uses the explicit phase when subagent and bash are both advertised", () => {
    const parent = selectSmokeModelAction({
      tools: [tool("bash"), tool("subagent")],
      messages: [toolResult("historical", "old result")],
    }, "validate-command", state("awaiting-parent-subagent-call", 0));
    expect(parent.action).toMatchObject({ kind: "tool", id: "call_native_stage", name: "subagent" });

    const stage = selectSmokeModelAction({
      tools: [tool("subagent"), tool("bash")],
      messages: [toolResult("historical", completedStage)],
    }, "validate-command", parent.state);
    expect(stage.action).toEqual({
      kind: "tool",
      id: "call_native_venv",
      name: "bash",
      arguments: JSON.stringify({ command: "validate-command", timeout: 60 }),
    });
    expect(stage.state).toEqual({ phase: "awaiting-venv-tool-result", completedRequests: 2 });
  });

  it("matches the expected bash call instead of the last unrelated tool row", () => {
    const transition = selectSmokeModelAction({
      tools: [tool("subagent"), tool("bash")],
      messages: [
        toolResult("old-call", "easyresearch-venv-ok"),
        toolResult("call_native_venv", "validation log\n easyresearch-venv-ok  \n"),
        toolResult("unrelated-later-call", "wrong interpreter"),
      ],
    }, "validate-command", state("awaiting-venv-tool-result", 2));

    expect(transition.action).toEqual({ kind: "text", text: completedStage });
    expect(transition.state).toEqual({ phase: "awaiting-subagent-tool-result", completedRequests: 3 });
    expect(transition.validatedVenvResult).toBe(true);
  });

  it("matches the expected subagent call instead of unrelated history", () => {
    const transition = selectSmokeModelAction({
      tools: [tool("bash"), tool("subagent")],
      messages: [
        toolResult("call_native_venv", "easyresearch-venv-ok"),
        toolResult("unrelated", "Agent error: old failure"),
        toolResult("call_native_stage", `${completedStage}\n\nSession history JSONL: /sessions/search.jsonl`),
      ],
    }, "validate-command", state("awaiting-subagent-tool-result", 3));

    expect(transition).toEqual({
      action: { kind: "text", text: "Parent smoke run complete." },
      state: { phase: "complete", completedRequests: 4 },
      validatedVenvResult: false,
    });
  });

  it.each([
    ["awaiting-venv-tool-result", 2, "call_native_venv", undefined],
    ["awaiting-venv-tool-result", 2, "call_native_venv", "wrong-call"],
    ["awaiting-subagent-tool-result", 3, "call_native_stage", undefined],
    ["awaiting-subagent-tool-result", 3, "call_native_stage", "wrong-call"],
  ] as const)("rejects a %s request at step %s without the expected %s result", (phase, completedRequests, expectedId, actualId) => {
    const content = expectedId === "call_native_venv" ? "easyresearch-venv-ok" : completedStage;
    expect(() => selectSmokeModelAction({
      tools: [tool("subagent"), tool("bash")],
      messages: [toolResult(actualId, content)],
    }, "validate-command", state(phase, completedRequests))).toThrow(expectedId);
  });

  it("rejects duplicate rows for the expected tool call", () => {
    expect(() => selectSmokeModelAction({
      tools: [tool("bash")],
      messages: [
        toolResult("call_native_venv", "easyresearch-venv-ok"),
        toolResult("call_native_venv", "easyresearch-venv-ok"),
      ],
    }, "validate-command", state("awaiting-venv-tool-result", 2))).toThrow("exactly one");
  });

  it.each([
    "wrong interpreter",
    "easyresearch-venv-ok-invalid",
    "prefix easyresearch-venv-ok suffix",
  ])("rejects a failed or inexact bash result: %s", (content) => {
    expect(() => selectSmokeModelAction({
      tools: [tool("bash")],
      messages: [toolResult("call_native_venv", content)],
    }, "validate-command", state("awaiting-venv-tool-result", 2))).toThrow("easyresearch-venv-ok");
  });

  it.each([
    "blocked\nArtifacts: none\nGaps: validation failed\nNext action: retry",
    "Agent error: search stage failed",
    "complete-invalid\nArtifacts: none\nGaps: none\nNext action: none",
  ])("fails closed for an unsuccessful correlated subagent result: %s", (content) => {
    expect(() => selectSmokeModelAction({
      tools: [tool("subagent")],
      messages: [toolResult("call_native_stage", content)],
    }, "validate-command", state("awaiting-subagent-tool-result", 3))).toThrow("successful deterministic handoff");
  });

  it("completes the exact four-request sequence and validates the venv result once", () => {
    let current = state("awaiting-parent-subagent-call", 0);
    let validatedVenvResults = 0;

    const parentCall = selectSmokeModelAction({
      tools: [tool("bash"), tool("subagent")],
      messages: [toolResult("historical", "ignored")],
    }, "validate-command", current);
    current = parentCall.state;
    validatedVenvResults += Number(parentCall.validatedVenvResult);

    const bashCall = selectSmokeModelAction({
      tools: [tool("subagent"), tool("bash")],
      messages: [toolResult("historical", completedStage)],
    }, "validate-command", current);
    current = bashCall.state;
    validatedVenvResults += Number(bashCall.validatedVenvResult);

    const bashResult = selectSmokeModelAction({
      tools: [tool("subagent"), tool("bash")],
      messages: [toolResult("call_native_venv", "easyresearch-venv-ok\n")],
    }, "validate-command", current);
    current = bashResult.state;
    validatedVenvResults += Number(bashResult.validatedVenvResult);

    const parentResult = selectSmokeModelAction({
      tools: [tool("bash"), tool("subagent")],
      messages: [
        toolResult("call_native_venv", "easyresearch-venv-ok\n"),
        toolResult("call_native_stage", completedStage),
      ],
    }, "validate-command", current);
    current = parentResult.state;
    validatedVenvResults += Number(parentResult.validatedVenvResult);

    expect(parentCall.action).toMatchObject({ kind: "tool", id: "call_native_stage", name: "subagent" });
    expect(bashCall.action).toMatchObject({ kind: "tool", id: "call_native_venv", name: "bash" });
    expect(bashResult.action).toEqual({ kind: "text", text: completedStage });
    expect(parentResult.action).toEqual({ kind: "text", text: "Parent smoke run complete." });
    expect(current).toEqual({ phase: "complete", completedRequests: 4 });
    expect(validatedVenvResults).toBe(1);
  });

  it("does not accept the same venv result again after advancing the phase", () => {
    const first = selectSmokeModelAction({
      tools: [tool("bash")],
      messages: [toolResult("call_native_venv", "easyresearch-venv-ok")],
    }, "validate-command", state("awaiting-venv-tool-result", 2));
    expect(first.validatedVenvResult).toBe(true);

    expect(() => selectSmokeModelAction({
      tools: [tool("bash")],
      messages: [toolResult("call_native_venv", "easyresearch-venv-ok")],
    }, "validate-command", first.state)).toThrow("call_native_stage");
  });

  it("rejects requests after the four phases complete", () => {
    expect(() => selectSmokeModelAction({
      tools: [tool("subagent"), tool("bash")],
      messages: [],
    }, "validate-command", state("complete", 4))).toThrow("already complete");
  });
});
