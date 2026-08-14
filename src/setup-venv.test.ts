import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectPython, setupSkillVenv, venvPythonPath, type RunFn } from "./setup-venv";

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "not found") => ({ status: 1, stdout: "", stderr });

const tempRoots: string[] = [];
function tempVenvDir(): string {
  const root = mkdtempSync(join(tmpdir(), "setup-venv-"));
  tempRoots.push(root);
  return join(root, "venv");
}

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

describe("venvPythonPath", () => {
  it("uses Scripts layout on win32", () => {
    expect(venvPythonPath("C:\\agent\\venv", "win32").replace(/\\/g, "/")).toBe("C:/agent/venv/Scripts/python.exe");
  });
  it("uses bin layout elsewhere", () => {
    expect(venvPythonPath("/home/u/.easyresearch/agent/venv", "linux")).toBe("/home/u/.easyresearch/agent/venv/bin/python");
  });
});

describe("detectPython", () => {
  it("prefers python3 when it works", () => {
    expect(detectPython((cmd) => (cmd === "python3" ? ok("Python 3.12") : fail()))).toBe("python3");
  });
  it("falls back to python", () => {
    expect(detectPython((cmd) => (cmd === "python3" ? fail() : cmd === "python" ? ok("Python 3.12") : fail()))).toBe("python");
  });
  it("returns undefined when neither works", () => {
    expect(detectPython(() => fail())).toBeUndefined();
  });
});

describe("setupSkillVenv", () => {
  it("reports failure without throwing when python is missing", () => {
    const venvDir = tempVenvDir();
    const run: RunFn = () => fail();
    const result = setupSkillVenv({ venvDir, run, log: () => {} });
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/python/i);
  });

  it("creates venv then installs markitdown and arxiv on success", () => {
    const venvDir = tempVenvDir();
    const python = venvPythonPath(venvDir, "linux");
    const calls: string[][] = [];
    const run: RunFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "python3") return ok("Python 3.12");
      if (cmd.endsWith("python") && args[0] === "-m" && args[1] === "venv") return ok();
      if (cmd === python && args[0] === "-m" && args[1] === "pip") return ok();
      return fail();
    };
    const result = setupSkillVenv({ venvDir, run, log: () => {} });
    expect(result.success).toBe(true);
    expect(calls).toContainEqual(["python3", "--version"]);
    expect(calls).toContainEqual([python, "-m", "pip", "install", "--upgrade", "pip", "markitdown", "arxiv"]);
  });

  it("skips venv creation when venv python already exists", () => {
    const venvDir = tempVenvDir();
    const python = venvPythonPath(venvDir, "linux");
    mkdirSync(join(venvDir, "bin"), { recursive: true });
    writeFileSync(join(venvDir, "bin", "python"), "");
    const calls: string[][] = [];
    const run: RunFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === python && args[0] === "-m" && args[1] === "pip") return ok();
      return fail();
    };
    const result = setupSkillVenv({ venvDir, run, log: () => {} });
    expect(result.success).toBe(true);
    expect(calls.some((c) => c[1] === "-m" && c[2] === "venv")).toBe(false);
  });
});
