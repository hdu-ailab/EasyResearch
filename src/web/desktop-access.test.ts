import { describe, expect, it } from "vitest";
import {
  DESKTOP_ACCESS_HEADER,
  rejectUnauthorizedDesktopRequest,
} from "./desktop-access";

describe("desktop renderer access", () => {
  it("does nothing in ordinary CLI Web mode", () => {
    expect(rejectUnauthorizedDesktopRequest(
      new Request("http://127.0.0.1:3000/api/status"),
      undefined,
    )).toBeUndefined();
  });

  it("accepts only the exact renderer credential", () => {
    const access = { token: "renderer-secret" };
    expect(rejectUnauthorizedDesktopRequest(
      new Request("http://127.0.0.1:43123/api/status", {
        headers: { [DESKTOP_ACCESS_HEADER]: "renderer-secret" },
      }),
      access,
    )).toBeUndefined();

    const denied = rejectUnauthorizedDesktopRequest(
      new Request("http://127.0.0.1:43123/api/status", {
        headers: { [DESKTOP_ACCESS_HEADER]: "wrong-secret" },
      }),
      access,
    );
    expect(denied?.status).toBe(401);
  });

  it("does not echo the expected or supplied credential", async () => {
    const denied = rejectUnauthorizedDesktopRequest(
      new Request("http://127.0.0.1:43123/", {
        headers: { [DESKTOP_ACCESS_HEADER]: "supplied-secret" },
      }),
      { token: "expected-secret" },
    );
    const serialized = `${await denied?.text()} ${JSON.stringify([...denied!.headers])}`;
    expect(serialized).not.toContain("supplied-secret");
    expect(serialized).not.toContain("expected-secret");
    expect(denied?.headers.get("cache-control")).toBe("no-store");
  });
});
