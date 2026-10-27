import type { BrowserWindow } from "electron";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyDesktopSmokeVideo, waitForDesktopSmokeFullscreen } from "./smoke-video";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  let fullscreen = false;
  const events = new EventEmitter();
  const window = Object.assign(events, { isFullScreen: () => fullscreen }) as unknown as BrowserWindow;
  return { events, window, setFullscreen: (value: boolean) => { fullscreen = value; } };
}

describe("packaged native fullscreen transition ownership", () => {
  it.each([true, false])("waits for macOS native completion after renderer fullscreen=%s", async (fullscreen) => {
    const h = fixture();
    h.setFullscreen(!fullscreen);
    const event = fullscreen ? "enter-full-screen" : "leave-full-screen";
    const unrelated = vi.fn();
    h.events.on(event, unrelated);
    let accepted = false;
    const task = waitForDesktopSmokeFullscreen({
      window: h.window, fullscreen, requireNativeEvent: true, timeoutMs: 1000,
      trigger: async () => { h.setFullscreen(fullscreen); return true; },
    }).then(() => { accepted = true; });
    await vi.advanceTimersByTimeAsync(200);
    expect(accepted).toBe(false);
    h.events.emit(event);
    await task;
    expect(h.events.listeners(event)).toEqual([unrelated]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("owns the native event before triggering synchronous transitions", async () => {
    const h = fixture();
    await waitForDesktopSmokeFullscreen({
      window: h.window, fullscreen: true, requireNativeEvent: true,
      trigger: async () => { h.setFullscreen(true); h.events.emit("enter-full-screen"); return true; },
    });
    expect(h.events.listenerCount("enter-full-screen")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["missing native event", "wrong native state", "stalled renderer"])("bounds %s", async (scenario) => {
    const h = fixture();
    const task = waitForDesktopSmokeFullscreen({
      window: h.window, fullscreen: true, requireNativeEvent: true, timeoutMs: 1000,
      trigger: async () => {
        if (scenario !== "wrong native state") h.setFullscreen(true);
        if (scenario !== "missing native event") h.events.emit("enter-full-screen");
        if (scenario === "stalled renderer") await new Promise(() => {});
        return true;
      },
    });
    const rejection = expect(task).rejects.toThrow(/transition deadline/i);
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(h.events.listenerCount("enter-full-screen")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, undefined])("rejects missing DOM evidence %s despite a native transition", async (result) => {
    const h = fixture();
    await expect(waitForDesktopSmokeFullscreen({
      window: h.window, fullscreen: true, requireNativeEvent: true,
      trigger: async () => { h.setFullscreen(true); h.events.emit("enter-full-screen"); return result; },
    })).rejects.toThrow(/renderer did not verify/i);
    expect(h.events.listenerCount("enter-full-screen")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sanitizes renderer failures and removes owned listeners", async () => {
    const h = fixture();
    await expect(waitForDesktopSmokeFullscreen({
      window: h.window, fullscreen: true, requireNativeEvent: true,
      trigger: async () => { throw new Error("private renderer data"); },
    })).rejects.toThrow("Desktop video renderer fullscreen operation failed.");
    expect(h.events.listenerCount("enter-full-screen")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails safely when the owning window disappears during a transition", async () => {
    const h = fixture();
    await expect(waitForDesktopSmokeFullscreen({
      window: h.window, fullscreen: true, requireNativeEvent: true,
      trigger: async () => {
        h.window.isFullScreen = () => { throw new Error("Object has been destroyed"); };
        h.events.emit("enter-full-screen");
        return true;
      },
    })).rejects.toThrow(/window became unavailable/i);
    expect(h.events.listenerCount("enter-full-screen")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("attempts renderer media/fullscreen cleanup after preparation fails", async () => {
    const h = fixture();
    const executeJavaScript = vi.fn().mockRejectedValueOnce(new Error("fixture load failed")).mockResolvedValueOnce(true);
    await expect(verifyDesktopSmokeVideo({
      window: h.window, webContents: { executeJavaScript }, url: "http://127.0.0.1/fixture", id: "fixture", platform: "darwin",
    })).rejects.toThrow("fixture load failed");
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
    expect(h.events.listenerCount("leave-full-screen")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails acceptance when cleanup fails after an accepted native enter", async () => {
    const h = fixture();
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => { h.setFullscreen(true); h.events.emit("enter-full-screen"); return true; })
      .mockRejectedValueOnce(new Error("exit failed"));
    await expect(verifyDesktopSmokeVideo({
      window: h.window, webContents: { executeJavaScript }, url: "http://127.0.0.1/fixture", id: "fixture", platform: "darwin",
    })).rejects.toThrow(/fullscreen exit or media cleanup/i);
    expect(h.events.listenerCount("enter-full-screen")).toBe(0);
    expect(h.events.listenerCount("leave-full-screen")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
