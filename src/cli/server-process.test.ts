import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayStamp } from "../runtime/logger";
import { acquireServerLease, type RuntimeLease } from "./runtime-lease";
import {
  archiveDeadLegacyCliOwner,
  inspectServerProcess,
  isProcessAlive,
  readServerPid,
  readServerProcess,
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

function localNonLoopbackIpv4(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  throw new Error("A non-loopback IPv4 interface is required for the local transport test.");
}

async function listen(
  server: ReturnType<typeof createServer>,
  host: string,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not bind a port.");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

  it("removes an owned record only while its matching server lease remains held", async () => {
    const lease = await acquireServerLease(root, "cli", "owned-token");
    writeOwnedRecord();
    const removeOwned = removeServerPid as unknown as (
      agentDir: string,
      expectedToken: string,
      lease?: RuntimeLease,
    ) => boolean;

    expect(removeOwned(root, "owned-token")).toBe(false);
    expect(readServerPid(root)).toBe(4242);
    expect(removeOwned(root, "owned-token", {
      ...lease,
      path: join(root, "server.transition.lease"),
    })).toBe(false);
    expect(readServerPid(root)).toBe(4242);
    expect(removeOwned(root, "owned-token", lease)).toBe(true);
    expect(removeOwned(root, "owned-token", lease)).toBe(false);
    expect(lease.release()).toBe(true);
  });

  it("does not let an older daemon remove a successor ownership record", async () => {
    const lease = await acquireServerLease(root, "cli", "successor-token");
    writeOwnedRecord(ownedRecord("successor-token"));
    const removeOwned = removeServerPid as unknown as (
      agentDir: string,
      expectedToken: string,
      lease: RuntimeLease,
    ) => boolean;

    expect(removeOwned(root, "older-token", lease)).toBe(false);
    expect(readServerPid(root)).toBe(4242);
    expect(removeOwned(root, "successor-token", lease)).toBe(true);
    expect(readServerPid(root)).toBeUndefined();
    expect(lease.release()).toBe(true);
  });

  it("never moves the canonical ownership record while its server lease is held", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const path = serverPidPath(root);
    const lease = await acquireServerLease(root, "cli", "older-token");
    writeOwnedRecord(ownedRecord("older-token"));

    vi.doMock("node:fs", () => ({
      ...actualFs,
      renameSync: ((oldPath, newPath) => {
        if (String(oldPath) === path) throw new Error("canonical server.pid was hidden");
        return actualFs.renameSync(oldPath, newPath);
      }) as typeof actualFs.renameSync,
    }));
    vi.resetModules();
    try {
      const serverProcess = await import("./server-process");

      expect(() => serverProcess.removeServerPid(root, "older-token", lease as never)).not.toThrow();
      expect(serverProcess.readServerProcess(root)).toEqual({ kind: "missing" });
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
      lease.release();
    }
  });
});

