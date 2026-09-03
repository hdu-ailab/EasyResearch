import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAEMON_RUNTIME_ID_ENV,
  DAEMON_TOKEN_ENV,
  DAEMON_OWNER_ENV,
  readServerPid,
  readServerProcess,
  serverOwner,
  writeServerProcess,
} from "../server-process";

const [loggerMock, createLoggerMock] = vi.hoisted(() => {
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return [mockLogger, vi.fn(() => mockLogger)] as const;
});

const [piImportMock] = vi.hoisted(() => [{
  agentDir: "",
  onGetAgentDir: undefined as (() => void) | undefined,
}]);
const [bootstrapMock, startServerMock] = vi.hoisted(() => [vi.fn(), vi.fn()]);
const [serverLeaseMock, serverLeaseState, acquireServerLeaseMock] = vi.hoisted(() => {
  const state = { held: true, token: "launch-token", path: "server.lease" };
  const lease = {
    get path() {
      return state.path;
    },
    get token() {
      return state.token;
    },
    get held() {
      return state.held;
    },
    release: vi.fn(() => {
      if (!state.held) return false;
      state.held = false;
      return true;
    }),
  };
  return [
    lease,
    state,
    vi.fn(async (_root: string, _owner: "cli" | "desktop", token: string) => {
      state.token = token;
      return lease;
    }),
  ] as const;
});
const [transitionLeaseMock, transitionLeaseState, acquireTransitionLeaseMock, transitionHandoffMock] = vi.hoisted(() => {
  const state = { held: true, transferred: false };
  const handoff = {
    token: "surviving-child-token",
    get transferred() {
      return state.transferred;
    },
    commit: vi.fn(() => {
      state.transferred = true;
    }),
    cancel: vi.fn(() => true),
    relinquish: vi.fn(() => {
      if (!state.transferred) throw new Error("handoff was not committed");
      state.held = false;
    }),
  };
  const lease = {
    path: "transition.lease",
    token: "transition-token",
    get held() {
      return state.held;
    },
    reserveHandoff: vi.fn(() => handoff),
    release: vi.fn(() => {
      if (!state.held) return false;
      state.held = false;
      return true;
    }),
  };
  return [lease, state, vi.fn(async () => lease), handoff] as const;
});
const [startCliDaemonSuccessorMock] = vi.hoisted(() => [vi.fn(async (_options: unknown) => {})]);

vi.mock("../../runtime/logger", () => ({
  createLogger: createLoggerMock,
  dayStamp: () => "2026-08-21",
  resolveLogConfig: (agentDir: string) => ({ logDir: join(agentDir, "logs") }),
}));

vi.mock("../../runtime/pi-import", () => ({
  getAgentDir: () => {
    piImportMock.onGetAgentDir?.();
    return piImportMock.agentDir;
  },
}));

const bootstrapError = new Error("EADDRINUSE: address already in use :::3000");
vi.mock("../../bootstrap/resources", () => ({
  bootstrapBundledResources: bootstrapMock,
}));

vi.mock("../../web/server", () => ({
  startServer: startServerMock,
}));

vi.mock("../runtime-lease", () => ({
  acquireServerLease: acquireServerLeaseMock,
  acquireTransitionLease: acquireTransitionLeaseMock,
}));

vi.mock("../daemon-spawn", () => ({
  startCliDaemonSuccessor: startCliDaemonSuccessorMock,
}));

let root: string;

