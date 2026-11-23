import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { DAEMON_TOKEN_HEADER } from "../cli/daemon-control";
import { prepareDesktopDaemonUpdate } from "./update-control";

it.each([false, true])("sends only the authenticated final preparation action with force=%s", async (force) => {
  let received: unknown; let credential: unknown;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8")); credential = req.headers[DAEMON_TOKEN_HEADER];
      res.writeHead(force ? 200 : 409, { "content-type": "application/json" });
      res.end(JSON.stringify(force ? { ok: true } : { code: "RUNTIME_BUSY", activeSessions: 3, authFlowActive: true }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const port = (server.address() as { port: number }).port;
    const result = await prepareDesktopDaemonUpdate(`http://127.0.0.1:${port}`, "private-control", force, new AbortController().signal);
    expect(received).toEqual({ action: "prepare-update", force }); expect(credential).toBe("private-control");
    expect(result).toEqual(force ? { ok: true } : { code: "RUNTIME_BUSY", activeSessions: 3, authFlowActive: true });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("cancellation interrupts a stalled final-admission body", async () => {
  const abort = new AbortController();
  const server = createServer((_req, res) => { res.writeHead(200); res.flushHeaders(); abort.abort(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const port = (server.address() as { port: number }).port;
    await expect(prepareDesktopDaemonUpdate(`http://127.0.0.1:${port}`, "token", true, abort.signal)).rejects.toThrow(/cancelled/);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
