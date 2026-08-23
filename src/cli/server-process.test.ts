import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayStamp } from "../runtime/logger";
import {
  inspectServerProcess,
  isProcessAlive,
  readServerPid,
  serverOwner,
  removeServerPid,
  serverLogFile,
  serverLogPath,
  serverPidPath,
  stopServerProcess,
  writeServerProcess,
  writeServerPid,
  type ServerProcessRecord,
} from "./server-process";

let root: string;

const ownedRecord = (token = "owned-token"): ServerProcessRecord => ({
  schema: 1 as const,
  pid: 4242,
  host: "127.0.0.1",
  port: 3000,
  token,
  runtimeId: "runtime-current",
});

function writeOwnedRecord(record = ownedRecord()): void {
  writeFileSync(serverPidPath(root), `${JSON.stringify(record)}\n`, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "server-process-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("paths", () => {
  it("places pid and log under the agent dir", () => {
    expect(serverPidPath("/x/agent")).toBe("/x/agent/server.pid");
    expect(serverLogPath("/x/agent")).toBe("/x/agent/server.log");
  });

  it("points serverLogFile at the day-stamped file in the configured log dir", () => {
    expect(serverLogFile(root)).toBe(join(root, "logs", `easyresearch-${dayStamp()}.log`));
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

  it.runIf(process.platform !== "win32")("stores daemon control credentials in a user-only file", () => {
    writeServerProcess(root, ownedRecord());
    expect(statSync(serverPidPath(root)).mode & 0o777).toBe(0o600);
  });

  it("reads the diagnostic pid from a structured ownership record", () => {
    writeOwnedRecord();
    expect(readServerPid(root)).toBe(4242);
  });

  it("treats an omitted schema-1 owner as cli", () => {
    expect(serverOwner(ownedRecord())).toBe("cli");
  });

  it("preserves an explicit desktop owner", () => {
    expect(serverOwner({ ...ownedRecord(), owner: "desktop" })).toBe("desktop");
  });

  it("returns undefined for a non-numeric pid file", () => {
    writeFileSync(serverPidPath(root), "not-a-number", "utf8");
    expect(readServerPid(root)).toBeUndefined();
  });

  it("rejects an unsafe structured pid", () => {
    writeOwnedRecord({ ...ownedRecord(), pid: Number.MAX_SAFE_INTEGER + 1 });
    expect(readServerPid(root)).toBeUndefined();
  });

  it("removes the pid file and is idempotent", () => {
    writeServerPid(root, 1);
    removeServerPid(root);
    expect(readServerPid(root)).toBeUndefined();
    removeServerPid(root);
    expect(readServerPid(root)).toBeUndefined();
  });

  it("does not let an older daemon remove a successor ownership record", () => {
    writeOwnedRecord(ownedRecord("successor-token"));
    const removeOwned = removeServerPid as unknown as (
      agentDir: string,
      expectedToken: string,
    ) => boolean;

    expect(removeOwned(root, "older-token")).toBe(false);
    expect(readServerPid(root)).toBe(4242);
    expect(removeOwned(root, "successor-token")).toBe(true);
    expect(readServerPid(root)).toBeUndefined();
  });
});

describe("isProcessAlive", () => {
  it("returns true for the current process and false for a dead pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

describe("inspectServerProcess", () => {
  it("trusts only a token-authenticated probe and compares the running runtime", async () => {
    writeOwnedRecord();
    const fetchControl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("x-easyresearch-daemon-token")).toBe("owned-token");
      return new Response(JSON.stringify({ runtimeId: "runtime-current" }), { status: 200 });
    });

    await expect(inspectServerProcess(
      root,
      "runtime-current",
      "127.0.0.1",
      3000,
      { fetch: fetchControl as unknown as typeof fetch, isAlive: () => true },
    )).resolves.toBe("current");
    await expect(inspectServerProcess(
      root,
      "runtime-new",
      "127.0.0.1",
      3000,
      { fetch: fetchControl as unknown as typeof fetch, isAlive: () => true },
    )).resolves.toBe("stale");
  });

  it("does not discard a live record when its ownership probe fails", async () => {
    writeOwnedRecord();

    await expect(inspectServerProcess(
      root,
      "runtime-current",
      "127.0.0.1",
      3000,
      {
        fetch: vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
        isAlive: () => true,
      },
    )).rejects.toThrow(/Cannot verify EasyResearch daemon ownership/);
    expect(readServerPid(root)).toBe(4242);
  });

  it("reports a live authenticated desktop owner without comparing CLI runtime or port", async () => {
    writeOwnedRecord({ ...ownedRecord(), owner: "desktop" });
    const fetchControl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("x-easyresearch-daemon-token")).toBe("owned-token");
      return new Response(JSON.stringify({ runtimeId: "runtime-current" }), { status: 200 });
    });

    await expect(inspectServerProcess(
      root,
      "another-runtime",
      "127.0.0.1",
      3999,
      { fetch: fetchControl as unknown as typeof fetch, isAlive: () => true },
    )).resolves.toBe("desktop");
  });
});

