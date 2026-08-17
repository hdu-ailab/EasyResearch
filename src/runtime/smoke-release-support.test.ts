import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FIRST_RUN_CEILING_MS,
  createCompiledChildEnv,
  readTextFileWithRetry,
  resolveSmokePython,
  runVenvValidation,
  selectSmokeModelAction,
  settleProcess,
  skillVenvPython,
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

describe("venvToolCommand", () => {
  it("uses the runtime POSIX venv interpreter", () => {
    const command = venvToolCommand("linux", "/tmp/native validate.py");
    expect(command).toContain("$EASYRESEARCH_VENV/bin/python");
    expect(command).toContain('"/tmp/native validate.py"');
    expect(command).not.toContain("/agent/venv");
  });

  it("uses the runtime Windows venv interpreter", () => {
    const command = venvToolCommand("win32", "C:\\temp\\native validate.py");
    expect(command).toContain("%EASYRESEARCH_VENV%\\Scripts\\python.exe");
    expect(command).toContain('"C:\\temp\\native validate.py"');
    expect(command).not.toContain("C:\\agent\\venv");
  });
});

describe("selectSmokeModelAction", () => {
  const tool = (name: string) => ({ function: { name } });
  const completedStage = "complete\nArtifacts: none\nGaps: none\nNext action: none";

  it("dispatches the search subagent from the parent", () => {
    const action = selectSmokeModelAction({ tools: [tool("subagent")], messages: [] }, "validate-command");

    expect(action.kind).toBe("tool");
    if (action.kind !== "tool") throw new Error("expected a tool action");
    expect(action.name).toBe("subagent");
    expect(JSON.parse(action.arguments)).toMatchObject({ agent: "search" });
  });

  it("invokes bash with the supplied command from the search stage", () => {
    const action = selectSmokeModelAction({ tools: [tool("bash")], messages: [] }, "validate-command");

    expect(action).toEqual({
      kind: "tool",
      id: "call_native_venv",
      name: "bash",
      arguments: JSON.stringify({ command: "validate-command", timeout: 60 }),
    });
  });

  it("completes the search stage after bash returns the sentinel", () => {
    const action = selectSmokeModelAction({
      tools: [tool("bash")],
      messages: [{ role: "tool", content: "easyresearch-venv-ok\n" }],
    }, "validate-command");

    expect(action.kind).toBe("text");
    if (action.kind !== "text") throw new Error("expected a text action");
    expect(action.text).toContain("complete");
  });

  it("hard-fails the search stage when bash omits the sentinel", () => {
    expect(() => selectSmokeModelAction({
      tools: [tool("bash")],
      messages: [{ role: "tool", content: "wrong interpreter" }],
    }, "validate-command")).toThrow("easyresearch-venv-ok");
  });

  it("hard-fails the search stage for a near-match sentinel line", () => {
    expect(() => selectSmokeModelAction({
      tools: [tool("bash")],
      messages: [{ role: "tool", content: "easyresearch-venv-ok-invalid" }],
    }, "validate-command")).toThrow("easyresearch-venv-ok");
  });

  it("completes the parent after the subagent result", () => {
    const action = selectSmokeModelAction({
      tools: [tool("subagent")],
      messages: [{
        role: "tool",
        content: `${completedStage}\n\nSession history JSONL: /sessions/search.jsonl`,
      }],
    }, "validate-command");

    expect(action).toEqual({ kind: "text", text: "Parent smoke run complete." });
  });

  it.each([
    "blocked\nArtifacts: none\nGaps: validation failed\nNext action: retry",
    "Agent error: search stage failed",
    "complete-invalid\nArtifacts: none\nGaps: none\nNext action: none",
  ])("fails closed for an unsuccessful subagent result: %s", (content) => {
    expect(() => selectSmokeModelAction({
      tools: [tool("subagent")],
      messages: [{ role: "tool", content }],
    }, "validate-command")).toThrow("successful deterministic handoff");
  });
});
