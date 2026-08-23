import type { ReactNode } from "react";
import { createContext, use, useEffect, useEffectEvent, useRef, useState } from "react";
import type { WebUiPreferences } from "../preferences";
import { readPreferences, STORAGE_KEY, writePreferences } from "../preferences";
import { applyFontPreferences } from "../webui-fonts";

export interface PreferencesContextValue {
  preferences: WebUiPreferences;
  updatePreferences: (patch: Partial<WebUiPreferences>) => void;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(() => readPreferences(window.localStorage, () => navigator.language));
  const shouldPersist = useRef(false);

  const apply = useEffectEvent((next: WebUiPreferences) => {
    applyFontPreferences(next);
    document.documentElement.lang = next.language;
  });

  useEffect(() => {
    apply(preferences);
    if (!shouldPersist.current) return;
    shouldPersist.current = false;
    try {
      writePreferences(window.localStorage, preferences);
      window.easyresearchDesktop?.persistWebUiPreferences(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      // Keep the user's preference in memory if browser storage is unavailable.
    }
  }, [preferences]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      shouldPersist.current = false;
      setPreferences(readPreferences(window.localStorage, () => navigator.language));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const updatePreferences = (patch: Partial<WebUiPreferences>) => {
    shouldPersist.current = true;
    setPreferences((current) => ({ ...current, ...patch }));
  };

  return <PreferencesContext value={{ preferences, updatePreferences }}>{children}</PreferencesContext>;
}

export function usePreferences(): PreferencesContextValue {
  const context = use(PreferencesContext);
  if (!context) throw new Error("usePreferences must be used within PreferencesProvider");
  return context;
}
