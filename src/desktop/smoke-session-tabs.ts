import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { readDesktopPreferenceBlob } from "./preferences-store";
import { STORAGE_KEY } from "../webui/src/preferences";
import type { SessionTab } from "../webui/src/session-tabs";
import { messages } from "../webui/src/i18n/messages";

const untitledLabels: Record<string, string> = {
  en: messages.en["sessionTabs.untitled"],
  "zh-CN": messages["zh-CN"]["sessionTabs.untitled"],
};

export interface DesktopSmokeSessionTabsReceipt {
  origin: string;
  hash: string;
  /** Ordinary fixture content from the real prompt, never injected into the UI. */
  transcriptUser: string;
  /** Put the dormant bookmark first: the URL, not catalog order, must select Work. */
  tabs: [SessionTab, SessionTab];
  /** Set only after clearing this receipt's old-origin renderer key and observing its absence. */
  storageCleared?: true;
}

interface ProbeOptions {
  webContents: Pick<WebContents, "executeJavaScript">;
  userDataDir: string;
  timeoutMs?: number;
  observationMs?: number;
}

/** Packaged smoke only: the receipt carries UI metadata and its ordinary fixture prompt, never preferences or credentials. */
export async function prepareDesktopSmokeSessionTabs(options: ProbeOptions & {
  origin: string;
  hash: string;
  sessionId: string;
  cwd: string;
  transcriptUser: string;
}): Promise<DesktopSmokeSessionTabsReceipt> {
  if (!options.transcriptUser?.trim()) throw new Error("Desktop session tabs requires fixture transcript evidence.");
  const probe = createProbe(options);
  const bridgeAvailable = await probe.run(() => options.webContents.executeJavaScript(
    "typeof window.easyresearchDesktop?.persistWebUiPreferences === 'function'",
  ));
  // Throw in the host: Electron can replace a renderer-thrown error with a generic
  // executeJavaScript failure, hiding the reason a preference mirror never appeared.
  if (bridgeAvailable !== true) throw new Error("Desktop session tabs preference bridge is unavailable in the authenticated renderer.");
  let root: SessionTab | undefined;
  let stableAt: number | undefined;
  while (true) {
    const current = await probe.run(() => options.webContents.executeJavaScript(
      `(${inspectInitialRenderer.toString()})(${JSON.stringify({
        key: STORAGE_KEY, origin: options.origin, hash: options.hash,
        id: options.sessionId, cwd: options.cwd,
        untitledLabels,
        transcriptUser: options.transcriptUser,
      })})`,
    )) as SessionTab | undefined;
    const raw = readDesktopPreferenceBlob(options.userDataDir);
    const mirrored = raw ? (JSON.parse(raw) as { sessionTabs?: SessionTab[] }).sessionTabs?.find((tab) => tab.id === options.sessionId) : undefined;
    if (!current || !mirrored || !sameTabs([mirrored], [current])) {
      root = undefined;
      stableAt = undefined;
    } else {
      if (!root || !sameTabs([root], [current])) stableAt = performance.now();
      root = current;
      if (stableAt !== undefined && performance.now() - stableAt >= probe.observationMs) break;
    }
    await probe.pause();
  }
  const receipt: DesktopSmokeSessionTabsReceipt = {
    origin: options.origin,
    hash: options.hash,
    transcriptUser: options.transcriptUser,
    tabs: [
      { id: randomUUID(), cwd: options.cwd, name: "Desktop smoke — inactive bookmark" },
      root,
    ],
  };
  // This one write crosses the real exposed preload. Never write the host store
  // directly, retry the write, or repair a later application overwrite.
  const saved = await probe.run(() => options.webContents.executeJavaScript(
    `(${seedRenderer.toString()})(${JSON.stringify({ key: STORAGE_KEY, receipt })})`,
  ));
  if (saved !== true) throw new Error("Desktop session tabs renderer preference write failed.");
  let committed = false;
  let observedAt: number | undefined;
  while (true) {
    const matches = mirrorMatches(options.userDataDir, receipt);
    if (committed && !matches) throw new Error("Desktop session tabs preference mirror was overwritten after commit.");
    if (matches) {
      committed = true;
      observedAt ??= performance.now();
    }
    const retained = await probe.run(() => options.webContents.executeJavaScript(
      `(${inspectSeededRenderer.toString()})(${JSON.stringify({ key: STORAGE_KEY, receipt })})`,
    ));
    if (retained !== true) throw new Error("Desktop session tabs renderer preference verification failed.");
    if (observedAt !== undefined && performance.now() - observedAt >= probe.observationMs) {
      if (!mirrorMatches(options.userDataDir, receipt)) throw new Error("Desktop session tabs preference mirror was overwritten after commit.");
      return receipt;
    }
    await probe.pause();
  }
}

