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
  it("restores the saved theme without discarding independent preferences", () => {
    const storage = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({ uiVersion: "studio", studioTheme: "dark", chatFontSize: 18, language: "zh-CN" }),
    });
    const preferences = readPreferences(storage, nav("en"));
    expect(preferences).toMatchObject({
      studioTheme: "dark",
      chatFontSize: 18,
      language: "zh-CN",
    });
    writePreferences(storage, preferences);
    expect(readPreferences(storage, nav("en"))).toEqual(preferences);
  });

  it.each([undefined, null, "future", false])("recovers only an invalid or absent theme (%s)", (studioTheme) => {
    const storage = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({ uiVersion: "studio", studioTheme, filesFontSize: 17 }),
    });
    expect(readPreferences(storage, nav("en"))).toMatchObject({
      studioTheme: "light",
      filesFontSize: 17,
    });
  });

  it("returns defaults and browser language when nothing is stored", () => {
    const prefs = readPreferences(fakeStorage(), nav("zh-CN"));
    expect(prefs).toEqual({
      chatFontSize: DEFAULT_CHAT_FONT_SIZE,
      filesFontSize: DEFAULT_FILES_FONT_SIZE,
      language: "zh-CN",
      studioTheme: "light",
      autoExpandThinking: false,
      autoExpandTools: false,
      expandSubagentOutput: false,
    });
    expect(readPreferences(fakeStorage(), nav("en-US")).language).toBe("en");
  });

  it.each(["current", "classic", "studio", undefined, "future"])(
    "retires the old presentation %s while preserving the saved theme",
    (uiVersion) => {
      const storage = fakeStorage({
        [STORAGE_KEY]: JSON.stringify({ uiVersion, studioTheme: "dark", chatFontSize: 18, autoExpandTools: true }),
      });
      const preferences = readPreferences(storage, nav("en"));
      expect(preferences).not.toHaveProperty("uiVersion");
      expect(preferences).toMatchObject({ studioTheme: "dark", chatFontSize: 18, autoExpandTools: true });
      writePreferences(storage, preferences);
      expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).not.toHaveProperty("uiVersion");
      expect(readPreferences(storage, nav("en"))).toEqual(preferences);
    },
  );

  it("round-trips stored values", () => {
    const storage = fakeStorage();
    writePreferences(storage, {
      chatFontSize: 16,
      filesFontSize: 11,
      language: "zh-CN",
      studioTheme: "dark",
      autoExpandThinking: true,
      autoExpandTools: false,
      expandSubagentOutput: true,
    });
    expect(readPreferences(storage, nav("en-US"))).toEqual({
      chatFontSize: 16,
      filesFontSize: 11,
      language: "zh-CN",
      studioTheme: "dark",
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
      studioTheme: "light",
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
      studioTheme: "light",
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
      studioTheme: "light",
      autoExpandThinking: false,
      autoExpandTools: true,
      expandSubagentOutput: false,
    });
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      chatFontSize: 15,
      filesFontSize: 12,
      language: "en",
      studioTheme: "light",
      autoExpandThinking: false,
      autoExpandTools: true,
      expandSubagentOutput: false,
    });
  });
});
