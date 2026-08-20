export interface RuntimeSettingsManager {
  getShellPath(): string | undefined;
  applyOverrides(overrides: { shellPath: string }): void;
}

const WINDOWS_GIT_BASH_PATH = "C:/Program Files/Git/bin/bash.exe";

export function applyRuntimeSettingsDefaults<T extends RuntimeSettingsManager>(settingsManager: T): T {
  if (process.platform === "win32" && !settingsManager.getShellPath()) {
    settingsManager.applyOverrides({ shellPath: WINDOWS_GIT_BASH_PATH });
  }
  return settingsManager;
}
