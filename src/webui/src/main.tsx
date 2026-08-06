import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { readPreferences } from "./preferences";
import { applyFontPreferences } from "./webui-fonts";
import "./index.css";

applyFontPreferences(readPreferences(window.localStorage, () => navigator.language));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
