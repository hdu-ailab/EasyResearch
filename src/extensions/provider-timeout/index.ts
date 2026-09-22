import type { ExtensionFactory, SettingsManager } from "@earendil-works/pi-coding-agent";

/** A host default, never a settings-file mutation or a whole-response timer. */
export function createProviderTimeoutExtension(settings: SettingsManager): ExtensionFactory {
  return (pi) => {
    const applyDefault = () => {
      if (settings.getProviderRetrySettings().timeoutMs !== undefined) return;
      // Preserve Pi's explicit HTTP-idle fallback, including its zero sentinel.
      if (settings.getGlobalSettings().httpIdleTimeoutMs !== undefined
        || settings.getProjectSettings().httpIdleTimeoutMs !== undefined) return;
      settings.applyOverrides({ retry: { provider: { timeoutMs: 3_600_000 } } });
    };
    pi.on("session_start", applyDefault);
    // reload/save can discard transient overrides; apply before SDK streamFn
    // reads settings, including completion-woken and native retry requests.
    pi.on("context", applyDefault);
  };
}
