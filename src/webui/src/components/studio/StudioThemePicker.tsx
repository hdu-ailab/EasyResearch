import { useI18n } from "../../i18n/useI18n";
import { usePreferences } from "../../preferences/PreferencesProvider";

export function StudioThemePicker() {
  const { t } = useI18n();
  const { preferences, updatePreferences } = usePreferences();
  return (
    <section className="er-theme-settings" aria-label={t("studio.theme")}>
      <h3>{t("studio.theme")}</h3>
      <div className="er-theme-options">
        {(["light", "dark"] as const).map((theme) => (
          <button
            key={theme}
            type="button"
            className="er-theme-option"
            aria-label={t(`studio.${theme}`)}
            aria-pressed={(preferences.studioTheme ?? "light") === theme}
            onClick={() => updatePreferences({ studioTheme: theme })}
          >
            <span className="er-theme-preview" data-theme={theme} aria-hidden>
              <span className="er-theme-preview-top" />
              <span className="er-theme-preview-rail">
                <i />
                <i />
                <i />
              </span>
              <span className="er-theme-preview-main">
                <i />
                <i />
                <i />
                <span />
              </span>
            </span>
            <span className="er-theme-caption">
              <span>{t(`studio.${theme}`)}</span>
              <small aria-hidden>{t("studio.selected")}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
