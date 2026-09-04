import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayStamp } from "../runtime/logger";
import { runCli, waitForReady, type CliDependencies, type CliOptions } from "./index";
import * as cliModule from "./index";
import { readServerPid, serverPidPath, writeServerPid } from "./server-process";
import type { RuntimeLease } from "./runtime-lease";

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
  "EASYRESEARCH_NETWORK_TEST_KEEP",
] as const;
let networkEnvSnapshot: Partial<Record<(typeof NETWORK_ENV_KEYS)[number], string>>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-index-"));
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

function readNetworkEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Partial<Record<(typeof NETWORK_ENV_KEYS)[number], string>> {
  const values: Partial<Record<(typeof NETWORK_ENV_KEYS)[number], string>> = {};
  for (const key of NETWORK_ENV_KEYS) {
    const value = environment[key];
    if (value !== undefined) values[key] = value;
  }
  return values;
}

function makeDeps(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    serve: vi.fn(async () => 0),
    openBrowser: vi.fn(async () => true),
    waitForReady: vi.fn(async () => true),
    withRuntimeTransition: async (_agentDir, operation) => {
      const lease = testTransitionLease();
      try {
        return await (operation as (lease: RuntimeLease) => Promise<unknown>)(lease);
      } finally {
        if (lease.held) lease.release();
      }
    },
    spawnBackground: vi.fn(),
    inspectBackground: vi.fn(async (agentDir: string) =>
      readServerPid(agentDir) === undefined ? "none" : "current"),
    archiveDeadLegacyCliOwner: vi.fn(() => false),
    stopBackground: vi.fn(async () => false),
    ...overrides,
  } as CliDependencies;
}

