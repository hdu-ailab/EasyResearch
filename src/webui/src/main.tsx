import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./i18n/I18nProvider";
import { readPreferences } from "./preferences";
import { PreferencesProvider } from "./preferences/PreferencesProvider";
import { applyFontPreferences } from "./webui-fonts";
import "./index.css";

const preferences = readPreferences(window.localStorage, () => navigator.language);
applyFontPreferences(preferences);
document.documentElement.lang = preferences.language;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PreferencesProvider>
      <I18nProvider>
        <App />
      </I18nProvider>
    </PreferencesProvider>
  </StrictMode>,
);
