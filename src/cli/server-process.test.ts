import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isProcessAlive,
  readServerPid,
  removeServerPid,
  serverLogPath,
  serverPidPath,
  writeServerPid,
} from "./server-process";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "server-process-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("paths", () => {
  it("places pid and log under the agent dir", () => {
    expect(serverPidPath("/x/agent")).toBe("/x/agent/server.pid");
    expect(serverLogPath("/x/agent")).toBe("/x/agent/server.log");
  });
});

describe("readServerPid / writeServerPid / removeServerPid", () => {
  it("returns undefined without a pid file", () => {
    expect(readServerPid(root)).toBeUndefined();
  });

  it("round-trips a written pid", () => {
    writeServerPid(root, 4242);
    expect(readServerPid(root)).toBe(4242);
  });

  it("returns undefined for a non-numeric pid file", () => {
    writeFileSync(serverPidPath(root), "not-a-number", "utf8");
    expect(readServerPid(root)).toBeUndefined();
  });

  it("removes the pid file and is idempotent", () => {
    writeServerPid(root, 1);
    removeServerPid(root);
    expect(readServerPid(root)).toBeUndefined();
    removeServerPid(root);
    expect(readServerPid(root)).toBeUndefined();
  });
});

describe("isProcessAlive", () => {
  it("returns true for the current process and false for a dead pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(99999999)).toBe(false);
  });
});