const NETWORK_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "PLAYWRIGHT_MCP_PROXY_SERVER",
  "PLAYWRIGHT_MCP_PROXY_BYPASS",
] as const;
let networkEnvSnapshot: Partial<Record<(typeof NETWORK_ENV_KEYS)[number], string>>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-serve-"));
  networkEnvSnapshot = {};
  for (const key of NETWORK_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) networkEnvSnapshot[key] = value;
    delete process.env[key];
  }
  piImportMock.agentDir = root;
  piImportMock.onGetAgentDir = undefined;
  bootstrapMock.mockReset().mockRejectedValue(bootstrapError);
  startServerMock.mockReset();
  process.env[DAEMON_TOKEN_ENV] = "launch-token";
  process.env[DAEMON_RUNTIME_ID_ENV] = "runtime-current";
  process.env[DAEMON_OWNER_ENV] = "cli";
  serverLeaseState.held = true;
  serverLeaseState.token = "launch-token";
  serverLeaseState.path = join(root, "server.lease");
  serverLeaseMock.release.mockReset().mockImplementation(() => {
    if (!serverLeaseState.held) return false;
    serverLeaseState.held = false;
    return true;
  });
  acquireServerLeaseMock.mockReset().mockImplementation(async (_root, _owner, token) => {
    serverLeaseState.path = join(_root, "server.lease");
    serverLeaseState.token = token;
    return serverLeaseMock;
  });
  transitionLeaseState.held = true;
  transitionLeaseState.transferred = false;
  transitionLeaseMock.release.mockReset().mockImplementation(() => {
    if (!transitionLeaseState.held) return false;
    transitionLeaseState.held = false;
    return true;
  });
  transitionLeaseMock.reserveHandoff.mockReset().mockImplementation(() => transitionHandoffMock);
  transitionHandoffMock.commit.mockReset().mockImplementation(() => {
    transitionLeaseState.transferred = true;
  });
  transitionHandoffMock.cancel.mockReset().mockReturnValue(true);
  transitionHandoffMock.relinquish.mockReset().mockImplementation(() => {
    if (!transitionLeaseState.transferred) throw new Error("handoff was not committed");
    transitionLeaseState.held = false;
  });
  acquireTransitionLeaseMock.mockReset().mockResolvedValue(transitionLeaseMock);
  startCliDaemonSuccessorMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const key of NETWORK_ENV_KEYS) {
    const value = networkEnvSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
  delete process.env[DAEMON_TOKEN_ENV];
  delete process.env[DAEMON_RUNTIME_ID_ENV];
  delete process.env[DAEMON_OWNER_ENV];
  vi.clearAllMocks();
});

