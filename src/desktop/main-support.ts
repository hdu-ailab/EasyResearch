import type { DesktopLifecycleState } from "./lifecycle";
import { handleWindowClose } from "./lifecycle";
import {
  parseHashRoute,
  routeToHash,
  withoutSettings,
} from "../webui/src/router";

export const DESKTOP_PREFERENCES_READ_CHANNEL = "desktop:preferences:read";
export const DESKTOP_PREFERENCES_WRITE_CHANNEL = "desktop:preferences:write";
export const DESKTOP_HOST_VERSION_CHANNEL = "desktop:host-version";
export const DESKTOP_SESSION_PARTITION = "persist:easyresearch-desktop";

export interface DesktopWindowOptions {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  show: boolean;
  backgroundColor: string;
  title: string;
  webPreferences: {
    preload: string;
    partition: string;
    nodeIntegration: false;
    contextIsolation: true;
    sandbox: true;
    webSecurity: true;
  };
}

export function desktopWindowOptions(
  preload: string,
  partition: string,
): DesktopWindowOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: "#f3efe6",
    title: "EasyResearch",
    webPreferences: {
      preload,
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  };
}

export function isCurrentDesktopDocument(
  documentUrl: string,
  readyOrigin: string,
  hasRenderedRoot: boolean,
  authenticatedStatus: boolean,
): boolean {
  if (!hasRenderedRoot || !authenticatedStatus) return false;
  try {
    const document = new URL(documentUrl);
    return document.origin === new URL(readyOrigin).origin
      && document.username === ""
      && document.password === ""
      && document.pathname === "/"
      && document.search === "";
  } catch {
    return false;
  }
}

export function captureDesktopRestartHash(documentUrl: string, readyOrigin: string): string {
  try {
    const document = new URL(documentUrl);
    if (
      document.origin !== new URL(readyOrigin).origin
      || document.username !== ""
      || document.password !== ""
      || document.pathname !== "/"
      || document.search !== ""
    ) {
      return "#/";
    }
    const route = parseHashRoute(document.hash);
    if (!route) return "#/";
    if (route.page === "config") {
      return route.returnTo ? routeToHash(withoutSettings(route.returnTo)) : "#/";
    }
    return routeToHash(withoutSettings(route));
  } catch {
    return "#/";
  }
}

export function handleMainWindowClose(
  state: DesktopLifecycleState,
  event: { preventDefault(): void },
  hide: () => void,
): void {
  if (handleWindowClose(state).action === "close") return;
  event.preventDefault();
  hide();
}

export interface TrayMenuItem {
  label?: string;
  type?: "separator";
  click?: () => void;
}

export function createTrayMenuTemplate(actions: {
  open: () => void;
  check: () => void;
  exit: () => void;
}): TrayMenuItem[] {
  return [
    { label: "Open EasyResearch", click: actions.open },
    { label: "Check for Updates", click: actions.check },
    { type: "separator" },
    { label: "Exit", click: actions.exit },
  ];
}
