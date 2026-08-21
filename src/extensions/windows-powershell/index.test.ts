import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  buildPowerShellScript,
  createPowerShellOperations,
  createWindowsPowerShellExtension,
  resolvePowerShellExecutable,
} from "./index";

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

describe("PowerShell command transport", () => {
  it("uses UTF-8 and preserves the command as stdin script content", () => {
    const command = "Get-ChildItem -LiteralPath 'C:\\论文 & data'";
    const script = buildPowerShellScript(command);
    expect(script).toContain("[Console]::OutputEncoding");
    const encoded = script.match(/FromBase64String\('([^']+)'\)/u)?.[1];
    expect(Buffer.from(encoded ?? "", "base64").toString("utf16le")).toBe(command);
    expect(script).not.toContain(command);
    expect(script).toContain("$global:LASTEXITCODE");
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
      promptSnippet: "Execute native Windows PowerShell commands",
    }));
  });
});
