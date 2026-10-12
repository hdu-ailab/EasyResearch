import type { ExtensionFactory, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ProviderTimeoutSettingsDto } from "../../web/contracts";
import { DEFAULT_PROVIDER_TIMEOUT_MS, MAX_PROVIDER_TIMEOUT_MS, parseProviderTimeoutSettings } from "../../runtime/provider-timeout-settings";

/** A host default, never a settings-file mutation or a whole-response timer. */
export function createProviderTimeoutExtension(
  settings: SettingsManager,
  acceptedPolicy?: () => ProviderTimeoutSettingsDto | undefined,
): ExtensionFactory {
  return (pi) => {
    const applyDefault = () => {
      const global = acceptedPolicy?.();
      if (global) {
        const project = parseProviderTimeoutSettings(settings.getProjectSettings());
        const selected = project.source === "provider" ? project
          : global.source === "provider" ? global
            : project.source === "httpIdle" ? project : global;
        // SDKs such as OpenAI interpret a literal zero timer as immediate abort.
        const timeoutMs = selected.timeoutMs === 0
          ? MAX_PROVIDER_TIMEOUT_MS : selected.timeoutMs;
        settings.applyOverrides({ retry: { provider: { timeoutMs } } });
        return;
      }
      const configured = settings.getProviderRetrySettings().timeoutMs;
      if (configured !== undefined) {
        if (configured === 0) settings.applyOverrides({ retry: { provider: { timeoutMs: MAX_PROVIDER_TIMEOUT_MS } } });
        return;
      }
      // Preserve Pi's explicit HTTP-idle fallback, including its zero sentinel.
      if (settings.getGlobalSettings().httpIdleTimeoutMs !== undefined
        || settings.getProjectSettings().httpIdleTimeoutMs !== undefined) return;
      settings.applyOverrides({ retry: { provider: { timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS } } });
    };
    pi.on("session_start", applyDefault);
    // reload/save can discard transient overrides; apply before SDK streamFn
    // reads settings, including completion-woken and native retry requests.
    pi.on("context", applyDefault);
  };
}
