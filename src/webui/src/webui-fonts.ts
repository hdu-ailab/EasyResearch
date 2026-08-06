import type { WebuiSettingsDto } from "../../web/contracts";

/**
 * Apply Web panel font sizes as CSS variables on the document root so every
 * component that uses `text-[length:var(--v2-chat-font-size)]` /
 * `--v2-files-font-size` re-renders live, with no reload.
 */
export function applyWebuiSettings(settings: WebuiSettingsDto): void {
  const root = document.documentElement.style;
  root.setProperty("--v2-chat-font-size", `${settings.chatFontSize}px`);
  root.setProperty("--v2-files-font-size", `${settings.filesFontSize}px`);
}
