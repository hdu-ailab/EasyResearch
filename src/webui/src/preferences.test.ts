import { describe, expect, it } from "vitest";
import {
  CHAT_FONT_MIN,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_FILES_FONT_SIZE,
  FILES_FONT_MAX,
  readPreferences,
  resolveLanguage,
  STORAGE_KEY,
  writePreferences,
} from "./preferences";

function fakeStorage(initial: Record<string, string> = {}): Storage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
    get length() {
      return Object.keys(data).length;
    },
  } as Storage & { data: Record<string, string> };
}

const nav = (lang: string) => () => lang;

describe("resolveLanguage", () => {
  it("maps zh* to zh-CN", () => {
    for (const lang of ["zh", "zh-CN", "zh-TW", "zh-Hant"]) {
      expect(resolveLanguage(lang)).toBe("zh-CN");
    }
  });
  it("maps everything else to en", () => {
    for (const lang of ["en", "en-US", "en-GB", "fr", "de", ""]) {
      expect(resolveLanguage(lang)).toBe("en");
    }
  });
});

describe("readPreferences", () => {
  it("returns defaults and browser language when nothing is stored", () => {
    const prefs = readPreferences(fakeStorage(), nav("zh-CN"));
    expect(prefs).toEqual({
      chatFontSize: DEFAULT_CHAT_FONT_SIZE,
      filesFontSize: DEFAULT_FILES_FONT_SIZE,
      language: "zh-CN",
      autoExpandThinking: false,
      autoExpandTools: false,
      expandSubagentOutput: false,
    });
    expect(readPreferences(fakeStorage(), nav("en-US")).language).toBe("en");
  });

  it("round-trips stored values", () => {
    const storage = fakeStorage();
    writePreferences(storage, {
      chatFontSize: 16,
      filesFontSize: 11,
      language: "zh-CN",
      autoExpandThinking: true,
      autoExpandTools: false,
      expandSubagentOutput: true,
    });
    expect(readPreferences(storage, nav("en-US"))).toEqual({
      chatFontSize: 16,
      filesFontSize: 11,
      language: "zh-CN",
      autoExpandThinking: true,
      autoExpandTools: false,
      expandSubagentOutput: true,
    });
  });

  it("salvages fields individually on garbage", () => {
    const storage = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({
        chatFontSize: "big",
        filesFontSize: 14,
        language: "xx",
        autoExpandThinking: true,
        autoExpandTools: "yes",
        expandSubagentOutput: true,
      }),
    });
    const prefs = readPreferences(storage, nav("en"));
    expect(prefs).toEqual({
      chatFontSize: DEFAULT_CHAT_FONT_SIZE,
      filesFontSize: 14,
      language: "en",
      autoExpandThinking: true,
      autoExpandTools: false,
      expandSubagentOutput: true,
    });
  });

  it("falls back to defaults for out-of-range integers", () => {
    const storage = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({
        chatFontSize: CHAT_FONT_MIN - 1,
        filesFontSize: FILES_FONT_MAX + 1,
        language: "en",
      }),
    });
    const prefs = readPreferences(storage, nav("en"));
    expect(prefs.chatFontSize).toBe(DEFAULT_CHAT_FONT_SIZE);
    expect(prefs.filesFontSize).toBe(DEFAULT_FILES_FONT_SIZE);
  });

  it("falls back entirely on invalid JSON", () => {
    const storage = fakeStorage({ [STORAGE_KEY]: "{ not json" });
    expect(readPreferences(storage, nav("en"))).toEqual({
      chatFontSize: DEFAULT_CHAT_FONT_SIZE,
      filesFontSize: DEFAULT_FILES_FONT_SIZE,
      language: "en",
      autoExpandThinking: false,
      autoExpandTools: false,
      expandSubagentOutput: false,
    });
  });
});

describe("writePreferences", () => {
  it("stores the full blob under the single key", () => {
    const storage = fakeStorage();
    writePreferences(storage, {
      chatFontSize: 15,
      filesFontSize: 12,
      language: "en",
      autoExpandThinking: false,
      autoExpandTools: true,
      expandSubagentOutput: false,
    });
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      chatFontSize: 15,
      filesFontSize: 12,
      language: "en",
      autoExpandThinking: false,
      autoExpandTools: true,
      expandSubagentOutput: false,
    });
  });
});
