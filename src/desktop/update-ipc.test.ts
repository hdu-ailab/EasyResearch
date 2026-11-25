import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { isDesktopUpdateSender, registerDesktopUpdateIpc, registerDesktopUpdatePresentation, type DesktopUpdateOwner } from "./update-ipc";
import { DESKTOP_UPDATE_ACTION_CHANNEL, DESKTOP_UPDATE_OPEN_READY_CHANNEL, DESKTOP_UPDATE_SNAPSHOT_CHANNEL } from "./contracts";

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

function presentationFixture() {
  const ipc = new EventEmitter();
  const frame = { url: "http://127.0.0.1:1234/#/" };
  const contents = { mainFrame: frame, getURL: () => contents.mainFrame.url, isDestroyed: () => false };
  let owner: DesktopUpdateOwner | undefined = { contents, origin: "http://127.0.0.1:1234" };
  let loaded = false;
  const send = vi.fn();
  const presentation = registerDesktopUpdatePresentation(ipc, () => owner, { loaded: () => loaded, send });
  const ready = (raw: unknown = true, event = { sender: contents, senderFrame: contents.mainFrame }) =>
    ipc.emit(DESKTOP_UPDATE_OPEN_READY_CHANNEL, event, raw);
  return { ipc, frame, contents, send, presentation, ready,
    loaded(value = true) { loaded = value; presentation.flush(); },
    owner(value: DesktopUpdateOwner | undefined) { owner = value; },
  };
}

describe("desktop update presentation intent", () => {
  it("coalesces pre-load requests and waits for both document load and the React subscriber", () => {
    const fixture = presentationFixture();
    fixture.presentation.request("check");
    fixture.presentation.request("check");
    fixture.ready();
    expect(fixture.send).not.toHaveBeenCalled();
    fixture.loaded();
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith("check");
    fixture.presentation.flush();
    fixture.ready();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    fixture.presentation.close();
  });

  it("retains a recovery notice ahead of repeated manual checks when React subscribes after load", () => {
    const fixture = presentationFixture();
    fixture.loaded();
    fixture.presentation.request("check");
    fixture.presentation.request("recovery");
    fixture.presentation.request("check");
    expect(fixture.send).not.toHaveBeenCalled();
    fixture.ready();
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith("recovery");
    fixture.presentation.request("check");
    expect(fixture.send).toHaveBeenLastCalledWith("check");
    fixture.presentation.close();
  });

  it("rejects nonboolean readiness, subframes, preview documents and detached owners", () => {
    const fixture = presentationFixture();
    fixture.loaded();
    fixture.presentation.request("check");
    fixture.ready({ ready: true });
    fixture.ready(true, { sender: fixture.contents, senderFrame: { ...fixture.frame } });
    fixture.frame.url = "http://127.0.0.1:1234/api/file/preview/report.html";
    fixture.ready();
    fixture.frame.url = "http://127.0.0.1:1234/#/";
    fixture.owner(undefined);
    fixture.ready();
    expect(fixture.send).not.toHaveBeenCalled();
    fixture.owner({ contents: fixture.contents, origin: "http://127.0.0.1:1234" });
    fixture.ready();
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith("check");
    fixture.presentation.close();
  });

  it("revokes navigation/replacement grants and rejects stale cleanup without losing a pending intent", () => {
    const fixture = presentationFixture();
    fixture.loaded();
    fixture.ready();
    const old = { sender: fixture.contents, senderFrame: fixture.frame };
    fixture.presentation.revoke();
    fixture.loaded(false);
    fixture.presentation.request("recovery");
    fixture.contents.mainFrame = { url: "http://127.0.0.1:1234/#/work/new" };
    fixture.loaded();
    fixture.ready(true, old);
    expect(fixture.send).not.toHaveBeenCalled();
    fixture.ready();
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith("recovery");
    fixture.ready(false, old);
    fixture.presentation.request("check");
    expect(fixture.send).toHaveBeenLastCalledWith("check");
    fixture.ready(false);
    fixture.presentation.request("check");
    expect(fixture.send).toHaveBeenCalledTimes(2);
    fixture.presentation.close();
    fixture.ready();
    fixture.presentation.request("recovery");
    expect(fixture.send).toHaveBeenCalledTimes(2);
    expect(fixture.ipc.listenerCount(DESKTOP_UPDATE_OPEN_READY_CHANNEL)).toBe(0);
  });

  it("revalidates the current document on delivery and retains a failed-send intent for the replacement", () => {
    const fixture = presentationFixture();
    fixture.loaded();
    fixture.ready();
    fixture.frame.url = "http://127.0.0.1:5678/";
    fixture.presentation.request("check");
    expect(fixture.send).not.toHaveBeenCalled();
    fixture.frame.url = "http://127.0.0.1:1234/";
    fixture.send.mockImplementationOnce(() => { throw new Error("Renderer closed"); });
    fixture.ready();
    fixture.presentation.flush();
    expect(fixture.send).toHaveBeenCalledTimes(1);
    fixture.ready();
    expect(fixture.send).toHaveBeenCalledTimes(2);
    expect(fixture.send).toHaveBeenLastCalledWith("check");
    fixture.presentation.close();
  });
});
