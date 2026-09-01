import { describe, expect, it, vi } from "vitest";
import { SessionStatsNotifier } from "./session-stats";

describe("SessionStatsNotifier", () => {
  it("notifies current subscribers and releases them independently", () => {
    const notifier = new SessionStatsNotifier();
    const first = vi.fn();
    const second = vi.fn();
    const removeFirst = notifier.subscribe(first);
    notifier.subscribe(second);

    notifier.notify();
    removeFirst();
    notifier.notify();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("isolates listener failures from Pi lifecycle hooks and sibling subscribers", () => {
    const notifier = new SessionStatsNotifier();
    const healthy = vi.fn();
    notifier.subscribe(() => {
      throw new Error("projection failed");
    });
    notifier.subscribe(healthy);

    expect(() => notifier.notify()).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
  });
});
