import { createContext } from "react";
import type { ReactNode } from "react";
import type { Language } from "../preferences";
import { usePreferences } from "../preferences/PreferencesProvider";
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
  const { preferences, updatePreferences } = usePreferences();
  const language = preferences.language;
  const setLanguage = (next: Language) => updatePreferences({ language: next });
  const value: I18nContextValue = { language, setLanguage, t: (key) => messages[language][key] };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
