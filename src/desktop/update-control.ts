import { request } from "node:http";
import { DAEMON_CONTROL_PATH, DAEMON_TOKEN_HEADER } from "../cli/daemon-control";
import type { DesktopUpdateBusy } from "./update-install";

export async function prepareDesktopDaemonUpdate(origin: string, token: string, force: boolean, signal: AbortSignal): Promise<DesktopUpdateBusy | { ok: true }> {
  signal.throwIfAborted();
  const url = new URL(DAEMON_CONTROL_PATH, origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) throw new Error("Invalid Desktop control origin.");
  const body = JSON.stringify({ action: "prepare-update", force });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: DesktopUpdateBusy | { ok: true }) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value!);
    };
    const req = request(url, { agent: false, method: "POST", headers: {
      [DAEMON_TOKEN_HEADER]: token, "content-type": "application/json", "content-length": Buffer.byteLength(body),
    } }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16 * 1024) { req.destroy(new Error("Desktop update admission response exceeded its limit.")); return; }
        chunks.push(chunk);
      });
      response.on("error", (error) => finish(error));
      response.on("end", () => {
        try { finish(undefined, parseDesktopUpdateAdmission(response.statusCode, JSON.parse(Buffer.concat(chunks).toString("utf8")))); }
        catch { finish(new Error("Desktop update admission failed.")); }
      });
    });
    const abort = () => req.destroy(new Error("Desktop update admission cancelled."));
    const timer = setTimeout(() => req.destroy(new Error("Desktop update admission timed out.")), 5_000);
    req.on("error", (error) => finish(error)); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else req.end(body);
  });
}

export function parseDesktopUpdateAdmission(status: number | undefined, raw: unknown): DesktopUpdateBusy | { ok: true } {
  if (!raw || typeof raw !== "object") throw new Error("Invalid Desktop update admission.");
  const value = raw as Record<string, unknown>;
  if (status === 200 && value.ok === true) return { ok: true };
  if (status === 409 && value.code === "RUNTIME_BUSY" && Number.isSafeInteger(value.activeSessions)
    && (value.activeSessions as number) >= 0 && typeof value.authFlowActive === "boolean") {
    return { code: "RUNTIME_BUSY", activeSessions: value.activeSessions as number, authFlowActive: value.authFlowActive };
  }
  throw new Error("Invalid Desktop update admission.");
}