/** Recheck at restart admission, after the harness's independent auth/ownership checks. */
export async function verifyDesktopSmokeSessionTabsCommitted(
  options: ProbeOptions & { receipt: DesktopSmokeSessionTabsReceipt },
): Promise<void> {
  if (!mirrorMatches(options.userDataDir, options.receipt)) {
    throw new Error("Desktop session tabs preference mirror changed before restart.");
  }
  const probe = createProbe(options);
  const retained = await probe.run(() => options.webContents.executeJavaScript(
    `(${inspectSeededRenderer.toString()})(${JSON.stringify({ key: STORAGE_KEY, receipt: options.receipt })})`,
  ));
  if (retained !== true) throw new Error("Desktop session tabs renderer preference verification failed.");
  if (!mirrorMatches(options.userDataDir, options.receipt)) {
    throw new Error("Desktop session tabs preference mirror changed before restart.");
  }
}

/** Remove only the fixture's renderer key; the preference IPC/store must remain untouched. */
export async function clearDesktopSmokeSessionTabsStorage(
  options: ProbeOptions & { receipt: DesktopSmokeSessionTabsReceipt },
): Promise<DesktopSmokeSessionTabsReceipt> {
  if (options.receipt.storageCleared) throw new Error("Desktop session tabs renderer storage was already cleared.");
  const probe = createProbe(options);
  const before = readDesktopPreferenceBlob(options.userDataDir);
  if (!before || !mirrorMatches(options.userDataDir, options.receipt)) {
    throw new Error("Desktop session tabs preference mirror changed before storage clear.");
  }
  const input = JSON.stringify({ key: STORAGE_KEY, receipt: options.receipt });
  // Validate and clear in one renderer task. Do not send null through the preload:
  // that would delete the authoritative host mirror as well.
  const cleared = await probe.run(() => options.webContents.executeJavaScript(`((input) => {
    (${inspectSeededRenderer.toString()})(input);
    localStorage.removeItem(input.key);
    return (${inspectClearedRenderer.toString()})(input);
  })(${input})`));
  if (cleared !== true) throw new Error("Desktop session tabs renderer storage clear was not acknowledged.");
  const observedAt = performance.now();
  while (true) {
    const absent = await probe.run(() => options.webContents.executeJavaScript(
      `(${inspectClearedRenderer.toString()})(${input})`,
    ));
    if (absent !== true) throw new Error("Desktop session tabs cleared renderer storage was not verified.");
    if (readDesktopPreferenceBlob(options.userDataDir) !== before) {
      throw new Error("Desktop session tabs host mirror changed while clearing renderer storage.");
    }
    if (performance.now() - observedAt >= probe.observationMs) return { ...options.receipt, storageCleared: true };
    await probe.pause();
  }
}

