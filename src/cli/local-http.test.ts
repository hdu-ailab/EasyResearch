import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectLocalHttpFetch } from "./local-http";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;
const originalProxyEnvironment = Object.fromEntries(
  PROXY_ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    const value = originalProxyEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("direct local HTTP transport", () => {
  it("bypasses ambient and applied proxy variables for an explicit non-loopback interface", async () => {
    const host = localNonLoopbackIpv4();
    const targetTokens: Array<string | undefined> = [];
    const target = createServer((request, response) => {
      targetTokens.push(typeof request.headers["x-private-lifecycle-token"] === "string"
        ? request.headers["x-private-lifecycle-token"]
        : undefined);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    const proxyRecords: Array<{ url: string; token?: string }> = [];
    const proxy = createServer((request, response) => {
      proxyRecords.push({
        url: request.url ?? "",
        token: typeof request.headers["x-private-lifecycle-token"] === "string"
          ? request.headers["x-private-lifecycle-token"]
          : undefined,
      });
      response.writeHead(502);
      response.end();
    });
    const targetPort = await listen(target, host);
    const proxyPort = await listen(proxy, "127.0.0.1");
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    for (const key of PROXY_ENV_KEYS) process.env[key] = proxyUrl;

    try {
      const response = await createDirectLocalHttpFetch(1_000)(
        `http://${host}:${targetPort}/api/status`,
        { headers: { "x-private-lifecycle-token": "private-token" } },
      );

      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(targetTokens).toEqual(["private-token"]);
      expect(proxyRecords).toEqual([]);
      expect(JSON.stringify(proxyRecords)).not.toContain("private-token");
    } finally {
      await Promise.all([close(target), close(proxy)]);
    }
  });

  it("aborts an in-flight direct request without waiting for the operation deadline", async () => {
    let requestObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      requestObserved = resolve;
    });
    const target = createServer(() => requestObserved());
    const port = await listen(target, "127.0.0.1");
    const controller = new AbortController();

    try {
      const pending = createDirectLocalHttpFetch(30_000)(
        `http://127.0.0.1:${port}/api/status`,
        { signal: controller.signal },
      );
      await observed;
      controller.abort(new Error("lifecycle cancelled"));

      await expect(pending).rejects.toThrow("lifecycle cancelled");
    } finally {
      await close(target);
    }
  });
});

function localNonLoopbackIpv4(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  throw new Error("A non-loopback IPv4 interface is required for the local transport test.");
}

async function listen(
  server: ReturnType<typeof createServer>,
  host: string,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not bind a port.");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
