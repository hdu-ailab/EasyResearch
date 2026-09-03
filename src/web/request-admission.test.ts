import { createServer, request as requestHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { rejectDisallowedWebRequest } from "./request-admission";

describe("Web request admission", () => {
  it("blocks a rebound browser authority over a real loopback TCP connection", async () => {
    let port = 0;
    let jsonApiCalls = 0;
    const transport = createServer((incoming, outgoing) => {
      incoming.resume();
      const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, {
        method: incoming.method,
        headers: {
          Host: incoming.headers.host ?? "",
          ...(typeof incoming.headers.origin === "string"
            ? { Origin: incoming.headers.origin }
            : {}),
          "Content-Type": incoming.headers["content-type"] ?? "application/json",
        },
        body: "{}",
      });
      const rejection = rejectDisallowedWebRequest(request, { host: "127.0.0.1", port });
      if (rejection) {
        outgoing.writeHead(rejection.status, Object.fromEntries(rejection.headers));
        outgoing.end("Forbidden");
        return;
      }
      jsonApiCalls++;
      outgoing.writeHead(200, { "Content-Type": "application/json" });
      outgoing.end("{\"ok\":true}");
    });
    await new Promise<void>((resolve, reject) => {
      transport.once("error", reject);
      transport.listen(0, "127.0.0.1", resolve);
    });
    port = (transport.address() as AddressInfo).port;
    const send = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const request = requestHttp({
        hostname: "127.0.0.1",
        port,
        path: "/api/status",
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", "Content-Length": "2" },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
      request.end("{}");
    });

    try {
      expect(await send({
        Host: `attacker.example:${port}`,
        Origin: `http://attacker.example:${port}`,
      })).toBe(403);
      expect(jsonApiCalls).toBe(0);

      expect(await send({ Host: `127.0.0.1:${port}` })).toBe(200);
      expect(jsonApiCalls).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        transport.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it("accepts the standard loopback aliases only on the actual listener port", () => {
    const listener = { host: "127.0.0.1", port: 43123 };

    expect(rejectDisallowedWebRequest(
      new Request("http://127.0.0.1:43123/api/status"),
      listener,
    )).toBeUndefined();
    expect(rejectDisallowedWebRequest(
      new Request("http://127.0.0.1:43123/api/status", {
        headers: { Host: "localhost:43123" },
      }),
      listener,
    )).toBeUndefined();

    expect(rejectDisallowedWebRequest(
      new Request("http://127.0.0.1:43123/api/status", {
        headers: { Host: "localhost:43124" },
      }),
      listener,
    )?.status).toBe(403);
    expect(rejectDisallowedWebRequest(
      new Request("http://127.0.0.1:43123/api/status", {
        headers: { Host: "attacker.example:43123" },
      }),
      listener,
    )?.status).toBe(403);
  });

  it.each(["localhost", "::1"])(
    "keeps localhost, IPv4, and bracketed IPv6 loopback aliases for a %s bind",
    (host) => {
      const listener = { host, port: 43123 };
      for (const authority of ["localhost:43123", "127.0.0.1:43123", "[::1]:43123"]) {
        expect(rejectDisallowedWebRequest(
          new Request("http://localhost:43123/api/status", { headers: { Host: authority } }),
          listener,
        ), authority).toBeUndefined();
      }

      expect(rejectDisallowedWebRequest(
        new Request("http://localhost:43123/api/status", {
          headers: { Host: "::1:43123" },
        }),
        listener,
      )?.status).toBe(403);
    },
  );

  it("rejects non-canonical numeric spellings of loopback Host", () => {
    const listener = { host: "127.0.0.1", port: 43123 };
    for (const host of ["2130706433", "0x7f000001", "127.1", "0177.0.0.1"]) {
      expect(rejectDisallowedWebRequest(
        new Request("http://127.0.0.1:43123/api/status", {
          headers: { Host: `${host}:43123` },
        }),
        listener,
      )?.status, host).toBe(403);
    }
  });

  it("requires a present Origin to equal the accepted Host origin", () => {
    const listener = { host: "127.0.0.1", port: 43123 };
    const request = (host: string, origin: string) => new Request(
      "http://127.0.0.1:43123/api/settings/api-usage",
      { headers: { Host: host, Origin: origin } },
    );

    expect(rejectDisallowedWebRequest(
      request("localhost:43123", "http://localhost:43123"),
      listener,
    )).toBeUndefined();

    for (const [host, origin] of [
      ["localhost:43123", "http://127.0.0.1:43123"],
      ["localhost:43123", "https://localhost:43123"],
      ["localhost:43123", "http://attacker.example:43123"],
      ["localhost:43123", "null"],
    ]) {
      expect(rejectDisallowedWebRequest(request(host!, origin!), listener)?.status).toBe(403);
    }
  });

  it("rejects non-HTTP and malformed serialized Origin values", () => {
    const listener = { host: "127.0.0.1", port: 43123 };
    for (const origin of [
      "blob:http://localhost:43123/id",
      "http://user@localhost:43123",
      "http://localhost:43123/not-an-origin",
      "http://localhost:43123?query",
    ]) {
      expect(rejectDisallowedWebRequest(
        new Request("http://localhost:43123/api/status", {
          headers: { Host: "localhost:43123", Origin: origin },
        }),
        listener,
      )?.status, origin).toBe(403);
    }
  });

  it("permits an omitted Host port only for the HTTP default listener port", () => {
    expect(rejectDisallowedWebRequest(
      new Request("http://research-box.local/api/status", {
        headers: {
          Host: "research-box.local",
          Origin: "http://research-box.local",
        },
      }),
      { host: "research-box.local", port: 80 },
    )).toBeUndefined();

    expect(rejectDisallowedWebRequest(
      new Request("http://research-box.local:43123/api/status", {
        headers: { Host: "research-box.local" },
      }),
      { host: "research-box.local", port: 43123 },
    )?.status).toBe(403);
  });

  it("accepts only the configured hostname for an explicit non-wildcard bind", () => {
    const listener = { host: "Research-Box.Local", port: 43123 };

    expect(rejectDisallowedWebRequest(
      new Request("http://research-box.local:43123/api/status", {
        headers: { Origin: "http://research-box.local:43123" },
      }),
      listener,
    )).toBeUndefined();
    for (const host of ["attacker.example:43123", "192.168.50.4:43123"]) {
      expect(rejectDisallowedWebRequest(
        new Request("http://research-box.local:43123/api/status", {
          headers: { Host: host },
        }),
        listener,
      )?.status).toBe(403);
    }
  });

  it("applies the same origin boundary to OPTIONS without blocking same-origin handling", () => {
    const listener = { host: "127.0.0.1", port: 43123 };
    const request = (origin: string) => new Request("http://127.0.0.1:43123/api/status", {
      method: "OPTIONS",
      headers: {
        Host: "127.0.0.1:43123",
        Origin: origin,
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(rejectDisallowedWebRequest(
      request("http://127.0.0.1:43123"),
      listener,
    )).toBeUndefined();
    expect(rejectDisallowedWebRequest(
      request("http://attacker.example:43123"),
      listener,
    )?.status).toBe(403);
  });

  it("canonicalizes configured IPv6 literals while requiring bracketed Host syntax", () => {
    const listener = { host: "2001:0db8:0000:0000:0000:0000:0000:0001", port: 43123 };

    expect(rejectDisallowedWebRequest(
      new Request("http://[2001:db8::1]:43123/api/status"),
      listener,
    )).toBeUndefined();
    expect(rejectDisallowedWebRequest(
      new Request("http://[2001:db8::1]:43123/api/status", {
        headers: { Host: "2001:db8::1:43123" },
      }),
      listener,
    )?.status).toBe(403);
  });

  it.each(["0.0.0.0", "::"])(
    "admits only current local interface IP literals for the %s wildcard bind",
    (host) => {
      const listener = {
        host,
        port: 43123,
        localInterfaceAddresses: ["127.0.0.1", "192.168.50.4", "2001:db8::4", "attacker.example"],
      };

      for (const [authority, origin] of [
        ["127.0.0.1:43123", "http://127.0.0.1:43123"],
        ["192.168.50.4:43123", "http://192.168.50.4:43123"],
        ["[2001:db8::4]:43123", "http://[2001:db8::4]:43123"],
      ]) {
        expect(rejectDisallowedWebRequest(
          new Request("http://127.0.0.1:43123/api/status", {
            headers: { Host: authority!, Origin: origin! },
          }),
          listener,
        ), authority).toBeUndefined();
      }

      for (const authority of [
        "attacker.example:43123",
        "localhost:43123",
        "192.168.50.99:43123",
        "0.0.0.0:43123",
        "[::]:43123",
      ]) {
        expect(rejectDisallowedWebRequest(
          new Request("http://127.0.0.1:43123/api/status", {
            headers: { Host: authority },
          }),
          listener,
        )?.status, authority).toBe(403);
      }
    },
  );

  it("keeps loopback IP access when a wildcard listener uses discovered interfaces", () => {
    expect(rejectDisallowedWebRequest(
      new Request("http://127.0.0.1:43123/api/status"),
      { host: "0.0.0.0", port: 43123 },
    )).toBeUndefined();
  });
});
