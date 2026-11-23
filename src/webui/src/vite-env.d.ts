/// <reference types="vite/client" />

interface Window {
  easyresearchDesktop?: Readonly<{
    platform: "win32" | "darwin" | "linux";
    version: string;
    persistWebUiPreferences(raw: string | null): void;
    updateSnapshot?(): Promise<import("../../runtime/update-contract").UpdateSnapshot>;
    updateAction?(
      action: import("../../runtime/update-contract").UpdateAction,
    ): Promise<import("../../runtime/update-contract").UpdateActionResult>;
    onUpdate?(listener: (snapshot: import("../../runtime/update-contract").UpdateSnapshot) => void): () => void;
  }>;
}
