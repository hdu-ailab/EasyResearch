// @vitest-environment jsdom
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDesktopPreferenceBlob, writeDesktopPreferenceBlob } from "./preferences-store";
import {
  clearDesktopSmokeSessionTabsStorage,
  prepareDesktopSmokeSessionTabs,
  verifyDesktopSmokeSessionTabs,
  verifyDesktopSmokeSessionTabsCleared,
  verifyDesktopSmokeSessionTabsCommitted,
  type DesktopSmokeSessionTabsReceipt,
} from "./smoke-session-tabs";
import { STORAGE_KEY } from "../webui/src/preferences";
import type { SessionTab } from "../webui/src/session-tabs";
import { messages } from "../webui/src/i18n/messages";

let userDataDir: string;
const initialOrigin = "http://127.0.0.1:43123";
const successorOrigin = "http://127.0.0.1:43124";
const root = { id: "0dd16bce-90b7-4aaf-9f19-4347905c8828", cwd: "/isolated/论文", name: "Current root" };
const hash = `#/work/${root.id}?cwd=${encodeURIComponent(root.cwd)}`;
const transcriptUser = "Desktop fixture prompt from the session snapshot.";
const prefs = {
  chatFontSize: 13, filesFontSize: 12, language: "en", studioTheme: "light",
  autoExpandThinking: false, autoExpandTools: false, expandSubagentOutput: false,
  sessionTabs: [root],
};

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), "easyresearch-smoke-session-tabs-"));
  vi.useFakeTimers();
  localStorage.clear();
  document.body.replaceChildren();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.easyresearchDesktop;
  localStorage.clear();
  document.body.replaceChildren();
  rmSync(userDataDir, { recursive: true, force: true });
});

function tab(value: SessionTab, selected: boolean, language: "en" | "zh-CN" = "en") {
  const element = document.createElement("button");
  element.dataset.sessionTabId = value.id;
  element.setAttribute("role", "tab");
  element.setAttribute("aria-selected", String(selected));
  element.setAttribute("aria-label", value.name || messages[language]["sessionTabs.untitled"]);
  document.body.append(element);
  return element;
}

function surface(id: string) {
  const element = document.createElement("div");
  element.dataset.sessionSurface = id;
  element.dataset.sessionActive = "true";
  const composer = document.createElement("div");
  composer.dataset.chatComposer = "";
  composer.append(document.createElement("textarea"));
  element.append(composer);
  const message = document.createElement("div");
  message.dataset.messageBody = "user";
  message.textContent = transcriptUser;
  element.append(message);
  document.body.append(element);
  return element;
}

function harness(descriptor: SessionTab = root, language: "en" | "zh-CN" = "en") {
  let origin = initialOrigin;
  let route = hash;
  const raw = JSON.stringify({ ...prefs, language, sessionTabs: [descriptor] });
  localStorage.setItem(STORAGE_KEY, raw);
  writeDesktopPreferenceBlob(userDataDir, raw);
  const persist = vi.fn((value: string | null) => writeDesktopPreferenceBlob(userDataDir, value));
  window.easyresearchDesktop = { platform: "linux", version: "test", persistWebUiPreferences: persist };
  tab(descriptor, true, language);
  surface(root.id);
  // Execute the actual serialized probe in a DOM. This tests the harness logic,
  // not Electron IPC acceptance (which only the native packaged jobs can prove).
  const executeJavaScript = vi.fn(async (code: string): Promise<unknown> => {
    return new Function("window", "document", "location", "localStorage", `return ${code}`)(
      window, document, { origin, hash: route }, localStorage,
    );
  });
  const options = { webContents: { executeJavaScript }, userDataDir, timeoutMs: 500, observationMs: 50 };
  const prepare = () => prepareDesktopSmokeSessionTabs({ ...options, origin, hash, sessionId: root.id, cwd: root.cwd, transcriptUser });
  const restore = (receipt: DesktopSmokeSessionTabsReceipt, newOrigin = successorOrigin, preload = true) => {
    if (newOrigin !== origin) localStorage.clear();
    origin = newOrigin;
    if (preload) localStorage.setItem(STORAGE_KEY, readDesktopPreferenceBlob(userDataDir)!);
    document.body.replaceChildren();
    tab(receipt.tabs[0], false, language);
    tab(receipt.tabs[1], true, language);
    surface(root.id);
  };
  const verify = (receipt: DesktopSmokeSessionTabsReceipt) => verifyDesktopSmokeSessionTabs({
    ...options, receipt, origin, bootId: "successor-boot",
  });
  return { options, executeJavaScript, persist, prepare, restore, verify, setRoute: (value: string) => { route = value; } };
}

