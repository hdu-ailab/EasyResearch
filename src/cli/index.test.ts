import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayStamp } from "../runtime/logger";
import { runCli, waitForReady, type CliDependencies, type CliOptions } from "./index";
import * as cliModule from "./index";
import { readServerPid, serverPidPath, writeServerPid } from "./server-process";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-index-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeDeps(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    serve: vi.fn(async () => 0),
    openBrowser: vi.fn(async () => true),
    waitForReady: vi.fn(async () => true),
    spawnBackground: vi.fn(),
    ...overrides,
  };
}

/** runCli with first-run setup stubbed out (tests must not touch real venvs). */
function runTestCli(argv: string[], deps: CliDependencies, options: Partial<CliOptions> = {}) {
  return runCli(argv, deps, { setup: vi.fn(), ...options });
}

describe("runCli argument parsing", () => {
  it("starts a background server with defaults for an empty argv", async () => {
    const deps = makeDeps();
    expect(await runTestCli([], deps, { agentDir: root })).toBe(0);
    expect(deps.spawnBackground).toHaveBeenCalledWith("127.0.0.1", 3000);
    expect(deps.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:3000");
  });

  it("parses -p port and --host", async () => {
    const deps = makeDeps();
    await runTestCli(["-p", "4000", "--host", "0.0.0.0"], deps, { agentDir: root });
    expect(deps.spawnBackground).toHaveBeenCalledWith("0.0.0.0", 4000);
    expect(deps.waitForReady).toHaveBeenCalledWith("0.0.0.0", 4000);
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });

  it("skips opening the browser with --no-open", async () => {
    const deps = makeDeps();
    await runTestCli(["--no-open"], deps, { agentDir: root });
    expect(deps.spawnBackground).toHaveBeenCalledWith("127.0.0.1", 3000);
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
    writeServerPid(root, process.pid);
    const deps = makeDeps({ spawnBackground: vi.fn(), serve: vi.fn(async () => 0) });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) return true;
      throw Object.assign(new Error("ESRCH: no such process"), { code: "ESRCH" });
    });
    try {
      expect(await runTestCli(["exit"], deps, { agentDir: root })).toBe(0);
    } finally {
      killSpy.mockRestore();
    }
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
    const deps = makeDeps({ waitForReady: vi.fn(async () => false) });
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

  it("probes readiness on the bound host", async () => {
    const deps = makeDeps();
    await runTestCli(["--host", "192.168.1.5"], deps, { agentDir: root });
    expect(deps.spawnBackground).toHaveBeenCalledWith("192.168.1.5", 3000);
    expect(deps.waitForReady).toHaveBeenCalledWith("192.168.1.5", 3000);
  });
});

describe("waitForReady", () => {
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
  it("writes the exact version line synchronously", () => {
    const writeVersionOutput = (cliModule as typeof cliModule & {
      writeVersionOutput(version: string, write: (fd: number, output: string) => unknown): void;
    }).writeVersionOutput;
    const write = vi.fn();

    writeVersionOutput("1.2.3", write);

    expect(write).toHaveBeenCalledWith(1, "easyresearch 1.2.3\n");
  });
});

describe("first-run setup", () => {
  it("runs injected setup on normal start", async () => {
    const setup = vi.fn();
    const deps = makeDeps();
    await runCli([], deps, { agentDir: root, setup });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith(root, expect.any(Function));
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

describe("resource retirement version gate", () => {
  it("retires same-name resources only once per version", () => {
    const retireBundledResourcesOnce = (cliModule as typeof cliModule & {
      retireBundledResourcesOnce(agentDir: string, version: string, retire: () => void): boolean;
    }).retireBundledResourcesOnce;
    const retire = vi.fn();

    expect(retireBundledResourcesOnce(root, "1.0.0", retire)).toBe(true);
    expect(retireBundledResourcesOnce(root, "1.0.0", retire)).toBe(false);
    expect(retire).toHaveBeenCalledTimes(1);
    expect(retireBundledResourcesOnce(root, "2.0.0", retire)).toBe(true);
    expect(retire).toHaveBeenCalledTimes(2);
  });

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
