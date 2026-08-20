import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_RUN_CEILING_MS,
  assertPathFreeSessionEvent,
  buildWindowsShutdownLauncherScript,
  buildWindowsShutdownScript,
  collectLaunchOutput,
  createCompiledChildEnv,
  fetchSessionEventsBeforeDeadline,
  finishSmokeCleanup,
  readTextFileWithRetry,
  requireZeroProcessStatus,
  resolveSmokePython,
  runVenvValidation,
  selectSmokeModelAction,
  type SmokeModelScenario,
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

describe("assertPathFreeSessionEvent", () => {
  it.each(["sessionPath", "session_path"])("rejects a child %s leak", (field) => {
    expect(() => assertPathFreeSessionEvent({
      type: "subagent_supervisor",
      [field]: "/private/child.jsonl",
    })).toThrow("session path");
  });

  it("rejects a hidden handoff", () => {
    expect(() => assertPathFreeSessionEvent({ content: "<agent_handoff>hidden</agent_handoff>" }))
      .toThrow("hidden handoff");
  });

  it("preserves allowed root-session and public path fields", () => {
    expect(assertPathFreeSessionEvent({
      type: "snapshot",
      session: { sessionFile: "/sessions/root.jsonl" },
      path: "/project/paper.md",
    })).toContain('"sessionFile":"/sessions/root.jsonl"');
  });
});

