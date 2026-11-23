import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleShellTimeout } from "./timer";

afterEach(() => vi.useRealTimers());
describe("shell millisecond deadlines", () => {
  it("does not clamp a long timeout to an immediate stop", async () => {
    vi.useFakeTimers();
    let fired = false;
    const cancel = scheduleShellTimeout(2_147_483_648, () => { fired = true; });
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(fired).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toBe(true);
    cancel();
  });
  it("cancels ownership of every remaining timer chunk", async () => {
    vi.useFakeTimers();
    let fired = false;
    const cancel = scheduleShellTimeout(2_147_483_648, () => { fired = true; });
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    cancel();
    await vi.runAllTimersAsync();
    expect(fired).toBe(false);
  });
});
