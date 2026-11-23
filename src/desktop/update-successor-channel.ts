import { randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validToken, type DesktopUpdateSuccessor } from "./update-protocol";

export interface DesktopSuccessorReady { version: string; pid: number; bootId: string; sidecarPid: number }
const failure = () => new Error("Desktop update successor channel failed.");
function matches(value: unknown, token: string): boolean {
  return validToken(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
}
function frames(socket: Socket, receive: (frame: Record<string, unknown>) => void): void {
  let text = "", bytes = 0;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024) { socket.destroy(failure()); return; }
    text += chunk;
    let newline: number;
    try {
      while ((newline = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, newline); text = text.slice(newline + 1);
        if (Buffer.byteLength(line) > 4096) throw failure();
        const frame = JSON.parse(line);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw failure();
        receive(frame);
      }
      if (Buffer.byteLength(text) > 4096) throw failure();
    } catch { socket.destroy(failure()); }
  });
}
function send(socket: Socket, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) { reject(failure()); return; }
    socket.write(`${JSON.stringify(value)}\n`, error => error ? reject(failure()) : resolve());
  });
}
function readyValue(frame: Record<string, unknown>): DesktopSuccessorReady {
  if (typeof frame.version !== "string" || frame.version.length > 80 || !/^\d+\.\d+\.\d+$/u.test(frame.version)
    || !Number.isSafeInteger(frame.pid) || (frame.pid as number) <= 0
    || !Number.isSafeInteger(frame.sidecarPid) || (frame.sidecarPid as number) <= 0
    || typeof frame.bootId !== "string" || !frame.bootId || frame.bootId.length > 200) throw failure();
  return { version: frame.version, pid: frame.pid as number, sidecarPid: frame.sidecarPid as number, bootId: frame.bootId };
}

/** One process-only named pipe; this listener never accepts Web/API traffic. */
export async function createDesktopSuccessorChannel(token: string) {
  if (!validToken(token)) throw failure();
  const id = randomUUID();
  const path = process.platform === "win32" ? `\\\\.\\pipe\\easyresearch-update-${id}` : join(tmpdir(), `er-update-${id}.sock`);
  let childPid: number | undefined, authenticated: Socket | undefined, received = false, accepted = false;
  let resolveReady!: (value: DesktopSuccessorReady) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<DesktopSuccessorReady>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    if (authenticated || sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(failure()), 5000);
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer); sockets.delete(socket);
      if (socket === authenticated && !accepted) rejectReady(failure());
    });
    frames(socket, frame => {
      if (!matches(frame.token, token)) throw failure();
      if (!authenticated) {
        if (frame.type !== "attach" || frame.pid !== childPid || !childPid || Object.keys(frame).length !== 3) throw failure();
        authenticated = socket; clearTimeout(timer);
        for (const other of sockets) if (other !== socket) other.destroy();
        void send(socket, { type: "attached", token, workerPid: process.pid }).catch(() => socket.destroy());
      } else {
        if (socket !== authenticated || received || frame.type !== "ready" || frame.pid !== childPid || Object.keys(frame).length !== 6) throw failure();
        const value = readyValue(frame); received = true; resolveReady(value);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(path, () => { server.removeListener("error", reject); resolve(); });
  });
  server.on("error", () => rejectReady(failure()));
  let closing: Promise<void> | undefined;
  return { path, ready,
    bindChild(pid: number) {
      if (childPid || !Number.isSafeInteger(pid) || pid <= 0) throw failure();
      childPid = pid;
    },
    async accept() {
      if (!authenticated || !received || accepted) throw failure();
      await send(authenticated, { type: "accepted", token }); accepted = true;
    },
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        rejectReady(failure());
        for (const socket of sockets) socket.destroy();
        server.close(error => error ? reject(error) : resolve());
      });
      return closing;
    },
  };
}

export async function connectDesktopSuccessorChannel(context: DesktopUpdateSuccessor & { pipe: string }, lost: () => void) {
  if (!validToken(context.token)) throw failure();
  const socket = createConnection(context.pipe);
  let attached = false, sent = false, accepted = false, closing = false;
  let resolveAttached!: () => void, rejectAttached!: (error: Error) => void;
  let resolveAccepted!: () => void, rejectAccepted!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => { resolveAttached = resolve; rejectAttached = reject; });
  const complete = new Promise<void>((resolve, reject) => { resolveAccepted = resolve; rejectAccepted = reject; });
  void complete.catch(() => {});
  const timer = setTimeout(() => socket.destroy(failure()), 10_000);
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  socket.on("error", () => {});
  socket.once("close", () => {
    clearTimeout(timer); clearTimeout(readyTimer); rejectAttached(failure()); rejectAccepted(failure());
    if (!accepted && !closing) lost();
  });
  frames(socket, frame => {
    if (!matches(frame.token, context.token)) throw failure();
    if (!attached && frame.type === "attached" && frame.workerPid === context.workerPid && Object.keys(frame).length === 3) {
      attached = true; clearTimeout(timer); resolveAttached();
    } else if (attached && sent && !accepted && frame.type === "accepted" && Object.keys(frame).length === 2) {
      accepted = true; clearTimeout(readyTimer); resolveAccepted();
    } else throw failure();
  });
  socket.once("connect", () => {
    void send(socket, { type: "attach", token: context.token, pid: process.pid }).catch(() => socket.destroy());
  });
  await connected;
  return {
    async ready(value: DesktopSuccessorReady) {
      if (sent || socket.destroyed || value.pid !== process.pid) throw failure();
      readyValue({ ...value }); sent = true;
      readyTimer = setTimeout(() => socket.destroy(failure()), 15 * 60_000);
      await send(socket, { ...value, type: "ready", token: context.token });
      await complete;
    },
    close() { closing = true; socket.destroy(); },
  };
}
