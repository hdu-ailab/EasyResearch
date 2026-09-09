import { describe, expect, it, vi } from "vitest";
import {
  parseNulEnvironment,
  resolveDesktopEnvironment,
  resolvePackagedSidecar,
  windowsTaskkillCommand,
} from "./environment";

describe("packaged sidecar path", () => {
  it("resolves only the Windows packaged resource", () => {
    expect(resolvePackagedSidecar("C:\\app\\resources", "win32"))
      .toBe("C:\\app\\resources\\sidecar\\easyresearch.exe");
  });

  it("resolves only the macOS packaged resource", () => {
    expect(resolvePackagedSidecar(
      "/Applications/EasyResearch.app/Contents/Resources",
      "darwin",
    )).toBe("/Applications/EasyResearch.app/Contents/Resources/sidecar/easyresearch");
  });

  it("rejects unsupported desktop platforms", () => {
    expect(() => resolvePackagedSidecar("/app/resources", "linux")).toThrow(/unsupported desktop platform/i);
  });
});

describe("desktop launch environment", () => {
  it("keeps inherited Windows variables without invoking a shell", () => {
    const runShell = vi.fn();
    expect(resolveDesktopEnvironment({ Path: "C:\\Windows" }, "win32", { runShell }))
      .toEqual({ Path: "C:\\Windows" });
    expect(runShell).not.toHaveBeenCalled();
  });

  it("uses the macOS login PATH while preserving controlled inherited values", () => {
    const runShell = vi.fn(() => ({
      status: 0,
      stdout: "PATH=/login/bin\0SHELL=/bin/zsh\0FROM_LOGIN=yes\0HOME=/shell-home\0EASYRESEARCH_CODING_AGENT_DIR=/shell-agent\0EASYRESEARCH_SKIP_SETUP=0\0",
      stderr: "",
    }));
    expect(resolveDesktopEnvironment(
      { PATH: "/usr/bin:/bin", HOME: "/controlled-home", EASYRESEARCH_CODING_AGENT_DIR: "/agent", EASYRESEARCH_SKIP_SETUP: "1" },
      "darwin",
      { runShell },
    )).toEqual({
      PATH: "/login/bin",
      HOME: "/controlled-home",
      SHELL: "/bin/zsh",
      FROM_LOGIN: "yes",
      EASYRESEARCH_CODING_AGENT_DIR: "/agent",
      EASYRESEARCH_SKIP_SETUP: "1",
    });
    expect(runShell).toHaveBeenCalledWith("/bin/zsh", ["-ilc", "/usr/bin/env -0"], {
      env: { PATH: "/usr/bin:/bin", HOME: "/controlled-home", EASYRESEARCH_CODING_AGENT_DIR: "/agent", EASYRESEARCH_SKIP_SETUP: "1" },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  });

  it.each(["", "PATH=\0"])("keeps the inherited PATH when shell output has no usable PATH: %j", (stdout) => {
    expect(resolveDesktopEnvironment({ PATH: "/usr/bin:/bin" }, "darwin", {
      runShell: () => ({ status: 0, stdout, stderr: "" }),
    }).PATH).toBe("/usr/bin:/bin");
  });

  it("falls back to inherited macOS variables and reports a local warning", () => {
    const warn = vi.fn();
    expect(resolveDesktopEnvironment({ PATH: "/inherited" }, "darwin", {
      runShell: () => ({ status: 1, stdout: "", stderr: "shell failed" }),
      warn,
    })).toEqual({ PATH: "/inherited" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("login shell environment"));
  });

  it("parses values after the first equals and ignores invalid records", () => {
    expect(parseNulEnvironment("A=one=two\0=bad\0NO_EQUALS\0B=three\0"))
      .toEqual({ A: "one=two", B: "three" });
  });
});

describe("Windows process-tree termination", () => {
  it("uses the in-box absolute taskkill path for only the owned PID", () => {
    expect(windowsTaskkillCommand("C:\\Windows", 4242)).toEqual({
      command: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "4242", "/T", "/F"],
    });
  });
});
