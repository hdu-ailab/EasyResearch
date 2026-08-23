import { describe, expect, it } from "vitest";
import { DESKTOP_EVENT_PREFIX } from "./contracts";
import { parseDesktopSidecarLine } from "./sidecar-events";

describe("desktop sidecar event parsing", () => {
  it("ignores ordinary sidecar output", () => {
    expect(parseDesktopSidecarLine("EasyResearch server listening")).toBeUndefined();
  });

  it("accepts a strict ephemeral loopback ready event", () => {
    expect(parseDesktopSidecarLine(
      `${DESKTOP_EVENT_PREFIX}${JSON.stringify({
        type: "desktop.ready",
        origin: "http://127.0.0.1:43123",
        owner: "desktop",
        pid: 42,
        logPath: "/tmp/easyresearch.log",
      })}`,
    )).toEqual({
      type: "desktop.ready",
      origin: "http://127.0.0.1:43123",
      owner: "desktop",
      pid: 42,
      logPath: "/tmp/easyresearch.log",
    });
  });

  it.each([
    "http://0.0.0.0:43123",
    "http://localhost:43123",
    "https://127.0.0.1:43123",
    "http://user@127.0.0.1:43123",
    "http://127.0.0.1:43123/path",
    "http://127.0.0.1:43123/?token=x",
    "http://127.0.0.1",
  ])("rejects a non-exact ready origin %s", (origin) => {
    expect(() => parseDesktopSidecarLine(
      `${DESKTOP_EVENT_PREFIX}${JSON.stringify({
        type: "desktop.ready",
        origin,
        owner: "desktop",
        pid: 42,
        logPath: "/tmp/easyresearch.log",
      })}`,
    )).toThrow(/loopback origin/i);
  });

  it("rejects malformed prefixed JSON instead of treating it as a log", () => {
    expect(() => parseDesktopSidecarLine(`${DESKTOP_EVENT_PREFIX}{`)).toThrow(/machine event/i);
  });

  it("accepts setup, safe error, and stopped variants", () => {
    expect(parseDesktopSidecarLine(
      `${DESKTOP_EVENT_PREFIX}{"type":"desktop.setup","message":"Preparing resources"}`,
    )).toEqual({ type: "desktop.setup", message: "Preparing resources" });
    expect(parseDesktopSidecarLine(
      `${DESKTOP_EVENT_PREFIX}{"type":"desktop.error","phase":"server","code":"SERVER_FAILED","message":"Could not start","logPath":"/tmp/log"}`,
    )).toMatchObject({ type: "desktop.error", phase: "server", code: "SERVER_FAILED" });
    expect(parseDesktopSidecarLine(
      `${DESKTOP_EVENT_PREFIX}{"type":"desktop.stopped"}`,
    )).toEqual({ type: "desktop.stopped" });
  });
});