/** Final admission check immediately before the actual restart POST, after proxy preflight. */
export async function verifyDesktopSmokeSessionTabsCleared(
  options: ProbeOptions & { receipt: DesktopSmokeSessionTabsReceipt; bootId: string },
): Promise<Record<string, unknown>> {
  if (options.receipt.storageCleared !== true) throw new Error("Desktop session tabs renderer storage clear proof is missing.");
  if (!mirrorMatches(options.userDataDir, options.receipt)) throw new Error("Desktop session tabs host mirror changed before restart handoff.");
  const probe = createProbe(options);
  const absent = await probe.run(() => options.webContents.executeJavaScript(
    `(${inspectClearedRenderer.toString()})(${JSON.stringify({ key: STORAGE_KEY, receipt: options.receipt })})`,
  ));
  if (absent !== true) throw new Error("Desktop session tabs cleared renderer storage was not verified.");
  if (!mirrorMatches(options.userDataDir, options.receipt)) throw new Error("Desktop session tabs host mirror changed before restart handoff.");
  return {
    type: "desktop-smoke.session-tabs-storage-cleared",
    bootId: options.bootId,
    origin: options.receipt.origin,
    hash: options.receipt.hash,
    rendererStorageCleared: true,
    preferenceMirrorVerified: true,
  };
}

/** No writes in this phase: only the normal preload/App startup may restore the new document. */
export async function verifyDesktopSmokeSessionTabs(options: ProbeOptions & {
  receipt: DesktopSmokeSessionTabsReceipt;
  origin: string;
  bootId: string;
}): Promise<Record<string, unknown>> {
  if (options.receipt.storageCleared !== true) throw new Error("Desktop session tabs renderer storage clear proof is missing.");
  const probe = createProbe(options);
  let observedAt: number | undefined;
  while (true) {
    if (!mirrorMatches(options.userDataDir, options.receipt)) {
      throw new Error("Desktop session tabs preference mirror changed during successor restoration.");
    }
    const ready = await probe.run(() => options.webContents.executeJavaScript(
      `(${inspectRestoredRenderer.toString()})(${JSON.stringify({
        key: STORAGE_KEY, receipt: options.receipt, origin: options.origin, untitledLabels,
      })})`,
    ));
    if (ready === true) observedAt ??= performance.now();
    else if (observedAt !== undefined) throw new Error("Desktop session tabs disappeared after successor restoration.");
    if (observedAt !== undefined && performance.now() - observedAt >= probe.observationMs) {
      if (!mirrorMatches(options.userDataDir, options.receipt)) {
        throw new Error("Desktop session tabs preference mirror changed during successor restoration.");
      }
      return {
        type: "desktop-smoke.session-tabs-restored",
        bootId: options.bootId,
        origin: options.origin,
        hash: options.receipt.hash,
        originChanged: options.origin !== options.receipt.origin,
        rendererStorageCleared: true,
        preferenceMirrorVerified: true,
        selectedRootVerified: true,
        inactiveBookmarkLazy: true,
        snapshotTranscriptVerified: true,
      };
    }
    await probe.pause();
  }
}

function mirrorMatches(userDataDir: string, receipt: DesktopSmokeSessionTabsReceipt): boolean {
  const raw = readDesktopPreferenceBlob(userDataDir);
  if (!raw) return false;
  const tabs = (JSON.parse(raw) as { sessionTabs?: SessionTab[] }).sessionTabs;
  return sameTabs(tabs, receipt.tabs);
}

function sameTabs(tabs: SessionTab[] | undefined, expected: SessionTab[]): boolean {
  return Array.isArray(tabs) && tabs.length === expected.length && tabs.every((tab, index) => {
    const wanted = expected[index]!;
    // Work reports an unnamed session as ""; status/open may omit its name.
    // No other value (including whitespace) is normalized.
    return tab.id === wanted.id && tab.cwd === wanted.cwd && (tab.name === undefined ? "" : tab.name) === (wanted.name === undefined ? "" : wanted.name);
  });
}

function createProbe(options: ProbeOptions) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const observationMs = options.observationMs ?? 400;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || !Number.isSafeInteger(observationMs) || observationMs <= 0 || observationMs >= timeoutMs) {
    throw new Error("Desktop session tabs probe requires a positive deadline longer than its observation window.");
  }
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const ms = deadline - performance.now();
    if (ms <= 0) throw new Error("Desktop session tabs deadline expired.");
    return ms;
  };
  return {
    observationMs,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      // executeJavaScript has no cancellation API. Keep its rejection observed
      // even on timeout; the caller then terminally closes the owned smoke host.
      // Each renderer probe is synchronous and no successor write is scheduled.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => { remaining(); return operation(); }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Desktop session tabs deadline expired.")), remaining());
          }),
        ]);
        remaining(); // A late success cannot satisfy the deadline.
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
    async pause() {
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining())));
      remaining();
    },
  };
}

