import { EventEmitter } from "node:events";
import { createServer } from "node:http";
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

  emitProcessExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  emitClose(code: number | null = this.exitCode, signal: NodeJS.Signals | null = this.signalCode): void {
    this.emit("close", code, signal);
  }

  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emitProcessExit(code, signal);
    this.emitClose(code, signal);
  }
}

function fakeChild(pid = 4242): FakeSidecarChild {
  return new FakeSidecarChild(pid);
}

describe("desktop sidecar client", () => {
  it("exposes a stoppable owned child immediately after spawn and before readiness", async () => {
    const child = fakeChild();
    child.stdin.once("finish", () => child.emitExit());
    let spawned: {
      shutdown(): Promise<void>;
      forceTerminate(): void;
    } | undefined;
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));

    const starting = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch,
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      onSpawned: (handle) => {
        spawned = handle;
      },
      startupTimeoutMs: 10_000,
      shutdownTimeoutMs: 100,
    });

    expect(spawned).toBeDefined();
    await spawned!.shutdown();
    await expect(starting).rejects.toThrow(/exited before readiness/i);

    expect(fetch).not.toHaveBeenCalled();
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("uses direct local HTTP for token-bearing health and shutdown requests by default", async () => {
    const child = fakeChild();
    const targetRequests: Array<{ path: string; desktop: string | null; daemon: string | null }> = [];
    const target = createServer((request, response) => {
      targetRequests.push({
        path: request.url ?? "",
        desktop: typeof request.headers[DESKTOP_ACCESS_HEADER] === "string"
          ? request.headers[DESKTOP_ACCESS_HEADER]
          : null,
        daemon: typeof request.headers[DAEMON_TOKEN_HEADER] === "string"
          ? request.headers[DAEMON_TOKEN_HEADER]
          : null,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      if (request.url === DAEMON_CONTROL_PATH) queueMicrotask(() => child.emitExit());
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const port = (target.address() as { port: number }).port;
    const originalFetch = globalThis.fetch;
    const proxyRecords: Array<{ url: string; desktop: string | null; daemon: string | null }> = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      proxyRecords.push({
        url,
        desktop: new Headers(init?.headers).get(DESKTOP_ACCESS_HEADER),
        daemon: new Headers(init?.headers).get(DAEMON_TOKEN_HEADER),
      });
      if (url.endsWith(DAEMON_CONTROL_PATH)) queueMicrotask(() => child.emitExit());
      return Response.json({ ok: true });
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    const tokens = ["control-token-abcdefghijklmnopqrstuvwxyz", "renderer-token-abcdefghijklmnopqrstuvwxyz"];

    try {
      const handlePromise = startDesktopSidecar({
        sidecarPath: "/app/resources/sidecar/easyresearch",
        baseEnv: {},
        spawn: (() => child) as never,
        createToken: () => tokens.shift()!,
        startupTimeoutMs: 1_000,
      });
      child.stdout.write(
        `@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:${port}","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n`,
      );
      const handle = await handlePromise;
      await handle.shutdown();

      expect(targetRequests).toEqual([
        {
          path: "/api/status",
          desktop: "renderer-token-abcdefghijklmnopqrstuvwxyz",
          daemon: null,
        },
        {
          path: DAEMON_CONTROL_PATH,
          desktop: null,
          daemon: "control-token-abcdefghijklmnopqrstuvwxyz",
        },
      ]);
      expect(proxyRecords).toEqual([]);
      expect(JSON.stringify(proxyRecords)).not.toContain("token-abcdefghijklmnopqrstuvwxyz");
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve, reject) => {
        target.close((error) => error ? reject(error) : resolve());
      });
    }
  });

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
        '@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n',
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
    expect(handle.ready.bootId).toBe("boot-ready");
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

  it("creates an isolated macOS process group without changing Windows spawn semantics", async () => {
    const platforms = ["darwin", "win32"] as const;
    const spawnOptions: Array<{ detached?: boolean }> = [];

    for (const [index, platform] of platforms.entries()) {
      const child = fakeChild(4242 + index);
      const handlePromise = startDesktopSidecar({
        sidecarPath: platform === "win32"
          ? "/app/sidecar/easyresearch.exe"
          : "/app/sidecar/easyresearch",
        baseEnv: {},
        spawn: ((_command: string, _args: readonly string[], options: { detached?: boolean }) => {
          spawnOptions.push(options);
          queueMicrotask(() => child.stdout.write(
            `@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":${child.pid},"logPath":"/tmp/log","bootId":"boot-${platform}"}\n`,
          ));
          return child;
        }) as never,
        fetch: async () => Response.json({ ok: true }),
        createToken: (() => {
          const tokens = [`control-${platform}-abcdefghijklmnopqrstuvwxyz`, `renderer-${platform}-abcdefghijklmnopqrstuvwxyz`];
          return () => tokens.shift()!;
        })(),
        startupTimeoutMs: 1_000,
        platform,
      });
      const handle = await handlePromise;
      child.emitExit();
      await handle.exited;
    }

    expect(spawnOptions[0]).toMatchObject({ detached: true });
    expect(spawnOptions[1]?.detached).not.toBe(true);
  });

  it("force-terminates the isolated macOS sidecar process group", async () => {
    const child = fakeChild();
    const killProcess = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const handlePromise = startDesktopSidecar({
        sidecarPath: "/app/sidecar/easyresearch",
        baseEnv: {},
        spawn: (() => child) as never,
        fetch: async () => Response.json({ ok: true }),
        createToken: (() => {
          const tokens = ["c".repeat(43), "r".repeat(43)];
          return () => tokens.shift()!;
        })(),
        startupTimeoutMs: 1_000,
        platform: "darwin",
      });
      child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
      const handle = await handlePromise;

      handle.forceTerminate();

      expect(killProcess).toHaveBeenCalledWith(-4242, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
      child.emitExit(null, "SIGKILL");
      await handle.exited;
    } finally {
      killProcess.mockRestore();
    }
  });

  it("force-terminates the macOS process group after its leader exits but descendants retain pipes", async () => {
    const child = fakeChild();
    const killProcess = vi.fn(() => true);
    const handlePromise = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch: async () => Response.json({ ok: true }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      startupTimeoutMs: 1_000,
      platform: "darwin",
      killProcess,
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
    const handle = await handlePromise;
    child.emitProcessExit(0);

    handle.forceTerminate();

    expect(killProcess).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
    child.emitClose(0);
    await handle.exited;
  });

  it("does not signal a reusable macOS process-group id after child close", async () => {
    const child = fakeChild();
    const killProcess = vi.fn(() => true);
    const handlePromise = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch: async () => Response.json({ ok: true }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      startupTimeoutMs: 1_000,
      platform: "darwin",
      killProcess,
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
    const handle = await handlePromise;
    child.emitExit();
    await handle.exited;

    handle.forceTerminate();

    expect(killProcess).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("creates fresh boot and credential ownership even when a successor reuses the same origin", async () => {
    const children = [fakeChild(4242), fakeChild(4343)];
    const spawned: FakeSidecarChild[] = [];
    const bootIds = ["boot-old", "boot-fresh"];
    const childEnvironments: NodeJS.ProcessEnv[] = [];
    const healthCredentials: Array<string | null> = [];
    const tokens = [
      "control-old-abcdefghijklmnopqrstuvwxyz",
      "renderer-old-abcdefghijklmnopqrstuvwxyz",
      "control-fresh-abcdefghijklmnopqrstuvwxyz",
      "renderer-fresh-abcdefghijklmnopqrstuvwxyz",
    ];
    const start = async () => startDesktopSidecar({
      sidecarPath: "/app/resources/sidecar/easyresearch",
      baseEnv: {},
      spawn: ((_command: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = children.shift()!;
        const bootId = bootIds.shift()!;
        spawned.push(child);
        childEnvironments.push(options.env);
        queueMicrotask(() => child.stdout.write(
          `@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":${child.pid},"logPath":"/tmp/log","bootId":"${bootId}"}\n`,
        ));
        return child as unknown as ChildProcessWithoutNullStreams;
      }) as never,
      fetch: async (_input, init) => {
        healthCredentials.push(new Headers(init?.headers).get(DESKTOP_ACCESS_HEADER));
        return new Response("{}", { status: 200 });
      },
      createToken: () => tokens.shift()!,
      startupTimeoutMs: 1_000,
    });

    const oldHandle = await start();
    const freshHandle = await start();

    expect(freshHandle.ready.origin).toBe(oldHandle.ready.origin);
    expect(freshHandle.ready.bootId).not.toBe(oldHandle.ready.bootId);
    expect(freshHandle.rendererToken).not.toBe(oldHandle.rendererToken);
    expect(childEnvironments[1]?.[DESKTOP_CONTROL_TOKEN_ENV])
      .not.toBe(childEnvironments[0]?.[DESKTOP_CONTROL_TOKEN_ENV]);
    expect(childEnvironments[1]?.[DESKTOP_RENDERER_TOKEN_ENV])
      .not.toBe(childEnvironments[0]?.[DESKTOP_RENDERER_TOKEN_ENV]);
    expect(healthCredentials).toEqual([
      oldHandle.rendererToken,
      freshHandle.rendererToken,
    ]);
    for (const child of spawned) child.emitExit();
    await Promise.all([oldHandle.exited, freshHandle.exited]);
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
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');

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
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
    await start;

    child.stderr.write("post-ready diagnostic\n");
    child.emit("error", new Error("post-ready child error"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logs).toContain("post-ready diagnostic");
    expect(logs).toContain("Desktop sidecar process error: post-ready child error");
  });

  it("exposes one matching post-ready restart only after a clean drained exit", async () => {
    const child = fakeChild();
    const restarts: Array<{ type: string; bootId: string }> = [];
    const logs: string[] = [];
    const handlePromise = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      onRestartRequested: (event) => restarts.push(event),
      log: (line) => logs.push(line),
      startupTimeoutMs: 1_000,
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
    const handle = await handlePromise;

    child.stdout.write('@easyresearch-desktop {"type":"desktop.restart-requested","bootId":"boot-ready"}\n');
    child.emitExit();

    expect(restarts).toEqual([{ type: "desktop.restart-requested", bootId: "boot-ready" }]);
    await expect(handle.restartRequested).resolves.toEqual({
      type: "desktop.restart-requested",
      bootId: "boot-ready",
    });
    await expect(handle.exited).resolves.toEqual({
      code: 0,
      signal: null,
      expectedRestart: { type: "desktop.restart-requested", bootId: "boot-ready" },
    });
    expect(logs).not.toContain(expect.stringContaining("restart-requested"));
  });

  it("does not authorize a mismatched restart event", async () => {
    const child = fakeChild();
    const onRestartRequested = vi.fn();
    const killProcess = vi.fn(() => true);
    const logs: string[] = [];
    const handlePromise = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      onRestartRequested,
      log: (line) => logs.push(line),
      startupTimeoutMs: 1_000,
      platform: "darwin",
      killProcess,
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
    const handle = await handlePromise;

    child.stdout.write('@easyresearch-desktop {"type":"desktop.restart-requested","bootId":"boot-other"}\n');
    child.emitExit(1);

    expect(onRestartRequested).not.toHaveBeenCalled();
    expect(killProcess).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
    await expect(handle.exited).resolves.toEqual({
      code: 1,
      signal: null,
      protocolError: "Desktop sidecar restart identity did not match readiness.",
    });
    expect(logs).toContain("Desktop sidecar protocol error: restart identity did not match readiness.");
    expect(logs.join("\n")).not.toContain("boot-other");
  });

  it("invalidates duplicate restart events while invoking the callback at most once", async () => {
    const child = fakeChild();
    const onRestartRequested = vi.fn();
    const handlePromise = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      onRestartRequested,
      startupTimeoutMs: 1_000,
      platform: "darwin",
      killProcess: vi.fn(() => true),
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
    const handle = await handlePromise;

    const restartLine = '@easyresearch-desktop {"type":"desktop.restart-requested","bootId":"boot-ready"}\n';
    child.stdout.write(restartLine);
    child.stdout.write(restartLine);
    child.emitExit(1);

    expect(onRestartRequested).toHaveBeenCalledOnce();
    await expect(handle.exited).resolves.toEqual({
      code: 1,
      signal: null,
      protocolError: "Desktop sidecar emitted duplicate terminal machine events.",
    });
  });

  it("turns an invalid post-ready machine event into a safe protocol failure", async () => {
    const child = fakeChild();
    const logs: string[] = [];
    const handlePromise = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      log: (line) => logs.push(line),
      startupTimeoutMs: 1_000,
      platform: "darwin",
      killProcess: vi.fn(() => true),
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
    const handle = await handlePromise;

    child.stdout.write('@easyresearch-desktop {"type":"desktop.restart-requested","bootId":""}\n');
    child.emitExit(1);

    await expect(handle.exited).resolves.toEqual({
      code: 1,
      signal: null,
      protocolError: "Desktop sidecar emitted an invalid machine event.",
    });
    expect(logs).toContain("Desktop sidecar protocol error: invalid machine event.");
  });

  it("waits for stdout protocol bytes after process exit before classifying the exit", async () => {
    const child = fakeChild();
    const onRestartRequested = vi.fn();
    const handlePromise = startDesktopSidecar({
      sidecarPath: "/app/sidecar/easyresearch",
      baseEnv: {},
      spawn: (() => child) as never,
      fetch: async () => new Response("{}", { status: 200 }),
      createToken: (() => {
        const tokens = ["c".repeat(43), "r".repeat(43)];
        return () => tokens.shift()!;
      })(),
      onRestartRequested,
      startupTimeoutMs: 1_000,
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
    const handle = await handlePromise;

    child.emit("exit", 0, null);
    let classified = false;
    void handle.exited.then(() => {
      classified = true;
    });
    await Promise.resolve();
    expect(classified).toBe(false);
    child.stdout.write('@easyresearch-desktop {"type":"desktop.restart-requested","bootId":"boot-ready"}');
    child.emit("close", 0, null);

    await expect(handle.exited).resolves.toMatchObject({
      expectedRestart: { bootId: "boot-ready" },
    });
    expect(onRestartRequested).toHaveBeenCalledOnce();
  });

  it("does not signal an exited child while validating its final protocol bytes", async () => {
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
      platform: "darwin",
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
    const handle = await handlePromise;

    child.emit("exit", 1, null);
    child.stdout.write('@easyresearch-desktop {"type":"desktop.restart-requested","bootId":""}');
    child.emit("close", 1, null);

    await expect(handle.exited).resolves.toMatchObject({
      code: 1,
      protocolError: "Desktop sidecar emitted an invalid machine event.",
    });
    expect(child.kill).not.toHaveBeenCalled();
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
    const killProcess = vi.fn(() => true);
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
      killProcess,
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
    const handle = await handlePromise;

    vi.useFakeTimers();
    try {
      const shutdown = handle.shutdown();
      const rejected = expect(shutdown).rejects.toThrow(/did not exit after forced termination/i);
      await vi.advanceTimersByTimeAsync(5_020);
      await rejected;
      expect(killProcess).toHaveBeenCalledWith(-4242, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a nonzero Windows taskkill result as an authoritative force-termination failure", async () => {
    const actualChildProcess = await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
    const taskkill = vi.fn(() => ({ status: 1, signal: null, error: undefined }));
    vi.doMock("node:child_process", () => ({
      ...actualChildProcess,
      spawnSync: taskkill,
    }));
    vi.resetModules();
    try {
      const sidecar = await import("./sidecar");
      const child = fakeChild();
      const handlePromise = sidecar.startDesktopSidecar({
        sidecarPath: "/app/sidecar/easyresearch.exe",
        baseEnv: {},
        spawn: (() => child) as never,
        fetch: async () => new Response("{}", { status: 200 }),
        createToken: (() => {
          const tokens = ["c".repeat(43), "r".repeat(43)];
          return () => tokens.shift()!;
        })(),
        startupTimeoutMs: 1_000,
        platform: "win32",
        systemRoot: "C:\\Windows",
      });
      child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"C:\\\\tmp\\\\log","bootId":"boot-ready"}\n');
      const handle = await handlePromise;

      expect(() => handle.forceTerminate()).toThrow(/taskkill|status 1/i);
      expect(taskkill).toHaveBeenCalledOnce();
      child.emitExit(1);
      await handle.exited;
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("bounds Windows taskkill itself and treats a timeout as cleanup failure", async () => {
    const actualChildProcess = await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
    const timeoutError = Object.assign(new Error("taskkill timed out"), { code: "ETIMEDOUT" });
    const taskkill = vi.fn(() => ({ status: null, signal: "SIGTERM", error: timeoutError }));
    vi.doMock("node:child_process", () => ({
      ...actualChildProcess,
      spawnSync: taskkill,
    }));
    vi.resetModules();
    try {
      const sidecar = await import("./sidecar");
      const child = fakeChild();
      const handlePromise = sidecar.startDesktopSidecar({
        sidecarPath: "/app/sidecar/easyresearch.exe",
        baseEnv: {},
        spawn: (() => child) as never,
        fetch: async () => Response.json({ ok: true }),
        createToken: (() => {
          const tokens = ["c".repeat(43), "r".repeat(43)];
          return () => tokens.shift()!;
        })(),
        startupTimeoutMs: 1_000,
        platform: "win32",
        systemRoot: "C:\\Windows",
      });
      child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"C:\\\\tmp\\\\log","bootId":"boot-ready"}\n');
      const handle = await handlePromise;

      expect(() => handle.forceTerminate()).toThrow();
      expect(taskkill).toHaveBeenCalledWith(
        "C:\\Windows\\System32\\taskkill.exe",
        ["/PID", "4242", "/T", "/F"],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      const timeout = (taskkill.mock.calls[0] as unknown[] | undefined)?.[2] as
        | { timeout?: number }
        | undefined;
      expect(timeout?.timeout).toBeGreaterThan(0);
      child.emitExit(1);
      await handle.exited;
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("allows explicit cleanup to retry after force termination fails without discarding the child", async () => {
    const child = fakeChild();
    const killProcess = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("force kill failed");
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => child.emitExit(null, "SIGKILL"));
        return true;
      });
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
      killProcess,
    });
    child.stdout.write('@easyresearch-desktop {"type":"desktop.ready","origin":"http://127.0.0.1:43123","owner":"desktop","pid":4242,"logPath":"/tmp/log","bootId":"boot-ready"}\n');
    const handle = await handlePromise;

    vi.useFakeTimers();
    try {
      const first = handle.shutdown();
      const firstFailure = expect(first).rejects.toThrow("force kill failed");
      await vi.advanceTimersByTimeAsync(20);
      await firstFailure;

      const second = handle.shutdown();
      await vi.advanceTimersByTimeAsync(20);
      await expect(second).resolves.toBeUndefined();
      expect(killProcess).toHaveBeenCalledTimes(2);
      expect(killProcess).toHaveBeenCalledWith(-4242, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
      await expect(handle.exited).resolves.toMatchObject({ signal: "SIGKILL" });
    } finally {
      vi.useRealTimers();
    }
  });
});
