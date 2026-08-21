import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPowerShellScript,
  createPowerShellOperations,
  createWindowsPowerShellExtension,
  resolveWindowsShellFromEnv,
  resolvePowerShellExecutable,
} from "./index";

afterEach(() => vi.useRealTimers());

describe("native Windows PowerShell resolution", () => {
  it("prefers pwsh from PATH", () => {
    expect(resolvePowerShellExecutable({
      env: { SystemRoot: "C:\\Windows" },
      locateOnPath: () => "D:\\PowerShell\\pwsh.exe",
      exists: () => true,
    })).toBe("D:\\PowerShell\\pwsh.exe");
  });

  it("falls back to in-box Windows PowerShell without considering bash or WSL", () => {
    expect(resolvePowerShellExecutable({
      env: { SystemRoot: "D:\\Windows" },
      locateOnPath: () => undefined,
      exists: (path) => path === "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    })).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });
});

describe("Windows shell detection", () => {
  it("labels PowerShell 7 from module path", () => {
    const info = resolveWindowsShellFromEnv({
      env: {
        PSModulePath: "C:\\Users\\Test\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\7\\Modules",
      },
    });
    expect(info.kind).toBe("powershell7");
    expect(info.displayName).toBe("PowerShell 7");
  });

  it("labels Windows PowerShell 5.1 from module path", () => {
    const info = resolveWindowsShellFromEnv({
      env: {
        PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules",
      },
    });
    expect(info.kind).toBe("powershell5.1");
    expect(info.displayName).toBe("Windows PowerShell 5.1");
  });

  it("labels Git Bash from MSYSTEM", () => {
    const info = resolveWindowsShellFromEnv({
      env: {
        MSYSTEM: "MINGW64",
        SHELL: "C:/Program Files/Git/usr/bin/bash.exe",
      },
    });
    expect(info.kind).toBe("gitbash");
    expect(info.displayName).toBe("Git Bash");
  });

  it("classifies Git Bash install path", () => {
    const info = resolveWindowsShellFromEnv({
      env: {
        SHELL: "C:\\Program Files\\Git\\bin\\bash.exe",
      },
    });
    expect(info.kind).toBe("gitbash");
    expect(info.displayName).toBe("Git Bash");
  });

  it("classifies Cygwin or MSYS bash as Other Bash", () => {
    const info = resolveWindowsShellFromEnv({
      env: {
        SHELL: "C:/tools/cygwin64/bin/bash.exe",
      },
    });
    expect(info.kind).toBe("other-bash");
    expect(info.displayName).toBe("Other Bash");
  });

  it("labels PowerShell 7 from SHELL path", () => {
    const info = resolveWindowsShellFromEnv({
      env: {
        SHELL: "C:/Program Files/PowerShell/7/pwsh.exe",
      },
    });
    expect(info.kind).toBe("powershell7");
    expect(info.displayName).toBe("PowerShell 7");
  });

  it("labels other Bash launchers", () => {
    const info = resolveWindowsShellFromEnv({
      env: {
        SHELL: "C:/Windows/System32/bash.exe",
      },
    });
    expect(info.kind).toBe("other-bash");
    expect(info.displayName).toBe("Other Bash");
  });

  it("falls back to other shell", () => {
    const info = resolveWindowsShellFromEnv({
      exists: () => false,
      locateOnPath: () => undefined,
      env: {},
    });
    expect(info.kind).toBe("other-shell");
    expect(info.displayName).toBe("Other shell");
  });

  it("classifies Program Files Git Bash as Git Bash", () => {
    const info = resolveWindowsShellFromEnv({
      locateOnPath: () => undefined,
      env: {
        ProgramFiles: "C:/Program Files",
      },
      exists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
    });
    expect(info.kind).toBe("gitbash");
    expect(info.displayName).toBe("Git Bash");
  });

  it("falls back to other Bash from PATH", () => {
    const info = resolveWindowsShellFromEnv({
      env: {
        SHELL: "",
      },
      exists: (path) => path === "C:/PortableTools/bash.exe",
      locateOnPath: () => "C:/PortableTools/bash.exe",
    });
    expect(info.kind).toBe("other-bash");
    expect(info.displayName).toBe("Other Bash");
  });
});

describe("PowerShell command transport", () => {
  it("uses UTF-8 and preserves the command as stdin script content", () => {
    const command = "Get-ChildItem -LiteralPath 'C:\\论文 & data'";
    const script = buildPowerShellScript(command);
    expect(script).toContain("[Console]::OutputEncoding");
    const encoded = script.match(/FromBase64String\('([^']+)'\)/u)?.[1];
    const decoded = Buffer.from(encoded ?? "", "base64").toString("utf16le");
    expect(decoded).toBe([
      command,
      "",
      "$easyresearchCommandSucceeded = $?",
      "$easyresearchNativeExit = $global:LASTEXITCODE",
      "if ($easyresearchCommandSucceeded) { exit 0 }",
      "if ($null -ne $easyresearchNativeExit -and $easyresearchNativeExit -ne 0) { exit $easyresearchNativeExit }",
      "exit 1",
      "",
    ].join("\r\n"));
    expect(script).not.toContain(command);
    expect(script).toContain([
      "& $easyresearchScript",
      "$easyresearchCommandSucceeded = $?",
      "$easyresearchNativeExit = $global:LASTEXITCODE",
      "if ($easyresearchCommandSucceeded) { exit 0 }",
    ].join("\r\n"));
    expect(script).not.toContain("wsl.exe");
    expect(script).not.toContain("bash.exe");
  });

  it("spawns hidden non-interactive PowerShell and streams output", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const spawnProcess = vi.fn(() => child as never);
    const chunks: string[] = [];
    const execution = createPowerShellOperations({
      executable: "C:\\Windows\\powershell.exe",
      spawnProcess: spawnProcess as never,
      killTree: vi.fn(),
    }).exec("Get-Location", "C:\\paper", {
      onData: (chunk) => chunks.push(chunk.toString("utf8")),
      env: { EASYRESEARCH_VENV: "C:\\venv" },
    });

    child.stdout.write("native-output");
    child.emit("close", 0);
    await expect(execution).resolves.toEqual({ exitCode: 0 });
    expect(chunks).toEqual(["native-output"]);
    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\Windows\\powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command", "-"]),
      expect.objectContaining({ cwd: "C:\\paper", windowsHide: true, detached: false }),
    );
  });

  it("settles after inherited output pipes become idle without waiting for close", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const chunks: Buffer[] = [];
    const execution = createPowerShellOperations({
      executable: "C:\\Windows\\powershell.exe",
      spawnProcess: vi.fn(() => child as never) as never,
      killTree: vi.fn(),
    }).exec("Get-Location", "C:\\paper", {
      onData: (chunk) => chunks.push(chunk),
      env: {},
    });
    let settled: { exitCode: number | null } | undefined;
    void execution.then((result) => {
      settled = result;
    });

    child.stdout.write("head");
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(75);
    child.stdout.write("|stdout-tail");
    await vi.advanceTimersByTimeAsync(75);
    child.stderr.write("|stderr-tail");
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const settledWithoutClose = settled;

    if (!settledWithoutClose) child.emit("close", 0);
    await execution;
    vi.useRealTimers();

    expect(settledWithoutClose).toEqual({ exitCode: 0 });
    expect(Buffer.concat(chunks).toString("utf8")).toBe("head|stdout-tail|stderr-tail");
  });

  it("kills the process tree and reports abort after exit even without close", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const killTree = vi.fn();
    const controller = new AbortController();
    const execution = createPowerShellOperations({
      executable: "C:\\Windows\\powershell.exe",
      spawnProcess: vi.fn(() => child as never) as never,
      killTree,
    }).exec("Get-Location", "C:\\paper", {
      onData: () => {},
      env: {},
      signal: controller.signal,
    });
    const rejected = expect(execution).rejects.toThrow("aborted");

    controller.abort();
    expect(killTree).toHaveBeenCalledWith(4321);
    child.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    vi.useRealTimers();
  });

  it("kills the process tree and reports timeout after exit even without close", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 4321,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const killTree = vi.fn();
    const execution = createPowerShellOperations({
      executable: "C:\\Windows\\powershell.exe",
      spawnProcess: vi.fn(() => child as never) as never,
      killTree,
    }).exec("Get-Location", "C:\\paper", {
      onData: () => {},
      env: {},
      timeout: 0.05,
    });
    const rejected = expect(execution).rejects.toThrow("timeout:0.05");

    await vi.advanceTimersByTimeAsync(50);
    expect(killTree).toHaveBeenCalledWith(4321);
    child.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    vi.useRealTimers();
  });

  it("preserves a spawn error", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const failure = new Error("spawn failed");
    const execution = createPowerShellOperations({
      executable: "C:\\Windows\\powershell.exe",
      spawnProcess: vi.fn(() => child as never) as never,
      killTree: vi.fn(),
    }).exec("Get-Location", "C:\\paper", {
      onData: () => {},
      env: {},
    });

    child.emit("error", failure);
    await expect(execution).rejects.toBe(failure);
  });

  it.runIf(process.platform === "win32")(
    "executes Unicode commands in native PowerShell without WSL",
    async () => {
      const chunks: Buffer[] = [];
      const result = await createPowerShellOperations().exec(
        "[Console]::Write('Windows原生'); exit 7",
        process.cwd(),
        { onData: (chunk) => chunks.push(chunk), env: process.env },
      );
      expect(Buffer.concat(chunks).toString("utf8")).toContain("Windows原生");
      expect(result).toEqual({ exitCode: 7 });
    },
  );

  it.runIf(process.platform === "win32")(
    "does not reuse a stale native exit code after a successful final command",
    async () => {
      const result = await createPowerShellOperations().exec(
        "& \"$env:SystemRoot\\System32\\cmd.exe\" /d /c \"exit 7\"; Write-Output 'recovered'",
        process.cwd(),
        { onData: () => {}, env: process.env },
      );
      expect(result).toEqual({ exitCode: 0 });
    },
  );
});