// These functions are serialized after bundling. Keep them closure-free, with
// only DOM/localStorage/the existing preference bridge; no source UI test hooks.
function inspectInitialRenderer(input: { key: string; origin: string; hash: string; id: string; cwd: string; untitledLabels: Record<string, string>; transcriptUser: string }): SessionTab | undefined {
  if (location.origin !== input.origin || location.hash !== input.hash) throw new Error("Desktop session tabs initial route changed.");
  const tabs = [...document.querySelectorAll('[data-session-tab-id]')];
  const root = tabs.find((tab) => tab.getAttribute("data-session-tab-id") === input.id);
  const surface = [...document.querySelectorAll('[data-session-surface]')].find((node) => node.getAttribute("data-session-surface") === input.id);
  const composer = surface?.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea");
  if (!root || !surface || !composer || composer.disabled) return undefined;
  if (![...surface.querySelectorAll('[data-message-body="user"]')].some((node) => node.textContent === input.transcriptUser)) return undefined;
  if (root.getAttribute("role") !== "tab" || root.getAttribute("aria-selected") !== "true"
    || root.hasAttribute("data-loading") || root.hasAttribute("data-error")
    || surface.getAttribute("data-session-active") !== "true") {
    throw new Error("Desktop session tabs initial root is not the selected hydrated Work view.");
  }
  const raw = localStorage.getItem(input.key);
  const prefs = raw ? JSON.parse(raw) as { sessionTabs?: SessionTab[]; language?: string } : undefined;
  const descriptor = prefs?.sessionTabs?.find((tab) => tab.id === input.id);
  if (!descriptor) return undefined; // App's metadata preference effect may not have committed yet.
  if (descriptor.cwd !== input.cwd) throw new Error("Desktop session tabs initial root cwd mismatch.");
  const expectedLabel = descriptor.name || input.untitledLabels[prefs?.language ?? ""];
  if (!expectedLabel || root.getAttribute("aria-label") !== expectedLabel) return undefined;
  return { id: descriptor.id, cwd: descriptor.cwd, ...(descriptor.name === undefined ? {} : { name: descriptor.name }) };
}

function seedRenderer(input: { key: string; receipt: DesktopSmokeSessionTabsReceipt }): boolean {
  if (location.origin !== input.receipt.origin || location.hash !== input.receipt.hash) throw new Error("Desktop session tabs seed route changed.");
  const raw = localStorage.getItem(input.key);
  if (!raw || !window.easyresearchDesktop) throw new Error("Desktop session tabs preference bridge or initial preferences unavailable.");
  const prefs = JSON.parse(raw) as { sessionTabs?: SessionTab[] };
  const root = input.receipt.tabs[1];
  const current = prefs.sessionTabs?.find((tab) => tab.id === root.id);
  if (!current || current.cwd !== root.cwd || (current.name === undefined ? "" : current.name) !== (root.name === undefined ? "" : root.name)) {
    throw new Error("Desktop session tabs root metadata changed after its stable observation.");
  }
  const next = JSON.stringify({ ...prefs, sessionTabs: input.receipt.tabs });
  localStorage.setItem(input.key, next);
  window.easyresearchDesktop.persistWebUiPreferences(next);
  return true;
}

function inspectSeededRenderer(input: { key: string; receipt: DesktopSmokeSessionTabsReceipt }): boolean {
  if (location.origin !== input.receipt.origin || location.hash !== input.receipt.hash) throw new Error("Desktop session tabs seeded route changed.");
  const raw = localStorage.getItem(input.key);
  const tabs = raw ? (JSON.parse(raw) as { sessionTabs?: SessionTab[] }).sessionTabs : undefined;
  if (!Array.isArray(tabs) || tabs.length !== input.receipt.tabs.length || tabs.some((tab, index) => {
    const expected = input.receipt.tabs[index]!;
    return tab.id !== expected.id || tab.cwd !== expected.cwd || (tab.name === undefined ? "" : tab.name) !== (expected.name === undefined ? "" : expected.name);
  })) throw new Error("Desktop session tabs renderer preferences were overwritten after seeding.");
  return true;
}