describe("isProcessAlive", () => {
  it("returns true for the current process and false for a dead pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

describe("dead legacy CLI ownership recovery", () => {
  function writeLegacyLease(owner: "cli" | "desktop", token = "owned-token"): void {
    writeFileSync(join(root, "server.lease"), `${JSON.stringify({
      schema: 1,
      kind: "server",
      owner,
      pid: 4242,
      token,
    })}\n`, "utf8");
  }

  it("archives an exactly matching dead CLI record and legacy file lease", () => {
    const recordBytes = `${JSON.stringify({ ...ownedRecord(), owner: "cli" })}\n`;
    const leaseBytes = `${JSON.stringify({
      schema: 1,
      kind: "server",
      owner: "cli",
      pid: 4242,
      token: "owned-token",
    })}\n`;
    writeFileSync(serverPidPath(root), recordBytes, "utf8");
    writeFileSync(join(root, "server.lease"), leaseBytes, "utf8");

    expect(archiveDeadLegacyCliOwner(root, {
      isAlive: () => false,
      createArchiveSuffix: () => "upgrade-test",
    })).toBe(true);

    expect(existsSync(serverPidPath(root))).toBe(false);
    expect(existsSync(join(root, "server.lease"))).toBe(false);
    expect(readFileSync(join(root, "server.pid.stale-upgrade-test"), "utf8")).toBe(recordBytes);
    expect(readFileSync(join(root, "server.lease.stale-upgrade-test"), "utf8")).toBe(leaseBytes);
  });

  it.each([
    ["live CLI", { owner: "cli" as const, token: "owned-token", alive: true }],
    ["Desktop owner", { owner: "desktop" as const, token: "owned-token", alive: false }],
    ["token mismatch", { owner: "cli" as const, token: "other-token", alive: false }],
  ])("keeps $0 legacy ownership fail-closed", (_name, scenario) => {
    writeOwnedRecord({ ...ownedRecord(), owner: scenario.owner });
    writeLegacyLease(scenario.owner, scenario.token);

    expect(archiveDeadLegacyCliOwner(root, {
      isAlive: () => scenario.alive,
      createArchiveSuffix: () => "must-not-archive",
    })).toBe(false);

    expect(readServerProcess(root)).toMatchObject({ kind: "owned" });
    expect(existsSync(join(root, "server.lease"))).toBe(true);
    expect(readdirSync(root)).not.toContain("server.pid.stale-must-not-archive");
  });

  it("keeps malformed legacy lease state fail-closed", () => {
    writeOwnedRecord({ ...ownedRecord(), owner: "cli" });
    writeFileSync(join(root, "server.lease"), "not-json\n", "utf8");

    expect(archiveDeadLegacyCliOwner(root, {
      isAlive: () => false,
      createArchiveSuffix: () => "must-not-archive",
    })).toBe(false);
    expect(existsSync(serverPidPath(root))).toBe(true);
    expect(readFileSync(join(root, "server.lease"), "utf8")).toBe("not-json\n");
  });
});

describe("inspectServerProcess", () => {
  it.each([
    ["malformed", "not-json"],
    ["legacy", "4242\n"],
  ])("fails closed for a dead %s record instead of tokenlessly deleting it", async (_name, content) => {
    const path = serverPidPath(root);
    writeFileSync(path, content, "utf8");

    await expect(inspectServerProcess(
      root,
      "runtime-current",
      "127.0.0.1",
      3000,
      { isAlive: () => false },
    )).rejects.toThrow(/cannot verify|manually/i);

    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("leaves a dead token-owned record published for the next lease owner to replace", async () => {
    writeOwnedRecord();

    await expect(inspectServerProcess(
      root,
      "runtime-current",
      "127.0.0.1",
      3000,
      {
        fetch: vi.fn(async () => { throw new Error("not listening"); }) as never,
        isAlive: () => false,
      },
    )).resolves.toBe("none");

    expect(readServerProcess(root)).toEqual({ kind: "owned", record: ownedRecord() });
  });

  it("keeps ownership credentials on a direct non-loopback local connection despite proxy routing", async () => {
    const lease = await acquireServerLease(root, "cli", "owned-token");
    const host = localNonLoopbackIpv4();
    const targetRequests: Array<{ method: string; token?: string }> = [];
    const target = createServer((request, response) => {
      targetRequests.push({
        method: request.method ?? "GET",
        token: typeof request.headers["x-easyresearch-daemon-token"] === "string"
          ? request.headers["x-easyresearch-daemon-token"]
          : undefined,
      });
      if (request.method === "POST") {
        removeServerPid(root, "owned-token", lease);
        lease.release();
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ runtimeId: "runtime-current" }));
    });
    const proxyRecords: Array<{ url: string; token?: string }> = [];
    const proxy = createServer((request, response) => {
      proxyRecords.push({
        url: request.url ?? "",
        token: typeof request.headers["x-easyresearch-daemon-token"] === "string"
          ? request.headers["x-easyresearch-daemon-token"]
          : undefined,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ runtimeId: "runtime-current" }));
    });
    const targetPort = await listen(target, host);
    const proxyPort = await listen(proxy, "127.0.0.1");
    const originalFetch = globalThis.fetch;
    const proxyUrl = `http://127.0.0.1:${proxyPort}/record`;
    const envKeys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
    const originalEnvironment = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) process.env[key] = proxyUrl;
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => originalFetch(proxyUrl, {
        method: init?.method,
        headers: init?.headers,
        signal: init?.signal,
      }),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    writeOwnedRecord({
      ...ownedRecord(),
      pid: process.pid,
      host,
      port: targetPort,
    });

    try {
      await expect(inspectServerProcess(
        root,
        "runtime-current",
        host,
        targetPort,
        { isAlive: () => true },
      )).resolves.toBe("current");
      await expect(stopServerProcess(root, {
        isAlive: () => true,
        wait: async () => {},
      })).resolves.toBe(true);

      expect(targetRequests).toEqual([
        { method: "GET", token: "owned-token" },
        { method: "POST", token: "owned-token" },
      ]);
      expect(proxyRecords).toEqual([]);
      expect(JSON.stringify(proxyRecords)).not.toContain("owned-token");
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of envKeys) {
        const value = originalEnvironment[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await Promise.all([close(target), close(proxy)]);
    }
  });

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
  it.each([
    ["malformed", "not-json"],
    ["legacy", "4242\n"],
  ])("fails closed for a dead %s record instead of tokenlessly deleting it", async (_name, content) => {
    const path = serverPidPath(root);
    writeFileSync(path, content, "utf8");

    await expect(stopServerProcess(root, { isAlive: () => false }))
      .rejects.toThrow(/cannot verify|manually/i);
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("does not contact or remove a record that does not match the expected child token", async () => {
    writeOwnedRecord(ownedRecord("another-token"));
    const fetchControl = vi.fn();

    await expect(stopServerProcess(root, {
      expectedOwner: "cli",
      expectedToken: "expected-child-token",
      fetch: fetchControl as unknown as typeof fetch,
      isAlive: () => true,
    })).resolves.toBe(false);

    expect(fetchControl).not.toHaveBeenCalled();
    expect(readServerPid(root)).toBe(4242);
  });

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
    const lease = await acquireServerLease(root, "cli", "owned-token");
    writeOwnedRecord();
    const fetchControl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-easyresearch-daemon-token")).toBe("owned-token");
      removeServerPid(root, "owned-token", lease);
      lease.release();
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

  it("waits for both the matching pid record and matching server lease to be released", async () => {
    const lease = await acquireServerLease(root, "cli", "owned-token");
    writeOwnedRecord();
    const continuePolling = deferred<void>();
    const fetchControl = vi.fn(async () => {
      expect(removeServerPid(root, "owned-token", lease)).toBe(true);
      return Response.json({ ok: true });
    });
    let settled = false;

    const stopping = stopServerProcess(root, {
      fetch: fetchControl as unknown as typeof fetch,
      isAlive: () => true,
      wait: () => continuePolling.promise,
    }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(fetchControl).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(readServerProcess(root)).toEqual({ kind: "missing" });
    expect(lease.held).toBe(true);
    expect(settled).toBe(false);

    expect(lease.release()).toBe(true);
    continuePolling.resolve();
    await expect(stopping).resolves.toBe(true);
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
    const lease = await acquireServerLease(root, "cli", "owned-token");
    writeOwnedRecord({ ...ownedRecord(), owner: "cli" });
    const fetchControl = vi.fn(async () => {
      removeServerPid(root, "owned-token", lease);
      lease.release();
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
