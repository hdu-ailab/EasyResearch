import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("repairs a failed interpreter without deleting the previous venv's files", () => {
    const venvDir = tempVenvDir();
    const python = venvPythonPath(venvDir);
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(join(venvDir, "pyvenv.cfg"), "home = /old-python\n");
    writeFileSync(python, "broken interpreter");
    writeFileSync(join(venvDir, "user-notes.txt"), "keep these bytes");
    let repaired = false;
    const calls: string[][] = [];
    const run: RunFn = (command, args) => {
      calls.push([command, ...args]);
      if (command === python) return repaired ? ok() : fail("interpreter cannot start");
      if (args.includes("venv")) {
        repaired = true;
        return ok();
      }
      return ok("Python 3.12");
    };
    expect(setupSkillVenv({ venvDir, run, log: () => {} }).success).toBe(true);
    expect(calls.some((args) => args.includes("--clear"))).toBe(false);
    const backup = readdirSync(dirname(venvDir)).find((name) => name.startsWith("venv.repair-"));
    expect(backup).toBeDefined();
    expect(readFileSync(join(dirname(venvDir), backup!, "venv", "user-notes.txt"), "utf8")).toBe("keep these bytes");
    expect(readFileSync(join(dirname(venvDir), backup!, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), "utf8")).toBe("broken interpreter");
  });

  it("does not mutate an unrecognized existing directory while trying to repair it", () => {
    const venvDir = tempVenvDir();
    mkdirSync(venvDir);
    writeFileSync(join(venvDir, "notes.txt"), "not a venv");
    const run = vi.fn(() => ok());
    const result = setupSkillVenv({ venvDir, run, log: () => {} });
    expect(result.success).toBe(false);
    expect(result.reason).toMatch(/pyvenv.cfg/);
    expect(run).not.toHaveBeenCalled();
    expect(readFileSync(join(venvDir, "notes.txt"), "utf8")).toBe("not a venv");
  });

  it("reports ensurepip failure without attempting package installation or replacing a working interpreter", () => {
    const venvDir = tempVenvDir();
    const python = venvPythonPath(venvDir);
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(join(venvDir, "pyvenv.cfg"), "home = /python\n");
    writeFileSync(python, "interpreter fixture");
    const calls: string[][] = [];
    const run: RunFn = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "--version") return ok("Python 3.12");
      if (args[1] === "ensurepip") return fail("ensurepip unavailable");
      return fail("No module named pip");
    };
    const result = setupSkillVenv({ venvDir, run, log: () => {} });
    expect(result).toMatchObject({ success: false, reason: expect.stringContaining("ensurepip unavailable") });
    expect(calls.some((args) => args.includes("install") || args.includes("venv"))).toBe(false);
    expect(readFileSync(python, "utf8")).toBe("interpreter fixture");
  });

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
    writeFileSync(join(venvDir, "pyvenv.cfg"), "home = /python\n");
    const calls: string[][] = [];
    const run: RunFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === python && (args[0] === "--version" || (args[0] === "-m" && args[1] === "pip"))) return ok();
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

  it("reports an archive failure without discarding the broken venv and retries on the next launch", async () => {
    const agentDir = tempAgentDir();
    const venvDir = join(agentDir, "venv");
    const python = venvPythonPath(venvDir);
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(join(venvDir, "pyvenv.cfg"), "home = /old-python\n");
    writeFileSync(python, "broken interpreter");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let obstructed = true;
    vi.doMock("node:fs", () => ({
      ...fs,
      mkdtempSync: (prefix: string) => {
        if (obstructed) throw new Error("archive denied");
        return fs.mkdtempSync(prefix);
      },
    }));
    vi.resetModules();
    try {
      const { ensureSkillVenv } = await import("./setup-venv");
      let repaired = false;
      const run: RunFn = (command, args) => {
        if (command === python) return repaired ? ok() : fail("interpreter cannot start");
        if (args.includes("venv")) repaired = true;
        return ok();
      };
      const first = ensureSkillVenv(agentDir, { run });
      expect(first).toMatchObject({ success: false, reason: "archive denied" });
      expect(readFileSync(python, "utf8")).toBe("broken interpreter");
      obstructed = false;
      expect(ensureSkillVenv(agentDir, { run }).success).toBe(true);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });

  it("does not reuse an interpreter from an owned incomplete directory without pyvenv.cfg", () => {
    const agentDir = tempAgentDir();
    const venvDir = join(agentDir, "venv");
    const python = venvPythonPath(venvDir);
    let creates = 0;
    const run: RunFn = (_command, args) => {
      if (args.includes("venv")) {
        creates += 1;
        mkdirSync(dirname(python), { recursive: true });
        writeFileSync(python, "interpreter that would resolve outside a venv");
        if (creates === 1) return fail("interrupted before config");
        writeFileSync(join(venvDir, "pyvenv.cfg"), "home = /python\n");
      }
      return ok();
    };
    expect(ensureSkillVenv(agentDir, { run }).success).toBe(false);
    expect(ensureSkillVenv(agentDir, { run }).success).toBe(true);
    expect(creates).toBe(2);
    expect(existsSync(join(venvDir, "pyvenv.cfg"))).toBe(true);
  });

  it("keeps an unusable pip rebuild retryable without installing or repeatedly replacing it in one startup", () => {
    const agentDir = tempAgentDir();
    const venvDir = join(agentDir, "venv");
    const python = venvPythonPath(venvDir);
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(join(venvDir, "pyvenv.cfg"), "home = /python\n");
    writeFileSync(python, "interpreter fixture");
    writeFileSync(join(venvDir, "notes.txt"), "original user notes");
    let creates = 0;
    let installs = 0;
    const run: RunFn = (_command, args) => {
      if (args.includes("venv")) {
        creates += 1;
        mkdirSync(dirname(python), { recursive: true });
        writeFileSync(join(venvDir, "pyvenv.cfg"), "home = /python\n");
        writeFileSync(python, "rebuilt interpreter fixture");
        writeFileSync(join(venvDir, "notes.txt"), "notes from incomplete creation");
        return ok();
      }
      if (args.includes("install")) installs += 1;
      if (args[0] === "-c" || args[1] === "pip") return creates >= 2 ? ok() : fail("No module named pip");
      return ok();
    };
    expect(ensureSkillVenv(agentDir, { run }).success).toBe(false);
    expect(installs).toBe(0);
    expect(creates).toBe(1);
    expect(existsSync(join(venvDir, ".easyresearch-venv-creation"))).toBe(true);
    const backup = readdirSync(agentDir).find((name) => name.startsWith("venv.repair-"))!;
    expect(readFileSync(join(agentDir, backup, "venv", "notes.txt"), "utf8")).toBe("original user notes");
    expect(ensureSkillVenv(agentDir, { run }).success).toBe(true);
    expect(creates).toBe(2);
    expect(installs).toBe(1);
    expect(existsSync(join(venvDir, ".easyresearch-venv-creation"))).toBe(false);
    expect(readFileSync(join(agentDir, backup, "venv", "notes.txt"), "utf8")).toBe("original user notes");
    const partialBackup = readdirSync(agentDir).find((name) => name.startsWith("venv.repair-") && name !== backup)!;
    expect(readFileSync(join(agentDir, partialBackup, "venv", "notes.txt"), "utf8")).toBe("notes from incomplete creation");
  });

  it("does not adopt a replacement directory carrying a copied creation marker", () => {
    const agentDir = tempAgentDir();
    const venvDir = join(agentDir, "venv");
    const displaced = join(agentDir, "displaced-owned-venv");
    const run: RunFn = (_command, args) => {
      if (args.includes("venv")) {
        renameSync(venvDir, displaced);
        mkdirSync(venvDir);
        writeFileSync(join(venvDir, ".easyresearch-venv-creation"), readFileSync(join(displaced, ".easyresearch-venv-creation")));
        writeFileSync(join(venvDir, "notes.txt"), "unrelated user data");
        return fail("interrupted and replaced");
      }
      return ok();
    };
    expect(ensureSkillVenv(agentDir, { run }).success).toBe(false);
    const retry = vi.fn(() => ok());
    expect(ensureSkillVenv(agentDir, { run: retry }).success).toBe(false);
    expect(retry).not.toHaveBeenCalled();
    expect(readFileSync(join(venvDir, "notes.txt"), "utf8")).toBe("unrelated user data");
    expect(existsSync(displaced)).toBe(true);
  });

  it("recovers an owned creation interrupted before pyvenv.cfg across module reload without losing old or new files", async (context) => {
    const agentDir = tempAgentDir();
    const env = {
      PATH: process.env.PATH, HOME: agentDir, USERPROFILE: agentDir, SystemRoot: process.env.SystemRoot,
      TMPDIR: agentDir, TMP: agentDir, TEMP: agentDir,
    };
    const runLocal: RunFn = (command, args) => {
      const result = spawnSync(command, args, { env, cwd: agentDir, encoding: "utf8", timeout: 30_000 });
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
    };
    if (!detectPython(runLocal)) {
      context.skip("Python is unavailable; native release smoke still requires CPython");
      return;
    }
    const venvDir = join(agentDir, "venv");
    const python = venvPythonPath(venvDir);
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(join(venvDir, "pyvenv.cfg"), "home = /old-python\n");
    writeFileSync(python, "broken interpreter");
    writeFileSync(join(venvDir, "old-notes.txt"), "old user data");
    const interrupted: RunFn = (command, args) => {
      if (command === python) return fail("broken interpreter");
      if (args.includes("venv")) {
        mkdirSync(venvDir, { recursive: true });
        writeFileSync(join(venvDir, "new-notes.txt"), "new user data after creation started");
        return fail("interrupted before pyvenv.cfg");
      }
      return ok("Python 3.12");
    };
    expect(ensureSkillVenv(agentDir, { run: interrupted }).success).toBe(false);
    expect(existsSync(join(venvDir, "pyvenv.cfg"))).toBe(false);
    const originalBackup = readdirSync(agentDir).find((name) => name.startsWith("venv.repair-"))!;
    vi.resetModules();
    try {
      const reloaded = await import("./setup-venv");
      const result = reloaded.ensureSkillVenv(agentDir, {
        packages: [{ distribution: "pip", imports: ["pip"] }],
        run: (command, args) => runLocal(command, args[1] === "pip" && args[2] === "install" ? ["-m", "pip", "--version"] : args),
      });
      expect(result.success, result.reason).toBe(true);
      expect(readFileSync(join(agentDir, originalBackup, "venv", "old-notes.txt"), "utf8")).toBe("old user data");
      const partialBackup = readdirSync(agentDir).find((name) => name.startsWith("venv.repair-") && name !== originalBackup)!;
      expect(readFileSync(join(agentDir, partialBackup, "venv", "new-notes.txt"), "utf8")).toBe("new user data after creation started");
      const pip = join(venvDir, process.platform === "win32" ? "Scripts/pip.exe" : "bin/pip");
      const launcher = runLocal(pip, ["--version"]);
      expect(launcher.status, launcher.stderr).toBe(0);
      expect(launcher.stdout).toContain(venvDir);
    } finally {
      vi.resetModules();
    }
  });

  it.for([["pip", false], ["json", false], ["pip", true]] as const)("repairs a real interrupted venv with %s imports (broken interpreter=%s) and reuses it", ([module, broken], context) => {
    const agentDir = tempAgentDir();
    const env = {
      PATH: process.env.PATH, HOME: agentDir, USERPROFILE: agentDir, SystemRoot: process.env.SystemRoot,
      TMPDIR: agentDir, TMP: agentDir, TEMP: agentDir,
    };
    const runLocal: RunFn = (command, args) => {
      const result = spawnSync(command, args, { env, cwd: agentDir, encoding: "utf8", timeout: 30_000 });
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
    };
    const detected = detectPython(runLocal);
    if (!detected) {
      context.skip("Python is unavailable; native release smoke still requires CPython");
      return;
    }
    const venv = join(agentDir, "venv");
    const created = runLocal(detected.command, [...detected.prefixArgs, "-m", "venv", "--without-pip", venv]);
    expect(created.status, created.stderr).toBe(0);
    writeFileSync(join(venv, "notes.txt"), "retain user notes");
    if (broken) {
      // Unlink the venv entry first: never overwrite a symlink to the system Python.
      const python = venvPythonPath(venv);
      rmSync(python);
      writeFileSync(python, "broken interpreter");
    }
    const calls: string[][] = [];
    const run: RunFn = (command, args) => {
      calls.push([command, ...args]);
      // Exercise all real local recovery commands, but never contact a package index.
      return runLocal(command, args[1] === "pip" && args[2] === "install" ? ["-m", "pip", "--version"] : args);
    };
    const options = { run, packages: [{ distribution: "pip", imports: [module] as [string] }] };
    const first = ensureSkillVenv(agentDir, options);
    expect(first.success, first.reason).toBe(true);
    if (broken) {
      const backup = readdirSync(agentDir).find((name) => name.startsWith("venv.repair-"));
      expect(backup).toBeDefined();
      expect(readFileSync(join(agentDir, backup!, "venv", "notes.txt"), "utf8")).toBe("retain user notes");
    } else {
      expect(calls.some((args) => args.includes("ensurepip"))).toBe(true);
      expect(readFileSync(join(venv, "notes.txt"), "utf8")).toBe("retain user notes");
    }
    calls.length = 0;
    expect(ensureSkillVenv(agentDir, options).success).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([command]) => command === venvPythonPath(venv))).toBe(true);
    expect(calls.some((args) => args.includes("install") || args.includes("venv") || args.includes("ensurepip"))).toBe(false);
    expect(existsSync(join(venv, "pyvenv.cfg"))).toBe(true);
  });

  it.for(["stale metadata", "no metadata", "corrupt_internal", "corrupt_main", "missing_required", "healthy"] as const)("keeps real CPython 3.12 pip usable across two startups (%s)", { timeout: 60_000 }, (state, context) => {
    const agentDir = tempAgentDir();
    const env = {
      PATH: process.env.PATH, HOME: agentDir, USERPROFILE: agentDir, SystemRoot: process.env.SystemRoot,
      TMPDIR: agentDir, TMP: agentDir, TEMP: agentDir, PYTHONDONTWRITEBYTECODE: "1",
      PIP_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null", PIP_NO_INDEX: "1",
    };
    const runLocal: RunFn = (command, args) => {
      const result = spawnSync(command, args, { env, cwd: agentDir, encoding: "utf8", timeout: 30_000 });
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
    };
    const detected = detectPython(runLocal);
    if (!detected || runLocal(detected.command, [...detected.prefixArgs, "-c",
      "import sys; assert sys.implementation.name == 'cpython' and sys.version_info[:2] == (3, 12)",
    ]).status !== 0) {
      context.skip("CPython 3.12 is unavailable on PATH");
      return;
    }
    const venvDir = join(agentDir, "venv");
    const python = venvPythonPath(venvDir);
    const created = runLocal(detected.command, [...detected.prefixArgs, "-m", "venv", venvDir]);
    expect(created.status, created.stderr).toBe(0);
    const site = runLocal(python, ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"]);
    expect(site.status, site.stderr).toBe(0);
    const sitePackages = site.stdout.trim();
    expect(sitePackages.startsWith(`${venvDir}${sep}`)).toBe(true);
    const metadata = readdirSync(sitePackages).filter((name) => name.startsWith("pip-") && name.endsWith(".dist-info"));
    expect(metadata).not.toHaveLength(0);
    writeFileSync(join(venvDir, "notes.txt"), "retain user notes");
    const requiredPackage = join(sitePackages, "required_package.py");
    if (state !== "missing_required") writeFileSync(requiredPackage, "value = 42\n");
    if (state !== "healthy" && state !== "missing_required") {
      const missing = state === "corrupt_internal" ? "pip/_internal"
        : state === "corrupt_main" ? "pip/__main__.py" : "pip";
      renameSync(join(sitePackages, missing), join(agentDir, "saved-pip"));
      if (state === "no metadata") {
        for (const name of metadata) rmSync(join(sitePackages, name), { recursive: true });
      } else {
        const bootstrap = runLocal(python, ["-m", "ensurepip", "--upgrade"]);
        expect(bootstrap.status, bootstrap.stderr).toBe(0);
        expect(runLocal(python, ["-m", "pip", "--version"]).status).not.toBe(0);
      }
      const imports = runLocal(python, ["-c", "import pip"]);
      if (state === "corrupt_internal" || state === "corrupt_main") expect(imports.status, imports.stderr).toBe(0);
      else expect(imports.status).not.toBe(0);
    } else if (state === "missing_required") {
      expect(runLocal(python, ["-m", "pip", "--version"]).status).toBe(0);
      expect(runLocal(python, ["-c", "import required_package"]).status).not.toBe(0);
    }
    const calls: string[][] = [];
    const options = {
      packages: [{ distribution: "fixture-dist", imports: ["required_package"] as [string] }],
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (args[1] === "pip" && args[2] === "install") {
          // Only substitute package installation; bootstrap, rebuild, and health checks are real.
          expect(args).toContain("fixture-dist");
          const result = runLocal(command, ["-m", "pip", "--version"]);
          if (result.status === 0) writeFileSync(requiredPackage, "value = 42\n");
          return result;
        }
        return runLocal(command, args);
      },
    };
    const first = ensureSkillVenv(agentDir, options);
    const firstImport = runLocal(python, ["-c", "import pip, pip._internal, required_package"]);
    const firstCli = runLocal(python, ["-m", "pip", "--version"]);
    const firstCalls = calls.splice(0);
    const second = ensureSkillVenv(agentDir, options);
    const secondImport = runLocal(python, ["-c", "import pip, pip._internal, required_package"]);
    const secondCli = runLocal(python, ["-m", "pip", "--version"]);
    expect([first.success, second.success], JSON.stringify([first, second])).toEqual([true, true]);
    expect([firstCli.status, secondCli.status], JSON.stringify([firstCli, secondCli])).toEqual([0, 0]);
    expect(firstImport.status, firstImport.stderr).toBe(0);
    expect(secondImport.status, secondImport.stderr).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([command]) => command === python)).toBe(true);
    expect(calls.some((args) => args.includes("install") || args.includes("venv") || args.includes("ensurepip"))).toBe(false);
    const backups = readdirSync(agentDir).filter((name) => name.startsWith("venv.repair-"));
    if (state === "stale metadata" || state === "corrupt_internal" || state === "corrupt_main") {
      expect(backups).toHaveLength(1);
      const backup = join(agentDir, backups[0]!, "venv");
      expect(readFileSync(join(backup, "notes.txt"), "utf8")).toBe("retain user notes");
      for (const name of metadata) {
        expect(existsSync(join(backup, sitePackages.slice(venvDir.length), name))).toBe(true);
      }
    } else {
      expect(backups).toHaveLength(0);
      expect(readFileSync(join(venvDir, "notes.txt"), "utf8")).toBe("retain user notes");
      if (state === "healthy") expect(firstCalls).toEqual(calls);
      else if (state === "missing_required") expect(firstCalls.some((args) => args.includes("install"))).toBe(true);
      else expect(firstCalls.some((args) => args.includes("ensurepip"))).toBe(true);
    }
    expect(firstCli.stdout).toContain(venvDir);
    expect(secondCli.stdout).toContain(venvDir);
  });

  it("streams setup output without passing the host lifecycle stdin to Python", async () => {
    const actualChildProcess = await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
    const spawn = vi.fn(() => ({ status: 0, stdout: null, stderr: null }));
    vi.doMock("node:child_process", () => ({
      ...actualChildProcess,
      spawnSync: spawn,
    }));
    vi.resetModules();
    try {
      const setupVenv = await import("./setup-venv");
      const agentDir = tempAgentDir();
      const python = setupVenv.venvPythonPath(join(agentDir, "venv"));
      mkdirSync(dirname(python), { recursive: true });
      writeFileSync(python, "fake", "utf8");
      writeFileSync(join(agentDir, "venv", "pyvenv.cfg"), "home = /python\n");

      expect(setupVenv.ensureSkillVenv(agentDir, { stream: true }).success).toBe(true);
      expect(spawn).toHaveBeenCalledWith(
        python,
        expect.any(Array),
        {
          stdio: ["ignore", "inherit", "inherit"],
          timeout: expect.any(Number),
        },
      );
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("reuses an existing healthy venv without reinstalling", () => {
    const agentDir = tempAgentDir();
    const python = venvPythonPath(join(agentDir, "venv"));
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "fake", "utf8");
    writeFileSync(join(agentDir, "venv", "pyvenv.cfg"), "home = /python\n");
    let mutations = 0;
    const run = fakeRun((command, args) => {
      expect(command).toBe(python);
      if (args.includes("install") || args.includes("venv") || args.includes("ensurepip")) mutations += 1;
      return 0;
    });
    const result = ensureSkillVenv(agentDir, { run, log: () => {} });
    expect(result.success).toBe(true);
    expect(mutations).toBe(0);
  });

  it("reinstalls packages when the venv exists but imports fail", () => {
    const agentDir = tempAgentDir();
    const python = venvPythonPath(join(agentDir, "venv"));
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "fake", "utf8");
    writeFileSync(join(agentDir, "venv", "pyvenv.cfg"), "home = /python\n");
    let installs = 0;
    const run = fakeRun((command, args) => {
      if (args[0] === "-c") return 1;
      if (args[0] === "-m" && args[1] === "pip" && args[2] === "install") installs += 1;
      return 0;
    });
    const result = ensureSkillVenv(agentDir, { run, log: () => {} });
    expect(result.success).toBe(true);
    expect(installs).toBeGreaterThan(0);
  });

  it("installs every declared distribution after an import failure", () => {
    const agentDir = tempAgentDir();
    const python = venvPythonPath(join(agentDir, "venv"));
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "fake", "utf8");
    writeFileSync(join(agentDir, "venv", "pyvenv.cfg"), "home = /python\n");
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
      if (args[0] === "-m" && args[1] === "pip") return 0;
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
