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
export const TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABTElEQVRYw+2XMVLDMBBFH5lcgziNZkwTiqTEVRquwQ0IB8kVuAaNK6eEAjd4Rk2cXIOCIquwMWAnkYyHwdtoLMv6T+vd0S78d7v4bjI2EcAEmAOjADobIAXywpb1ALGJIuAJiFs4cAHcFrbcUxwAiPhaTWXASwDhGXCjnscOYg8gbn+Tk78DprDl+niNeotNNAYsMBRPXBW2ZKDWTPh0e1BxANnPOB7ROwCYy7gKLV6ByLSeBnDR/tyGuDIXUyPY/Y9ae0yuL4EHD8HlXfa6/ellI4CI33ueeuEDsPQUr/2+EUDct2had64N/Lf44wBtZEFt1J8MwHlZcHTMtJEFJ63vs6BzgP4u6O8CHYQbGadtiYnNtJ4GSGVMpIAMbrKvq47TKkDOrloFsKEhVFWM6OTQ3BesCFMjToFEPX/tCyoQ3XRGCgJ+qTfs3D4AUxdvdO8dHTAAAAAASUVORK5CYII=";

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

export function renderLoadingDocument(status: string): string {
  const safeStatus = escapeHtml(status);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EasyResearch</title>
  <style>
    :root { color-scheme: light; font-family: Georgia, 'Times New Roman', serif; background: #f3efe6; color: #28251f; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; }
    main { width: min(30rem, calc(100vw - 3rem)); border: 1px solid #c8bead; background: #fffdf8; padding: 2rem; box-shadow: 0 18px 50px rgba(49, 42, 31, .12); }
    h1 { margin: 0 0 .7rem; font-size: 1.65rem; font-weight: 600; letter-spacing: -.02em; }
    p { margin: 0; color: #6c6254; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .rule { width: 4rem; height: 2px; margin: 1.1rem 0; background: #9f3d2f; }
  </style>
</head>
<body><main><h1>EasyResearch</h1><div class="rule"></div><p>${safeStatus}</p></main></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}
