import { describe, expect, it } from "vitest";
import { DESKTOP_ACCESS_HEADER } from "./contracts";
import {
  desktopRequestHeaders,
  navigationDecision,
} from "./security";

describe("desktop request authentication", () => {
  it("adds renderer auth only to the exact ready origin", () => {
    expect(desktopRequestHeaders(
      "http://127.0.0.1:43123/api/status",
      "http://127.0.0.1:43123",
      "renderer-secret",
      { Accept: "application/json" },
    )).toEqual({
      Accept: "application/json",
      [DESKTOP_ACCESS_HEADER]: "renderer-secret",
    });

    expect(desktopRequestHeaders(
      "http://127.0.0.1:43124/api/status",
      "http://127.0.0.1:43123",
      "renderer-secret",
      { Accept: "application/json" },
    )).toEqual({ Accept: "application/json" });
  });

  it("does not add credentials to malformed or external request URLs", () => {
    for (const url of ["not-a-url", "https://example.com/", "file:///tmp/index.html"]) {
      expect(desktopRequestHeaders(
        url,
        "http://127.0.0.1:43123",
        "renderer-secret",
        { [DESKTOP_ACCESS_HEADER]: "must-not-leak" },
      )).not.toHaveProperty(DESKTOP_ACCESS_HEADER);
    }
  });
});

describe("desktop navigation policy", () => {
  it("allows navigation only within the exact sidecar origin", () => {
    expect(navigationDecision(
      "http://127.0.0.1:43123/settings",
      "http://127.0.0.1:43123",
    )).toEqual({ kind: "allow" });
  });

  it("opens credential-free external HTTP links in the system browser", () => {
    expect(navigationDecision(
      "https://github.com/hdu-ailab/EasyResearch",
      "http://127.0.0.1:43123",
    )).toEqual({
      kind: "external",
      url: "https://github.com/hdu-ailab/EasyResearch",
    });
  });

  it.each([
    "javascript:alert(1)",
    "file:///tmp/secret",
    "https://user:password@example.com/",
    "not-a-url",
  ])("denies unsafe navigation %s", (url) => {
    expect(navigationDecision(url, "http://127.0.0.1:43123")).toEqual({ kind: "deny" });
  });
});
