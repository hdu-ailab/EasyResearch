import type { Socket } from "node:net";
import type { ShellProcessInput } from "./process";
import type { ShellResult } from "./types";

export const SHELL_WORKER_FLAG = "--shell-worker";
export const HANDOFF_LIFETIME_MS = 30_000;
export interface WorkerRegistration {
  port: number;
  token: string;
  workerPID: number;
  resultPath: string;
}
export interface WorkerHandoff { ticket: string; expiresAt: number }
export interface WorkerInit {
  version: 1;
  token: string;
  resultPath: string;
  input: ShellProcessInput;
}
export interface WorkerMessage {
  id?: number;
  op?: "attach" | "start" | "prepare" | "detach" | "revoke" | "cancel" | "release";
  token?: string;
  ticket?: string;
  error?: string;
  pid?: number;
  result?: ShellResult;
  handoff?: WorkerHandoff;
}
export function send(socket: Socket, message: WorkerMessage) { socket.write(`${JSON.stringify(message)}\n`); }
export function receive(socket: Socket, handle: (message: WorkerMessage) => void): void {
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    text += chunk;
    if (text.length > 128_000) { socket.destroy(new Error("Shell worker frame too large.")); return; }
    let end: number;
    while ((end = text.indexOf("\n")) !== -1) {
      const line = text.slice(0, end);
      text = text.slice(end + 1);
      try { handle(JSON.parse(line) as WorkerMessage); } catch { socket.destroy(new Error("Invalid shell worker frame.")); return; }
    }
  });
}
