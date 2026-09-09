import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { readServerProcess, stopServerProcess } from "./server-process";
import { serverLeasePath, transitionLeasePath } from "./runtime-lease";

it("starts and reuses the source CLI without preparing a compiled daemon copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "cli-source-startup-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  const run = (args: string[]) => new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile("bun", [entry, ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: root,
        USERPROFILE: root,
        EASYRESEARCH_CODING_AGENT_DIR: agentDir,
        EASYRESEARCH_SKIP_SETUP: "1",
      },
      timeout: 20_000,
    }, (error, _stdout, stderr) => resolve({ code: error ? 1 : 0, stderr }));
  });
  try {
    const result = await run(["--no-open", "-p", String(port)]);
    const errorPath = join(agentDir, "cli-error.log");
    expect(result.code, result.stderr + (existsSync(errorPath) ? readFileSync(errorPath, "utf8") : "")).toBe(0);
    const first = readServerProcess(agentDir);
    expect(first.kind).toBe("owned");
    expect(existsSync(join(agentDir, "bin"))).toBe(false);
    expect((await run(["--no-open", "-p", String(port)])).code).toBe(0);
    expect(readServerProcess(agentDir)).toEqual(first);
    expect((await run(["exit"])).code).toBe(0);
    expect(readServerProcess(agentDir).kind).toBe("missing");
    expect(existsSync(serverLeasePath(agentDir))).toBe(false);
    expect(existsSync(transitionLeasePath(agentDir))).toBe(false);
  } finally {
    const current = readServerProcess(agentDir);
    if (current.kind === "owned" && current.record.host === "127.0.0.1" && current.record.port === port) {
      await stopServerProcess(agentDir, { expectedOwner: "cli", expectedToken: current.record.token });
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
