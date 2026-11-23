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
import type { RuntimeLease } from "../runtime-lease";

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
    serverLeaseState.held = true;
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
  it("retires the old executable only after terminal owned-work settlement and disposes a failed successor candidate", async () => {
    const artifacts = await import("../npm-update-artifact");
    const order: string[] = [];
    const register = vi.spyOn(artifacts, "registerNpmArtifactProcess").mockReturnValue({ retire() { order.push("retire"); }, close() { order.push("close-use"); } });
    const discard = vi.spyOn(artifacts, "discardNpmUpdateCandidate").mockImplementation(async () => { order.push("discard-candidate"); });
    const stopped = deferred<void>();
    bootstrapMock.mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({ port: 3000, beginShutdown() {}, stop: async () => { await stopped.promise; order.push("settled"); } });
    startCliDaemonSuccessorMock.mockImplementation(async () => { order.push("spawn"); throw new Error("successor setup failed and child cleanup completed"); });
    const { runServe } = await import("./serve");
    const running = runServe();
    try {
      await vi.waitFor(() => expect(startServerMock).toHaveBeenCalled());
      const owner = startServerMock.mock.calls[0]![0].npmUpdate;
      const lease = await owner.reserve();
      owner.activate({ executable: "/owned/candidate", version: "2.0.0", sha256: "a".repeat(64), runtimeId: "new" }, lease);
      expect(order).not.toContain("retire");
      stopped.resolve(); expect(await running).toBe(1);
      expect(order.indexOf("settled")).toBeLessThan(order.indexOf("retire"));
      expect(order.indexOf("retire")).toBeLessThan(order.indexOf("spawn"));
      expect(order).toContain("discard-candidate");
    } finally { stopped.resolve(); await running; register.mockRestore(); discard.mockRestore(); }
  });
  it("waits for new-version first-run setup before constructing Web or publishing readiness", async () => {
    const entry = await import("../npm-update-entry");
    const pending = deferred<void>();
    const order: string[] = [];
    const setup = vi.spyOn(entry, "prepareNpmUpdateBoot").mockImplementation(async () => {
      order.push("setup-start"); await pending.promise; order.push("setup-finished");
    });
    bootstrapMock.mockImplementation(async () => { order.push("bootstrap"); });
    let shutdown!: () => void;
    startServerMock.mockImplementation(async (options) => {
      order.push("web"); shutdown = options.daemonControl.requestShutdown;
      return { port: 3000, beginShutdown() {}, stop: async () => {} };
    });
    const { runServe } = await import("./serve");
    const running = runServe("127.0.0.1", 3000, {
      updateBoot: { host: "127.0.0.1", port: 3000, version: "2.0.0", sha256: "a".repeat(64) },
      onReady() { order.push("ready"); shutdown(); },
    });
    try {
      await vi.waitFor(() => expect(order).toEqual(["setup-start"]));
      expect(startServerMock).not.toHaveBeenCalled();
      expect(readServerPid(root)).toBeUndefined();
      pending.resolve();
      expect(await running).toBe(0);
      expect(order).toEqual(["setup-start", "setup-finished", "bootstrap", "web", "ready"]);
    } finally { pending.resolve(); await running; setup.mockRestore(); }
  });

  it("keeps new-version setup failure from entering Web or claiming successor readiness", async () => {
    const entry = await import("../npm-update-entry");
    const setup = vi.spyOn(entry, "prepareNpmUpdateBoot").mockRejectedValue(new Error("new-version setup failed"));
    const ready = vi.fn();
    try {
      const { runServe } = await import("./serve");
      expect(await runServe("127.0.0.1", 3000, {
        updateBoot: { host: "127.0.0.1", port: 3000, version: "2.0.0", sha256: "a".repeat(64) }, onReady: ready,
      })).toBe(1);
      expect(startServerMock).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
      expect(readServerPid(root)).toBeUndefined();
      expect(serverLeaseMock.held).toBe(false);
    } finally { setup.mockRestore(); }
  });

  it("uses terminal cleanup for update activation and launches only the selected candidate", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    const stop = vi.fn(async () => {});
    startServerMock.mockResolvedValue({ port: 3000, beginShutdown() {}, stop });
    const { runServe } = await import("./serve");
    const running = runServe();
    await vi.waitFor(() => expect(startServerMock).toHaveBeenCalled());
    const owner = startServerMock.mock.calls[0]![0].npmUpdate;
    const lease = await owner.reserve();
    await expect(startServerMock.mock.calls[0]![0].daemonControl.reserveRestart()).rejects.toThrow();
    owner.activate({ executable: "/owned/new-executable", version: "2.0.0", sha256: "a".repeat(64), runtimeId: "new-runtime" }, lease);
    expect(await running).toBe(0);
    expect(stop).toHaveBeenCalledWith(undefined);
    expect(startCliDaemonSuccessorMock.mock.calls[0]![0]).toMatchObject({ daemonExecutable: "/owned/new-executable", runtimeId: "new-runtime", expectedVersion: "2.0.0", updateCandidate: { version: "2.0.0", sha256: "a".repeat(64) } });
  });
  it("consumes npm provenance before Web creation and forwards it through a safe restart", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    const provenance = { schema: 1, metaRoot: join(root, "meta"), launcher: join(root, "meta/launcher.mjs"), platformManifest: join(root, "platform/package.json"), binary: join(root, "platform/bin/easyresearch"), nodeExecutable: process.execPath, platform: "linux", arch: "x64", version: "1.0.0" };
    process.env.EASYRESEARCH_NPM_PROVENANCE = JSON.stringify(provenance);
    startServerMock.mockImplementation(async () => {
      expect(process.env.EASYRESEARCH_NPM_PROVENANCE).toBeUndefined();
      return { port: 3000, beginShutdown() {}, stop: async () => {} };
    });
    const { runServe } = await import("./serve");
    const running = runServe();
    await vi.waitFor(() => expect(startServerMock).toHaveBeenCalled());
    const control = startServerMock.mock.calls[0]![0].daemonControl;
    (await control.reserveRestart()).commit();
    expect(await running).toBe(0);
    expect(startCliDaemonSuccessorMock.mock.calls[0]![0]).toMatchObject({ currentEnvironment: { EASYRESEARCH_NPM_PROVENANCE: JSON.stringify(provenance) } });
  });
  it("closes new-work admission synchronously on terminal shutdown before the response-flush delay", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    const beginShutdown = vi.fn();
    const stop = vi.fn(async () => {});
    startServerMock.mockResolvedValue({ port: 3000, beginShutdown, stop });
    const { runServe } = await import("./serve");
    let shutdown!: () => void;
    const running = runServe("127.0.0.1", 3000, { registerShutdownTrigger(request) { shutdown = request; return () => {}; } });
    await vi.waitFor(() => expect(shutdown).toBeDefined());
    shutdown();
    expect(beginShutdown).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(await running).toBe(0);
  });
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
    expect(startServerMock.mock.calls[0]?.[0]?.ownsExclusiveServerLease).toBe(true);
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

    expect(startServerMock).toHaveBeenCalledWith(expect.objectContaining({
      host: "127.0.0.1",
      port: 3000,
      ownsExclusiveServerLease: true,
      bootId: expect.any(String),
      networkPolicy: expect.any(Object),
      daemonControl: expect.objectContaining({
        token: "launch-token",
        runtimeId: "runtime-current",
        requestShutdown: expect.any(Function),
      }),
    }));
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
    expect(startServerMock).toHaveBeenCalledWith(expect.objectContaining({
      host: "127.0.0.1",
      port: 0,
      ownsExclusiveServerLease: true,
      bootId: expect.any(String),
      networkPolicy: expect.any(Object),
      daemonControl: expect.objectContaining({ token: "desktop-control" }),
      desktopAccess: { token: "renderer-token" },
    }));
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
    const onExpectedRestart = vi.fn((bootId: string, transition: RuntimeLease) => {
      expect(bootId).toBe((startServerMock.mock.calls[0]?.[0] as { bootId: string }).bootId);
      expect(transition).toBe(transitionLeaseMock);
      const handoff = transition.reserveHandoff("desktop-host-transition-token");
      handoff.commit(5151);
      handoff.relinquish();
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
    expect(transitionLeaseMock.release).not.toHaveBeenCalled();
    expect(transitionHandoffMock.commit).toHaveBeenCalledWith(5151);
    expect(transitionHandoffMock.relinquish).toHaveBeenCalledOnce();
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
    let successorOwnsJournals = false;
    let journalRevocations = 0;
    startServerMock.mockResolvedValue({ port: 3456, stop: vi.fn(async (options?: { restart?: boolean }) => {
      if (options?.restart) return;
      expect(successorOwnsJournals).toBe(false);
      expect(serverLeaseState.held).toBe(true);
      journalRevocations++;
    }) });
    const readinessStarted = deferred<AbortSignal | undefined>();
    const terminalRequested = deferred<void>();
    const cleanupStarted = deferred<void>();
    const cleanup = deferred<void>();
    let requestTerminalShutdown: (() => void) | undefined;
    startCliDaemonSuccessorMock.mockImplementation(async (options) => {
      successorOwnsJournals = true;
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
      successorOwnsJournals = false;
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
    expect(journalRevocations).toBe(1);
  });

  it("transfers restart ownership when terminal cancellation cannot settle the successor", async () => {
    bootstrapMock.mockResolvedValue(undefined);
    let journalRevocations = 0;
    startServerMock.mockResolvedValue({ port: 3456, stop: vi.fn(async (options?: { restart?: boolean }) => {
      if (!options?.restart) journalRevocations++;
    }) });
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
      acquireServerLeaseMock.mockRejectedValue(new Error("Successor still owns the server lease"));
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
    expect(journalRevocations).toBe(0);
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
