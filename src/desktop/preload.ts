import { contextBridge, ipcRenderer } from "electron";
import type { UpdateAction, UpdateActionResult, UpdateSnapshot } from "../runtime/update-contract";
import { DESKTOP_UPDATE_ACTION_CHANNEL, DESKTOP_UPDATE_EVENT_CHANNEL, DESKTOP_UPDATE_SNAPSHOT_CHANNEL } from "./contracts";
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
  persistWebUiPreferences(raw: string | null): void {
    if (raw === null || typeof raw === "string") {
      ipcRenderer.send(DESKTOP_PREFERENCES_WRITE_CHANNEL, raw);
    }
  },
}));
