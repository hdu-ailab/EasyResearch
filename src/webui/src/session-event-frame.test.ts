import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createSessionEventFrame } from "./session-event-frame";

const textDelta = (contentIndex: number, delta: string) =>
  ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex, delta },
  }) as AgentSessionEvent;
const thinkingDelta = (contentIndex: number, delta: string) =>
  ({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex, delta },
  }) as AgentSessionEvent;

function fakeFrameClock() {
  let next = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    schedule(callback: FrameRequestCallback) {
      callbacks.set(++next, callback);
      return next;
    },
    cancel(id: number) {
      callbacks.delete(id);
    },
    fire() {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback(0);
    },
    size() {
      return callbacks.size;
    },
  };
}

describe("createSessionEventFrame", () => {
  it("coalesces only adjacent matching deltas and flushes FIFO", () => {
    const applied: AgentSessionEvent[][] = [];
    const clock = fakeFrameClock();
    const frame = createSessionEventFrame({
      schedule: clock.schedule,
      cancel: clock.cancel,
      apply: (events) => applied.push(events),
    });
    expect(frame.enqueue(textDelta(0, "a"))).toBe(true);
    expect(frame.enqueue(textDelta(0, "b"))).toBe(true);
    expect(frame.enqueue(thinkingDelta(1, "c"))).toBe(true);
    expect(clock.size()).toBe(1);
    frame.flush();
    expect(applied).toEqual([[textDelta(0, "ab"), thinkingDelta(1, "c")]]);
    expect(clock.size()).toBe(0);
  });

  it("rejects non-delta boundaries and keeps different indexes separate", () => {
    const apply = vi.fn();
    const clock = fakeFrameClock();
    const frame = createSessionEventFrame({ schedule: clock.schedule, cancel: clock.cancel, apply });
    expect(frame.enqueue(textDelta(0, "a"))).toBe(true);
    expect(frame.enqueue(textDelta(1, "b"))).toBe(true);
    expect(frame.enqueue({ type: "message_end", message: {} } as AgentSessionEvent)).toBe(false);
    clock.fire();
    expect(apply).toHaveBeenCalledWith([textDelta(0, "a"), textDelta(1, "b")]);
  });

  it("discards scheduled browser work", () => {
    const apply = vi.fn();
    const clock = fakeFrameClock();
    const frame = createSessionEventFrame({ schedule: clock.schedule, cancel: clock.cancel, apply });
    frame.enqueue(textDelta(0, "a"));
    frame.discard();
    clock.fire();
    expect(apply).not.toHaveBeenCalled();
  });
});
