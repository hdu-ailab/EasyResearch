import { describe, expect, it } from "vitest";
import { selectShell, shellEnvironment } from "./process";

describe("managed shell environment", () => {
  it("preserves accepted All traffic and venv variables while removing daemon credential carriers", () => {
    const env = shellEnvironment({
      HTTPS_PROXY: "http://proxy.test:8080", PIP_PROXY: "http://proxy.test:8080",
      EASYRESEARCH_VENV: "/private/venv", EASYRESEARCH_DAEMON_TOKEN: "secret",
      EASYRESEARCH_DESKTOP_RENDERER_TOKEN: "secret", EASYRESEARCH_NETWORK_BASELINE: "secret",
      EASYRESEARCH_SHELL_WORKER_TOKEN: "secret", PATH: "/bin", HOME: "/temporary/home",
    }, "child");
    expect(env.HTTPS_PROXY).toBe(env.PIP_PROXY);
    expect(env.EASYRESEARCH_VENV).toBe("/private/venv");
    expect(env.EASYRESEARCH_SESSION_ID).toBe("child");
    expect(Object.values(env)).not.toContain("secret");
  });
  it("uses configured native PowerShell arguments on Windows", () => {
    const shell = selectShell("win32", {}, "C:\\Tools\\pwsh.exe");
    expect(shell.executable).toBe("C:\\Tools\\pwsh.exe");
    const args = shell.args("Write-Output hello");
    expect(args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
    expect(args.at(-1)).toContain("UTF8Encoding");
    expect(args.at(-1)?.endsWith("\nWrite-Output hello")).toBe(true);
  });
  it("falls back from an incompatible Unix SHELL without introducing another public tool", () => {
    const shell = selectShell("linux", { SHELL: "/bin/fish", PATH: "/bin" });
    expect(shell.executable).toMatch(/\/(?:ba)?sh$/);
    expect(shell.args("echo hello")).toEqual(["-c", "echo hello"]);
  });
});