function testTransitionLease(): RuntimeLease {
  let held = true;
  return {
    path: join(root, "server.transition.lease"),
    token: "transition-token",
    get held() {
      return held;
    },
    reserveHandoff: vi.fn((token: string) => {
      let transferred = false;
      return {
        token,
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
    }),
    release: vi.fn(() => {
      if (!held) return false;
      held = false;
      return true;
    }),
  } as RuntimeLease;
}

/** runCli with first-run setup stubbed out (tests must not touch real venvs). */
function runTestCli(argv: string[], deps: CliDependencies, options: Partial<CliOptions> = {}) {
  return runCli(argv, deps, { setup: vi.fn(), ...options });
}

describe("runCli argument parsing", () => {
  it("restores an empty Bun environment before resolving the agent directory and loads it only once", async () => {
    const environment: Record<string, string | undefined> = {};
    const readEnviron = vi.fn(() => [
      `EASYRESEARCH_CODING_AGENT_DIR=${root}`,
      "HTTPS_PROXY=http://sandbox.proxy:8443",
      "NO_PROXY=sandbox.internal",
    ].join("\0"));
    let environmentAtAgentDir: Record<string, string | undefined> | undefined;
    const options = {
      get agentDir() {
        environmentAtAgentDir = { ...environment };
        return root;
      },
      setup: vi.fn(),
      environment,
      environmentRestore: { isBun: true, readEnviron },
    } as CliOptions & {
      environment: Record<string, string | undefined>;
      environmentRestore: { isBun: boolean; readEnviron: () => string };
    };

    expect(await runCli(["--no-open"], makeDeps(), options)).toBe(0);

    expect(environmentAtAgentDir).toMatchObject({
      EASYRESEARCH_CODING_AGENT_DIR: root,
      HTTPS_PROXY: "http://sandbox.proxy:8443",
      NO_PROXY: "sandbox.internal",
    });
    expect(readEnviron).toHaveBeenCalledOnce();
  });

  it("starts a background server with defaults for an empty argv", async () => {
    const deps = makeDeps();
    expect(await runTestCli([], deps, { agentDir: root })).toBe(0);
    expect(deps.spawnBackground).toHaveBeenCalledWith(
      "127.0.0.1",
      3000,
      expect.any(Object),
      expect.any(Object),
    );
    expect(deps.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3000");
  });

  it("archives a dead legacy CLI owner before starting the replacement daemon", async () => {
    const order: string[] = [];
    const archiveDeadLegacyCliOwner = vi.fn(() => {
      order.push("archive");
      return true;
    });
    const deps = makeDeps({
      inspectBackground: vi.fn(async () => {
        order.push("inspect");
        return "none" as const;
      }),
      archiveDeadLegacyCliOwner,
      spawnBackground: vi.fn(async () => {
        order.push("spawn");
      }),
    });

    expect(await runTestCli(["--no-open"], deps, {
      agentDir: root,
      setup: () => {
        order.push("setup");
      },
    })).toBe(0);

    expect(order).toEqual(["inspect", "archive", "setup", "spawn"]);
    expect(archiveDeadLegacyCliOwner).toHaveBeenCalledWith(root);
    expect(deps.stopBackground).not.toHaveBeenCalled();
  });

  it("parses -p port and --host", async () => {
    const deps = makeDeps();
    await runTestCli(["-p", "4000", "--host", "0.0.0.0"], deps, { agentDir: root });
    expect(deps.spawnBackground).toHaveBeenCalledWith(
      "0.0.0.0",
      4000,
      expect.any(Object),
      expect.any(Object),
    );
    expect(deps.waitForReady).not.toHaveBeenCalled();
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });

  it("skips opening the browser with --no-open", async () => {
    const deps = makeDeps();
    await runTestCli(["--no-open"], deps, { agentDir: root });
    expect(deps.spawnBackground).toHaveBeenCalledWith(
      "127.0.0.1",
      3000,
      expect.any(Object),
      expect.any(Object),
    );
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });

  it("reuses an existing alive process (idempotent start)", async () => {
    writeServerPid(root, process.pid);
    const deps = makeDeps();
    expect(await runTestCli([], deps, { agentDir: root })).toBe(0);
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.waitForReady).toHaveBeenCalledWith("127.0.0.1", 3000);
    expect(deps.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3000");
  });

  it("restarts an existing daemon when its copied runtime is stale", async () => {
    const stopBackground = vi.fn(async (agentDir: string) => {
      expect(agentDir).toBe(root);
      return true;
    });
    const deps = makeDeps({
      inspectBackground: vi.fn(async () => "stale" as const),
      stopBackground,
    });

    expect(await runTestCli([], deps, { agentDir: root })).toBe(0);

    expect(stopBackground).toHaveBeenCalledOnce();
    expect(deps.spawnBackground).toHaveBeenCalledWith(
      "127.0.0.1",
      3000,
      expect.any(Object),
      expect.any(Object),
    );
    expect(deps.waitForReady).not.toHaveBeenCalled();
    expect(deps.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3000");
  });

  it("refuses to reuse a live pid when nothing listens on the requested port", async () => {
    writeServerPid(root, process.pid);
    const deps = makeDeps({ waitForReady: vi.fn(async () => false) });
    const messages: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      messages.push(String(msg));
    });
    try {
      expect(await runTestCli(["-p", "4000"], deps, { agentDir: root })).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect(messages.join("\n")).toContain("4000");
    expect(readServerPid(root)).toBe(process.pid);
  });

  it("exit without a pid file prints a notice and exits 0", async () => {
    const deps = makeDeps();
    expect(await runTestCli(["exit"], deps, { agentDir: root })).toBe(0);
    expect(deps.serve).not.toHaveBeenCalled();
  });

  it("exit with a live pid sends a stop", async () => {
    const stopBackground = vi.fn(async () => true);
    const deps = makeDeps({ stopBackground });
    expect(await runTestCli(["exit"], deps, { agentDir: root })).toBe(0);
    expect(stopBackground).toHaveBeenCalledWith(root);
  });

  it("fails closed instead of spawning when daemon ownership cannot be verified", async () => {
    const deps = makeDeps({
      inspectBackground: vi.fn(async () => {
        throw new Error("Cannot verify daemon ownership");
      }),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runTestCli([], deps, { agentDir: root })).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
    expect(deps.spawnBackground).not.toHaveBeenCalled();
  });

  it("rejects normal startup before setup while desktop owns the runtime", async () => {
    const setup = vi.fn();
    const deps = makeDeps({ inspectBackground: vi.fn(async () => "desktop" as const) });
    const messages: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
      messages.push(String(message));
    });
    try {
      expect(await runCli([], deps, { agentDir: root, setup })).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }

    expect(setup).not.toHaveBeenCalled();
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(messages.join("\n")).toMatch(/quit it from the tray or menu bar/i);
  });

  it("rejects exit while desktop owns the runtime", async () => {
    const setup = vi.fn();
    const deps = makeDeps({ inspectBackground: vi.fn(async () => "desktop" as const) });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runCli(["exit"], deps, { agentDir: root, setup })).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }

    expect(setup).not.toHaveBeenCalled();
    expect(deps.stopBackground).not.toHaveBeenCalled();
  });

  it("holds one transition around inspection, setup, spawn, and readiness", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      withRuntimeTransition: async (_agentDir, operation) => {
        const lease = testTransitionLease();
        order.push("lease-acquired");
        const result = await operation(lease);
        order.push("lease-released");
        return result;
      },
      inspectBackground: vi.fn(async () => {
        order.push("inspected");
        return "none" as const;
      }),
      spawnBackground: vi.fn(() => {
        order.push("spawned");
      }),
      waitForReady: vi.fn(async () => {
        order.push("ready");
        return true;
      }),
    });

    expect(await runCli([], deps, {
      agentDir: root,
      setup: () => { order.push("setup"); },
    })).toBe(0);

    expect(order).toEqual([
      "lease-acquired",
      "inspected",
      "setup",
      "spawned",
      "lease-released",
    ]);
  });

  it("does not accept a separate unauthenticated status-only probe after initial owned startup", async () => {
    const waitForReady = vi.fn(async () => true);
    const spawnBackground = vi.fn(async () => {});
    const deps = makeDeps({ waitForReady, spawnBackground });

    await expect(runTestCli(["--no-open"], deps, { agentDir: root })).resolves.toBe(0);

    expect(spawnBackground).toHaveBeenCalledOnce();
    expect(waitForReady).not.toHaveBeenCalled();
  });

  it("does not release initial transition ownership after a spawned child takes fail-closed custody", async () => {
    const transition = testTransitionLease();
    const release = vi.spyOn(transition, "release");
    const reserveHandoff = vi.spyOn(transition, "reserveHandoff");
    const deps = makeDeps({
      withRuntimeTransition: async (_agentDir, operation) => {
        try {
          return await operation(transition);
        } finally {
          if (transition.held) transition.release();
        }
      },
      spawnBackground: vi.fn(async (_host, _port, _environment, lease: RuntimeLease) => {
        const handoff = lease.reserveHandoff("surviving-child-token");
        handoff.commit(222);
        handoff.relinquish();
        throw new Error("child survived forced cleanup");
      }) as never,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(runTestCli(["--no-open"], deps, { agentDir: root })).resolves.toBe(1);
    } finally {
      errorSpy.mockRestore();
    }

    expect(reserveHandoff).toHaveBeenCalledWith("surviving-child-token");
    expect(release).not.toHaveBeenCalled();
  });

  it.each([
    [["-p", "abc"]],
    [["-p", "0"]],
    [["-p", "70000"]],
    [["bogus"]],
    [["web"]],
  ])("rejects invalid argv %j", async (argv) => {
    const deps = makeDeps();
    expect(await runTestCli(argv as string[], deps, { agentDir: root })).toBe(1);
    expect(deps.spawnBackground).not.toHaveBeenCalled();
  });

  it.each([
    [["--serve"]],
    [["--serve", "127.0.0.1", "3000"]],
    [["--serve", "--no-open"]],
    [["--serve", "127.0.0.1", "3000", "extra"]],
  ])("rejects the internal --serve flag on the user path %j", async (argv) => {
    const deps = makeDeps();
    expect(await runTestCli(argv as string[], deps, { agentDir: root })).toBe(1);
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.serve).not.toHaveBeenCalled();
  });

  it("exit combined with --serve does not start a daemon", async () => {
    const deps = makeDeps();
    expect(await runTestCli(["exit", "--serve"], deps, { agentDir: root })).toBe(1);
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.serve).not.toHaveBeenCalled();
  });

  it("points the failure hint at the real web-server log file", async () => {
    const deps = makeDeps({
      spawnBackground: vi.fn(async () => {
        throw new Error("authenticated initial readiness failed");
      }),
    });
    const messages: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((msg: unknown) => {
      messages.push(String(msg));
    });
    try {
      expect(await runTestCli([], deps, { agentDir: root })).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
    const expected = join(root, "logs", `easyresearch-${dayStamp()}.log`);
    expect(messages.join("\n")).toContain(expected);
  });

  it("passes the bound host to owned authenticated startup", async () => {
    const deps = makeDeps();
    await runTestCli(["--host", "192.168.1.5"], deps, { agentDir: root });
    expect(deps.spawnBackground).toHaveBeenCalledWith(
      "192.168.1.5",
      3000,
      expect.any(Object),
      expect.any(Object),
    );
    expect(deps.waitForReady).not.toHaveBeenCalled();
  });
});

