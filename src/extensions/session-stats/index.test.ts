import { describe, expect, it, vi } from "vitest";
import { SessionStatsNotifier } from "../../web/session-stats";
import { createSessionStatsExtension } from ".";

describe("session-stats extension", () => {
  it("refreshes root stats at each relevant native boundary", async () => {
    const notifier = new SessionStatsNotifier();
    const listener = vi.fn();
    notifier.subscribe(listener);
    const handlers = new Map<string, () => void>();
    const extension = createSessionStatsExtension(notifier);
    await extension({
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    } as never);

    handlers.get("turn_end")?.();
    handlers.get("agent_settled")?.();
    handlers.get("session_tree")?.();
    handlers.get("session_compact")?.();

    expect(listener).toHaveBeenCalledTimes(4);
    expect(handlers.has("agent_end")).toBe(false);
    expect(handlers.has("model_select")).toBe(false);
  });
});
