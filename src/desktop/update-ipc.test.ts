import { expect, it, vi } from "vitest";
import { isDesktopUpdateSender, registerDesktopUpdateIpc } from "./update-ipc";
import { DESKTOP_UPDATE_ACTION_CHANNEL, DESKTOP_UPDATE_SNAPSHOT_CHANNEL } from "./contracts";

it("accepts only the live current main app document, never a subframe, old owner or preview", () => {
  const frame = { url: "http://127.0.0.1:1234/#/" };
  const contents = { mainFrame: frame, getURL: () => "http://127.0.0.1:1234/#/work/id", isDestroyed: () => false };
  const owner = { contents, origin: "http://127.0.0.1:1234" };
  expect(isDesktopUpdateSender({ sender: contents, senderFrame: frame }, owner)).toBe(true);
  expect(isDesktopUpdateSender({ sender: contents, senderFrame: { ...frame } }, owner)).toBe(false);
  expect(isDesktopUpdateSender({ sender: {}, senderFrame: frame }, owner)).toBe(false);
  frame.url = "http://127.0.0.1:1234/api/files/preview/report.html";
  expect(isDesktopUpdateSender({ sender: contents, senderFrame: frame }, owner)).toBe(false);
  expect(isDesktopUpdateSender({ sender: contents, senderFrame: frame }, undefined)).toBe(false);
});

it("exposes only validated path-free actions and denies untrusted snapshots", async () => {
  const handlers = new Map<string, (event: never, data?: unknown) => unknown>();
  const action = vi.fn(async () => ({})); const snapshot = vi.fn(() => ({}));
  registerDesktopUpdateIpc({ handle: (name, handler) => { handlers.set(name, handler as never); } }, () => ({ action, snapshot } as never), () => undefined);
  await expect(handlers.get(DESKTOP_UPDATE_SNAPSHOT_CHANNEL)!({} as never)).rejects.toThrow();
  await expect(handlers.get(DESKTOP_UPDATE_ACTION_CHANNEL)!({} as never, { action: "install", path: "/tmp/evil" })).rejects.toThrow();
  expect(action).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled();
});

it("rejects extra path/URL inputs even from the trusted current document", async () => {
  const frame = { url: "http://127.0.0.1:1234/" };
  const contents = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const owner = { contents, origin: "http://127.0.0.1:1234" };
  const handlers = new Map<string, (event: never, data?: unknown) => unknown>();
  const action = vi.fn(async () => ({})); const snapshot = vi.fn(() => ({}));
  registerDesktopUpdateIpc({ handle: (name, handler) => { handlers.set(name, handler as never); } }, () => ({ action, snapshot } as never), () => owner);
  const event = { sender: contents, senderFrame: frame } as never;
  await expect(handlers.get(DESKTOP_UPDATE_ACTION_CHANNEL)!(event, { action: "download", url: "https://example.com" })).rejects.toThrow();
  await handlers.get(DESKTOP_UPDATE_ACTION_CHANNEL)!(event, { action: "check" });
  expect(action).toHaveBeenCalledExactlyOnceWith({ action: "check" });
});