describe("waitForReady", () => {
  it("uses the direct local transport instead of the configured global fetch router", async () => {
    const targetRequests: string[] = [];
    const server = createServer((request, response) => {
      targetRequests.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ bootId: "boot-ready" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const originalFetch = globalThis.fetch;
    const proxyRecords: string[] = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      proxyRecords.push(String(input));
      return Response.json({ bootId: "proxy-boot" });
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;

    try {
      await expect(waitForReady("127.0.0.1", port, 2_000)).resolves.toBe(true);
      expect(targetRequests).toEqual(["/api/status"]);
      expect(proxyRecords).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("probes the given host", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await waitForReady("127.0.0.1", port, 2000)).toBe(true);
    } finally {
      server.close();
    }
  });

  it.each(["0.0.0.0", "::"])("falls back to the loopback probe for %s", async (host) => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await waitForReady(host, port, 2000)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("times out when nothing listens on the probe host", async () => {
    expect(await waitForReady("127.0.0.1", 1, 300)).toBe(false);
  });
});

describe("browser opener", () => {
  it("uses cmd.exe for the Windows start shell builtin", () => {
    const browserOpenCommand = (cliModule as typeof cliModule & {
      browserOpenCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] };
    }).browserOpenCommand;
    expect(browserOpenCommand("win32", "http://127.0.0.1:3000")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", "http://127.0.0.1:3000"],
    });
  });
});