function readNetworkEnvironment(): Partial<Record<(typeof NETWORK_ENV_KEYS)[number], string>> {
  const values: Partial<Record<(typeof NETWORK_ENV_KEYS)[number], string>> = {};
  for (const key of NETWORK_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) values[key] = value;
  }
  return values;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("runServe startup failure", () => {
  it("restores and consumes daemon credentials before agent-dir or owner reads without resurrecting them", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockRejectedValue(new Error("bind failed"));
    delete process.env[DAEMON_TOKEN_ENV];
    delete process.env[DAEMON_RUNTIME_ID_ENV];
    delete process.env[DAEMON_OWNER_ENV];
    const environment: Record<string, string | undefined> = {};
    const privateToken = "sandbox-daemon-token";
    const readEnviron = vi.fn(() => [
      `EASYRESEARCH_DAEMON_TOKEN=${privateToken}`,
      "EASYRESEARCH_DAEMON_RUNTIME_ID=sandbox-runtime",
      "EASYRESEARCH_DAEMON_OWNER=cli",
      "HTTPS_PROXY=http://sandbox.proxy:8443",
    ].join("\0"));
    let environmentAtAgentDir: Record<string, string | undefined> | undefined;
    piImportMock.onGetAgentDir = () => {
      environmentAtAgentDir = { ...environment };
    };

    const { runServe } = await import("./serve");
    expect(await runServe("127.0.0.1", 3000, {
      environment,
      environmentRestore: { isBun: true, readEnviron },
    } as never)).toBe(1);

    expect(environmentAtAgentDir).toMatchObject({ HTTPS_PROXY: "http://sandbox.proxy:8443" });
    expect(environmentAtAgentDir).not.toHaveProperty(DAEMON_TOKEN_ENV);
    expect(environmentAtAgentDir).not.toHaveProperty(DAEMON_RUNTIME_ID_ENV);
    expect(environmentAtAgentDir).not.toHaveProperty(DAEMON_OWNER_ENV);
    expect(startServerMock.mock.calls[0]?.[0]?.daemonControl).toMatchObject({
      token: privateToken,
      runtimeId: "sandbox-runtime",
    });
    expect(environment).not.toHaveProperty(DAEMON_TOKEN_ENV);
    expect(environment).not.toHaveProperty(DAEMON_RUNTIME_ID_ENV);
    expect(environment).not.toHaveProperty(DAEMON_OWNER_ENV);
    expect(readEnviron).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "configured All traffic",
      settings: {
        httpProxy: " HTTP://ALL.EXAMPLE:80/ ",
        easyresearch: { network: { llmProxy: "https://LLM.EXAMPLE:443/" } },
      },
      configured: { all: "http://all.example", llm: "https://llm.example" },
      sources: { all: "configured", llm: "configured", search: "all" },
      appliedProxy: "http://all.example",
    },
    {
      name: "ambient proxy values without product settings",
      settings: {},
      configured: {},
      sources: { all: "environment", llm: "environment", search: "environment" },
      appliedProxy: "http://ambient.example:8080",
    },
  ])("applies $name before bootstrap and passes immutable policy to Web", async ({
    settings,
    configured,
    sources,
    appliedProxy,
  }) => {
    writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
    Object.assign(process.env, {
      HTTPS_PROXY: "http://ambient.example:8080",
      NO_PROXY: "ambient.internal",
      PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://ambient-browser.example:1080",
      PLAYWRIGHT_MCP_PROXY_BYPASS: "browser.internal",
    });
    let bootstrapEnvironment: ReturnType<typeof readNetworkEnvironment> | undefined;
    let startOptions: Record<string, unknown> | undefined;
    bootstrapMock.mockImplementation(async () => {
      bootstrapEnvironment = readNetworkEnvironment();
      expect(process.env[DAEMON_TOKEN_ENV]).toBeUndefined();
      expect(process.env[DAEMON_RUNTIME_ID_ENV]).toBeUndefined();
      expect(process.env[DAEMON_OWNER_ENV]).toBeUndefined();
    });
    startServerMock.mockImplementation(async (options) => {
      expect(process.env[DAEMON_TOKEN_ENV]).toBeUndefined();
      expect(process.env[DAEMON_RUNTIME_ID_ENV]).toBeUndefined();
      expect(process.env[DAEMON_OWNER_ENV]).toBeUndefined();
      startOptions = options as Record<string, unknown>;
      throw new Error("bind failed");
    });

    const { runServe } = await import("./serve");
    expect(await runServe("127.0.0.1", 3000)).toBe(1);

    const policy = startOptions?.networkPolicy as {
      configured: Record<string, string>;
      sources: Record<string, string>;
      errors: readonly unknown[];
    } | undefined;
    expect(policy).toMatchObject({ configured, sources, errors: [] });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy?.configured)).toBe(true);
    expect(Object.isFrozen(policy?.sources)).toBe(true);
    expect(Object.isFrozen(policy?.errors)).toBe(true);
    expect(startOptions).not.toHaveProperty("networkBaseline");
    expect(JSON.stringify(policy)).not.toContain("launch-token");

    if (configured.all) {
      expect(bootstrapEnvironment).toMatchObject({
        HTTP_PROXY: appliedProxy,
        http_proxy: appliedProxy,
        HTTPS_PROXY: appliedProxy,
        https_proxy: appliedProxy,
        ALL_PROXY: appliedProxy,
        all_proxy: appliedProxy,
        PLAYWRIGHT_MCP_PROXY_SERVER: appliedProxy,
      });
    } else {
      expect(bootstrapEnvironment).toMatchObject({
        HTTPS_PROXY: appliedProxy,
        PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://ambient-browser.example:1080",
        PLAYWRIGHT_MCP_PROXY_BYPASS: "browser.internal",
      });
      expect(bootstrapEnvironment).not.toHaveProperty("HTTP_PROXY");
    }
    expect(readNetworkEnvironment()).toEqual(bootstrapEnvironment);
  });

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
      bootId: expect.any(String),
      networkPolicy: expect.any(Object),
      daemonControl: expect.objectContaining({
        token: "launch-token",
        runtimeId: "runtime-current",
        requestShutdown: expect.any(Function),
      }),
    });
    expect(readServerPid(root)).toBeUndefined();
  });

  it("publishes an explicit desktop owner and renderer access after an ephemeral bind", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    const stop = vi.fn(async () => {});
    startServerMock.mockResolvedValue({ port: 43123, stop });
    const ready = vi.fn();

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 0, {
      owner: "desktop",
      token: "desktop-control",
      runtimeId: "desktop-runtime",
      rendererToken: "renderer-token",
      onReady: ready,
    });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith({
      port: 43123,
      logPath: expect.any(String),
      bootId: expect.any(String),
    }));

    const entry = readServerProcess(root);
    expect(entry.kind).toBe("owned");
    if (entry.kind !== "owned") throw new Error("expected owned server record");
    expect(serverOwner(entry.record)).toBe("desktop");
    expect(entry.record.port).toBe(43123);
    expect(startServerMock).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 0,
      bootId: expect.any(String),
      networkPolicy: expect.any(Object),
      daemonControl: expect.objectContaining({ token: "desktop-control" }),
      desktopAccess: { token: "renderer-token" },
    });
    const desktopControl = startServerMock.mock.calls[0]?.[0]?.daemonControl as Record<string, unknown>;
    expect(desktopControl).toHaveProperty("reserveRestart", expect.any(Function));

    const options = startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { requestShutdown: () => void };
    };
    options.daemonControl.requestShutdown();
    await expect(running).resolves.toBe(0);
  });

  it("notifies Desktop only after clean Web shutdown without spawning", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    const order: string[] = [];
    const stop = vi.fn(async () => {
      order.push("stop");
    });
    startServerMock.mockResolvedValue({ port: 43123, stop });
    acquireTransitionLeaseMock.mockImplementation(async (...args) => {
      order.push("reserve");
      expect(args).toEqual([root, "desktop", { timeoutMs: 0 }]);
      return transitionLeaseMock;
    });
    const onExpectedRestart = vi.fn((bootId: string) => {
      expect(bootId).toBe((startServerMock.mock.calls[0]?.[0] as { bootId: string }).bootId);
      order.push("expected-restart");
    });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 0, {
      owner: "desktop",
      token: "desktop-control",
      runtimeId: "desktop-runtime",
      rendererToken: "renderer-token",
      onExpectedRestart,
    });
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { reserveRestart(): Promise<{ commit(): void }> };
    }).daemonControl;

    (await control.reserveRestart()).commit();
    expect(onExpectedRestart).not.toHaveBeenCalled();
    await expect(running).resolves.toBe(0);

    expect(order).toEqual(["reserve", "stop", "expected-restart"]);
    expect(onExpectedRestart).toHaveBeenCalledOnce();
    expect(startCliDaemonSuccessorMock).not.toHaveBeenCalled();
    expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
    expect(readServerProcess(root)).toEqual({ kind: "missing" });
  });

  it("suppresses Desktop replacement when terminal shutdown arrives during Web cleanup", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    const stopping = deferred<void>();
    const stop = vi.fn(() => stopping.promise);
    startServerMock.mockResolvedValue({ port: 43123, stop });
    const onExpectedRestart = vi.fn();

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 0, {
      owner: "desktop",
      token: "desktop-control",
      runtimeId: "desktop-runtime",
      rendererToken: "renderer-token",
      onExpectedRestart,
    });
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: {
        requestShutdown(): void;
        reserveRestart(): Promise<{ commit(): void }>;
      };
    }).daemonControl;

    (await control.reserveRestart()).commit();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    control.requestShutdown();
    stopping.resolve();

    await expect(running).resolves.toBe(0);
    expect(onExpectedRestart).not.toHaveBeenCalled();
  });

  it("suppresses a committed Desktop restart when terminal shutdown wins the flush window", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ port: 43123, stop: vi.fn(async () => {}) });
    const onExpectedRestart = vi.fn();
    let requestTerminalShutdown: (() => void) | undefined;

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 0, {
      owner: "desktop",
      token: "desktop-control",
      runtimeId: "desktop-runtime",
      rendererToken: "renderer-token",
      onExpectedRestart,
      registerShutdownTrigger: (requestShutdown) => {
        requestTerminalShutdown = requestShutdown;
        return () => {};
      },
    });
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { reserveRestart(): Promise<{ commit(): void }> };
    }).daemonControl;

    (await control.reserveRestart()).commit();
    requestTerminalShutdown?.();
    await expect(running).resolves.toBe(0);

    expect(onExpectedRestart).not.toHaveBeenCalled();
    expect(startCliDaemonSuccessorMock).not.toHaveBeenCalled();
    expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
  });

  it("never enables renderer access for a CLI-owned server", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ port: 3456, stop: vi.fn(async () => {}) });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000, {
      owner: "cli",
      token: "cli-control",
      runtimeId: "cli-runtime",
      rendererToken: "must-not-be-used",
    });
    await vi.waitFor(() => expect(startServerMock).toHaveBeenCalledOnce());

    expect(startServerMock.mock.calls[0]?.[0]).not.toHaveProperty("desktopAccess");
    const options = startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { requestShutdown: () => void };
    };
    options.daemonControl.requestShutdown();
    await expect(running).resolves.toBe(0);
  });

  it("refuses a desktop server without renderer authentication", async () => {
    bootstrapMock.mockResolvedValue(undefined);

    const { runServe } = await import("./serve");
    await expect(runServe("127.0.0.1", 0, {
      owner: "desktop",
      token: "desktop-control",
      runtimeId: "desktop-runtime",
    })).resolves.toBe(1);

    expect(startServerMock).not.toHaveBeenCalled();
    expect(acquireServerLeaseMock).not.toHaveBeenCalled();
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
    expect(serverLeaseMock.release).toHaveBeenCalledOnce();
    expect(readServerPid(root)).toBeUndefined();
    expect(acquireTransitionLeaseMock).not.toHaveBeenCalled();
    expect(startCliDaemonSuccessorMock).not.toHaveBeenCalled();
  });

  it("removes its ownership record while the matching live-server lease is still held", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ port: 3456, stop: vi.fn(async () => {}) });
    serverLeaseMock.release.mockImplementation(() => {
      expect(readServerPid(root)).toBeUndefined();
      serverLeaseState.held = false;
      return true;
    });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000);
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const options = startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { requestShutdown: () => void };
    };
    options.daemonControl.requestShutdown();

    await expect(running).resolves.toBe(0);
    expect(readServerPid(root)).toBeUndefined();
  });

  it("holds restart transition ownership across old cleanup and authenticated successor readiness", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    const order: string[] = [];
    const stop = vi.fn(async () => {
      order.push("stop");
    });
    startServerMock.mockResolvedValue({ port: 3456, stop });
    acquireTransitionLeaseMock.mockImplementation(async (...args) => {
      order.push("reserve");
      expect(args).toEqual([root, "cli", { timeoutMs: 0 }]);
      return transitionLeaseMock;
    });
    serverLeaseMock.release.mockImplementation(() => {
      order.push("server-lease-release");
      expect(readServerPid(root)).toBeUndefined();
      serverLeaseState.held = false;
      return true;
    });
    startCliDaemonSuccessorMock.mockImplementation(async (options) => {
      order.push("old-record-remove");
      expect(readServerPid(root)).toBeUndefined();
      order.push("spawn", "authenticated-ready");
      const startOptions = startServerMock.mock.calls[0]?.[0] as { bootId?: string };
      expect(options).toMatchObject({
        agentDir: root,
        daemonExecutable: process.execPath,
        host: "127.0.0.1",
        port: 3456,
        runtimeId: "runtime-current",
        previousToken: "launch-token",
        oldBootId: startOptions.bootId,
        oldPid: process.pid,
        transitionLease: transitionLeaseMock,
      });
    });
    transitionLeaseMock.release.mockImplementation(() => {
      order.push("transition-release");
      return true;
    });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000);
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const startOptions = startServerMock.mock.calls[0]?.[0] as {
      bootId?: string;
      daemonControl: {
        reserveRestart?: () => Promise<{ commit(): void; release(): boolean | void }>;
      };
    };
    expect(startOptions.bootId).toEqual(expect.any(String));
    expect(startOptions.bootId).not.toBe("");

    const reservation = await startOptions.daemonControl.reserveRestart?.();
    if (!reservation) throw new Error("restart reservation was not exposed");
    order.push("admission-commit");
    reservation.commit();
    expect(() => reservation.commit()).toThrow(/already consumed/i);
    expect(reservation.release()).toBe(false);

    await expect(running).resolves.toBe(0);
    expect(order).toEqual([
      "reserve",
      "admission-commit",
      "stop",
      "server-lease-release",
      "old-record-remove",
      "spawn",
      "authenticated-ready",
      "transition-release",
    ]);
    expect(startCliDaemonSuccessorMock).toHaveBeenCalledOnce();
    expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
  });

  it("does not release listener ownership, its record, or the transition before async stop resolves", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    const listenerStopStarted = deferred<void>();
    const listenerStopped = deferred<void>();
    const stop = vi.fn(async () => {
      listenerStopStarted.resolve();
      await listenerStopped.promise;
    });
    startServerMock.mockResolvedValue({ port: 3456, stop });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000);
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { reserveRestart(): Promise<{ commit(): void }> };
    }).daemonControl;
    (await control.reserveRestart()).commit();
    await listenerStopStarted.promise;

    expect(serverLeaseMock.release).not.toHaveBeenCalled();
    expect(readServerPid(root)).toBe(process.pid);
    expect(startCliDaemonSuccessorMock).not.toHaveBeenCalled();
    expect(transitionLeaseMock.release).not.toHaveBeenCalled();

    listenerStopped.resolve();
    await expect(running).resolves.toBe(0);
    expect(serverLeaseMock.release).toHaveBeenCalledOnce();
    expect(readServerProcess(root)).toEqual({ kind: "missing" });
    expect(startCliDaemonSuccessorMock).toHaveBeenCalledOnce();
    expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
  });

  it("rejects restart transition contention without waiting or closing the running server", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ port: 3456, stop: vi.fn(async () => {}) });
    acquireTransitionLeaseMock.mockRejectedValue(new Error("private lease owner pid 9876"));

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000);
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: {
        requestShutdown(): void;
        reserveRestart(): Promise<unknown>;
      };
    }).daemonControl;

    await expect(control.reserveRestart()).rejects.toThrow("private lease owner pid 9876");
    expect(acquireTransitionLeaseMock).toHaveBeenCalledWith(root, "cli", { timeoutMs: 0 });
    expect(startCliDaemonSuccessorMock).not.toHaveBeenCalled();
    expect(readServerPid(root)).toBe(process.pid);

    control.requestShutdown();
    await expect(running).resolves.toBe(0);
  });

  it("releases an uncommitted restart reservation only once and leaves shutdown in stop mode", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ port: 3456, stop: vi.fn(async () => {}) });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000);
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: {
        requestShutdown(): void;
        reserveRestart(): Promise<{ commit(): void; release(): boolean | void }>;
      };
    }).daemonControl;
    const reservation = await control.reserveRestart();

    expect(reservation.release()).toBe(true);
    expect(reservation.release()).toBe(false);
    expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
    control.requestShutdown();

    await expect(running).resolves.toBe(0);
    expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
    expect(startCliDaemonSuccessorMock).not.toHaveBeenCalled();
  });

  it("suppresses a committed restart when terminal shutdown arrives before successor spawn", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ port: 3456, stop: vi.fn(async () => {}) });
    let requestTerminalShutdown: (() => void) | undefined;

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000, {
      registerShutdownTrigger: (requestShutdown) => {
        requestTerminalShutdown = requestShutdown;
        return () => {};
      },
    });
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { reserveRestart(): Promise<{ commit(): void }> };
    }).daemonControl;
    const reservation = await control.reserveRestart();

    reservation.commit();
    requestTerminalShutdown?.();

    await expect(running).resolves.toBe(0);
    expect(startCliDaemonSuccessorMock).not.toHaveBeenCalled();
    expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
  });

  it("aborts successor readiness on terminal shutdown and holds transition ownership through cleanup", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ port: 3456, stop: vi.fn(async () => {}) });
    const readinessStarted = deferred<AbortSignal | undefined>();
    const terminalRequested = deferred<void>();
    const cleanupStarted = deferred<void>();
    const cleanup = deferred<void>();
    let requestTerminalShutdown: (() => void) | undefined;
    startCliDaemonSuccessorMock.mockImplementation(async (options) => {
      const signal = (options as { signal?: AbortSignal }).signal;
      readinessStarted.resolve(signal);
      if (signal) {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      } else {
        await terminalRequested.promise;
      }
      cleanupStarted.resolve();
      await cleanup.promise;
    });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000, {
      registerShutdownTrigger: (requestShutdown) => {
        requestTerminalShutdown = () => {
          requestShutdown();
          terminalRequested.resolve();
        };
        return () => {};
      },
    });
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { reserveRestart(): Promise<{ commit(): void }> };
    }).daemonControl;
    (await control.reserveRestart()).commit();
    const readinessSignal = await readinessStarted.promise;

    requestTerminalShutdown?.();
    await cleanupStarted.promise;
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(transitionLeaseMock.release).not.toHaveBeenCalled();
    cleanup.resolve();

    await expect(running).resolves.toBe(0);
    expect(readinessSignal).toBeInstanceOf(AbortSignal);
    expect(readinessSignal?.aborted).toBe(true);
    expect(startCliDaemonSuccessorMock).toHaveBeenCalledOnce();
    expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
    expect(readServerProcess(root)).toEqual({ kind: "missing" });
  });

  it("transfers restart ownership when terminal cancellation cannot settle the successor", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ port: 3456, stop: vi.fn(async () => {}) });
    const readinessStarted = deferred<void>();
    let requestTerminalShutdown: (() => void) | undefined;
    startCliDaemonSuccessorMock.mockImplementation(async (options) => {
      const signal = (options as { signal?: AbortSignal }).signal;
      readinessStarted.resolve();
      if (signal && !signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      const transition = (options as {
        transitionLease?: {
          reserveHandoff(token: string): {
            commit(pid: number): void;
            relinquish(): void;
          };
        };
      }).transitionLease;
      if (!transition) throw new Error("restart transition was not supplied to the successor owner");
      const handoff = transition.reserveHandoff("surviving-child-token");
      handoff.commit(222);
      handoff.relinquish();
      throw new Error("EasyResearch daemon successor did not exit after forced termination.");
    });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000, {
      registerShutdownTrigger: (requestShutdown) => {
        requestTerminalShutdown = requestShutdown;
        return () => {};
      },
    });
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { reserveRestart(): Promise<{ commit(): void }> };
    }).daemonControl;
    (await control.reserveRestart()).commit();
    await readinessStarted.promise;

    requestTerminalShutdown?.();

    await expect(running).resolves.toBe(1);
    expect(startCliDaemonSuccessorMock).toHaveBeenCalledOnce();
    expect(transitionLeaseMock.reserveHandoff).toHaveBeenCalledWith("surviving-child-token");
    expect(transitionHandoffMock.commit).toHaveBeenCalledWith(222);
    expect(transitionHandoffMock.relinquish).toHaveBeenCalledOnce();
    expect(transitionLeaseMock.release).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining("did not exit after forced termination"),
    );
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "routes %s through the pending successor abort before releasing the transition",
    async (signalName) => {
      bootstrapMock.mockResolvedValue(undefined);
      startServerMock.mockResolvedValue({ port: 3456, stop: vi.fn(async () => {}) });
      const priorListeners = new Set(process.rawListeners(signalName));
      const readinessStarted = deferred<AbortSignal>();
      startCliDaemonSuccessorMock.mockImplementation(async (options) => {
        const signal = (options as { signal?: AbortSignal }).signal;
        if (!signal) throw new Error("successor readiness signal was missing");
        readinessStarted.resolve(signal);
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      });

      const { runServe } = await import("./serve");
      const running = runServe("127.0.0.1", 3000);
      await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
      const control = (startServerMock.mock.calls[0]?.[0] as {
        daemonControl: { reserveRestart(): Promise<{ commit(): void }> };
      }).daemonControl;
      (await control.reserveRestart()).commit();
      const readinessSignal = await readinessStarted.promise;
      const signalHandler = process.rawListeners(signalName)
        .find((listener) => !priorListeners.has(listener));
      if (!signalHandler) throw new Error(`${signalName} shutdown handler was not registered.`);

      signalHandler.call(process);

      await expect(running).resolves.toBe(0);
      expect(readinessSignal.aborted).toBe(true);
      expect(startCliDaemonSuccessorMock).toHaveBeenCalledOnce();
      expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
      expect(process.rawListeners(signalName).filter((listener) => !priorListeners.has(listener)))
        .toEqual([]);
    },
  );

  it("releases the transition after one failed successor attempt without retrying", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ port: 3456, stop: vi.fn(async () => {}) });
    startCliDaemonSuccessorMock.mockRejectedValue(new Error("successor readiness failed"));

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000);
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { reserveRestart(): Promise<{ commit(): void }> };
    }).daemonControl;
    (await control.reserveRestart()).commit();

    await expect(running).resolves.toBe(1);
    expect(startCliDaemonSuccessorMock).toHaveBeenCalledOnce();
    expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
    expect(readServerProcess(root)).toEqual({ kind: "missing" });
  });

  it("does not spawn when old server cleanup fails and releases transition afterward", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    const stop = vi.fn(async () => {
      throw new Error("listener still active");
    });
    startServerMock.mockResolvedValue({ port: 3456, stop });
    transitionLeaseMock.release.mockImplementation(() => {
      expect(stop).toHaveBeenCalledTimes(2);
      expect(readServerPid(root)).toBe(process.pid);
      return true;
    });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000);
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { reserveRestart(): Promise<{ commit(): void }> };
    }).daemonControl;
    (await control.reserveRestart()).commit();

    await expect(running).resolves.toBe(1);
    expect(startCliDaemonSuccessorMock).not.toHaveBeenCalled();
    expect(serverLeaseMock.release).not.toHaveBeenCalled();
    expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
    expect(readServerPid(root)).toBe(process.pid);
  });

  it("never removes a replacement token or spawns after old-record comparison fails", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({
      port: 3456,
      stop: vi.fn(async () => {
        writeServerProcess(root, {
          schema: 1,
          owner: "cli",
          pid: 9876,
          host: "127.0.0.1",
          port: 3000,
          token: "replacement-token",
          runtimeId: "runtime-current",
        });
      }),
    });
    serverLeaseMock.release.mockImplementation(() => {
      writeServerProcess(root, {
        schema: 1,
        owner: "cli",
        pid: 9876,
        host: "127.0.0.1",
        port: 3000,
        token: "replacement-token",
        runtimeId: "runtime-current",
      });
      serverLeaseState.held = false;
      return true;
    });

    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000);
    await vi.waitFor(() => expect(readServerPid(root)).toBe(process.pid));
    const control = (startServerMock.mock.calls[0]?.[0] as {
      daemonControl: { reserveRestart(): Promise<{ commit(): void }> };
    }).daemonControl;
    (await control.reserveRestart()).commit();

    await expect(running).resolves.toBe(1);
    expect(startCliDaemonSuccessorMock).not.toHaveBeenCalled();
    expect(serverLeaseMock.release).toHaveBeenCalledOnce();
    const entry = readServerProcess(root);
    expect(entry.kind).toBe("owned");
    if (entry.kind !== "owned") throw new Error("expected replacement record");
    expect(entry.record.token).toBe("replacement-token");
    expect(transitionLeaseMock.release).toHaveBeenCalledOnce();
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
