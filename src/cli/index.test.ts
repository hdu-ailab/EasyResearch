import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayStamp } from "../runtime/logger";
import { runCli, waitForReady, type CliDependencies } from "./index";
import { readServerPid, serverPidPath, writeServerPid } from "./server-process";

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
    expect(deps.waitForReady).toHaveBeenCalledWith("0.0.0.0", 4000);
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
    expect(deps.waitForReady).toHaveBeenCalledWith("127.0.0.1", 3000);
    expect(deps.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3000");
  });

  it("refuses to reuse a live pid when nothing listens on the requested port", async () => {
    writeServerPid(root, process.pid);
    const deps = makeDeps({ waitForReady: vi.fn(async () => false) });
    const messages: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      messages.push(String(msg));
    });
    try {
      expect(await runCli(["-p", "4000"], deps, { agentDir: root })).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect(messages.join("\n")).toContain("4000");
    expect(readServerPid(root)).toBe(process.pid);
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

  it.each([
    [["--serve"]],
    [["--serve", "127.0.0.1", "3000"]],
    [["--serve", "--no-open"]],
    [["--serve", "127.0.0.1", "3000", "extra"]],
  ])("rejects the internal --serve flag on the user path %j", async (argv) => {
    const deps = makeDeps();
    expect(await runCli(argv as string[], deps, { agentDir: root })).toBe(1);
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.serve).not.toHaveBeenCalled();
  });

  it("exit combined with --serve does not start a daemon", async () => {
    const deps = makeDeps();
    expect(await runCli(["exit", "--serve"], deps, { agentDir: root })).toBe(1);
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.serve).not.toHaveBeenCalled();
  });

  it("points the failure hint at the real web-server log file", async () => {
    const deps = makeDeps({ waitForReady: vi.fn(async () => false) });
    const messages: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      messages.push(String(msg));
    });
    try {
      expect(await runCli([], deps, { agentDir: root })).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
    const expected = join(root, "logs", `easyresearch-${dayStamp()}.log`);
    expect(messages.join("\n")).toContain(expected);
  });

  it("probes readiness on the bound host", async () => {
    const deps = makeDeps();
    await runCli(["--host", "192.168.1.5"], deps, { agentDir: root });
    expect(deps.spawnBackground).toHaveBeenCalledWith("192.168.1.5", 3000);
    expect(deps.waitForReady).toHaveBeenCalledWith("192.168.1.5", 3000);
  });
});

describe("waitForReady", () => {
  it("probes the given host", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await waitForReady("127.0.0.1", port, 2000)).toBe(true);
    } finally {
      server.close();
    }
  });

  it.each(["0.0.0.0", "::"])("falls back to the loopback probe for %s", async (host) => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await waitForReady(host, port, 2000)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("times out when nothing listens on the probe host", async () => {
    expect(await waitForReady("127.0.0.1", 1, 300)).toBe(false);
  });
});
