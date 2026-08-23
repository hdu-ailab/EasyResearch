import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { DAEMON_CONTROL_PATH, DAEMON_TOKEN_HEADER } from "../cli/daemon-control";
import {
  DESKTOP_ACCESS_HEADER,
  DESKTOP_CONTROL_TOKEN_ENV,
  DESKTOP_LAUNCH_ENV,
  DESKTOP_RENDERER_TOKEN_ENV,
} from "./contracts";
import { startDesktopSidecar } from "./sidecar";

class FakeSidecarChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(readonly pid = 4242) {
    super();
  }

  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

function fakeChild(pid = 4242): FakeSidecarChild {
  return new FakeSidecarChild(pid);
}

describe("desktop sidecar client", () => {
  it("starts with separate environment credentials, authenticates health, and shuts down itself", async () => {
    const child = fakeChild();
    let command = "";
    let args: readonly string[] = [];
    let childEnv: NodeJS.ProcessEnv = {};
    const spawn = vi.fn((nextCommand: string, nextArgs: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      command = nextCommand;
      args = nextArgs;
      childEnv = options.env ?? {};
      queueMicrotask(() => child.stdout.write(
        '@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log"}\n',
      ));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const requests: Array<{ url: string; method: string; headers: Headers }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      if (url.endsWith(DAEMON_CONTROL_PATH)) {
        queueMicrotask(() => child.emitExit());
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const tokens = ["control-token-abcdefghijklmnopqrstuvwxyz", "renderer-token-abcdefghijklmnopqrstuvwxyz"];

    const handle = await startDesktopSidecar({
      sidecarPath: "/app/resources/sidecar/easyresearch",
      baseEnv: { HOME: "/home/test" },
      spawn: spawn as never,
      fetch,
      createToken: () => tokens.shift()!,
      startupTimeoutMs: 1_000,
    });

    expect(command).toBe("/app/resources/sidecar/easyresearch");
    expect(args).toEqual(["--desktop-serve", "127.0.0.1", "0"]);
    expect(childEnv).toMatchObject({
      HOME: "/home/test",
      [DESKTOP_LAUNCH_ENV]: "1",
      [DESKTOP_CONTROL_TOKEN_ENV]: "control-token-abcdefghijklmnopqrstuvwxyz",
      [DESKTOP_RENDERER_TOKEN_ENV]: "renderer-token-abcdefghijklmnopqrstuvwxyz",
    });
    expect(args.join(" ")).not.toContain("control-token");
    expect(requests[0]?.headers.get(DESKTOP_ACCESS_HEADER))
      .toBe("renderer-token-abcdefghijklmnopqrstuvwxyz");
    expect(handle.ready.origin).toBe("http://127.0.0.1:43123");
    expect(handle.rendererToken).toBe("renderer-token-abcdefghijklmnopqrstuvwxyz");

    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(requests[1]).toMatchObject({
      url: `http://127.0.0.1:43123${DAEMON_CONTROL_PATH}`,
      method: "POST",
    });
    expect(requests[1]?.headers.get(DAEMON_TOKEN_HEADER))
      .toBe("control-token-abcdefghijklmnopqrstuvwxyz");
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("forwards setup progress without treating ordinary output as protocol", async () => {
    const child = fakeChild();
    const setupMessages: string[] = [];
    const logs: string[] = [];
    const start = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      onSetup: (message) => setupMessages.push(message),
      log: (line) => logs.push(line),
      startupTimeoutMs: 1_000,
    });
    child.stdout.write("ordinary output\n");
    child.stdout.write('@easyresearch-desktop {"type":"desktop.setup","message":"Preparing resources"}\n');
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log"}\n');

    await start;
    expect(setupMessages).toEqual(["Preparing resources"]);
    expect(logs).toContain("ordinary output");
  });

  it("rejects an early safe sidecar error", async () => {
    const child = fakeChild();
    const start = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      startupTimeoutMs: 1_000,
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.error","phase":"ownership","code":"BUSY","message":"Desktop is already running","logPath":"/tmp/log"}\n');

    await expect(start).rejects.toThrow(/Desktop is already running/);
  });

  it("reports a child spawn error without waiting for the startup deadline", async () => {
    const child = fakeChild();
    const start = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => {
        queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn denied"), { code: "EACCES" })));
        return child as unknown as ChildProcessWithoutNullStreams;
      }) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      startupTimeoutMs: 1_000,
    });

    await expect(start).rejects.toThrow(/spawn denied/);
  });

  it("listens for spawn errors before requiring the child process id", async () => {
    const child = fakeChild(0);
    const start = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => {
        queueMicrotask(() => child.emit("error", Object.assign(new Error("missing executable"), { code: "ENOENT" })));
        return child as unknown as ChildProcessWithoutNullStreams;
      }) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      startupTimeoutMs: 1_000,
    });

    await expect(start).rejects.toThrow(/missing executable/);
  });

  it("continues capturing sidecar diagnostics after readiness", async () => {
    const child = fakeChild();
    const logs: string[] = [];
    const start = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child as unknown as ChildProcessWithoutNullStreams) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      log: (line) => logs.push(line),
      startupTimeoutMs: 1_000,
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log"}\n');
    await start;

    child.stderr.write("post-ready diagnostic\n");
    child.emit("error", new Error("post-ready child error"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logs).toContain("post-ready diagnostic");
    expect(logs).toContain("Desktop sidecar process error: post-ready child error");
  });

  it("times out instead of leaving an unowned child", async () => {
    const child = fakeChild();
    await expect(startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      startupTimeoutMs: 10,
    })).rejects.toThrow(/timed out/i);
    expect(child.kill).toHaveBeenCalled();
  });

  it("reports when the owned child survives graceful and forced shutdown", async () => {
    const child = fakeChild();
    const handlePromise = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 10,
      platform: "darwin",
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log"}\n');
    const handle = await handlePromise;

    vi.useFakeTimers();
    try {
      const shutdown = handle.shutdown();
      const rejected = expect(shutdown).rejects.toThrow(/did not exit after forced termination/i);
      await vi.advanceTimersByTimeAsync(5_020);
      await rejected;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});