describe("version output", () => {
  it("writes the exact version line through the runtime console", () => {
    const writeVersionOutput = (cliModule as typeof cliModule & {
      writeVersionOutput(version: string, write: (output: string) => unknown): void;
    }).writeVersionOutput;
    const write = vi.fn();

    writeVersionOutput("1.2.3", write);

    expect(write).toHaveBeenCalledWith("easyresearch 1.2.3");
  });
});

describe("help output", () => {
  it("writes the full flag reference through the injected writer", () => {
    const writeHelpOutput = (cliModule as typeof cliModule & {
      writeHelpOutput(write: (output: string) => unknown): void;
    }).writeHelpOutput;
    const write = vi.fn();

    writeHelpOutput(write);

    const text = String(write.mock.calls[0]?.[0]);
    expect(text).toContain("easyresearch - Automated academic paper writing");
    expect(text).toContain("easyresearch exit");
    expect(text).toContain("-p, --port <port>");
    expect(text).toContain("--host <host>");
    expect(text).toContain("--no-open");
    expect(text).toContain("-h, --help");
    expect(text).toContain("-v, --version");
  });

  it("prints help and exits 0 for -h or --help without setup, daemon, or serve", async () => {
    for (const flag of ["-h", "--help"]) {
      const writes: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
        writes.push(String(msg));
      });
      try {
        const deps = makeDeps();
        const setup = vi.fn();
        expect(await runCli([flag], deps, { agentDir: root, setup })).toBe(0);
        expect(deps.spawnBackground).not.toHaveBeenCalled();
        expect(deps.serve).not.toHaveBeenCalled();
        expect(setup).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
      }
      expect(writes.join("\n")).toContain("easyresearch - Automated academic paper writing");
    }
  });

  it("keeps direct help pure without reading the Bun proc environment", async () => {
    const readEnviron = vi.fn(() => "PRIVATE_HELP_VALUE=must-not-load\0");
    const environment: Record<string, string | undefined> = {};
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runCli(["--help"], makeDeps(), {
        agentDir: root,
        setup: vi.fn(),
        environment,
        environmentRestore: { isBun: true, readEnviron },
      } as CliOptions & {
        environment: Record<string, string | undefined>;
        environmentRestore: { isBun: boolean; readEnviron: () => string };
      })).toBe(0);
    } finally {
      logSpy.mockRestore();
    }

    expect(readEnviron).not.toHaveBeenCalled();
    expect(environment).toEqual({});
  });

  it("prints help from any argument position and never starts a daemon", async () => {
    const deps = makeDeps();
    const writes: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      writes.push(String(msg));
    });
    try {
      expect(await runCli(["-p", "4000", "--help"], deps, { agentDir: root })).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
    expect(writes.join("\n")).toContain("--host <host>");
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.serve).not.toHaveBeenCalled();
  });

  it("no longer treats -h as a --host alias", async () => {
    const deps = makeDeps();
    expect(await runCli(["-h"], deps, { agentDir: root })).toBe(0);
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });
});

