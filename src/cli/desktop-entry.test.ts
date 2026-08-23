import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_CONTROL_TOKEN_ENV,
  DESKTOP_EVENT_PREFIX,
  DESKTOP_LAUNCH_ENV,
  DESKTOP_RENDERER_TOKEN_ENV,
  bindParentLife,
  consumeDesktopServeRequest,
  emitDesktopSidecarEvent,
  parseDesktopServeRequest,
  runDesktopServe,
  type DesktopServeRequest,
} from "./desktop-entry";

const validEnv = () => ({
  [DESKTOP_LAUNCH_ENV]: "1",
  [DESKTOP_CONTROL_TOKEN_ENV]: "c".repeat(43),
  [DESKTOP_RENDERER_TOKEN_ENV]: "r".repeat(43),
});

const request: DesktopServeRequest = {
  host: "127.0.0.1",
  port: 0,
  controlToken: "c".repeat(43),
  rendererToken: "r".repeat(43),
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-desktop-entry-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

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
      },
    )).toThrow(/distinct/i);
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
      acquireTransition: async () => ({ path: "transition", token: "transition", release: () => true }),
      inspectBackground: async () => "none",
      setup: (_agentDir, log) => log("x".repeat(5_000)),
      serve: async (_host, _port, options) => {
        options.onReady?.({ port: 43123, logPath: join(root, "server.log") });
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
      acquireTransition: async () => ({ path: "transition", token: "transition", release }),
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
        options.onReady?.({ port: 43123, logPath: join(root, "server.log") });
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
      "transition-released",
    ]);
    expect(emitted).toEqual(["desktop.setup", "desktop.ready", "desktop.stopped"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects another desktop owner without setup or bind", async () => {
    const setup = vi.fn();
    const serve = vi.fn();
    const events: Array<{ type: string; phase?: string }> = [];

    expect(await runDesktopServe(request, {
      agentDir: () => root,
      runtimeId: () => "desktop-runtime",
      acquireTransition: async () => ({ path: "transition", token: "transition", release: () => true }),
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
      acquireTransition: async () => ({ path: "transition", token: "transition", release: () => true }),
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