describe("Windows-only tool override", () => {
  it("does not register on Linux", () => {
    const on = vi.fn();
    createWindowsPowerShellExtension({ platform: "linux" })({ on } as never);
    expect(on).not.toHaveBeenCalled();
  });

  it("registers a session-start handler on Windows", () => {
    const on = vi.fn();
    createWindowsPowerShellExtension({
      platform: "win32",
      executable: "C:\\Windows\\powershell.exe",
      killTree: vi.fn(),
    })({ on } as never);
    expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });

  it("replaces the stable bash slot with PowerShell metadata at session start", () => {
    let start: ((event: unknown, context: { cwd: string }) => void) | undefined;
    const registerTool = vi.fn();
    createWindowsPowerShellExtension({
      platform: "win32",
      executable: "C:\\Windows\\powershell.exe",
      killTree: vi.fn(),
      env: {
        SHELL: "C:/Program Files/Git/usr/bin/bash.exe",
        MSYSTEM: "MINGW64",
      },
    })({
      on: (event: string, handler: typeof start) => {
        if (event === "session_start") start = handler;
      },
      registerTool,
    } as never);

    start?.({}, { cwd: "C:\\paper" });
    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "bash",
      label: "PowerShell",
      description: expect.stringContaining("Detected launcher shell: Git Bash"),
      promptSnippet: "Execute native commands from Git Bash context",
    }));
  });
});
