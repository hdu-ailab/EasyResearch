import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  spawnCliDaemon,
  startCliDaemon,
  startCliDaemonSuccessor,
  type DaemonLaunchSpec,
  type OwnedDaemonChild,
  waitForCliDaemonSuccessor,
} from "./daemon-spawn";
import {
  acquireServerLease,
  type RuntimeLease,
} from "./runtime-lease";
import {
  readServerProcess,
  removeServerPid,
  writeServerProcess,
  type ServerProcessRecord,
} from "./server-process";
import { captureInheritedProxyEnvironment } from "../runtime/network-policy";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-daemon-spawn-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function child(pid = 4321): OwnedDaemonChild {
  return {
    pid,
    unref: vi.fn(),
    terminate: vi.fn(),
    forceTerminate: vi.fn(() => {}),
    waitForExit: vi.fn(async () => true),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function transitionLease(): RuntimeLease & {
  readonly held: boolean;
  reserveHandoff: ReturnType<typeof vi.fn>;
  handoff: {
    readonly transferred: boolean;
    commit: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    relinquish: ReturnType<typeof vi.fn>;
  };
} {
  let held = true;
  let transferred = false;
  const handoff = {
    token: "fresh-token",
    get transferred() {
      return transferred;
    },
    commit: vi.fn(() => {
      transferred = true;
    }),
    cancel: vi.fn(() => true),
    relinquish: vi.fn(() => {
      if (!transferred) throw new Error("handoff was not committed");
      held = false;
    }),
  };
  const reserveHandoff = vi.fn(() => handoff);
  return {
    path: join(root, "server.transition.lease"),
    token: "transition-token",
    get held() {
      return held;
    },
    reserveHandoff,
    handoff,
    release: vi.fn(() => {
      if (!held) return false;
      held = false;
      return true;
    }),
  } as unknown as RuntimeLease & {
    readonly held: boolean;
    reserveHandoff: ReturnType<typeof vi.fn>;
    handoff: typeof handoff;
  };
}

describe("spawnCliDaemon", () => {
  it("runs the known TypeScript CLI entry through the current Bun executable in source mode", async () => {
    let launched: DaemonLaunchSpec | undefined;
    const owned = child();

    const result = await spawnCliDaemon({
      agentDir: root,
      daemonExecutable: "/agent/bin/easyresearch-daemon",
      sourceExecutable: "/opt/bun/bin/bun",
      sourceEntry: "/workspace/src/cli/index.ts",
      embedded: false,
      platform: "linux",
      host: "127.0.0.1",
      port: 3000,
      runtimeId: "runtime-current",
      environment: { KEEP: "yes" },
      transitionLease: transitionLease(),
    }, {
      randomToken: () => "fresh-token",
      launch: async (spec) => {
        launched = spec;
        return owned;
      },
    });

    expect(launched).toMatchObject({
      backend: "node",
      command: "/opt/bun/bin/bun",
      args: ["/workspace/src/cli/index.ts", "--serve", "127.0.0.1", "3000"],
    });
    expect(result).toMatchObject({ token: "fresh-token", child: owned });
    expect(owned.unref).not.toHaveBeenCalled();
  });

  it("runs the exact accepted daemon executable directly in compiled mode", async () => {
    let launched: DaemonLaunchSpec | undefined;

    await spawnCliDaemon({
      agentDir: root,
      daemonExecutable: "/agent/bin/easyresearch-daemon",
      sourceExecutable: "/ignored/bun",
      sourceEntry: "/ignored/index.ts",
      embedded: true,
      platform: "linux",
      host: "0.0.0.0",
      port: 4567,
      runtimeId: "runtime-current",
      environment: {},
      transitionLease: transitionLease(),
    }, {
      randomToken: () => "fresh-token",
      launch: async (spec) => {
        launched = spec;
        return child();
      },
    });

    expect(launched).toMatchObject({
      backend: "node",
      command: "/agent/bin/easyresearch-daemon",
      args: ["--serve", "0.0.0.0", "4567"],
    });
  });

  it("selects Bun's detached spawn backend only for a compiled Windows daemon", async () => {
    const launches: Array<{ backend: string; detached?: boolean }> = [];
    const launch = async (spec: DaemonLaunchSpec) => {
      launches.push({ backend: spec.backend, detached: spec.detached });
      return child();
    };
    const common = {
      agentDir: root,
      daemonExecutable: "C:\\agent\\easyresearch-daemon.exe",
      sourceExecutable: "C:\\bun\\bun.exe",
      sourceEntry: "C:\\workspace\\src\\cli\\index.ts",
      platform: "win32" as const,
      host: "127.0.0.1",
      port: 3000,
      runtimeId: "runtime-current",
      environment: {},
    };

    await spawnCliDaemon({ ...common, embedded: true, transitionLease: transitionLease() }, {
      randomToken: () => "compiled-token",
      launch,
    });
    await spawnCliDaemon({ ...common, embedded: false, transitionLease: transitionLease() }, {
      randomToken: () => "source-token",
      launch,
    });

    expect(launches).toEqual([
      { backend: "bun", detached: true },
      { backend: "node", detached: true },
    ]);
  });

  it("replaces stale private daemon controls with one fresh CLI identity", async () => {
    let launched: DaemonLaunchSpec | undefined;

    await spawnCliDaemon({
      agentDir: root,
      daemonExecutable: "/agent/bin/easyresearch-daemon",
      sourceExecutable: "/opt/bun/bin/bun",
      sourceEntry: "/workspace/src/cli/index.ts",
      embedded: true,
      platform: "linux",
      host: "127.0.0.1",
      port: 3000,
      runtimeId: "runtime-current",
      previousToken: "old-token",
      transitionLease: transitionLease(),
      environment: {
        EASYRESEARCH_DAEMON_TOKEN: "stale-token",
        EASYRESEARCH_DAEMON_RUNTIME_ID: "stale-runtime",
        EASYRESEARCH_DAEMON_OWNER: "desktop",
        KEEP: "yes",
      },
    }, {
      randomToken: () => "fresh-token",
      launch: async (spec) => {
        launched = spec;
        return child();
      },
    });

    expect(launched?.environment).toEqual({
      EASYRESEARCH_DAEMON_TOKEN: "fresh-token",
      EASYRESEARCH_DAEMON_RUNTIME_ID: "runtime-current",
      EASYRESEARCH_DAEMON_OWNER: "cli",
      KEEP: "yes",
    });
  });

  it("rejects an empty or reused launch token before spawning", async () => {
    const launch = vi.fn(async () => child());
    const options = {
      agentDir: root,
      daemonExecutable: "/agent/bin/easyresearch-daemon",
      sourceExecutable: "/opt/bun/bin/bun",
      sourceEntry: "/workspace/src/cli/index.ts",
      embedded: true,
      platform: "linux" as const,
      host: "127.0.0.1",
      port: 3000,
      runtimeId: "runtime-current",
      previousToken: "old-token",
      environment: {},
      transitionLease: transitionLease(),
    };

    await expect(spawnCliDaemon(options, {
      randomToken: () => "old-token",
      launch,
    })).rejects.toThrow(/fresh ownership token/i);
    await expect(spawnCliDaemon(options, {
      randomToken: () => "",
      launch,
    })).rejects.toThrow(/fresh ownership token/i);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("waitForCliDaemonSuccessor", () => {
  const expectedRecord = (): ServerProcessRecord => ({
    schema: 1,
    owner: "cli",
    pid: 222,
    host: "0.0.0.0",
    port: 3000,
    token: "fresh-token",
    runtimeId: "runtime-current",
  });

  function readinessFetch(options: {
    controlRuntimeId?: string;
    bootId?: string;
  } = {}): { fetch: typeof fetch; calls: Array<{ url: string; token: string | null }> } {
    const calls: Array<{ url: string; token: string | null }> = [];
    const fetchReady = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const token = new Headers(init?.headers).get("x-easyresearch-daemon-token");
      calls.push({ url, token });
      if (url.endsWith("/api/internal/daemon")) {
        return new Response(JSON.stringify({
          runtimeId: options.controlRuntimeId ?? "runtime-current",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ bootId: options.bootId ?? "boot-new" }), { status: 200 });
    }, { preconnect: globalThis.fetch.preconnect }) as typeof fetch;
    return { fetch: fetchReady, calls };
  }

  it("uses direct local HTTP by default instead of the configured global fetch router", async () => {
    const requests: Array<{ path: string; token?: string }> = [];
    const target = createServer((request, response) => {
      requests.push({
        path: request.url ?? "",
        token: typeof request.headers["x-easyresearch-daemon-token"] === "string"
          ? request.headers["x-easyresearch-daemon-token"]
          : undefined,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(
        request.url?.endsWith("/api/internal/daemon")
          ? { runtimeId: "runtime-current" }
          : { bootId: "boot-new" },
      ));
    });
    const port = await listen(target);
    writeServerProcess(root, { ...expectedRecord(), host: "127.0.0.1", port });
    const originalFetch = globalThis.fetch;
    const proxyRecords: Array<{ url: string; token: string | null }> = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      proxyRecords.push({
        url,
        token: new Headers(init?.headers).get("x-easyresearch-daemon-token"),
      });
      return Response.json(url.endsWith("/api/internal/daemon")
        ? { runtimeId: "runtime-current" }
        : { bootId: "boot-new" });
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;

    try {
      await expect(waitForCliDaemonSuccessor({
        agentDir: root,
        host: "127.0.0.1",
        port,
        runtimeId: "runtime-current",
        token: "fresh-token",
        oldBootId: "boot-old",
        oldPid: 111,
        expectedPid: 222,
        timeoutMs: 1_000,
      })).resolves.toBe(true);

      expect(requests).toEqual([
        { path: "/api/internal/daemon", token: "fresh-token" },
        { path: "/api/status", token: undefined },
      ]);
      expect(proxyRecords).toEqual([]);
      expect(JSON.stringify(proxyRecords)).not.toContain("fresh-token");
    } finally {
      globalThis.fetch = originalFetch;
      await close(target);
    }
  });

  it("accepts only the expected fresh record plus authenticated control and a changed boot id", async () => {
    writeServerProcess(root, expectedRecord());
    const probe = readinessFetch();

    await expect(waitForCliDaemonSuccessor({
      agentDir: root,
      host: "0.0.0.0",
      port: 3000,
      runtimeId: "runtime-current",
      token: "fresh-token",
      oldBootId: "boot-old",
      oldPid: 111,
      expectedPid: 222,
      timeoutMs: 0,
    }, { fetch: probe.fetch })).resolves.toBe(true);

    expect(probe.calls).toEqual([
      {
        url: "http://127.0.0.1:3000/api/internal/daemon",
        token: "fresh-token",
      },
      {
        url: "http://127.0.0.1:3000/api/status",
        token: null,
      },
    ]);
  });

  it.each([
    ["token", { token: "another-token" }, {}],
    ["owner", { owner: "desktop" as const }, {}],
    ["host", { host: "127.0.0.1" }, {}],
    ["port", { port: 3001 }, {}],
    ["runtime", { runtimeId: "runtime-other" }, {}],
    ["old pid", { pid: 111 }, {}],
    ["unexpected child pid", { pid: 333 }, {}],
    ["control runtime", {}, { controlRuntimeId: "runtime-other" }],
    ["unchanged boot", {}, { bootId: "boot-old" }],
    ["empty boot", {}, { bootId: "" }],
  ])("rejects a %s mismatch", async (_name, recordPatch, responsePatch) => {
    writeServerProcess(root, { ...expectedRecord(), ...recordPatch });
    const probe = readinessFetch(responsePatch);

    await expect(waitForCliDaemonSuccessor({
      agentDir: root,
      host: "0.0.0.0",
      port: 3000,
      runtimeId: "runtime-current",
      token: "fresh-token",
      oldBootId: "boot-old",
      oldPid: 111,
      expectedPid: 222,
      timeoutMs: 0,
    }, { fetch: probe.fetch })).resolves.toBe(false);
  });

  it("does not start the status probe after authenticated control consumes the deadline", async () => {
    writeServerProcess(root, expectedRecord());
    let now = 100;
    const calls: string[] = [];
    const fetchSlow = Object.assign(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/internal/daemon")) {
        now = 111;
        return new Response(JSON.stringify({ runtimeId: "runtime-current" }), { status: 200 });
      }
      return new Response(JSON.stringify({ bootId: "boot-new" }), { status: 200 });
    }, { preconnect: globalThis.fetch.preconnect }) as typeof fetch;

    await expect(waitForCliDaemonSuccessor({
      agentDir: root,
      host: "0.0.0.0",
      port: 3000,
      runtimeId: "runtime-current",
      token: "fresh-token",
      oldBootId: "boot-old",
      oldPid: 111,
      expectedPid: 222,
      timeoutMs: 10,
    }, {
      fetch: fetchSlow,
      now: () => now,
    })).resolves.toBe(false);

    expect(calls).toEqual(["http://127.0.0.1:3000/api/internal/daemon"]);
  });
});

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
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

describe("startCliDaemonSuccessor", () => {
  function successorOptions() {
    return {
      agentDir: root,
      daemonExecutable: "/agent/bin/easyresearch-daemon",
      sourceExecutable: "/opt/bun/bin/bun",
      sourceEntry: "/workspace/src/cli/index.ts",
      embedded: true,
      platform: "linux" as const,
      host: "127.0.0.1",
      port: 3000,
      runtimeId: "runtime-current",
      previousToken: "old-token",
      oldBootId: "boot-old",
      oldPid: 111,
      currentEnvironment: {
        HTTP_PROXY: "http://applied.example",
        http_proxy: "http://applied.example",
        HTTPS_PROXY: "http://applied.example",
        https_proxy: "http://applied.example",
        ALL_PROXY: "http://applied.example",
        all_proxy: "http://applied.example",
        NO_PROXY: "localhost,127.0.0.1,::1",
        no_proxy: "localhost,127.0.0.1,::1",
        PLAYWRIGHT_MCP_PROXY_SERVER: "http://applied.example",
        PLAYWRIGHT_MCP_PROXY_BYPASS: "localhost,127.0.0.1,::1",
        EASYRESEARCH_DAEMON_TOKEN: "old-token",
        EASYRESEARCH_DAEMON_RUNTIME_ID: "runtime-current",
        EASYRESEARCH_DAEMON_OWNER: "cli",
        KEEP: "yes",
      },
      startupBaseline: captureInheritedProxyEnvironment({
        HTTPS_PROXY: "http://ambient.example:8080",
        NO_PROXY: "ambient.internal",
        PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://ambient-browser.example:1080",
      }),
      readyTimeoutMs: 0,
      cleanupTimeoutMs: 17,
      transitionLease: transitionLease(),
    };
  }

  function successfulFetch(order: string[]): typeof fetch {
    return Object.assign(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/internal/daemon")) {
        order.push("authenticated-ready");
        return new Response(JSON.stringify({ runtimeId: "runtime-current" }), { status: 200 });
      }
      order.push("boot-ready");
      return new Response(JSON.stringify({ bootId: "boot-new" }), { status: 200 });
    }, { preconnect: globalThis.fetch.preconnect }) as typeof fetch;
  }

  it("restores the startup baseline and keeps the exact child owned through authenticated readiness", async () => {
    const order: string[] = [];
    let launched: DaemonLaunchSpec | undefined;
    const owned = child(222);
    vi.mocked(owned.unref).mockImplementation(() => order.push("unref"));

    await startCliDaemonSuccessor(successorOptions(), {
      randomToken: () => "fresh-token",
      launch: async (spec) => {
        order.push("spawn");
        launched = spec;
        writeServerProcess(root, {
          schema: 1,
          owner: "cli",
          pid: 222,
          host: "127.0.0.1",
          port: 3000,
          token: "fresh-token",
          runtimeId: "runtime-current",
        });
        return owned;
      },
      fetch: successfulFetch(order),
    });

    expect(order).toEqual(["spawn", "authenticated-ready", "boot-ready", "unref"]);
    expect(launched).toMatchObject({
      command: "/agent/bin/easyresearch-daemon",
      args: ["--serve", "127.0.0.1", "3000"],
      environment: {
        HTTPS_PROXY: "http://ambient.example:8080",
        NO_PROXY: "ambient.internal",
        PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://ambient-browser.example:1080",
        EASYRESEARCH_DAEMON_TOKEN: "fresh-token",
        EASYRESEARCH_DAEMON_RUNTIME_ID: "runtime-current",
        EASYRESEARCH_DAEMON_OWNER: "cli",
        KEEP: "yes",
      },
    });
    expect(launched?.environment.HTTP_PROXY).toBeUndefined();
    expect(launched?.environment.PLAYWRIGHT_MCP_PROXY_BYPASS).toBeUndefined();
    expect(JSON.stringify(launched?.environment)).not.toContain("boot-old");
    expect(owned.terminate).not.toHaveBeenCalled();
  });

  it("arms transition handoff before spawn and publishes the child pid before readiness", async () => {
    const order: string[] = [];
    const owned = child(222);
    const transition = transitionLease();
    transition.reserveHandoff.mockImplementation((token: string) => {
      order.push(`reserve:${token}`);
      return transition.handoff;
    });
    transition.handoff.commit.mockImplementation((pid: number) => {
      order.push(`commit:${pid}`);
    });

    await startCliDaemonSuccessor({
      ...successorOptions(),
      transitionLease: transition,
    } as never, {
      randomToken: () => "fresh-token",
      launch: async () => {
        order.push("spawn");
        writeServerProcess(root, {
          schema: 1,
          owner: "cli",
          pid: 222,
          host: "127.0.0.1",
          port: 3000,
          token: "fresh-token",
          runtimeId: "runtime-current",
        });
        return owned;
      },
      fetch: Object.assign(async (input: string | URL | Request) => {
        order.push(String(input).endsWith("/api/internal/daemon") ? "control" : "status");
        return Response.json(String(input).endsWith("/api/internal/daemon")
          ? { runtimeId: "runtime-current" }
          : { bootId: "boot-new" });
      }, { preconnect: globalThis.fetch.preconnect }) as typeof fetch,
    });

    expect(order).toEqual([
      "reserve:fresh-token",
      "spawn",
      "commit:222",
      "control",
      "status",
    ]);
    expect(transition.held).toBe(true);
    expect(transition.handoff.relinquish).not.toHaveBeenCalled();
  });

  it("does not spawn when durable handoff reservation cannot be created", async () => {
    const transition = transitionLease();
    const reservationError = new Error("handoff reservation write denied");
    transition.reserveHandoff.mockImplementation(() => {
      throw reservationError;
    });
    const launch = vi.fn(async () => child(222));

    await expect(startCliDaemonSuccessor({
      ...successorOptions(),
      transitionLease: transition,
    } as never, {
      randomToken: () => "fresh-token",
      launch,
    })).rejects.toBe(reservationError);

    expect(launch).not.toHaveBeenCalled();
    expect(transition.held).toBe(true);
  });

  it("cleans the child before cancelling a handoff whose child-record write fails", async () => {
    const transition = transitionLease();
    const owned = child(222);
    const childRecordError = new Error("child transition record write denied");
    const order: string[] = [];
    transition.handoff.commit.mockImplementation(() => {
      order.push("commit-failed");
      throw childRecordError;
    });
    vi.mocked(owned.terminate).mockImplementation(() => {
      order.push("terminate");
    });
    vi.mocked(owned.waitForExit).mockImplementation(async () => {
      order.push("exited");
      return true;
    });
    transition.handoff.cancel.mockImplementation(() => {
      order.push("cancel");
      return true;
    });
    const fetchReady = vi.fn();

    await expect(startCliDaemonSuccessor({
      ...successorOptions(),
      transitionLease: transition,
    } as never, {
      randomToken: () => "fresh-token",
      launch: async () => owned,
      fetch: fetchReady as unknown as typeof fetch,
    })).rejects.toBe(childRecordError);

    expect(order).toEqual(["commit-failed", "terminate", "exited", "cancel"]);
    expect(fetchReady).not.toHaveBeenCalled();
    expect(transition.held).toBe(true);
  });

  it("terminates a failed child without tokenlessly deleting its late matching record", async () => {
    const owned = child(222);
    vi.mocked(owned.waitForExit).mockImplementation(async (timeoutMs) => {
      expect(timeoutMs).toBe(17);
      writeServerProcess(root, {
        schema: 1,
        owner: "cli",
        pid: 222,
        host: "127.0.0.1",
        port: 3000,
        token: "fresh-token",
        runtimeId: "runtime-current",
      });
      return true;
    });

    await expect(startCliDaemonSuccessor(successorOptions(), {
      randomToken: () => "fresh-token",
      launch: async () => owned,
    })).rejects.toThrow(/authenticated readiness/i);

    expect(owned.unref).not.toHaveBeenCalled();
    expect(owned.terminate).toHaveBeenCalledOnce();
    expect(owned.waitForExit).toHaveBeenCalledOnce();
    expect(readServerProcess(root)).toEqual({
      kind: "owned",
      record: expect.objectContaining({ token: "fresh-token", pid: 222 }),
    });
  });

  it("force-terminates a failed successor when graceful cleanup does not confirm exit", async () => {
    const owned = child(222);
    vi.mocked(owned.waitForExit)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(startCliDaemonSuccessor(successorOptions(), {
      randomToken: () => "fresh-token",
      launch: async () => owned,
    })).rejects.toThrow(/authenticated readiness/i);

    expect(owned.terminate).toHaveBeenCalledOnce();
    expect(owned.forceTerminate).toHaveBeenCalledOnce();
    expect(owned.waitForExit).toHaveBeenNthCalledWith(1, 17);
    expect(owned.waitForExit).toHaveBeenNthCalledWith(2, 17);
  });

  it("leaves a child-pid transition record when a successor survives forced termination", async () => {
    const owned = child(222);
    vi.mocked(owned.waitForExit).mockResolvedValue(false);
    const transition = transitionLease();

    await expect(startCliDaemonSuccessor({
      ...successorOptions(),
      transitionLease: transition,
    } as never, {
      randomToken: () => "fresh-token",
      launch: async () => owned,
    })).rejects.toThrow(/did not exit after forced termination/i);

    expect(transition.reserveHandoff).toHaveBeenCalledWith("fresh-token");
    expect(transition.handoff.commit).toHaveBeenCalledWith(222);
    expect(transition.handoff.relinquish).toHaveBeenCalledOnce();
    expect(transition.held).toBe(false);
    expect(owned.terminate).toHaveBeenCalledOnce();
    expect(owned.forceTerminate).toHaveBeenCalledOnce();
    expect(owned.waitForExit).toHaveBeenCalledTimes(2);
  });

  it("never removes another token's record during late child cleanup", async () => {
    const owned = child(222);
    vi.mocked(owned.waitForExit).mockImplementation(async () => {
      writeServerProcess(root, {
        schema: 1,
        owner: "cli",
        pid: 333,
        host: "127.0.0.1",
        port: 3000,
        token: "another-token",
        runtimeId: "runtime-current",
      });
      return true;
    });

    await expect(startCliDaemonSuccessor(successorOptions(), {
      randomToken: () => "fresh-token",
      launch: async () => owned,
    })).rejects.toThrow(/authenticated readiness/i);

    const entry = readServerProcess(root);
    expect(entry.kind).toBe("owned");
    if (entry.kind !== "owned") throw new Error("expected another owner record");
    expect(entry.record.token).toBe("another-token");
  });

  it("does not retry when the single successor spawn fails", async () => {
    const launch = vi.fn(async () => {
      throw new Error("spawn failed");
    });

    await expect(startCliDaemonSuccessor(successorOptions(), {
      randomToken: () => "fresh-token",
      launch,
    })).rejects.toThrow("spawn failed");

    expect(launch).toHaveBeenCalledOnce();
  });

  it("aborts pending readiness and boundedly cleans only the expected owned child", async () => {
    const controller = new AbortController();
    const readinessStarted = deferred<void>();
    let now = 0;
    let readinessSignal: AbortSignal | undefined;
    const owned = child(222);
    const serverLease = await acquireServerLease(root, "cli", "fresh-token");
    vi.mocked(owned.waitForExit)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const fetchReady = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        expect(new Headers(init.headers).get("x-easyresearch-daemon-token")).toBe("fresh-token");
        removeServerPid(root, "fresh-token", serverLease);
        serverLease.release();
        return Response.json({ ok: true });
      }
      readinessSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      readinessStarted.resolve();
      if (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return new Response(url.endsWith("/api/internal/daemon") ? "unavailable" : "{}", {
        status: 503,
      });
    });
    const starting = startCliDaemonSuccessor({
      ...successorOptions(),
      readyTimeoutMs: 30_000,
      signal: controller.signal,
    } as Parameters<typeof startCliDaemonSuccessor>[0], {
      randomToken: () => "fresh-token",
      launch: async () => {
        writeServerProcess(root, {
          schema: 1,
          owner: "cli",
          pid: 222,
          host: "127.0.0.1",
          port: 3000,
          token: "fresh-token",
          runtimeId: "runtime-current",
        });
        return owned;
      },
      fetch: fetchReady,
      now: () => now,
      wait: async () => {
        now = 30_000;
      },
    });

    await readinessStarted.promise;
    controller.abort(new Error("terminal shutdown"));
    await expect(starting).resolves.toBeUndefined();

    expect(readinessSignal?.aborted).toBe(true);
    expect(owned.unref).not.toHaveBeenCalled();
    expect(owned.terminate).toHaveBeenCalledOnce();
    expect(owned.forceTerminate).toHaveBeenCalledOnce();
    expect(owned.waitForExit).toHaveBeenNthCalledWith(1, 17);
    expect(owned.waitForExit).toHaveBeenNthCalledWith(2, 17);
    expect(readServerProcess(root)).toEqual({ kind: "missing" });
  });
});

