import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCompiledChildEnv,
  resolveSmokePython,
  runVenvValidation,
  selectSmokeModelAction,
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

function validationFixture(): { python: string; script: string; prefix: string; root: string } {
  const which = (name: string): string | undefined => {
    const executable = process.platform === "win32" ? `${name}.exe` : name;
    return process.env.PATH?.split(delimiter)
      .map((dir) => join(dir, executable))
      .find(existsSync);
  };
  const python = resolveSmokePython({ which, exists: existsSync });
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
});

describe("writeVenvValidationScript", () => {
  it("imports the skill packages and emits the sentinel for the expected prefix", () => {
    const fixture = validationFixture();
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

  it("rejects a Python process outside EASYRESEARCH_VENV", () => {
    const fixture = validationFixture();
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

  it("completes the parent after the subagent result", () => {
    const action = selectSmokeModelAction({
      tools: [tool("subagent")],
      messages: [{ role: "tool", content: "complete" }],
    }, "validate-command");

    expect(action).toEqual({ kind: "text", text: "Parent smoke run complete." });
  });
});
