/// <reference types="vite/client" />

interface Window {
  easyresearchDesktop?: Readonly<{
    platform: "win32" | "darwin";
    version: string;
    checkForUpdate?(): Promise<string | null>;
    startUpdate?(expectedVersion: string): Promise<void>;
    onUpdateProgress?(
      listener: (progress: { phase: "downloading" | "restarting"; percent?: number }) => void,
    ): () => void;
    persistWebUiPreferences(raw: string | null): void;
  }>;
}
