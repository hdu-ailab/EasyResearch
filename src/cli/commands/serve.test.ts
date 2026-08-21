import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAEMON_RUNTIME_ID_ENV,
  DAEMON_TOKEN_ENV,
  readServerPid,
  writeServerProcess,
} from "../server-process";

const [loggerMock, createLoggerMock] = vi.hoisted(() => {
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return [mockLogger, vi.fn(() => mockLogger)] as const;
});

const [piImportMock] = vi.hoisted(() => [{ agentDir: "" }]);
const [bootstrapMock, startServerMock] = vi.hoisted(() => [vi.fn(), vi.fn()]);

vi.mock("../../runtime/logger", () => ({
  createLogger: createLoggerMock,
  dayStamp: () => "2026-08-21",
  resolveLogConfig: (agentDir: string) => ({ logDir: join(agentDir, "logs") }),
}));

vi.mock("../../runtime/pi-import", () => ({
  getAgentDir: () => piImportMock.agentDir,
}));

const bootstrapError = new Error("EADDRINUSE: address already in use :::3000");
vi.mock("../../bootstrap/resources", () => ({
  bootstrapBundledResources: bootstrapMock,
}));

vi.mock("../../web/server", () => ({
  startServer: startServerMock,
}));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-serve-"));
  piImportMock.agentDir = root;
  bootstrapMock.mockReset().mockRejectedValue(bootstrapError);
  startServerMock.mockReset();
  process.env[DAEMON_TOKEN_ENV] = "launch-token";
  process.env[DAEMON_RUNTIME_ID_ENV] = "runtime-current";
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env[DAEMON_TOKEN_ENV];
  delete process.env[DAEMON_RUNTIME_ID_ENV];
  vi.clearAllMocks();
});

describe("runServe startup failure", () => {
  it("persists the startup error to the web-server log", async () => {
    const { runServe } = await import("./serve");
    expect(await runServe("127.0.0.1", 3000)).toBe(1);
    expect(createLoggerMock).toHaveBeenCalledWith("web-server");
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining("EasyResearch server failed to start"),
    );
    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining("EADDRINUSE"));
  });

  it("does not erase a successor ownership record when startup fails", async () => {
    writeServerProcess(root, {
      schema: 1,
      pid: 9876,
      host: "127.0.0.1",
      port: 3000,
      token: "successor-token",
      runtimeId: "successor-runtime",
    });

    const { runServe } = await import("./serve");
    expect(await runServe("127.0.0.1", 3000)).toBe(1);

    expect(readServerPid(root)).toBe(9876);
  });

  it("passes authenticated daemon control before publishing an ownership record", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockRejectedValue(new Error("bind failed"));

    const { runServe } = await import("./serve");
    expect(await runServe("127.0.0.1", 3000)).toBe(1);

    expect(startServerMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 3000,
      daemonControl: expect.objectContaining({
        token: "launch-token",
        runtimeId: "runtime-current",
        requestShutdown: expect.any(Function),
      }),
    });
    expect(readServerPid(root)).toBeUndefined();
  });

  it("consumes daemon ownership environment before starting the Web runtime", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    expect(process.env[DAEMON_TOKEN_ENV]).toBe("launch-token");
    expect(process.env[DAEMON_RUNTIME_ID_ENV]).toBe("runtime-current");
    let observedToken: string | undefined;
    let observedRuntimeId: string | undefined;
    startServerMock.mockImplementation(async () => {
      observedToken = process.env[DAEMON_TOKEN_ENV];
      observedRuntimeId = process.env[DAEMON_RUNTIME_ID_ENV];
      throw new Error("bind failed");
    });

    const { runServe } = await import("./serve");
    expect(await runServe("127.0.0.1", 3000)).toBe(1);
    expect(observedToken).toBeUndefined();
    expect(observedRuntimeId).toBeUndefined();
  });

  it("publishes ownership after bind and removes only that record on self-shutdown", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    const stop = vi.fn(async () => {});
    startServerMock.mockResolvedValue({ port: 3456, stop });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000);
    await vi.waitFor(() => expect(startServerMock).toHaveBeenCalledOnce());
    expect(readServerPid(root)).toBe(process.pid);

    const options = startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { requestShutdown: () => void };
    };
    options.daemonControl.requestShutdown();

    await expect(running).resolves.toBe(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(readServerPid(root)).toBeUndefined();
  });

  it("preserves ownership when shutdown cleanup cannot stop the server", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    const stop = vi.fn(async () => {
      throw new Error("listener still active");
    });
    startServerMock.mockResolvedValue({ port: 3456, stop });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000);
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const options = startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { requestShutdown: () => void };
    };
    options.daemonControl.requestShutdown();

    await expect(running).resolves.toBe(1);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(readServerPid(root)).toBe(process.pid);
  });
});