async function prepared(h: ReturnType<typeof harness>) {
  const task = h.prepare();
  await vi.advanceTimersByTimeAsync(150);
  return task;
}

async function cleared(h: ReturnType<typeof harness>, receipt?: DesktopSmokeSessionTabsReceipt) {
  const task = clearDesktopSmokeSessionTabsStorage({ ...h.options, receipt: receipt ?? await prepared(h) });
  await vi.advanceTimersByTimeAsync(100);
  return task;
}

describe("packaged session-tab preference acceptance", () => {
  it.each(["en", "zh-CN"] as const)("preserves absent, empty and named root metadata while checking its actual %s label", async (language) => {
    for (const name of [undefined, "", "Named root", "   "]) {
      document.body.replaceChildren();
      const descriptor = { id: root.id, cwd: root.cwd, ...(name === undefined ? {} : { name }) };
      const h = harness(descriptor, language);
      const receipt = await cleared(h);
      expect(receipt.tabs[1]).toEqual(descriptor);
      h.restore(receipt, initialOrigin);
      const selected = document.querySelector(`[data-session-tab-id="${root.id}"]`)!;
      expect(selected.getAttribute("aria-label")).toBe(name || messages[language]["sessionTabs.untitled"]);
      const task = h.verify(receipt);
      await vi.advanceTimersByTimeAsync(100);
      expect(await task).toMatchObject({ selectedRootVerified: true, originChanged: false });
      expect(h.persist).toHaveBeenCalledTimes(1);
    }
  });

  it.each([undefined, ""])("rejects blank or wrong-language fallback labels for unnamed root %j", async (name) => {
    const descriptor = { id: root.id, cwd: root.cwd, ...(name === undefined ? {} : { name }) };
    const h = harness(descriptor, "zh-CN");
    const receipt = await cleared(h);
    h.restore(receipt);
    const selected = document.querySelector(`[data-session-tab-id="${root.id}"]`)!;
    for (const label of ["", " ", messages.en["sessionTabs.untitled"]]) {
      selected.setAttribute("aria-label", label);
      await expect(h.verify(receipt)).rejects.toThrow(/catalog order or names/);
    }
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("waits for an enabled composer and stable matching renderer/disk root metadata before seeding", async () => {
    const h = harness();
    const composer = document.querySelector("textarea")!;
    composer.disabled = true;
    const task = h.prepare();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.persist).not.toHaveBeenCalled();
    composer.disabled = false;
    await vi.advanceTimersByTimeAsync(25);
    const updated = { ...root, name: "First SSE metadata" };
    const next = JSON.stringify({ ...prefs, sessionTabs: [updated] });
    localStorage.setItem(STORAGE_KEY, next);
    document.querySelector("[role=tab]")!.setAttribute("aria-label", updated.name);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.persist).not.toHaveBeenCalled(); // Host acceptance still has the original metadata.
    writeDesktopPreferenceBlob(userDataDir, next);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.persist).not.toHaveBeenCalled(); // Has not yet been stable for a complete observation window.
    await vi.advanceTimersByTimeAsync(100);
    const receipt = await task;
    expect(receipt.tabs[1]).toEqual(updated);
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["disabled composer", "unstable metadata"])("bounds %s without seeding", async (condition) => {
    const h = harness();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (condition === "disabled composer") document.querySelector("textarea")!.disabled = true;
    else {
      let revision = 0;
      timer = setInterval(() => {
        const next = { ...root, name: `Changing metadata ${++revision}` };
        const raw = JSON.stringify({ ...prefs, sessionTabs: [next] });
        localStorage.setItem(STORAGE_KEY, raw);
        writeDesktopPreferenceBlob(userDataDir, raw);
        document.querySelector("[role=tab]")!.setAttribute("aria-label", next.name);
      }, 25);
    }
    const rejection = expect(h.prepare()).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    clearInterval(timer);
    await vi.advanceTimersByTimeAsync(1); // jsdom schedules nested storage notifications one tick later.
    expect(h.persist).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for hydration, real disk commit and a quiet window after one renderer write", async () => {
    const h = harness();
    document.querySelector("textarea")!.remove();
    h.persist.mockImplementation((raw) => { setTimeout(() => writeDesktopPreferenceBlob(userDataDir, raw), 100); });
    let done = false;
    const task = h.prepare().then((receipt) => { done = true; return receipt; });
    await vi.advanceTimersByTimeAsync(50);
    expect(h.persist).not.toHaveBeenCalled();
    document.querySelector("[data-chat-composer]")!.append(document.createElement("textarea"));
    await vi.advanceTimersByTimeAsync(75);
    expect(done).toBe(false);
    expect(JSON.parse(readDesktopPreferenceBlob(userDataDir)!).sessionTabs).toEqual([root]);
    await vi.advanceTimersByTimeAsync(150);
    const receipt = await task;
    expect(receipt.tabs[1]).toEqual(root);
    expect(receipt.tabs[0].id).not.toBe(root.id);
    expect(receipt.tabs[0].cwd).toBe(root.cwd);
    expect(JSON.parse(readDesktopPreferenceBlob(userDataDir)!).sessionTabs).toEqual(receipt.tabs);
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears only the fixture renderer key, preserves exact host bytes and acknowledges one clear", async () => {
    const h = harness();
    const seeded = await prepared(h);
    const before = readDesktopPreferenceBlob(userDataDir);
    localStorage.setItem("unrelated-ui-key", "keep");
    const receipt = await cleared(h, seeded);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("unrelated-ui-key")).toBe("keep");
    expect(readDesktopPreferenceBlob(userDataDir)).toBe(before);
    expect(seeded).not.toHaveProperty("storageCleared");
    expect(receipt.storageCleared).toBe(true);
    expect(h.persist).toHaveBeenCalledTimes(1);
    await expect(clearDesktopSmokeSessionTabsStorage({ ...h.options, receipt })).rejects.toThrow(/already cleared/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let same-origin storage substitute for broken preload restoration", async () => {
    const h = harness();
    const receipt = await cleared(h);
    h.restore(receipt, initialOrigin, false);
    await expect(h.verify(receipt)).rejects.toThrow(/not restored by the preload/);
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("fails when the actual renderer key removal is ineffective", async () => {
    const h = harness();
    const receipt = await prepared(h);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => {});
    await expect(clearDesktopSmokeSessionTabsStorage({ ...h.options, receipt })).rejects.toThrow(/key reappeared/);
    expect(receipt).not.toHaveProperty("storageCleared");
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it.each(["renderer", "host"])("rejects a late %s write during clear observation without repair", async (layer) => {
    const h = harness();
    const receipt = await prepared(h);
    const before = readDesktopPreferenceBlob(userDataDir)!;
    const rejection = expect(clearDesktopSmokeSessionTabsStorage({ ...h.options, receipt })).rejects.toThrow(/key reappeared|host mirror changed/);
    setTimeout(() => {
      if (layer === "renderer") localStorage.setItem(STORAGE_KEY, before);
      else writeDesktopPreferenceBlob(userDataDir, JSON.stringify({ ...JSON.parse(before), filesFontSize: 14 }));
    }, 25);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(receipt).not.toHaveProperty("storageCleared");
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an App write between clear completion and actual restart POST admission", async () => {
    const h = harness();
    const receipt = await cleared(h);
    localStorage.setItem(STORAGE_KEY, readDesktopPreferenceBlob(userDataDir)!);
    await expect(verifyDesktopSmokeSessionTabsCleared({ ...h.options, receipt, bootId: "old" })).rejects.toThrow(/key reappeared before restart handoff/);
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled clear operation without granting proof or scheduling a retry", async () => {
    const h = harness();
    const receipt = await prepared(h);
    let reject!: (error: Error) => void;
    const beforeCalls = h.executeJavaScript.mock.calls.length;
    h.executeJavaScript.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    const rejection = expect(clearDesktopSmokeSessionTabsStorage({ ...h.options, receipt })).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    reject(new Error("late clear teardown"));
    await Promise.resolve();
    expect(receipt).not.toHaveProperty("storageCleared");
    expect(h.executeJavaScript.mock.calls.length).toBe(beforeCalls + 1);
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([initialOrigin, successorOrigin])("requires cleared-storage restoration at %s, with origin change informational", async (origin) => {
    const h = harness();
    const seeded = await prepared(h);
    await verifyDesktopSmokeSessionTabsCommitted({ ...h.options, receipt: seeded });
    const receipt = await cleared(h, seeded);
    expect(await verifyDesktopSmokeSessionTabsCleared({ ...h.options, receipt, bootId: "old" })).toMatchObject({
      type: "desktop-smoke.session-tabs-storage-cleared", origin: initialOrigin, hash, rendererStorageCleared: true,
    });
    h.restore(receipt, origin);
    const task = h.verify(receipt);
    await vi.advanceTimersByTimeAsync(100);
    expect(await task).toEqual({
      type: "desktop-smoke.session-tabs-restored", bootId: "successor-boot", origin,
      hash, preferenceMirrorVerified: true, selectedRootVerified: true, inactiveBookmarkLazy: true,
      originChanged: origin !== initialOrigin, rendererStorageCleared: true,
      snapshotTranscriptVerified: true,
    });
    expect(h.persist).toHaveBeenCalledTimes(1); // Verification never repairs the fixture.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept the preload call alone when host validation drops sessionTabs", async () => {
    const h = harness();
    h.persist.mockImplementation(() => {});
    const rejection = expect(h.prepare()).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a late disk overwrite during observation instead of retrying the renderer write", async () => {
    const h = harness();
    h.persist.mockImplementation((raw) => {
      writeDesktopPreferenceBlob(userDataDir, raw);
      setTimeout(() => writeDesktopPreferenceBlob(userDataDir, JSON.stringify(prefs)), 25);
    });
    const rejection = expect(h.prepare()).rejects.toThrow(/overwritten after commit/);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["disk", "renderer"])("rechecks a late %s overwrite at restart admission", async (layer) => {
    const h = harness();
    const receipt = await prepared(h);
    if (layer === "disk") writeDesktopPreferenceBlob(userDataDir, JSON.stringify(prefs));
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    await expect(verifyDesktopSmokeSessionTabsCommitted({ ...h.options, receipt })).rejects.toThrow(/changed before restart|overwritten/);
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled renderer and observes its late rejection without admitting another write", async () => {
    const h = harness();
    let reject!: (error: Error) => void;
    h.executeJavaScript.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    const rejection = expect(h.prepare()).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    reject(new Error("late renderer teardown"));
    await Promise.resolve();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a renderer success that consumes the entire deadline before fixture persistence", async () => {
    const h = harness();
    h.executeJavaScript.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(500);
      return root;
    });
    await expect(h.prepare()).rejects.toThrow(/deadline/);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects absent renderer acknowledgement before restart even when the disk mirror matches", async () => {
    const h = harness();
    const receipt = await prepared(h);
    h.executeJavaScript.mockResolvedValueOnce(undefined);
    await expect(verifyDesktopSmokeSessionTabsCommitted({ ...h.options, receipt })).rejects.toThrow(/renderer preference verification/);
  });

  it.each(["missing bridge", "wrong selected root", "root error", "cwd mismatch"])("fails initial %s before fixture persistence", async (failure) => {
    const h = harness();
    if (failure === "missing bridge") delete window.easyresearchDesktop;
    if (failure === "wrong selected root") document.querySelector("[role=tab]")!.setAttribute("aria-selected", "false");
    if (failure === "root error") document.querySelector("[role=tab]")!.setAttribute("data-error", "true");
    if (failure === "cwd mismatch") localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prefs, sessionTabs: [{ ...root, cwd: "/wrong" }] }));
    const rejection = expect(h.prepare()).rejects.toThrow(/bridge|selected hydrated|cwd mismatch/);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(h.persist).not.toHaveBeenCalled();
  });

  it.each([initialOrigin, successorOrigin])("requires explicit storage clear proof even if DOM looks restored at %s", async (origin) => {
    const h = harness();
    const receipt = await prepared(h);
    h.restore(receipt, origin);
    await expect(h.verify(receipt)).rejects.toThrow(/storage clear proof is missing/);
  });

  it.each([
    "selected bookmark", "loading bookmark", "errored bookmark", "mounted bookmark",
    "unselected root", "wrong hash", "wrong catalog order", "wrong name", "wrong stored cwd", "missing preload restoration",
  ])("rejects successor %s", async (failure) => {
    const h = harness();
    const receipt = await cleared(h);
    h.restore(receipt);
    const [dormant, selected] = [...document.querySelectorAll("[role=tab]")];
    if (failure === "selected bookmark") dormant!.setAttribute("aria-selected", "true");
    if (failure === "loading bookmark") dormant!.setAttribute("data-loading", "true");
    if (failure === "errored bookmark") dormant!.setAttribute("data-error", "true");
    if (failure === "mounted bookmark") surface(receipt.tabs[0].id);
    if (failure === "unselected root") selected!.setAttribute("aria-selected", "false");
    if (failure === "wrong hash") h.setRoute(`#/work/${receipt.tabs[0].id}`);
    if (failure === "wrong catalog order") document.body.prepend(selected!);
    if (failure === "wrong name") dormant!.setAttribute("aria-label", "wrong");
    if (failure === "wrong stored cwd") localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prefs, sessionTabs: receipt.tabs.map((tab) => ({ ...tab, cwd: "/wrong" })) }));
    if (failure === "missing preload restoration") localStorage.clear();
    await expect(h.verify(receipt)).rejects.toThrow(/inactive bookmark|selection|catalog|not restored/);
    expect(h.persist).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); // Drain jsdom's queued storage events.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cannot accept persisted preferences without actual restored DOM", async () => {
    const h = harness();
    const receipt = await cleared(h);
    h.restore(receipt);
    document.querySelector("[data-session-tab-id]")!.remove();
    const rejection = expect(h.verify(receipt)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["initial", "successor"] as const)("does not accept fixture text outside the selected root transcript during %s", async (phase) => {
    const h = harness();
    const receipt = phase === "successor" ? await cleared(h) : undefined;
    if (receipt) h.restore(receipt);
    document.querySelector('[data-message-body="user"]')!.remove();
    document.querySelector("textarea")!.value = transcriptUser;
    const unrelated = document.createElement("div");
    unrelated.dataset.messageBody = "user";
    unrelated.textContent = transcriptUser;
    document.body.append(unrelated);
    const rejection = expect(receipt ? h.verify(receipt) : h.prepare()).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    expect(h.persist).toHaveBeenCalledTimes(receipt ? 1 : 0);
  });

  it.each(["missing bookmark", "reordered IDs", "changed root ID", "changed cwd", "omitted named root", "changed named root", "trimmed named root"])("never normalizes %s while permitting only empty/omitted unnamed metadata", async (change) => {
    const h = harness();
    const receipt = await cleared(h);
    h.restore(receipt);
    const tabs: SessionTab[] = receipt.tabs.map((tab) => ({ ...tab }));
    if (change === "missing bookmark") tabs.shift();
    if (change === "reordered IDs") tabs.reverse();
    if (change === "changed root ID") tabs[1]!.id = "different-root";
    if (change === "changed cwd") tabs[1]!.cwd = "/different/project";
    if (change === "omitted named root") delete tabs[1]!.name;
    if (change === "changed named root") tabs[1]!.name = "Replacement name";
    if (change === "trimmed named root") tabs[1]!.name = ` ${root.name} `;
    const raw = JSON.stringify({ ...prefs, sessionTabs: tabs });
    localStorage.setItem(STORAGE_KEY, raw);
    writeDesktopPreferenceBlob(userDataDir, raw);
    await expect(h.verify(receipt)).rejects.toThrow(/mirror changed/);
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("does not hide a later eager mount during successor observation", async () => {
    const h = harness();
    const receipt = await cleared(h);
    h.restore(receipt);
    const rejection = expect(h.verify(receipt)).rejects.toThrow(/inactive bookmark/);
    setTimeout(() => surface(receipt.tabs[0].id), 25);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