describe("startCliDaemon initial ownership", () => {
  function initialOptions() {
    return {
      agentDir: root,
      daemonExecutable: "/agent/bin/easyresearch-daemon",
      sourceExecutable: "/opt/bun/bin/bun",
      sourceEntry: "/workspace/src/cli/index.ts",
      embedded: true,
      platform: "linux" as const,
      host: "127.0.0.1",
      port: 3000,
      runtimeId: "runtime-current",
      environment: { KEEP: "yes" },
      readyTimeoutMs: 30_000,
      cleanupTimeoutMs: 17,
      transitionLease: transitionLease(),
    };
  }

  it("retains the fresh child until its record, authenticated control, and nonempty boot are ready", async () => {
    const owned = child(222);
    const statusRequested = deferred<void>();
    const statusResponse = deferred<Response>();
    const fetchReady = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/internal/daemon")) {
        return Response.json({ runtimeId: "runtime-current" });
      }
      statusRequested.resolve();
      return statusResponse.promise;
    });
    const starting = startCliDaemon(initialOptions(), {
      randomToken: () => "fresh-token",
      launch: async () => {
        writeServerProcess(root, {
          schema: 1,
          owner: "cli",
          pid: 222,
          host: "127.0.0.1",
          port: 3000,
          token: "fresh-token",
          runtimeId: "runtime-current",
        });
        return owned;
      },
      fetch: fetchReady,
    });

    await statusRequested.promise;
    expect(owned.unref).not.toHaveBeenCalled();
    expect(owned.terminate).not.toHaveBeenCalled();
    statusResponse.resolve(Response.json({ bootId: "boot-initial" }));
    await expect(starting).resolves.toBeUndefined();

    expect(owned.unref).toHaveBeenCalledOnce();
    expect(owned.terminate).not.toHaveBeenCalled();
  });

  it("uses the initial CLI transition handle before spawning its first daemon", async () => {
    const transition = transitionLease();
    const owned = child(222);
    const order: string[] = [];
    transition.reserveHandoff.mockImplementation(() => {
      order.push("reserve");
      return transition.handoff;
    });
    transition.handoff.commit.mockImplementation(() => {
      order.push("commit");
    });

    await startCliDaemon({
      ...initialOptions(),
      readyTimeoutMs: 0,
      transitionLease: transition,
    } as never, {
      randomToken: () => "fresh-token",
      launch: async () => {
        order.push("spawn");
        writeServerProcess(root, {
          schema: 1,
          owner: "cli",
          pid: 222,
          host: "127.0.0.1",
          port: 3000,
          token: "fresh-token",
          runtimeId: "runtime-current",
        });
        return owned;
      },
      fetch: Object.assign(async (input: string | URL | Request) => {
        order.push("ready");
        return Response.json(String(input).endsWith("/api/internal/daemon")
          ? { runtimeId: "runtime-current" }
          : { bootId: "boot-initial" });
      }, { preconnect: globalThis.fetch.preconnect }) as typeof fetch,
    });

    expect(order).toEqual(["reserve", "spawn", "commit", "ready", "ready"]);
    expect(transition.held).toBe(true);
  });

  it("clears a pre-spawn reservation after launch fails without surrendering the parent lease", async () => {
    const transition = transitionLease();
    const launchError = new Error("spawn failed");

    await expect(startCliDaemon({
      ...initialOptions(),
      transitionLease: transition,
    } as never, {
      randomToken: () => "fresh-token",
      launch: async () => {
        throw launchError;
      },
    })).rejects.toBe(launchError);

    expect(transition.reserveHandoff).toHaveBeenCalledWith("fresh-token");
    expect(transition.handoff.cancel).toHaveBeenCalledOnce();
    expect(transition.held).toBe(true);
  });

  it("rejects an arbitrary HTTP 200 without the exact owned record and cleans the child boundedly", async () => {
    const owned = child(222);
    const fetchReady = vi.fn(async () => Response.json({
      runtimeId: "runtime-current",
      bootId: "boot-arbitrary",
    }));

    await expect(startCliDaemon({
      ...initialOptions(),
      readyTimeoutMs: 0,
    }, {
      randomToken: () => "fresh-token",
      launch: async () => owned,
      fetch: fetchReady,
    })).rejects.toThrow(/authenticated readiness/i);

    expect(fetchReady).not.toHaveBeenCalled();
    expect(owned.unref).not.toHaveBeenCalled();
    expect(owned.terminate).toHaveBeenCalledOnce();
    expect(owned.waitForExit).toHaveBeenCalledWith(17);
  });

  it("leaves a late matching initial record for a later lease owner to replace", async () => {
    const owned = child(222);
    vi.mocked(owned.waitForExit).mockImplementation(async (timeoutMs) => {
      expect(timeoutMs).toBe(17);
      writeServerProcess(root, {
        schema: 1,
        owner: "cli",
        pid: 222,
        host: "127.0.0.1",
        port: 3000,
        token: "fresh-token",
        runtimeId: "runtime-current",
      });
      return true;
    });

    await expect(startCliDaemon({
      ...initialOptions(),
      readyTimeoutMs: 0,
    }, {
      randomToken: () => "fresh-token",
      launch: async () => owned,
    })).rejects.toThrow(/authenticated readiness/i);

    expect(owned.unref).not.toHaveBeenCalled();
    expect(readServerProcess(root)).toEqual({
      kind: "owned",
      record: expect.objectContaining({ token: "fresh-token", pid: 222 }),
    });
  });

  it("retains cleanup ownership when readiness infrastructure throws", async () => {
    const owned = child(222);
    const readinessError = new Error("readiness clock failed");

    await expect(startCliDaemon(initialOptions(), {
      randomToken: () => "fresh-token",
      launch: async () => owned,
      now: () => {
        throw readinessError;
      },
    })).rejects.toBe(readinessError);

    expect(owned.unref).not.toHaveBeenCalled();
    expect(owned.terminate).toHaveBeenCalledOnce();
    expect(owned.waitForExit).toHaveBeenCalledWith(17);
  });

  it("leaves the initial transition with the surviving child after forced cleanup", async () => {
    const owned = child(222);
    vi.mocked(owned.waitForExit).mockResolvedValue(false);
    const transition = transitionLease();

    await expect(startCliDaemon({
      ...initialOptions(),
      readyTimeoutMs: 0,
      transitionLease: transition,
    } as never, {
      randomToken: () => "fresh-token",
      launch: async () => owned,
    })).rejects.toThrow(/did not exit after forced termination/i);

    expect(transition.reserveHandoff).toHaveBeenCalledWith("fresh-token");
    expect(transition.handoff.commit).toHaveBeenCalledWith(222);
    expect(transition.handoff.relinquish).toHaveBeenCalledOnce();
    expect(transition.held).toBe(false);
    expect(owned.unref).not.toHaveBeenCalled();
  });
});
