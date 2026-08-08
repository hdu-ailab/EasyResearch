import { describe, expect, it, vi } from "vitest";
import { mountPiEventLogger } from "./pi-event-logger";
import type { Logger } from "./logger";

function fakeLogger(): Logger & { calls: Array<[string, string, Record<string, unknown> | undefined]> } {
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const make = (level: string) => (msg: string, fields?: Record<string, unknown>) => calls.push([level, msg, fields]);
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error"), calls };
}

describe("mountPiEventLogger", () => {
  it("subscribes to pi.on and forwards mapped events", () => {
    const logger = fakeLogger();
    const handlers = new Map<string, (event: { type: string; [k: string]: unknown }) => void>();
    const pi = { on: vi.fn((name: string, fn: (event: { type: string; [k: string]: unknown }) => void) => { handlers.set(name, fn); }) };
    mountPiEventLogger(pi, logger);

    expect(pi.on).toHaveBeenCalled();
    handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolName: "web-search" });
    handlers.get("agent_start")!({ type: "agent_start" });
    handlers.get("message_update")!({ type: "message_update" });

    expect(logger.calls.map((c) => c[0])).toEqual(["info", "info", "debug"]);
  });
});
