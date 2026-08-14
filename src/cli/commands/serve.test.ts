import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const [loggerMock, createLoggerMock] = vi.hoisted(() => {
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return [mockLogger, vi.fn(() => mockLogger)] as const;
});

const [piImportMock] = vi.hoisted(() => [{ agentDir: "" }]);

vi.mock("../../runtime/logger", () => ({
  createLogger: createLoggerMock,
}));

vi.mock("../../runtime/pi-import", () => ({
  getAgentDir: () => piImportMock.agentDir,
}));

const bootstrapError = new Error("EADDRINUSE: address already in use :::3000");
vi.mock("../../bootstrap/resources", () => ({
  bootstrapBundledResources: vi.fn(async () => {
    throw bootstrapError;
  }),
}));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-serve-"));
  piImportMock.agentDir = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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
});
