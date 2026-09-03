import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_CONTROL_TOKEN_ENV,
  DESKTOP_EVENT_PREFIX,
  DESKTOP_HOST_PID_ENV,
  DESKTOP_HOST_TRANSITION_TOKEN_ENV,
  DESKTOP_LAUNCH_ENV,
  DESKTOP_RENDERER_TOKEN_ENV,
  DESKTOP_TRANSITION_HANDOFF_ENV,
  bindParentLife,
  consumeDesktopServeRequest,
  emitDesktopSidecarEvent,
  parseDesktopServeRequest,
  runDesktopServe,
  type DesktopServeRequest,
} from "./desktop-entry";
import type { ServeOptions } from "./commands/serve";
import type { RuntimeLease } from "./runtime-lease";

const validEnv = () => ({
  [DESKTOP_LAUNCH_ENV]: "1",
  [DESKTOP_CONTROL_TOKEN_ENV]: "c".repeat(43),
  [DESKTOP_RENDERER_TOKEN_ENV]: "r".repeat(43),
  [DESKTOP_HOST_PID_ENV]: "5151",
  [DESKTOP_HOST_TRANSITION_TOKEN_ENV]: "h".repeat(43),
});

const request: DesktopServeRequest = {
  host: "127.0.0.1",
  port: 0,
  controlToken: "c".repeat(43),
  rendererToken: "r".repeat(43),
  hostPid: 5151,
  hostTransitionToken: "h".repeat(43),
  inheritedTransition: false,
};

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

function fakeTransitionLease(releaseOwner: () => boolean = () => true): RuntimeLease {
  let held = true;
  return {
    path: "transition",
    token: "transition",
    get held() {
      return held;
    },
    reserveHandoff: vi.fn((token: string) => ({
      token,
      transferred: false,
      commit: vi.fn(),
      cancel: vi.fn(() => true),
      relinquish: vi.fn(() => {
        held = false;
      }),
    })),
    release: () => {
      if (!held) return false;
      const released = releaseOwner();
      if (released) held = false;
      return released;
    },
  };
}

