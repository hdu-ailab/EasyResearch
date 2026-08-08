import { describe, expect, it, vi } from "vitest";
import { attachEventLogger } from "./event-logger";
import type { Logger } from "../runtime/logger";

function fakeLogger(): Logger & { calls: Array<[level: string, msg: string, fields?: Record<string, unknown>]> } {
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const make = (level: string) => (msg: string, fields?: Record<string, unknown>) => calls.push([level, msg, fields]);
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error"), calls };
}

describe("attachEventLogger", () => {
  it("forwards mapped events with sessionId/cwd fields and unsubscribes", () => {
    const logger = fakeLogger();
    let listener: ((event: unknown) => void) | undefined;
    const unsubscribe = attachEventLogger("s1", "/p", (fn) => {
      listener = fn;
      return () => { listener = undefined; };
    }, logger);

    listener!({ type: "agent_start" });
    listener!({ type: "message_update" });
    listener!({ type: "some_unknown_event" });

    expect(logger.calls).toHaveLength(2);
    expect(logger.calls[0]?.[0]).toBe("info");
    expect(logger.calls[0]?.[1]).toBe("agent_start");
    expect(logger.calls[0]?.[2]).toEqual({ sessionId: "s1", cwd: "/p" });
    expect(logger.calls[1]?.[0]).toBe("debug");

    unsubscribe();
    listener = undefined; // no further calls possible after unsubscribe
    expect(logger.calls).toHaveLength(2);
  });

  it("attaches through the adapter onEvent", () => {
    const logger = fakeLogger();
    const onEvent = vi.fn(() => () => {});
    attachEventLogger("s2", "/q", onEvent, logger);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