function inspectClearedRenderer(input: { key: string; receipt: DesktopSmokeSessionTabsReceipt }): boolean {
  if (location.origin !== input.receipt.origin || location.hash !== input.receipt.hash) throw new Error("Desktop session tabs storage clear left the old-origin Work route.");
  if (localStorage.getItem(input.key) !== null) throw new Error("Desktop session tabs renderer preference key reappeared before restart handoff.");
  return true;
}

function inspectRestoredRenderer(input: { key: string; receipt: DesktopSmokeSessionTabsReceipt; origin: string; untitledLabels: Record<string, string> }): boolean {
  if (location.origin !== input.origin || location.hash !== input.receipt.hash) throw new Error("Desktop session tabs successor selection changed.");
  const raw = localStorage.getItem(input.key);
  const prefs = raw ? JSON.parse(raw) as { sessionTabs?: SessionTab[]; language?: string } : undefined;
  const stored = prefs?.sessionTabs;
  if (!Array.isArray(stored) || stored.length !== input.receipt.tabs.length || stored.some((tab, index) => {
    const expected = input.receipt.tabs[index]!;
    return tab.id !== expected.id || tab.cwd !== expected.cwd || (tab.name === undefined ? "" : tab.name) !== (expected.name === undefined ? "" : expected.name);
  })) throw new Error("Desktop session tabs successor preferences were not restored by the preload.");
  const [bookmark, root] = input.receipt.tabs;
  const tabs = [...document.querySelectorAll('[data-session-tab-id]')];
  const dormant = tabs.find((tab) => tab.getAttribute("data-session-tab-id") === bookmark.id);
  const selected = tabs.find((tab) => tab.getAttribute("data-session-tab-id") === root.id);
  const surfaces = [...document.querySelectorAll('[data-session-surface]')];
  if (surfaces.some((node) => node.getAttribute("data-session-surface") === bookmark.id)
    || (dormant && (dormant.getAttribute("role") !== "tab" || dormant.getAttribute("aria-selected") !== "false"
      || dormant.hasAttribute("data-loading") || dormant.hasAttribute("data-error")))) {
    throw new Error("Desktop session tabs inactive bookmark was selected, loaded or errored.");
  }
  if (selected && (selected.getAttribute("role") !== "tab" || selected.getAttribute("aria-selected") !== "true"
    || selected.hasAttribute("data-error"))) throw new Error("Desktop session tabs root selection was not restored.");
  if (!dormant || !selected) return false;
  const expectedRootLabel = root.name || input.untitledLabels[prefs?.language ?? ""];
  if (tabs.length !== input.receipt.tabs.length || tabs.some((tab, index) => tab.getAttribute("data-session-tab-id") !== input.receipt.tabs[index]!.id)
    || dormant.getAttribute("aria-label") !== bookmark.name
    || !expectedRootLabel || selected.getAttribute("aria-label") !== expectedRootLabel) {
    throw new Error("Desktop session tabs restored catalog order or names differ from the preference mirror.");
  }
  const surface = surfaces.find((node) => node.getAttribute("data-session-surface") === root.id);
  const composer = surface?.querySelector<HTMLTextAreaElement>("[data-chat-composer] textarea");
  const transcriptVisible = Boolean(input.receipt.transcriptUser?.trim() && surface
    && [...surface.querySelectorAll('[data-message-body="user"]')].some((node) => node.textContent === input.receipt.transcriptUser));
  return Boolean(!selected.hasAttribute("data-loading") && surface?.getAttribute("data-session-active") === "true"
    && !surface.hasAttribute("inert") && composer && !composer.disabled && transcriptVisible);
}
