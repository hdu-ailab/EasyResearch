/** Internal process-only executable entry. No Pi, Web, Agent, or config imports. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { startShellProcess, type ShellProcess } from "./process";
import { writeRecord } from "./storage";
import { HANDOFF_LIFETIME_MS, receive, send, type WorkerHandoff, type WorkerInit, type WorkerMessage } from "./worker-protocol";
import type { ShellResult } from "./types";

function equal(left: unknown, right: string): boolean {
  return typeof left === "string" && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
async function initialization(): Promise<WorkerInit> {
  let text = "";
  const timer = setTimeout(() => { process.stdin.destroy(new Error("Missing shell worker initialization.")); }, 10_000);
  try {
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (text.length > 1_048_576) throw new Error("Shell worker initialization too large.");
    }
  } finally { clearTimeout(timer); }
  const input = JSON.parse(text) as WorkerInit;
  if (input.version !== 1 || !/^[a-f0-9]{64}$/.test(input.token) || !isAbsolute(input.resultPath)
    || !input.input || !isAbsolute(input.input.file) || !isAbsolute(input.input.cwd)
    || typeof input.input.command !== "string" || !input.input.env || !Number.isSafeInteger(input.input.timeout) || input.input.timeout < 0) {
    throw new Error("Invalid shell worker initialization.");
  }
  return input;
}

export async function runShellWorker(): Promise<void> {
  const init = await initialization();
  let owner: Socket | undefined;
  let processHandle: ShellProcess | undefined;
  let outcome: ShellResult | undefined;
  let handoff: WorkerHandoff | undefined;
  let revocationTicket: string | undefined;
  let revoking: Promise<void> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(10_000, () => { if (owner !== socket) socket.destroy(); });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      if (owner !== socket) return;
      owner = undefined;
      if (!handoff || handoff.expiresAt <= Date.now()) void shutdown();
    });
    receive(socket, (message) => { void request(socket, message).catch(() => { socket.destroy(); }); });
  });
  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      if (expiry) clearTimeout(expiry);
      await processHandle?.stop();
      await completion;
      for (const socket of sockets) socket.end();
      const forceClose = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 500);
      try { await new Promise<void>((resolve) => server.close(() => resolve())); }
      finally { clearTimeout(forceClose); }
      finished();
    })();
    return closing;
  };
  let completion: Promise<void> | undefined;
  const request = async (socket: Socket, message: WorkerMessage): Promise<void> => {
    const reply = (body: WorkerMessage) => send(socket, { id: message.id, ...body });
    if (!equal(message.token, init.token)) { reply({ error: "Unauthorized shell custody." }); socket.end(); return; }
    if (message.op === "revoke") {
      if (!revocationTicket || !equal(message.ticket, revocationTicket)) { reply({ error: "Invalid shell revocation custody." }); socket.end(); return; }
      revoking ??= (async () => {
        handoff = undefined;
        if (expiry) clearTimeout(expiry);
        await processHandle?.stop();
        await completion;
      })();
      await revoking;
      reply({ ...(outcome ? { result: outcome } : {}) });
      void shutdown();
      return;
    }
    if (revoking) { reply({ error: "Shell custody is being revoked." }); return; }
    if (message.op === "attach") {
      if (owner && owner !== socket) { reply({ error: "Shell custody is already owned." }); return; }
      if (processHandle && (!handoff || handoff.expiresAt <= Date.now() || !equal(message.ticket, handoff.ticket))) {
        reply({ error: "Shell handoff is absent or expired." }); return;
      }
      owner = socket;
      handoff = undefined;
      if (expiry) clearTimeout(expiry);
      socket.setTimeout(0);
      reply({ pid: processHandle?.pid, ...(outcome ? { result: outcome } : {}) });
      return;
    }
    if (owner !== socket || closing) { reply({ error: "Shell custody is not attached." }); return; }
    if (message.op === "start") {
      // Idempotent admission: an ambiguous response can never start another copy.
      if (!processHandle) {
        processHandle = startShellProcess(init.input);
        completion = processHandle.done.then((result) => {
          writeRecord(init.resultPath, { version: 1, token: init.token, result });
          outcome = result;
          if (owner && !owner.destroyed) send(owner, { result });
        }).catch(() => { void shutdown(); });
      }
      reply({ pid: processHandle.pid, ...(outcome ? { result: outcome } : {}) });
    } else if (message.op === "prepare") {
      handoff = { ticket: randomBytes(32).toString("hex"), expiresAt: Date.now() + HANDOFF_LIFETIME_MS };
      revocationTicket = handoff.ticket;
      if (expiry) clearTimeout(expiry);
      expiry = setTimeout(() => { void shutdown(); }, HANDOFF_LIFETIME_MS);
      reply({ handoff });
    } else if (message.op === "detach") {
      if (!handoff || handoff.expiresAt <= Date.now()) { reply({ error: "Shell handoff is absent or expired." }); return; }
      owner = undefined;
      reply({});
      socket.end();
    } else if (message.op === "cancel") {
      await processHandle?.stop();
      await completion;
      reply({ ...(outcome ? { result: outcome } : {}) });
    } else if (message.op === "release") {
      reply({});
      void shutdown();
    } else reply({ error: "Invalid shell worker operation." });
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Shell worker listener failed.");
  process.stdout.write(`${JSON.stringify({ version: 1, port: address.port, workerPID: process.pid })}\n`);
  expiry = setTimeout(() => { void shutdown(); }, 10_000);
  const onSignal = () => { void shutdown(); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  await done;
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGINT", onSignal);
}