describe("first-run setup", () => {
  it("loads All traffic after ownership inspection and confines it to setup", async () => {
    const baseline = {
      HTTP_PROXY: "http://ambient-http.example:8080",
      https_proxy: "http://ambient-https.example:8443",
      NO_PROXY: "ambient.internal",
      PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://ambient-browser.example:1080",
      PLAYWRIGHT_MCP_PROXY_BYPASS: "browser.internal",
      EASYRESEARCH_NETWORK_TEST_KEEP: "retained",
    };
    Object.assign(process.env, baseline);
    const order: string[] = [];
    let setupEnvironment: ReturnType<typeof readNetworkEnvironment> | undefined;
    let spawnProcessEnvironment: ReturnType<typeof readNetworkEnvironment> | undefined;
    let childEnvironment: Record<string, string | undefined> | undefined;
    let browserEnvironment: ReturnType<typeof readNetworkEnvironment> | undefined;
    const deps = makeDeps({
      inspectBackground: vi.fn(async () => {
        order.push("inspected");
        writeFileSync(join(root, "settings.json"), JSON.stringify({
          httpProxy: " HTTP://CONFIGURED.EXAMPLE:80/ ",
        }));
        return "none" as const;
      }),
      spawnBackground: vi.fn((...args: unknown[]) => {
        order.push("spawned");
        spawnProcessEnvironment = readNetworkEnvironment();
        childEnvironment = args[2] as Record<string, string | undefined> | undefined;
      }),
      openBrowser: vi.fn(async () => {
        order.push("browser");
        browserEnvironment = readNetworkEnvironment();
        return true;
      }),
    });

    expect(await runCli([], deps, {
      agentDir: root,
      setup: () => {
        order.push("setup");
        setupEnvironment = readNetworkEnvironment();
      },
    })).toBe(0);

    expect(order).toEqual(["inspected", "setup", "spawned", "browser"]);
    expect(setupEnvironment).toEqual({
      HTTP_PROXY: "http://configured.example",
      http_proxy: "http://configured.example",
      HTTPS_PROXY: "http://configured.example",
      https_proxy: "http://configured.example",
      ALL_PROXY: "http://configured.example",
      all_proxy: "http://configured.example",
      NO_PROXY: "ambient.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
      no_proxy: "ambient.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
      PLAYWRIGHT_MCP_PROXY_SERVER: "http://configured.example",
      PLAYWRIGHT_MCP_PROXY_BYPASS: "ambient.internal,localhost,127.0.0.1,::1,localhost.,[::1]",
      EASYRESEARCH_NETWORK_TEST_KEEP: "retained",
    });
    expect(spawnProcessEnvironment).toEqual(baseline);
    expect(browserEnvironment).toEqual(baseline);
    expect(readNetworkEnvironment(childEnvironment ?? {})).toEqual(baseline);
  });

  it.each([
    ["help", ["--help"]],
    ["exit", ["exit"]],
  ])("keeps the launch network environment untouched for %s", async (_name, argv) => {
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      httpProxy: "http://configured.example:7890",
    }));
    const baseline = {
      HTTPS_PROXY: "http://ambient.example:8080",
      PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://ambient-browser.example:1080",
    };
    Object.assign(process.env, baseline);
    const deps = makeDeps();
    const setup = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runCli(argv, deps, { agentDir: root, setup })).toBe(0);
    } finally {
      logSpy.mockRestore();
    }

    expect(setup).not.toHaveBeenCalled();
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect(readNetworkEnvironment()).toEqual(baseline);
  });

  it("restores the launch network environment when setup fails", async () => {
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      httpProxy: "http://configured.example:7890",
    }));
    const baseline = {
      HTTP_PROXY: "http://ambient.example:8080",
      NO_PROXY: "ambient.internal",
      PLAYWRIGHT_MCP_PROXY_SERVER: "socks5://ambient-browser.example:1080",
      PLAYWRIGHT_MCP_PROXY_BYPASS: "browser.internal",
    };
    Object.assign(process.env, baseline);
    let setupEnvironment: ReturnType<typeof readNetworkEnvironment> | undefined;
    const deps = makeDeps();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runCli([], deps, {
        agentDir: root,
        setup: () => {
          setupEnvironment = readNetworkEnvironment();
          throw new Error("setup failed");
        },
      })).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }

    expect(setupEnvironment?.HTTPS_PROXY).toBe("http://configured.example:7890");
    expect(readNetworkEnvironment()).toEqual(baseline);
    expect(deps.spawnBackground).not.toHaveBeenCalled();
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });

  it("runs injected setup on normal start", async () => {
    const setup = vi.fn();
    const deps = makeDeps();
    await runCli([], deps, { agentDir: root, setup });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith(root, expect.any(Function));
  });

  it("atomically reports this invocation's setup result without exposing its reason", async () => {
    const resultPath = join(root, "setup-result.json");
    const previousPath = process.env.EASYRESEARCH_SMOKE_SETUP_RESULT_PATH;
    const previousRunId = process.env.EASYRESEARCH_SMOKE_SETUP_RUN_ID;
    process.env.EASYRESEARCH_SMOKE_SETUP_RESULT_PATH = resultPath;
    process.env.EASYRESEARCH_SMOKE_SETUP_RUN_ID = "current-run";
    try {
      const setup = vi.fn(() => ({
        venvDir: join(root, "venv"),
        success: false,
        reason: "credential-shaped diagnostic must stay out of evidence",
      }));
      const deps = makeDeps();

      expect(await runCli([], deps, { agentDir: root, setup })).toBe(0);
      expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({
        runId: "current-run",
        success: false,
      });
      expect(readFileSync(resultPath, "utf8")).not.toContain("credential-shaped");
    } finally {
      if (previousPath === undefined) delete process.env.EASYRESEARCH_SMOKE_SETUP_RESULT_PATH;
      else process.env.EASYRESEARCH_SMOKE_SETUP_RESULT_PATH = previousPath;
      if (previousRunId === undefined) delete process.env.EASYRESEARCH_SMOKE_SETUP_RUN_ID;
      else process.env.EASYRESEARCH_SMOKE_SETUP_RUN_ID = previousRunId;
    }
  });

  it("skips setup for the exit command", async () => {
    const setup = vi.fn();
    const deps = makeDeps();
    await runCli(["exit"], deps, { agentDir: root, setup });
    expect(setup).not.toHaveBeenCalled();
  });

  it("respects EASYRESEARCH_SKIP_SETUP=1", async () => {
    const previous = process.env.EASYRESEARCH_SKIP_SETUP;
    process.env.EASYRESEARCH_SKIP_SETUP = "1";
    try {
      const setup = vi.fn();
      const useExistingSetup = vi.fn();
      const deps = makeDeps();
      await runCli([], deps, { agentDir: root, setup, useExistingSetup } as CliOptions);
      expect(setup).not.toHaveBeenCalled();
      expect(useExistingSetup).toHaveBeenCalledWith(root);
    } finally {
      if (previous === undefined) delete process.env.EASYRESEARCH_SKIP_SETUP;
      else process.env.EASYRESEARCH_SKIP_SETUP = previous;
    }
  });

  it("stops with a useful error when skipped compiled setup is unavailable", async () => {
    const previous = process.env.EASYRESEARCH_SKIP_SETUP;
    process.env.EASYRESEARCH_SKIP_SETUP = "1";
    const messages: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => messages.push(String(message)));
    try {
      const deps = makeDeps();
      const result = await runCli([], deps, {
        agentDir: root,
        setup: vi.fn(),
        useExistingSetup: () => { throw new Error("Setup required: run EasyResearch without EASYRESEARCH_SKIP_SETUP"); },
      } as CliOptions);
      expect(result).toBe(1);
      expect(deps.spawnBackground).not.toHaveBeenCalled();
      expect(messages.join("\n")).toContain("Setup required");
    } finally {
      errorSpy.mockRestore();
      if (previous === undefined) delete process.env.EASYRESEARCH_SKIP_SETUP;
      else process.env.EASYRESEARCH_SKIP_SETUP = previous;
    }
  });
});

