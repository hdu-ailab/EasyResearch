import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli, type CliDependencies } from "./index";
import { serverPidPath, writeServerPid } from "./server-process";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-index-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeDeps(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    serve: vi.fn(async () => 0),
    openBrowser: vi.fn(async () => true),
    waitForReady: vi.fn(async () => true),
    spawnBackground: vi.fn(),
    ...overrides,
  };
}

describe("runCli argument parsing", () => {
  it("starts a background server with defaults for an empty argv", async () => {
    const deps = makeDeps();
    expect(await runCli([], deps, { agentDir: root })).toBe(0);
    expect(deps.spawnBackground).toHaveBeenCalledWith("127.0.0.1", 3000);
    expect(deps.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3000");
  });

  it("parses -p port and --host", async () => {
    const deps = makeDeps();
    await runCli(["-p", "4000", "--host", "0.0.0.0"], deps, { agentDir: root });
    expect(deps.spawnBackground).toHaveBeenCalledWith("0.0.0.0", 4000);
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });

  it("skips opening the browser with --no-open", async () => {
    const deps = makeDeps();
    await runCli(["--no-open"], deps, { agentDir: root });
    expect(deps.spawnBackground).toHaveBeenCalledWith("127.0.0.1", 3000);
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });

  it("reuses an existing alive process (idempotent start)", async () => {
    writeServerPid(root, process.pid);
    const deps = makeDeps();
    expect(await runCli([], deps, { agentDir: root })).toBe(0);
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3000");
  });

  it("exit without a pid file prints a notice and exits 0", async () => {
    const deps = makeDeps();
    expect(await runCli(["exit"], deps, { agentDir: root })).toBe(0);
    expect(deps.serve).not.toHaveBeenCalled();
  });

  it("exit with a live pid sends a stop", async () => {
    writeServerPid(root, process.pid);
    const deps = makeDeps({ spawnBackground: vi.fn(), serve: vi.fn(async () => 0) });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) return true;
      throw Object.assign(new Error("ESRCH: no such process"), { code: "ESRCH" });
    });
    try {
      expect(await runCli(["exit"], deps, { agentDir: root })).toBe(0);
    } finally {
      killSpy.mockRestore();
    }
  });

  it.each([
    [["-p", "abc"]],
    [["-p", "0"]],
    [["-p", "70000"]],
    [["bogus"]],
    [["web"]],
  ])("rejects invalid argv %j", async (argv) => {
    const deps = makeDeps();
    expect(await runCli(argv as string[], deps, { agentDir: root })).toBe(1);
    expect(deps.spawnBackground).not.toHaveBeenCalled();
  });
});
