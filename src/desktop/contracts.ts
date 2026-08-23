export const DESKTOP_LAUNCH_ENV = "EASYRESEARCH_DESKTOP_LAUNCH";
export const DESKTOP_CONTROL_TOKEN_ENV = "EASYRESEARCH_DESKTOP_CONTROL_TOKEN";
export const DESKTOP_RENDERER_TOKEN_ENV = "EASYRESEARCH_DESKTOP_RENDERER_TOKEN";
export const DESKTOP_EVENT_PREFIX = "@easyresearch-desktop ";
export const DESKTOP_ACCESS_HEADER = "x-easyresearch-desktop-token";
export const DESKTOP_SMOKE_USER_DATA_ENV = "EASYRESEARCH_DESKTOP_SMOKE_USER_DATA";

export type DesktopSidecarEvent =
  | { type: "desktop.setup"; message: string }
  | { type: "desktop.ready"; origin: string; owner: "desktop"; pid: number; logPath: string }
  | {
    type: "desktop.error";
    phase: "ownership" | "setup" | "server" | "shutdown";
    code: string;
    message: string;
    logPath: string;
  }
  | { type: "desktop.stopped" };

export type DesktopReadyEvent = Extract<DesktopSidecarEvent, { type: "desktop.ready" }>;

export interface DesktopHostMetadata {
  platform: "win32" | "darwin";
  version: string;
}
