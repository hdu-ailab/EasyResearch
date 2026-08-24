import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectPython,
  ensureSkillVenv,
  setupSkillVenv,
  SKILL_VENV_PACKAGES,
  venvPythonPath,
  type RunFn,
} from "./setup-venv";

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
    expect(detectPython((cmd) => (cmd === "python3" ? ok("Python 3.12") : fail()), "linux"))
      .toEqual({ command: "python3", prefixArgs: [] });
  });
  it("falls back to python", () => {
    expect(detectPython((cmd) => (cmd === "python" ? ok("Python 3.12") : fail()), "linux"))
      .toEqual({ command: "python", prefixArgs: [] });
  });
  it("prefers the native Windows py launcher with an explicit Python 3 selector", () => {
    const calls: string[][] = [];
    const detected = detectPython((command, args) => {
      calls.push([command, ...args]);
      return command === "py" ? ok("Python 3.12") : fail();
    }, "win32");
    expect(detected).toEqual({ command: "py", prefixArgs: ["-3"] });
    expect(calls[0]).toEqual(["py", "-3", "--version"]);
  });
  it("returns undefined when neither works", () => {
    expect(detectPython(() => fail(), "linux")).toBeUndefined();
  });
});

it("uses the fresh default venv only for conversion and arXiv", () => {
  expect(SKILL_VENV_PACKAGES).toEqual([
    { distribution: "markitdown", imports: ["markitdown"] },
    { distribution: "arxiv", imports: ["arxiv"] },
  ]);
});

describe("setupSkillVenv", () => {
  it("reports failure without throwing when python is missing", () => {
    const venvDir = tempVenvDir();
    const run: RunFn = () => fail();
    const result = setupSkillVenv({ venvDir, run, log: () => {}, platform: "linux" });
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/python/i);
  });

  it("creates venv then installs venv packages on success", () => {
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
    const result = setupSkillVenv({ venvDir, run, log: () => {}, platform: "linux" });
    expect(result.success).toBe(true);
    expect(calls).toContainEqual(["python3", "--version"]);
    expect(calls).toContainEqual([
      python,
      "-m",
      "pip",
      "install",
      "--upgrade",
      "pip",
      ...SKILL_VENV_PACKAGES.map((pkg) => pkg.distribution),
    ]);
  });

  it("creates a Windows venv through py -3", () => {
    const venvDir = tempVenvDir();
    const python = venvPythonPath(venvDir, "win32");
    const calls: string[][] = [];
    const run: RunFn = (command, args) => {
      calls.push([command, ...args]);
      if (command === "py" && args.join(" ") === "-3 --version") return ok("Python 3.12");
      if (command === "py" && args[0] === "-3" && args[1] === "-m" && args[2] === "venv") return ok();
      if (command === python && args[0] === "-m" && args[1] === "pip") return ok();
      return fail();
    };
    const result = setupSkillVenv({ venvDir, run, log: () => {}, platform: "win32" });
    expect(result.success).toBe(true);
    expect(calls).toContainEqual(["py", "-3", "-m", "venv", venvDir]);
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
    const result = setupSkillVenv({ venvDir, run, log: () => {}, platform: "linux" });
    expect(result.success).toBe(true);
    expect(calls.some((c) => c[1] === "-m" && c[2] === "venv")).toBe(false);
  });
});

describe("ensureSkillVenv", () => {
  function tempAgentDir(): string {
    const root = mkdtempSync(join(tmpdir(), "ensure-venv-"));
    tempRoots.push(root);
    return root;
  }

  function fakeRun(script: (command: string, args: string[]) => number) {
    return (command: string, args: string[]): { status: number; stdout: string; stderr: string } => ({
      status: script(command, args),
      stdout: "",
      stderr: "",
    });
  }

  it("reuses an existing healthy venv without reinstalling", () => {
    const agentDir = tempAgentDir();
    const python = venvPythonPath(join(agentDir, "venv"));
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "fake", "utf8");
    let pipCalls = 0;
    const run = fakeRun((command, args) => {
      if (args[0] === "-c") return 0;
      if (args[0] === "-m" && args[1] === "pip") pipCalls += 1;
      return 0;
    });
    const result = ensureSkillVenv(agentDir, { run, log: () => {} });
    expect(result.success).toBe(true);
    expect(pipCalls).toBe(0);
  });

  it("reinstalls packages when the venv exists but imports fail", () => {
    const agentDir = tempAgentDir();
    const python = venvPythonPath(join(agentDir, "venv"));
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "fake", "utf8");
    let pipCalls = 0;
    const run = fakeRun((command, args) => {
      if (args[0] === "-c") return 1;
      if (args[0] === "-m" && args[1] === "pip") pipCalls += 1;
      return 0;
    });
    const result = ensureSkillVenv(agentDir, { run, log: () => {} });
    expect(result.success).toBe(true);
    expect(pipCalls).toBeGreaterThan(0);
  });

  it("uses one dependency declaration for health checks and installation", () => {
    const agentDir = tempAgentDir();
    const python = venvPythonPath(join(agentDir, "venv"));
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "fake", "utf8");
    const calls: string[][] = [];
    const logs: string[] = [];
    const run: RunFn = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "-c") return fail("missing future_module");
      return ok();
    };

    const result = ensureSkillVenv(agentDir, {
      run,
      log: (message) => logs.push(message),
      packages: [
        { distribution: "future-dist", imports: ["future_module", "future_support"] },
        { distribution: "other-dist", imports: ["other_module"] },
      ],
    });

    expect(result.success).toBe(true);
    expect(calls).toContainEqual([
      python,
      "-c",
      "import future_module, future_support, other_module",
    ]);
    expect(calls).toContainEqual([
      python,
      "-m",
      "pip",
      "install",
      "--upgrade",
      "pip",
      "future-dist",
      "other-dist",
    ]);
    expect(logs.join("\n")).toContain("reinstalling future-dist + other-dist");
  });

  it("reports a recovery command for every declared dependency", () => {
    const agentDir = tempAgentDir();
    const logs: string[] = [];

    const result = ensureSkillVenv(agentDir, {
      run: () => fail("python unavailable"),
      log: (message) => logs.push(message),
      packages: [
        { distribution: "future-dist", imports: ["future_module"] },
        { distribution: "other-dist", imports: ["other_module"] },
      ],
    });

    expect(result.success).toBe(false);
    expect(logs.join("\n")).toContain("pip install future-dist other-dist");
  });

  it("creates a fresh venv when missing", () => {
    const agentDir = tempAgentDir();
    const run = fakeRun((command, args) => {
      if (command === "python3") return 0;
      if (args.join(" ") === "-m venv " + join(agentDir, "venv")) return 0;
      if (args.join(" ").includes("-m pip install")) return 0;
      return 1;
    });
    const result = ensureSkillVenv(agentDir, { run, log: () => {} });
    expect(result.success).toBe(true);
    expect(result.venvDir).toBe(join(agentDir, "venv"));
  });

  it("never throws on failure, returns success false", () => {
    const agentDir = tempAgentDir();
    const run = fakeRun(() => 1);
    const result = ensureSkillVenv(agentDir, { run, log: () => {} });
    expect(result.success).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
