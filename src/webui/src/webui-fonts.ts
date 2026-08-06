import type { WebUiPreferences } from "./preferences";

export const CHAT_FONT_VAR = "--v2-chat-font-size";
export const FILES_FONT_VAR = "--v2-files-font-size";

export function applyFontPreferences(prefs: WebUiPreferences): void {
  const root = document.documentElement.style;
  root.setProperty(CHAT_FONT_VAR, `${prefs.chatFontSize}px`);
  root.setProperty(FILES_FONT_VAR, `${prefs.filesFontSize}px`);
}