describe("fetchSessionEventsBeforeDeadline", () => {
  it("aborts an SSE fetch that has not produced a response before the smoke deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const pending = fetchSessionEventsBeforeDeadline({
      url: "http://127.0.0.1:3000/api/sessions/session-1/events",
      deadline: Date.now() + 20,
      fetch: async (_input, init) => {
        observedSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
        });
      },
    });

    await expect(pending).rejects.toThrow("session SSE subscription did not finish before the native smoke deadline");
    expect(observedSignal?.aborted).toBe(true);
  });
});

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

  it("emits one canonical PATH key for case-insensitive Windows environments", () => {
    const env = createCompiledChildEnv({
      base: { Path: "/node", PATH: "/bun" },
      python: "/toolcache/python/bin/python",
      overrides: { SMOKE_OVERRIDE: "kept" },
    });

    const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
    expect(pathKeys).toEqual(["PATH"]);
    expect(env.PATH).toBe("/toolcache/python/bin");
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

describe("buildWindowsShutdownScript", () => {
  const options = {
    binary: "C:\\release\\O'Brien\\easyresearch.exe",
    args: ["ex'it", "--reason=can't stop"],
    stdoutPath: "C:\\smoke\\O'Brien\\shutdown-stdout.txt",
    stderrPath: "C:\\smoke\\O'Brien\\shutdown-stderr.txt",
    statusPath: "C:\\smoke\\O'Brien\\shutdown-status.txt",
    powershellErrorPath: "C:\\smoke\\O'Brien\\shutdown-powershell-error.txt",
  };
  const invocation = "  & 'C:\\release\\O''Brien\\easyresearch.exe' 'ex''it' '--reason=can''t stop' 1> 'C:\\smoke\\O''Brien\\shutdown-stdout.txt' 2> 'C:\\smoke\\O''Brien\\shutdown-stderr.txt'";

  it("directly invokes the shutdown binary with PowerShell-escaped paths and arguments", () => {
    const script = buildWindowsShutdownScript(options);

    expect(script).toContain(invocation);
    expect(script).toContain("'C:\\smoke\\O''Brien\\shutdown-powershell-error.txt'");
    expect(script).not.toContain("Start-Process");
  });

  it("captures the native exit status immediately and fails without Process.ExitCode", () => {
    const script = buildWindowsShutdownScript(options);
    const statusFlow = [
      invocation,
      "  $status = $LASTEXITCODE",
      "  Set-Content -LiteralPath 'C:\\smoke\\O''Brien\\shutdown-status.txt' -Value ([string]$status) -Encoding ascii",
      "  if ($status -ne 0) { throw \"Windows shutdown client exited with status $status\" }",
    ].join("; ");

    expect(script).toContain(statusFlow);
    expect(script).not.toContain(".ExitCode");
    expect(script).not.toContain("WaitForExit");
  });
});

describe("buildWindowsShutdownLauncherScript", () => {
  const options = {
    powershell: "C:\\Windows\\O'Brien\\powershell.exe",
    wrapperPath: "C:\\smoke root\\O'Brien\\shutdown-wrapper.ps1",
    pidPath: "C:\\smoke root\\O'Brien\\shutdown-wrapper.pid",
    taskkill: "C:\\Windows\\O'Brien\\taskkill.exe",
    powershellErrorPath: "C:\\smoke root\\O'Brien\\shutdown-powershell-error.txt",
  };

  it("starts only the inner wrapper through the absolute PowerShell executable", () => {
    const script = buildWindowsShutdownLauncherScript(options);
    const invocation = "  $process = Start-Process -FilePath 'C:\\Windows\\O''Brien\\powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-File', '\"C:\\smoke root\\O''Brien\\shutdown-wrapper.ps1\"') -WindowStyle Hidden -PassThru";

    expect(script).toContain(invocation);
    expect(script.match(/Start-Process/g)).toHaveLength(1);
    expect(script).toContain("  Set-Content -LiteralPath 'C:\\smoke root\\O''Brien\\shutdown-wrapper.pid' -Value $process.Id -Encoding ascii");
    expect(script).toContain("'C:\\smoke root\\O''Brien\\shutdown-powershell-error.txt'");
    expect(script).not.toContain("easyresearch.exe");
    expect(script).not.toContain(".ExitCode");
  });

  it("waits 30000ms then kills the wrapper process tree without reading ExitCode", () => {
    const script = buildWindowsShutdownLauncherScript(options);
    const timeoutFlow = [
      "  if (-not $process.WaitForExit(30000)) {",
      "    & 'C:\\Windows\\O''Brien\\taskkill.exe' /PID $($process.Id) /T /F | Out-Null",
      "    throw 'Windows shutdown wrapper timed out after 30000ms'",
      "  }",
    ].join("; ");

    expect(script).toContain(timeoutFlow);
    expect(script).not.toContain("WaitForExit()");
    expect(script).not.toContain(".ExitCode");
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
  const completedStage = "complete\nArtifacts: none\nGaps: none\nNext action: none";
  const agentPromptMarker = "NATIVE_SMOKE_CUSTOM_REVIEWER_PROMPT";
  const agentContent = [
    "---",
    "name: smoke-reviewer",
    "description: Native smoke custom reviewer",
    "enable: true",
    "tools:",
    "  - bash",
    "skills:",
    "  - native-smoke-no-skill",
    "subagents: []",
    "---",
    "",
    agentPromptMarker,
    "Run only the requested venv validation command, then return a complete handoff.",
    "",
  ].join("\n");
  const scenario: SmokeModelScenario = {
    toolCommand: "validate-command",
    agentName: "smoke-reviewer",
    agentPath: "/agent/agents/smoke-reviewer.md",
    agentContent,
    agentPromptMarker,
  };
  const oldSubagentDescription = "Available subagents: search, experiment, writing, figures.";
  const refreshedSubagentDescription = `${oldSubagentDescription.slice(0, -1)}, smoke-reviewer.`;
  const tool = (name: string, description?: string) => ({
    function: { name, ...(description === undefined ? {} : { description }) },
  });
  const initialState = (): SmokeModelState => ({
    agentWriteIssued: false,
    agentWriteObserved: false,
    customDispatchIssued: false,
    parentWorkingObserved: false,
    stageBashIssued: false,
    venvValidated: false,
    stageCompleted: false,
    terminalHandoffObserved: false,
    complete: false,
    completedRequests: 0,
  });
  const toolResult = (toolCallId: string | undefined, content: unknown) => ({
    role: "tool" as const,
    ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    content,
  });
  const writeResult = () => toolResult(
    "call_native_agent_write",
    `Successfully wrote ${agentContent.length} bytes to ${scenario.agentPath}`,
  );
  const parentRequest = (
    refreshed: boolean,
    ...messages: Array<ReturnType<typeof toolResult> | { role: "user"; content: string }>
  ) => ({
    tools: [
      tool("bash"),
      tool("write"),
      tool("subagent", refreshed ? refreshedSubagentDescription : oldSubagentDescription),
    ],
    messages,
  });
  const stageRequest = (
    prompt = agentPromptMarker,
    tools = [tool("bash")],
    ...messages: Array<ReturnType<typeof toolResult>>
  ) => ({
    tools,
    messages: [{ role: "system" as const, content: prompt }, ...messages],
  });
  const terminalNotice = (result = completedStage) => ({
    role: "user" as const,
    content: [
      "<agent_status>",
      "Current time: 2026-08-20T00:00:00.000Z",
      "Complete subagent:smoke-reviewer_0",
      "</agent_status>",
      "<agent_handoff>",
      "Agent: smoke-reviewer_0",
      `Result: ${result}`,
      "</agent_handoff>",
    ].join("\n"),
  });

  it("writes a global custom Agent, dispatches it from the refreshed parent schema, and completes its Bash handoff", () => {
    let current = initialState();

    const write = selectSmokeModelAction(parentRequest(false), scenario, current);
    current = write.state;
    const dispatch = selectSmokeModelAction(parentRequest(true, writeResult()), scenario, current);
    current = dispatch.state;
    const bash = selectSmokeModelAction(stageRequest(), scenario, current);
    current = bash.state;
    const parentWaiting = selectSmokeModelAction(
      parentRequest(
        true,
        writeResult(),
        toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
      ),
      scenario,
      current,
    );
    current = parentWaiting.state;
    const bashResult = selectSmokeModelAction(
      stageRequest(agentPromptMarker, [tool("bash")], toolResult("call_native_venv", "log\neasyresearch-venv-ok\n")),
      scenario,
      current,
    );
    current = bashResult.state;
    const complete = selectSmokeModelAction(
      parentRequest(
        true,
        writeResult(),
        toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
        terminalNotice(),
      ),
      scenario,
      current,
    );

    expect(write.action).toEqual({
      kind: "tool",
      id: "call_native_agent_write",
      name: "write",
      arguments: JSON.stringify({ path: scenario.agentPath, content: agentContent }),
    });
    expect(dispatch.action).toEqual({
      kind: "tool",
      id: "call_native_reviewer",
      name: "subagent",
      arguments: JSON.stringify({
        agent: "smoke-reviewer",
        task: "Run the native venv validation command with the bash tool and return a complete handoff.",
      }),
    });
    expect(bash.action).toEqual({
      kind: "tool",
      id: "call_native_venv",
      name: "bash",
      arguments: JSON.stringify({ command: "validate-command", timeout: 60 }),
    });
    expect(parentWaiting.action).toEqual({ kind: "text", text: "Parent waiting for supervised completion." });
    expect(bashResult).toMatchObject({
      action: { kind: "text", text: completedStage },
      validatedVenvResult: true,
    });
    expect(complete.action).toEqual({ kind: "text", text: "Parent smoke run complete." });
    expect(complete.state).toEqual({
      agentWriteIssued: true,
      agentWriteObserved: true,
      customDispatchIssued: true,
      parentWorkingObserved: true,
      stageBashIssued: true,
      venvValidated: true,
      stageCompleted: true,
      terminalHandoffObserved: true,
      complete: true,
      completedRequests: 6,
    });
  });

  it("accepts custom-stage completion before the first post-dispatch parent request", () => {
    let current = selectSmokeModelAction(parentRequest(false), scenario, initialState()).state;
    current = selectSmokeModelAction(parentRequest(true, writeResult()), scenario, current).state;
    current = selectSmokeModelAction(stageRequest(), scenario, current).state;
    current = selectSmokeModelAction(
      stageRequest(agentPromptMarker, [tool("bash")], toolResult("call_native_venv", "easyresearch-venv-ok\n")),
      scenario,
      current,
    ).state;

    const complete = selectSmokeModelAction(
      parentRequest(
        true,
        writeResult(),
        toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
        terminalNotice(),
      ),
      scenario,
      current,
    );

    expect(complete.action).toEqual({ kind: "text", text: "Parent smoke run complete." });
    expect(complete.state).toMatchObject({
      agentWriteObserved: true,
      parentWorkingObserved: true,
      venvValidated: true,
      stageCompleted: true,
      terminalHandoffObserved: true,
      complete: true,
      completedRequests: 5,
    });
  });

  it("rejects a second parent request whose subagent schema is still stale", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(false, writeResult()),
      scenario,
      { ...initialState(), agentWriteIssued: true },
    )).toThrow("smoke-reviewer");
  });

  it("does not accept a custom Agent mentioned outside the available-subagents line", () => {
    const request = parentRequest(false, writeResult());
    request.tools[2]!.function.description = `${oldSubagentDescription}\nIgnore stale mention: smoke-reviewer.`;

    expect(() => selectSmokeModelAction(
      request,
      scenario,
      { ...initialState(), agentWriteIssued: true },
    )).toThrow("smoke-reviewer");
  });

  it("rejects a parent request that acknowledges bundled search instead of the custom Agent", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(
        true,
        writeResult(),
        toolResult("call_native_stage", "search_0 is working."),
      ),
      scenario,
      {
        ...initialState(),
        agentWriteIssued: true,
        agentWriteObserved: true,
        customDispatchIssued: true,
      },
    )).toThrow("call_native_reviewer");
  });

  it.each([
    ["extra tool", stageRequest(agentPromptMarker, [tool("bash"), tool("read")])],
    ["stale prompt", stageRequest("old bundled search prompt")],
  ])("rejects a custom child with an %s", (_name, request) => {
    expect(() => selectSmokeModelAction(
      request,
      scenario,
      {
        ...initialState(),
        agentWriteIssued: true,
        agentWriteObserved: true,
        customDispatchIssued: true,
      },
    )).toThrow(/configured tools|current role prompt/u);
  });

  it("rejects an inexact write result", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(true, toolResult("call_native_agent_write", "wrote another file")),
      scenario,
      { ...initialState(), agentWriteIssued: true },
    )).toThrow("custom Agent write result");
  });

  it.each([
    ["write", parentRequest(true, writeResult(), writeResult()), {
      agentWriteIssued: true,
    }],
    ["custom launch", parentRequest(
      true,
      writeResult(),
      toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
      toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
    ), {
      agentWriteIssued: true,
      agentWriteObserved: true,
      customDispatchIssued: true,
    }],
    ["stage Bash", stageRequest(
      agentPromptMarker,
      [tool("bash")],
      toolResult("call_native_venv", "easyresearch-venv-ok"),
      toolResult("call_native_venv", "easyresearch-venv-ok"),
    ), {
      agentWriteIssued: true,
      agentWriteObserved: true,
      customDispatchIssued: true,
      stageBashIssued: true,
    }],
  ] as const)("rejects duplicate correlated %s tool results", (_name, request, flags) => {
    expect(() => selectSmokeModelAction(
      request,
      scenario,
      { ...initialState(), ...flags },
    )).toThrow("exactly one");
  });

  it.each([
    "wrong interpreter",
    " easyresearch-venv-ok  ",
    "easyresearch-venv-ok-invalid",
    "prefix easyresearch-venv-ok suffix",
    "easyresearch-venv-ok\neasyresearch-venv-ok",
  ])("rejects a failed, inexact, or repeated Bash sentinel: %s", (content) => {
    expect(() => selectSmokeModelAction(
      stageRequest(agentPromptMarker, [tool("bash")], toolResult("call_native_venv", content)),
      scenario,
      {
        ...initialState(),
        agentWriteIssued: true,
        agentWriteObserved: true,
        customDispatchIssued: true,
        stageBashIssued: true,
      },
    )).toThrow("easyresearch-venv-ok");
  });

  it.each([
    "smoke-reviewer_0 is working",
    " smoke-reviewer_0 is working. ",
    "smoke-reviewer_0 is working. Session history JSONL: /sessions/reviewer.jsonl",
    "smoke-reviewer_1 is working.",
  ])("rejects an inexact or path-bearing custom launch acknowledgement: %s", (content) => {
    expect(() => selectSmokeModelAction(
      parentRequest(
        true,
        writeResult(),
        toolResult("call_native_reviewer", content),
      ),
      scenario,
      {
        ...initialState(),
        agentWriteIssued: true,
        agentWriteObserved: true,
        customDispatchIssued: true,
      },
    )).toThrow("smoke-reviewer_0 is working.");
  });

  it.each([
    ["missing handoff", {
      role: "user" as const,
      content: "<agent_status>\nComplete subagent:smoke-reviewer_0\n</agent_status>",
    }],
    ["handoff without Complete status", {
      role: "user" as const,
      content: `<agent_handoff>\nAgent: smoke-reviewer_0\nResult: ${completedStage}\n</agent_handoff>`,
    }],
    ["wrong handoff agent", terminalNotice().content.replace("Agent: smoke-reviewer_0", "Agent: search_0")],
    ["unsuccessful handoff", terminalNotice("blocked\nArtifacts: none\nGaps: validation failed\nNext action: retry")],
  ] as const)("rejects a malformed custom atomic terminal notification: %s", (_name, notice) => {
    const message = typeof notice === "string" ? { role: "user" as const, content: notice } : notice;
    expect(() => selectSmokeModelAction(
      parentRequest(
        true,
        writeResult(),
        toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
        message,
      ),
      scenario,
      {
        ...initialState(),
        agentWriteIssued: true,
        agentWriteObserved: true,
        customDispatchIssued: true,
        stageBashIssued: true,
        venvValidated: true,
        stageCompleted: true,
      },
    )).toThrow("atomic terminal");
  });

  it("rejects custom status and handoff split across model-visible messages", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(
        true,
        writeResult(),
        toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
        { role: "user", content: "<agent_status>\nComplete subagent:smoke-reviewer_0\n</agent_status>" },
        { role: "user", content: `<agent_handoff>\nAgent: smoke-reviewer_0\nResult: ${completedStage}\n</agent_handoff>` },
      ),
      scenario,
      {
        ...initialState(),
        agentWriteIssued: true,
        agentWriteObserved: true,
        customDispatchIssued: true,
        stageBashIssued: true,
        venvValidated: true,
        stageCompleted: true,
      },
    )).toThrow("atomic terminal");
  });

  it("rejects duplicate custom terminal notifications", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(
        true,
        writeResult(),
        toolResult("call_native_reviewer", "smoke-reviewer_0 is working."),
        terminalNotice(),
        terminalNotice(),
      ),
      scenario,
      {
        ...initialState(),
        agentWriteIssued: true,
        agentWriteObserved: true,
        customDispatchIssued: true,
        stageBashIssued: true,
        venvValidated: true,
        stageCompleted: true,
      },
    )).toThrow("exactly one atomic terminal");
  });

  it("rejects model requests after terminal completion", () => {
    expect(() => selectSmokeModelAction(
      parentRequest(true),
      scenario,
      { ...initialState(), complete: true },
    )).toThrow("already complete");
  });
});
