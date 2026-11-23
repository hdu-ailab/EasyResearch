import { describe, expect, it } from "vitest";
import { createServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startShellProcess, type ShellProcess } from "./process";
import type { ShellResult } from "./types";

describe.skipIf(process.platform === "win32")("stopped shell output custody", () => {
  it("bounds inherited-pipe draining after shell exit and preserves already captured bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "shell-output-drain-"));
    let escaped: Socket | undefined;
    let resolveConnected!: () => void;
    let resolveClosed!: () => void;
    const connected = new Promise<void>((resolve) => { resolveConnected = resolve; });
    const disconnected = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const server = createServer((socket) => {
      escaped = socket;
      socket.once("data", () => { resolveConnected(); });
      socket.once("close", () => { resolveClosed(); });
    });
    let handle: ShellProcess | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture listener.");
      const script = join(cwd, "leader.cjs");
      const descendant = `
        const socket = require('node:net').connect(${address.port}, '127.0.0.1');
        process.stdout.write('captured descendant output\\n', () => socket.write('ready'));
        socket.on('data', () => { socket.end(); process.exit(0); });
      `;
      await writeFile(script, `
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
          detached: true, stdio: ['ignore', 'inherit', 'inherit'],
        });
        child.unref();
        setInterval(() => {}, 1000);
      `);
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const file = join(cwd, "output");
      handle = startShellProcess({ command: `${quote(process.execPath)} ${quote(script)}`, cwd, file, env: process.env, timeout: 0 });
      await connected;
      let result: ShellResult | undefined;
      void handle.done.then((value) => { result = value; });
      const stopping = handle.stop();
      await expect.poll(() => result, { timeout: 2000 }).toBeDefined();
      await stopping;
      // The escaped descendant is still at its explicit gate, not naturally done.
      expect(escaped?.destroyed).toBe(false);
      expect(result).toMatchObject({ status: "cancelled", incomplete: true, truncated: true, outputPath: file });
      expect(result?.output).toContain("captured descendant output");
      expect(result?.output).toContain("incomplete");
      expect(await readFile(file, "utf8")).toBe("captured descendant output\n");
    } finally {
      if (escaped) { escaped.write("exit"); await disconnected; }
      await handle?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