describe("stopServerProcess", () => {
  it("fails closed for a live legacy pid without sending a termination signal", async () => {
    writeServerPid(root, 4242);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw new Error(`unexpected termination signal: ${String(signal)}`);
    });
    try {
      await expect(stopServerProcess(root)).rejects.toThrow(/legacy PID 4242/);
    } finally {
      killSpy.mockRestore();
    }
    expect(readServerPid(root)).toBe(4242);
    expect(killSpy).not.toHaveBeenCalledWith(4242, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("asks the token-authenticated daemon to stop without terminating its pid", async () => {
    writeOwnedRecord();
    const fetchControl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-easyresearch-daemon-token")).toBe("owned-token");
      removeServerPid(root, "owned-token");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw new Error(`unexpected termination signal: ${String(signal)}`);
    });
    const stopOwned = stopServerProcess as unknown as (
      agentDir: string,
      options: { fetch: typeof fetchControl; wait: () => Promise<void> },
    ) => Promise<boolean>;

    try {
      await expect(stopOwned(root, { fetch: fetchControl, wait: async () => {} })).resolves.toBe(true);
    } finally {
      killSpy.mockRestore();
    }
    expect(fetchControl).toHaveBeenCalledOnce();
    expect(killSpy).not.toHaveBeenCalledWith(4242, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("fails closed when a live ownership record cannot authenticate the daemon", async () => {
    writeOwnedRecord();
    const fetchControl = vi.fn(async () => new Response("not found", { status: 404 }));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const stopOwned = stopServerProcess as unknown as (
      agentDir: string,
      options: { fetch: typeof fetchControl },
    ) => Promise<boolean>;

    try {
      await expect(stopOwned(root, { fetch: fetchControl })).rejects.toThrow(/verify|ownership|authenticate/i);
    } finally {
      killSpy.mockRestore();
    }
    expect(readServerPid(root)).toBe(4242);
    expect(killSpy).not.toHaveBeenCalledWith(4242, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("refuses an owner-mismatched shutdown without contacting the desktop process", async () => {
    writeOwnedRecord({ ...ownedRecord(), owner: "desktop" });
    const fetchControl = vi.fn();

    await expect(stopServerProcess(root, {
      expectedOwner: "cli",
      fetch: fetchControl as unknown as typeof fetch,
      isAlive: () => true,
    })).rejects.toThrow(/Desktop owns the shared runtime/);

    expect(fetchControl).not.toHaveBeenCalled();
    expect(readServerPid(root)).toBe(4242);
  });

  it("allows the desktop transition to stop an authenticated cli owner", async () => {
    writeOwnedRecord({ ...ownedRecord(), owner: "cli" });
    const fetchControl = vi.fn(async () => {
      removeServerPid(root, "owned-token");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await expect(stopServerProcess(root, {
      expectedOwner: "cli",
      fetch: fetchControl as unknown as typeof fetch,
      isAlive: () => true,
      wait: async () => {},
    })).resolves.toBe(true);
  });
});
