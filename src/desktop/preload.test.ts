import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  DESKTOP_UPDATE_OPEN_CHANNEL,
  DESKTOP_UPDATE_OPEN_READY_CHANNEL,
  type DesktopUpdateOpenIntent,
} from "./contracts";

afterEach(() => {
  vi.doUnmock("electron");
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("listens before readiness, buffers a subscription gap and revokes only the owning consumer", async () => {
  const ipc = Object.assign(new EventEmitter(), {
    sendSync: vi.fn(() => undefined),
    send: vi.fn(),
    invoke: vi.fn(),
  });
  let bridge!: {
    onOpenUpdates(listener: (intent: DesktopUpdateOpenIntent) => void): () => void;
  };
  vi.doMock("electron", () => ({
    ipcRenderer: ipc,
    contextBridge: { exposeInMainWorld: (_name: string, value: typeof bridge) => { bridge = value; } },
  }));
  vi.stubGlobal("window", { localStorage: { setItem: vi.fn() } });
  vi.resetModules();
  await import("./preload");

  const intents: DesktopUpdateOpenIntent[] = [];
  ipc.send.mockImplementation((channel, ready) => {
    if (channel === DESKTOP_UPDATE_OPEN_READY_CHANNEL && ready === true) {
      ipc.emit(DESKTOP_UPDATE_OPEN_CHANNEL, {}, "check");
    }
  });
  const listener = (intent: DesktopUpdateOpenIntent) => { intents.push(intent); };
  const removeFirst = bridge.onOpenUpdates(listener);
  expect(intents).toEqual(["check"]);
  removeFirst();
  expect(ipc.send).toHaveBeenLastCalledWith(DESKTOP_UPDATE_OPEN_READY_CHANNEL, false);

  ipc.send.mockImplementation(() => {});
  ipc.emit(DESKTOP_UPDATE_OPEN_CHANNEL, {}, "check");
  ipc.emit(DESKTOP_UPDATE_OPEN_CHANNEL, {}, "recovery");
  ipc.emit(DESKTOP_UPDATE_OPEN_CHANNEL, {}, "check");
  ipc.emit(DESKTOP_UPDATE_OPEN_CHANNEL, {}, { path: "/untrusted", reason: "recovery" });
  const removeSecond = bridge.onOpenUpdates(listener);
  expect(intents).toEqual(["check", "recovery"]);
  const removeThird = bridge.onOpenUpdates(listener);
  const sends = ipc.send.mock.calls.length;
  removeSecond();
  expect(ipc.send).toHaveBeenCalledTimes(sends);
  ipc.emit(DESKTOP_UPDATE_OPEN_CHANNEL, {}, "recovery");
  expect(intents).toEqual(["check", "recovery", "recovery"]);
  removeThird();
  expect(ipc.send).toHaveBeenLastCalledWith(DESKTOP_UPDATE_OPEN_READY_CHANNEL, false);
});
