import { createContext, useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Language } from "../preferences";
import { readPreferences, writePreferences } from "../preferences";
import { messages } from "./messages";
import type { MessageKey } from "./messages";

export interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: MessageKey) => string;
}

const fallback: I18nContextValue = {
  language: "en",
  setLanguage: () => {},
  t: (key) => messages.en[key],
};

export const I18nContext = createContext<I18nContextValue>(fallback);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(
    () => readPreferences(window.localStorage, () => navigator.language).language,
  );
  const setLanguage = useCallback((next: Language) => {
    const storage = window.localStorage;
    writePreferences(storage, { ...readPreferences(storage, () => navigator.language), language: next });
    setLanguageState(next);
    document.documentElement.lang = next;
  }, []);
  const value = useMemo<I18nContextValue>(
    () => ({ language, setLanguage, t: (key) => messages[language][key] }),
    [language, setLanguage],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
