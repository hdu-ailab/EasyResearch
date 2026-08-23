/// <reference types="vite/client" />

interface Window {
  easyresearchDesktop?: Readonly<{
    platform: "win32" | "darwin";
    version: string;
    persistWebUiPreferences(raw: string | null): void;
  }>;
}