function orderedTransitionLease(label: string, order: string[]): RuntimeLease {
  let held = true;
  let token = `${label}-owner`;
  return {
    path: `${label}.lease`,
    get token() {
      return token;
    },
    get held() {
      return held;
    },
    reserveHandoff: vi.fn((nextToken: string) => {
      order.push(`${label}:reserve:${nextToken}`);
      let transferred = false;
      return {
        token: nextToken,
        get transferred() {
          return transferred;
        },
        commit: vi.fn((pid: number) => {
          order.push(`${label}:commit:${pid}`);
          token = nextToken;
          transferred = true;
        }),
        cancel: vi.fn(() => {
          order.push(`${label}:cancel`);
          return true;
        }),
        relinquish: vi.fn(() => {
          order.push(`${label}:relinquish`);
          held = false;
        }),
      };
    }),
    release: vi.fn(() => {
      order.push(`${label}:release`);
      if (!held) return false;
      held = false;
      return true;
    }),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-desktop-entry-"));
  networkEnvSnapshot = {};
  for (const key of NETWORK_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) networkEnvSnapshot[key] = value;
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of NETWORK_ENV_KEYS) {
    const value = networkEnvSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function readNetworkEnvironment(): Partial<Record<(typeof NETWORK_ENV_KEYS)[number], string>> {
  const values: Partial<Record<(typeof NETWORK_ENV_KEYS)[number], string>> = {};
  for (const key of NETWORK_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) values[key] = value;
  }
  return values;
}

describe("desktop entry validation", () => {
  it.each([
    [[], validEnv()],
    [["--desktop-serve", "localhost", "0"], validEnv()],
    [["--desktop-serve", "127.0.0.1", "3000"], validEnv()],
    [["--desktop-serve", "127.0.0.1", "0", "extra"], validEnv()],
    [["--desktop-serve", "127.0.0.1", "0"], {}],
  ])("rejects malformed desktop launch input %#", (argv, env) => {
    expect(() => parseDesktopServeRequest(argv, env)).toThrow(/desktop launch/i);
  });

  it("requires distinct sufficiently strong credentials", () => {
    const same = "s".repeat(43);
    expect(() => parseDesktopServeRequest(
      ["--desktop-serve", "127.0.0.1", "0"],
      {
        [DESKTOP_LAUNCH_ENV]: "1",
        [DESKTOP_CONTROL_TOKEN_ENV]: same,
        [DESKTOP_RENDERER_TOKEN_ENV]: same,
        [DESKTOP_HOST_PID_ENV]: "5151",
        [DESKTOP_HOST_TRANSITION_TOKEN_ENV]: "h".repeat(43),
      },
    )).toThrow(/distinct/i);
  });

  it.each([
    ["missing host pid", { [DESKTOP_HOST_PID_ENV]: undefined }],
    ["invalid host pid", { [DESKTOP_HOST_PID_ENV]: "0" }],
    ["weak host transition token", { [DESKTOP_HOST_TRANSITION_TOKEN_ENV]: "short" }],
    ["reused host transition token", { [DESKTOP_HOST_TRANSITION_TOKEN_ENV]: "c".repeat(43) }],
    ["invalid inherited marker", { [DESKTOP_TRANSITION_HANDOFF_ENV]: "true" }],
  ])("rejects $0", (_name, override) => {
    expect(() => parseDesktopServeRequest(
      ["--desktop-serve", "127.0.0.1", "0"],
      { ...validEnv(), ...override },
    )).toThrow(/desktop (launch|host)|credential|transition/i);
  });

  it("accepts and consumes one explicit inherited transition marker", () => {
    const env = { ...validEnv(), [DESKTOP_TRANSITION_HANDOFF_ENV]: "1" };

    expect(consumeDesktopServeRequest(
      ["--desktop-serve", "127.0.0.1", "0"],
      env,
    )).toEqual({ ...request, inheritedTransition: true });
    expect(env).toEqual({});
  });

  it("consumes credentials before runtime construction", () => {
    const env = validEnv();
    expect(consumeDesktopServeRequest(
      ["--desktop-serve", "127.0.0.1", "0"],
      env,
    )).toEqual(request);
    expect(env).toEqual({});
  });

  it("writes one prefixed machine-readable event", () => {
    const writes: string[] = [];
    emitDesktopSidecarEvent({ type: "desktop.setup", message: "Preparing resources" }, (line) => {
      writes.push(line);
    });
    expect(writes).toEqual([
      `${DESKTOP_EVENT_PREFIX}{"type":"desktop.setup","message":"Preparing resources"}`,
    ]);
  });

  it("bounds setup progress before it enters the machine protocol", () => {
    const events: Array<{ type: string; message?: string }> = [];
    return runDesktopServe(request, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition: async () => fakeTransitionLease(),
      inspectBackground: async () => "none",
      setup: (_agentDir, log) => log("x".repeat(5_000)),
      serve: async (_host: string, _port: number, options: ServeOptions) => {
        options.onReady?.({ port: 43123, logPath: join(root, "server.log"), bootId: "boot-ready" });
        return 0;
      },
      emit: (event) => events.push(event),
      parentLife: new EventEmitter(),
    }).then((exitCode) => {
      expect(exitCode).toBe(0);
      const setup = events.find((event) => event.type === "desktop.setup");
      expect(setup?.message).toHaveLength(4_096);
    });
  });
});