describe("compiled runtime preparation", () => {
  it("copies materialized Pi assets beside the daemon executable", () => {
    const copyPiRuntimeAssets = (cliModule as typeof cliModule & {
      copyPiRuntimeAssets(agentDir: string, source: string): void;
    }).copyPiRuntimeAssets;
    const source = join(root, "bundled", "pi");
    mkdirSync(join(source, "theme"), { recursive: true });
    writeFileSync(join(source, "package.json"), "{\"piConfig\":{\"configDir\":\".easyresearch\"}}");
    writeFileSync(join(source, "theme", "dark.json"), "{}");
    writeFileSync(join(source, "photon_rs_bg.wasm"), Buffer.from([0, 255, 1]));

    copyPiRuntimeAssets(root, source);

    expect(readFileSync(join(root, "bin", "theme", "dark.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(root, "bin", "photon_rs_bg.wasm"))).toEqual(Buffer.from([0, 255, 1]));
  });

  it("binds daemon runtime identity to the package version and executable metadata", () => {
    const source = join(root, "source.exe");
    writeFileSync(source, "new runtime");
    const initial = cliModule.daemonRuntimeId(source, "1.0.0");

    writeFileSync(source, "different runtime bytes");
    expect(cliModule.daemonRuntimeId(source, "1.0.0")).not.toBe(initial);
    expect(cliModule.daemonRuntimeId(source, "2.0.0")).not.toBe(
      cliModule.daemonRuntimeId(source, "1.0.0"),
    );
  });

  it("fails explicitly when the compiled daemon copy cannot be prepared", () => {
    const previous = process.env.EASYRESEARCH_BUNDLED_ROOT;
    const bundledRoot = join(root, "bundled");
    mkdirSync(join(bundledRoot, "pi"), { recursive: true });
    writeFileSync(join(bundledRoot, "pi", "package.json"), "{}");
    process.env.EASYRESEARCH_BUNDLED_ROOT = bundledRoot;
    const target = join(root, "bin", process.platform === "win32" ? "easyresearch-daemon.exe" : "easyresearch-daemon");
    mkdirSync(target, { recursive: true });

    try {
      expect(() => cliModule.daemonBinaryPath(root)).toThrow("Unable to prepare the daemon executable");
    } finally {
      if (previous === undefined) delete process.env.EASYRESEARCH_BUNDLED_ROOT;
      else process.env.EASYRESEARCH_BUNDLED_ROOT = previous;
    }
  });
});
