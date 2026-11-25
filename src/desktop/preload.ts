import { contextBridge, ipcRenderer } from "electron";
import type { UpdateAction, UpdateActionResult, UpdateSnapshot } from "../runtime/update-contract";
import {
  DESKTOP_UPDATE_ACTION_CHANNEL,
  DESKTOP_UPDATE_EVENT_CHANNEL,
  DESKTOP_UPDATE_OPEN_CHANNEL,
  DESKTOP_UPDATE_OPEN_READY_CHANNEL,
  DESKTOP_UPDATE_SNAPSHOT_CHANNEL,
  type DesktopUpdateOpenIntent,
} from "./contracts";
import { STORAGE_KEY } from "../webui/src/preferences";
import {
  DESKTOP_HOST_VERSION_CHANNEL,
  DESKTOP_PREFERENCES_READ_CHANNEL,
  DESKTOP_PREFERENCES_WRITE_CHANNEL,
} from "./main-support";

const stored = ipcRenderer.sendSync(DESKTOP_PREFERENCES_READ_CHANNEL) as unknown;
if (typeof stored === "string") {
  try {
    window.localStorage.setItem(STORAGE_KEY, stored);
  } catch {
    // The Web provider retains the same preference defaults in memory.
  }
}

const version = ipcRenderer.sendSync(DESKTOP_HOST_VERSION_CHANNEL) as unknown;
let openUpdatesSubscription: { listener: (intent: DesktopUpdateOpenIntent) => void } | undefined;
let pendingOpen: DesktopUpdateOpenIntent | undefined;
ipcRenderer.on(DESKTOP_UPDATE_OPEN_CHANNEL, (_event, intent: unknown) => {
  if (intent !== "check" && intent !== "recovery") return;
  if (openUpdatesSubscription) openUpdatesSubscription.listener(intent);
  else pendingOpen = pendingOpen === "recovery" ? pendingOpen : intent;
});
contextBridge.exposeInMainWorld("easyresearchDesktop", Object.freeze({
  platform: process.platform,
  version: typeof version === "string" ? version : "0.0.0",
  updateSnapshot(): Promise<UpdateSnapshot> {
    return ipcRenderer.invoke(DESKTOP_UPDATE_SNAPSHOT_CHANNEL);
  },
  updateAction(action: UpdateAction): Promise<UpdateActionResult> {
    return ipcRenderer.invoke(DESKTOP_UPDATE_ACTION_CHANNEL, action);
  },
  onUpdate(listener: (snapshot: UpdateSnapshot) => void): () => void {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: UpdateSnapshot) => listener(snapshot);
    ipcRenderer.on(DESKTOP_UPDATE_EVENT_CHANNEL, receive);
    return () => { ipcRenderer.removeListener(DESKTOP_UPDATE_EVENT_CHANNEL, receive); };
  },
  onOpenUpdates(listener: (intent: DesktopUpdateOpenIntent) => void): () => void {
    if (typeof listener !== "function") throw new Error("Update presentation requires a listener.");
    const subscription = { listener };
    openUpdatesSubscription = subscription;
    if (pendingOpen) {
      const intent = pendingOpen;
      pendingOpen = undefined;
      listener(intent);
    }
    // Listen before signalling: did-finish-load alone does not prove React has
    // mounted its shared dialog owner. A cleanup cannot revoke a newer listener.
    ipcRenderer.send(DESKTOP_UPDATE_OPEN_READY_CHANNEL, true);
    return () => {
      if (openUpdatesSubscription !== subscription) return;
      openUpdatesSubscription = undefined;
      ipcRenderer.send(DESKTOP_UPDATE_OPEN_READY_CHANNEL, false);
    };
  },
  persistWebUiPreferences(raw: string | null): void {
    if (raw === null || typeof raw === "string") {
      ipcRenderer.send(DESKTOP_PREFERENCES_WRITE_CHANNEL, raw);
    }
  },
}));