describe("desktop takeover", () => {
  it("hands startup transition custody to Electron before publishing readiness", async () => {
    const order: string[] = [];
    const transition = orderedTransitionLease("startup", order);

    expect(await runDesktopServe(request, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition: async () => transition,
      inspectBackground: async () => "none",
      setup: () => {},
      serve: async (_host, _port, options) => {
        options.onReady?.({ port: 43123, logPath: join(root, "server.log"), bootId: "boot-ready" });
        return 0;
      },
      emit: (event) => {
        if (event.type === "desktop.ready") order.push("ready");
      },
      parentLife: new EventEmitter(),
    })).toBe(0);

    expect(order).toEqual([
      `startup:reserve:${request.hostTransitionToken}`,
      `startup:commit:${request.hostPid}`,
      "startup:relinquish",
      "ready",
    ]);
    expect(transition.held).toBe(false);
    expect(transition.release).not.toHaveBeenCalled();
  });

  it("accepts inherited child custody without competing for another transition", async () => {
    const acquireTransition = vi.fn(async () => fakeTransitionLease());
    const waitForInheritedTransition = vi.fn(async () => {});

    expect(await runDesktopServe({ ...request, inheritedTransition: true }, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition,
      waitForInheritedTransition,
      inspectBackground: async () => "none",
      setup: () => {},
      serve: async (_host, _port, options) => {
        options.onReady?.({ port: 43123, logPath: join(root, "server.log"), bootId: "boot-ready" });
        return 0;
      },
      emit: vi.fn(),
      parentLife: new EventEmitter(),
    })).toBe(0);

    expect(waitForInheritedTransition).toHaveBeenCalledWith(
      root,
      "desktop",
      process.pid,
      request.controlToken,
    );
    expect(acquireTransition).not.toHaveBeenCalled();
  });

  it("hands restart custody to Electron before publishing the restart event", async () => {
    const order: string[] = [];
    const startup = orderedTransitionLease("startup", order);
    const restart = orderedTransitionLease("restart", order);

    expect(await runDesktopServe(request, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition: async () => startup,
      inspectBackground: async () => "none",
      setup: () => {},
      serve: async (_host, _port, options) => {
        options.onReady?.({ port: 43123, logPath: join(root, "server.log"), bootId: "boot-ready" });
        options.onExpectedRestart?.("boot-ready", restart);
        return 0;
      },
      emit: (event) => {
        if (event.type === "desktop.restart-requested") order.push("restart-event");
      },
      parentLife: new EventEmitter(),
    })).toBe(0);

    expect(order.slice(-4)).toEqual([
      `restart:reserve:${request.hostTransitionToken}`,
      `restart:commit:${request.hostPid}`,
      "restart:relinquish",
      "restart-event",
    ]);
    expect(restart.held).toBe(false);
  });

  it("owns parent EOF during setup and never starts an orphanable server", async () => {
    const parentLife = new EventEmitter();
    const release = vi.fn(() => true);
    const serve = vi.fn(async () => 0);
    const events: string[] = [];

    expect(await runDesktopServe(request, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition: async () => fakeTransitionLease(release),
      inspectBackground: async () => "none",
      setup: () => {
        parentLife.emit("end");
      },
      serve,
      emit: (event) => events.push(event.type),
      parentLife,
    })).toBe(0);

    expect(serve).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    expect(parentLife.listenerCount("end")).toBe(0);
    expect(parentLife.listenerCount("close")).toBe(0);
    expect(parentLife.listenerCount("error")).toBe(0);
  });

  it("does not acquire runtime ownership after the parent stream already ended", async () => {
    const parentLife = Object.assign(new EventEmitter(), { readableEnded: true });
    const acquireTransition = vi.fn(async () => fakeTransitionLease());

    expect(await runDesktopServe(request, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition,
      inspectBackground: vi.fn(),
      setup: vi.fn(),
      serve: vi.fn(),
      emit: vi.fn(),
      parentLife,
    })).toBe(0);

    expect(acquireTransition).not.toHaveBeenCalled();
  });

  it("restores and consumes desktop launch credentials before direct startup reads runtime ownership", async () => {
    const environment: Record<string, string | undefined> = {};
    const readEnviron = vi.fn(() => [
      `${DESKTOP_LAUNCH_ENV}=1`,
      `${DESKTOP_CONTROL_TOKEN_ENV}=${request.controlToken}`,
      `${DESKTOP_RENDERER_TOKEN_ENV}=${request.rendererToken}`,
      "HTTPS_PROXY=http://desktop-sandbox.proxy:8443",
    ].join("\0"));
    let environmentAtAgentDir: Record<string, string | undefined> | undefined;

    expect(await runDesktopServe(request, {
      agentDir: () => {
        environmentAtAgentDir = { ...environment };
        return root;
      },
      runtimeId: () => "desktop-runtime",
      acquireTransition: async () => fakeTransitionLease(),
      inspectBackground: async () => "none",
      setup: () => {},
      serve: async (_host: string, _port: number, options: ServeOptions) => {
        options.onReady?.({ port: 43123, logPath: join(root, "server.log"), bootId: "boot-ready" });
        return 0;
      },
      emit: vi.fn(),
      parentLife: new EventEmitter(),
      environment,
      environmentRestore: { isBun: true, readEnviron },
    } as never)).toBe(0);

    expect(environmentAtAgentDir).toMatchObject({ HTTPS_PROXY: "http://desktop-sandbox.proxy:8443" });
    expect(environmentAtAgentDir).not.toHaveProperty(DESKTOP_LAUNCH_ENV);
    expect(environmentAtAgentDir).not.toHaveProperty(DESKTOP_CONTROL_TOKEN_ENV);
    expect(environmentAtAgentDir).not.toHaveProperty(DESKTOP_RENDERER_TOKEN_ENV);
    expect(environment).not.toHaveProperty(DESKTOP_LAUNCH_ENV);
    expect(environment).not.toHaveProperty(DESKTOP_CONTROL_TOKEN_ENV);
    expect(environment).not.toHaveProperty(DESKTOP_RENDERER_TOKEN_ENV);
    expect(readEnviron).toHaveBeenCalledOnce();
  });

  it("applies All traffic only during setup before entering serve", async () => {
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      httpProxy: " HTTPS://DESKTOP-PROXY.EXAMPLE:443/ ",
    }));
    const baseline = {
      HTTPS_PROXY: "http://ambient.example:8080",
      NO_PROXY: "desktop.internal",
      PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://ambient-browser.example:1080",
      PLAYWRIGHT_MCP_PROXY_BYPASS: "browser.internal",
    };
    Object.assign(process.env, baseline);
    let setupEnvironment: ReturnType<typeof readNetworkEnvironment> | undefined;
    let serveEnvironment: ReturnType<typeof readNetworkEnvironment> | undefined;

    expect(await runDesktopServe(request, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition: async () => fakeTransitionLease(),
      inspectBackground: async () => "none",
      setup: () => {
        setupEnvironment = readNetworkEnvironment();
      },
      serve: async (_host, _port, options) => {
        serveEnvironment = readNetworkEnvironment();
        options.onReady?.({ port: 43123, logPath: join(root, "server.log"), bootId: "boot-ready" });
        return 0;
      },
      emit: vi.fn(),
      parentLife: new EventEmitter(),
    })).toBe(0);

    expect(setupEnvironment).toEqual({
      HTTP_PROXY: "https://desktop-proxy.example",
      http_proxy: "https://desktop-proxy.example",
      HTTPS_PROXY: "https://desktop-proxy.example",
      https_proxy: "https://desktop-proxy.example",
      ALL_PROXY: "https://desktop-proxy.example",
      all_proxy: "https://desktop-proxy.example",
      NO_PROXY: "desktop.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
      no_proxy: "desktop.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
      PLAYWRIGHT_MCP_PROXY_SERVER: "https://desktop-proxy.example",
      PLAYWRIGHT_MCP_PROXY_BYPASS: "desktop.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
    });
    expect(serveEnvironment).toEqual(baseline);
    expect(readNetworkEnvironment()).toEqual(baseline);
  });

  it("stops a CLI owner before setup and desktop bind", async () => {
    const order: string[] = [];
    const emitted: string[] = [];
    const release = vi.fn(() => {
      order.push("transition-released");
      return true;
    });

    expect(await runDesktopServe(request, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition: async () => fakeTransitionLease(release),
      inspectBackground: async () => "stale",
      stopCliOwner: async () => {
        order.push("cli-stopped");
        return true;
      },
      setup: (_agentDir, log) => {
        order.push("setup");
        log("Preparing resources");
      },
      serve: async (host, port, options) => {
        expect({ host, port }).toEqual({ host: "127.0.0.1", port: 0 });
        expect(options).toMatchObject({
          owner: "desktop",
          token: request.controlToken,
          rendererToken: request.rendererToken,
          runtimeId: "desktop-runtime",
        });
        order.push("serve");
        options.onReady?.({ port: 43123, logPath: join(root, "server.log"), bootId: "boot-ready" });
        return 0;
      },
      emit: (event) => {
        emitted.push(event.type);
        if (event.type === "desktop.ready") order.push("ready");
      },
      parentLife: new EventEmitter(),
    })).toBe(0);

    expect(order).toEqual([
      "cli-stopped",
      "setup",
      "serve",
      "ready",
    ]);
    expect(emitted).toEqual(["desktop.setup", "desktop.ready", "desktop.stopped"]);
    expect(release).not.toHaveBeenCalled();
  });

  it("emits a committed expected restart instead of an ordinary stopped event", async () => {
    const events: Array<Record<string, unknown>> = [];
    const restartTransition = fakeTransitionLease();

    expect(await runDesktopServe(request, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition: async () => fakeTransitionLease(),
      inspectBackground: async () => "none",
      setup: () => {},
      serve: async (_host, _port, options) => {
        options.onReady?.({
          port: 43123,
          logPath: join(root, "server.log"),
          bootId: "boot-ready",
        });
        options.onExpectedRestart?.("boot-ready", restartTransition);
        return 0;
      },
      emit: (event) => events.push(event),
      parentLife: new EventEmitter(),
    })).toBe(0);

    expect(events).toEqual([
      {
        type: "desktop.ready",
        origin: "http://127.0.0.1:43123",
        owner: "desktop",
        pid: process.pid,
        logPath: join(root, "server.log"),
        bootId: "boot-ready",
      },
      { type: "desktop.restart-requested", bootId: "boot-ready" },
    ]);
    expect(restartTransition.held).toBe(false);
  });

  it("rejects another desktop owner without setup or bind", async () => {
    const setup = vi.fn();
    const serve = vi.fn();
    const events: Array<{ type: string; phase?: string }> = [];

    expect(await runDesktopServe(request, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition: async () => fakeTransitionLease(),
      inspectBackground: async () => "desktop",
      stopCliOwner: vi.fn(),
      setup,
      serve,
      emit: (event) => events.push(event),
      parentLife: new EventEmitter(),
    })).toBe(1);

    expect(setup).not.toHaveBeenCalled();
    expect(serve).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ type: "desktop.error", phase: "ownership" }),
    ]);
  });

  it("logs raw setup failures locally but emits only a safe machine event", async () => {
    const failure = new Error("private setup detail /home/person");
    const logError = vi.fn();
    const events: unknown[] = [];

    expect(await runDesktopServe(request, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition: async () => fakeTransitionLease(),
      inspectBackground: async () => "none",
      setup: () => { throw failure; },
      serve: vi.fn(),
      emit: (event) => events.push(event),
      logError,
      parentLife: new EventEmitter(),
    })).toBe(1);

    expect(logError).toHaveBeenCalledWith("setup", failure);
    expect(JSON.stringify(events)).not.toContain("/home/person");
    expect(events).toEqual([
      expect.objectContaining({ type: "desktop.error", phase: "setup" }),
    ]);
  });
});

describe("parent-life signal", () => {
  it("requests shutdown when binding after the parent stream has already ended", () => {
    const parentLife = Object.assign(new EventEmitter(), { readableEnded: true });
    const requestShutdown = vi.fn();

    const unbind = bindParentLife(parentLife, requestShutdown);

    expect(requestShutdown).toHaveBeenCalledOnce();
    unbind();
  });

  it("requests shutdown once when stdin reaches EOF and cleans up listeners", () => {
    const parentLife = new EventEmitter();
    const requestShutdown = vi.fn();
    const unbind = bindParentLife(parentLife, requestShutdown);

    parentLife.emit("end");
    parentLife.emit("close");
    expect(requestShutdown).toHaveBeenCalledOnce();

    unbind();
    expect(parentLife.listenerCount("end")).toBe(0);
    expect(parentLife.listenerCount("close")).toBe(0);
    expect(parentLife.listenerCount("error")).toBe(0);
  });
});
