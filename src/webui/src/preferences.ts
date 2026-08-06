export type Language = "en" | "zh-CN";

export interface WebUiPreferences {
  chatFontSize: number;
  filesFontSize: number;
  language: Language;
}

export const CHAT_FONT_MIN = 10;
export const CHAT_FONT_MAX = 20;
export const FILES_FONT_MIN = 10;
export const FILES_FONT_MAX = 20;
export const DEFAULT_CHAT_FONT_SIZE = 13;
export const DEFAULT_FILES_FONT_SIZE = 12;
export const STORAGE_KEY = "lazyresearch.webui.preferences";

export function resolveLanguage(navigatorLanguage: string): Language {
  return navigatorLanguage.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

function pickFontSize(value: unknown, fallback: number, min: number, max: number): number {
  return isInt(value) && value >= min && value <= max ? value : fallback;
}

export function readPreferences(
  storage: Pick<Storage, "getItem">,
  navigatorLanguage: () => string,
): WebUiPreferences {
  const browserLanguage = resolveLanguage(navigatorLanguage());
  const defaults = (language: Language): WebUiPreferences => ({
    chatFontSize: DEFAULT_CHAT_FONT_SIZE,
    filesFontSize: DEFAULT_FILES_FONT_SIZE,
    language,
  });
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return defaults(browserLanguage);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const language: Language = parsed.language === "en" || parsed.language === "zh-CN" ? parsed.language : browserLanguage;
    return {
      chatFontSize: pickFontSize(parsed.chatFontSize, DEFAULT_CHAT_FONT_SIZE, CHAT_FONT_MIN, CHAT_FONT_MAX),
      filesFontSize: pickFontSize(parsed.filesFontSize, DEFAULT_FILES_FONT_SIZE, FILES_FONT_MIN, FILES_FONT_MAX),
      language,
    };
  } catch {
    return defaults(browserLanguage);
  }
}

export function writePreferences(storage: Pick<Storage, "setItem">, prefs: WebUiPreferences): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
