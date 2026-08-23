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

  it("merges a macOS login shell while controlled inherited values win", () => {
    const runShell = vi.fn(() => ({
      status: 0,
      stdout: "PATH=/login/bin\0SHELL=/bin/zsh\0FROM_LOGIN=yes\0",
      stderr: "",
    }));
    expect(resolveDesktopEnvironment(
      { PATH: "/controlled/bin", EASYRESEARCH_CODING_AGENT_DIR: "/agent" },
      "darwin",
      { runShell },
    )).toEqual({
      PATH: "/controlled/bin",
      SHELL: "/bin/zsh",
      FROM_LOGIN: "yes",
      EASYRESEARCH_CODING_AGENT_DIR: "/agent",
    });
    expect(runShell).toHaveBeenCalledWith("/bin/zsh", ["-ilc", "/usr/bin/env -0"], {
      env: { PATH: "/controlled/bin", EASYRESEARCH_CODING_AGENT_DIR: "/agent" },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
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
