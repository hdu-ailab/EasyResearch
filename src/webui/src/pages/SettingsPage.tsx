import { Activity, FileJson, Languages, MessageSquare, Minus, Plus, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentDto } from "../../../web/contracts";
import { getWebuiSettings, listAgents, listModels, updateWebuiSettings } from "../api";
import { ProductMark, Topbar } from "../components/Topbar";
import { agentDisplayName } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, FILES_FONT_MAX, FILES_FONT_MIN } from "../preferences";
import { usePreferences } from "../preferences/PreferencesProvider";

export interface SettingsPageProps {
  onBack: () => void;
  onOpenConfigPage: () => void;
}

const sectionClass =
  "rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] focus-within:border-v2-grey-200";

const buttonClass =
  "flex h-7 w-7 items-center justify-center rounded-md border border-v2-grey-200 text-v2-text-text-base transition-colors hover:bg-v2-grey-100 disabled:opacity-40";

interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  decreaseLabel: string;
  increaseLabel: string;
  preview: string;
  previewClassName: string;
  onDecrease: () => void;
  onIncrease: () => void;
}

function FontStepper({
  label,
  value,
  min,
  max,
  decreaseLabel,
  increaseLabel,
  preview,
  previewClassName,
  onDecrease,
  onIncrease,
}: StepperProps) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <span className="shrink-0 text-[13px] text-v2-text-text-base">{label}</span>
      <div className="flex min-w-0 items-center justify-end gap-3">
        <span className={`min-w-0 truncate ${previewClassName}`}>{preview}</span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label={decreaseLabel}
            disabled={value <= min}
            onClick={onDecrease}
            className={buttonClass}
          >
            <Minus size={13} aria-hidden />
          </button>
          <span className="w-10 text-center text-[13px] tabular-nums text-v2-text-text-base" aria-live="polite">
            {value}px
          </span>
          <button
            type="button"
            aria-label={increaseLabel}
            disabled={value >= max}
            onClick={onIncrease}
            className={buttonClass}
          >
            <Plus size={13} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

function PreferenceSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-v2-text-text-base">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-[20px] w-[36px] shrink-0 overflow-hidden rounded-full transition-colors ${checked ? "bg-v2-blue-600" : "bg-v2-grey-400"}`}
      >
        <span
          aria-hidden
          className={`absolute left-0 top-[2px] size-[16px] rounded-full bg-white transition-transform ${checked ? "translate-x-[18px]" : "translate-x-[2px]"}`}
        />
      </button>
    </div>
  );
}

type ModelOption = { provider: string; id: string };

function withConfiguredModel(models: ModelOption[], configured?: string): ModelOption[] {
  if (!configured || models.some((model) => `${model.provider}/${model.id}` === configured)) return models;
  const slash = configured.indexOf("/");
  return slash > 0 ? [...models, { provider: configured.slice(0, slash), id: configured.slice(slash + 1) }] : models;
}

export function SettingsPage({ onBack, onOpenConfigPage }: SettingsPageProps) {
  const { t, language, setLanguage } = useI18n();
  const { preferences: prefs, updatePreferences } = usePreferences();
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [models, setModels] = useState<Array<{ provider: string; id: string }>>([]);
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [orchestratorModel, setOrchestratorModelState] = useState<string | null>(null);
  const [effectiveOrchestratorModel, setEffectiveOrchestratorModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([getWebuiSettings(), listAgents(), listModels()])
      .then(([s, a, m]) => {
        setAgentModels(s.agentModels);
        setOrchestratorModelState(s.orchestratorModel);
        setEffectiveOrchestratorModel(s.effectiveOrchestratorModel);
        setAgents(a);
        setModels(m);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const setAgentModel = (name: string, value: string) => {
    const next = { ...agentModels };
    if (value === "") delete next[name];
    else next[name] = value;
    setBusy(true);
    setError(null);
    updateWebuiSettings({ agentModels: next })
      .then((s) => setAgentModels(s.agentModels))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const setOrchestratorModel = (value: string) => {
    setBusy(true);
    setError(null);
    updateWebuiSettings({ orchestratorModel: value === "" ? null : value })
      .then((s) => {
        setOrchestratorModelState(s.orchestratorModel);
        setEffectiveOrchestratorModel(s.effectiveOrchestratorModel);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const orchestratorValue = orchestratorModel ?? effectiveOrchestratorModel ?? "";
  const orchestratorOptions =
    effectiveOrchestratorModel !== null && !models.some((m) => `${m.provider}/${m.id}` === effectiveOrchestratorModel)
      ? [
          ...models,
          {
            provider: effectiveOrchestratorModel.slice(0, effectiveOrchestratorModel.indexOf("/")),
            id: effectiveOrchestratorModel.slice(effectiveOrchestratorModel.indexOf("/") + 1),
          },
        ]
      : models;

  /** Pin the orchestrator to the first row, keeping the rest in API order. */
  const roster = [...agents].sort((a, b) => (a.name === "orchestrator" ? -1 : b.name === "orchestrator" ? 1 : 0));

  return (
    <div className="flex h-full flex-col">
      <Topbar
        home={{ active: false, onClick: onBack }}
        leading={<ProductMark />}
        center={<span className="truncate text-[13px] text-v2-text-text-muted">{t("settings.title")}</span>}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-[4px]">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
          <section className={sectionClass} aria-label={t("settings.appearance.title")}>
            <header className="flex items-center gap-2 border-b border-v2-grey-200 px-4 py-2.5">
              <Activity size={14} className="text-v2-icon-icon-muted" aria-hidden />
              <h2 className="text-[13px] font-semibold text-v2-text-text-base">{t("settings.appearance.title")}</h2>
            </header>
            <div className="flex flex-col gap-3 px-4 py-4">
              <FontStepper
                label={t("settings.appearance.chatFontSize")}
                value={prefs.chatFontSize}
                min={CHAT_FONT_MIN}
                max={CHAT_FONT_MAX}
                decreaseLabel={t("settings.appearance.decreaseChat")}
                increaseLabel={t("settings.appearance.increaseChat")}
                preview={t("settings.appearance.previewChat")}
                previewClassName="v2-md text-[length:var(--v2-chat-font-size)] leading-relaxed text-v2-text-text-faint"
                onDecrease={() => updatePreferences({ chatFontSize: Math.max(CHAT_FONT_MIN, prefs.chatFontSize - 1) })}
                onIncrease={() => updatePreferences({ chatFontSize: Math.min(CHAT_FONT_MAX, prefs.chatFontSize + 1) })}
              />
              <FontStepper
                label={t("settings.appearance.filesFontSize")}
                value={prefs.filesFontSize}
                min={FILES_FONT_MIN}
                max={FILES_FONT_MAX}
                decreaseLabel={t("settings.appearance.decreaseFiles")}
                increaseLabel={t("settings.appearance.increaseFiles")}
                preview={t("settings.appearance.previewFiles")}
                previewClassName="font-mono text-[length:var(--v2-files-font-size)] leading-[1.5] text-v2-text-text-faint"
                onDecrease={() =>
                  updatePreferences({ filesFontSize: Math.max(FILES_FONT_MIN, prefs.filesFontSize - 1) })
                }
                onIncrease={() =>
                  updatePreferences({ filesFontSize: Math.min(FILES_FONT_MAX, prefs.filesFontSize + 1) })
                }
              />
            </div>
          </section>

          <section className={sectionClass} aria-label={t("settings.conversation.title")}>
            <header className="flex items-center gap-2 border-b border-v2-grey-200 px-4 py-2.5">
              <MessageSquare size={14} className="text-v2-icon-icon-muted" aria-hidden />
              <h2 className="text-[13px] font-semibold text-v2-text-text-base">{t("settings.conversation.title")}</h2>
            </header>
            <div className="flex flex-col gap-3 px-4 py-4">
              <PreferenceSwitch
                label={t("settings.conversation.autoExpandThinking")}
                checked={prefs.autoExpandThinking}
                onChange={(checked) => updatePreferences({ autoExpandThinking: checked })}
              />
              <PreferenceSwitch
                label={t("settings.conversation.autoExpandTools")}
                checked={prefs.autoExpandTools}
                onChange={(checked) => updatePreferences({ autoExpandTools: checked })}
              />
              <PreferenceSwitch
                label={t("settings.conversation.expandSubagentOutput")}
                checked={prefs.expandSubagentOutput}
                onChange={(checked) => updatePreferences({ expandSubagentOutput: checked })}
              />
            </div>
          </section>

          <section className={sectionClass} aria-label={t("settings.language.title")}>
            <header className="flex items-center gap-2 border-b border-v2-grey-200 px-4 py-2.5">
              <Languages size={14} className="text-v2-icon-icon-muted" aria-hidden />
              <h2 className="text-[13px] font-semibold text-v2-text-text-base">{t("settings.language.title")}</h2>
            </header>
            <div className="flex flex-col gap-3 px-4 py-4">
              {/* biome-ignore lint/a11y/useSemanticElements: this compact segmented control intentionally has no fieldset chrome. */}
              <div
                className="flex w-fit gap-1 rounded-md border border-v2-grey-200 bg-v2-background-bg-deep p-1"
                role="group"
                aria-label={t("settings.language.selector")}
              >
                {(["en", "zh-CN"] as const).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    aria-pressed={language === lang}
                    onClick={() => setLanguage(lang)}
                    className={`h-7 rounded px-3 text-[13px] transition-colors ${
                      language === lang ? "bg-v2-blue-600 text-white" : "text-v2-text-text-base hover:bg-v2-grey-100"
                    }`}
                  >
                    {lang === "en" ? "English" : "简体中文"}
                  </button>
                ))}
              </div>
              <p className="text-[12px] text-v2-text-text-muted">{t("settings.language.hint")}</p>
            </div>
          </section>

          <section className={sectionClass} aria-label={t("settings.agents.title")}>
            <header className="flex items-center gap-2 border-b border-v2-grey-200 px-4 py-2.5">
              <Settings2 size={14} className="text-v2-icon-icon-muted" aria-hidden />
              <h2 className="text-[13px] font-semibold text-v2-text-text-base">{t("settings.agents.title")}</h2>
              <span className="ml-auto text-[12px] text-v2-text-text-faint">{t("settings.agents.globalHint")}</span>
            </header>
            <div className="flex flex-col gap-3 px-4 py-4">
              {roster.map((agent) =>
                agent.name === "orchestrator" ? (
                  <div key={agent.name}>
                    <label className="flex items-center justify-between gap-4">
                      <span className="text-[13px] font-medium text-v2-text-text-base">
                        {agentDisplayName(t, "orchestrator")}
                      </span>
                      <select
                        className="h-8 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600 disabled:opacity-50"
                        aria-label={`${t("settings.agents.selectModelFor")} ${agentDisplayName(t, agent.name)}`}
                        value={orchestratorValue}
                        onChange={(e) => setOrchestratorModel(e.target.value)}
                        disabled={busy}
                      >
                        {orchestratorOptions.map((m) => (
                          <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                            {m.provider}/{m.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : (
                  <label key={agent.name} className="flex items-center justify-between gap-4">
                    <span className="text-[13px] font-medium text-v2-text-text-base">
                      {agentDisplayName(t, agent.name)}
                    </span>
                    <select
                      className="h-8 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600 disabled:opacity-50"
                      aria-label={`${t("settings.agents.selectModelFor")} ${agentDisplayName(t, agent.name)}`}
                      value={agentModels[agent.name] ?? ""}
                      onChange={(e) => setAgentModel(agent.name, e.target.value)}
                      disabled={busy}
                    >
                      <option value="">{t("settings.agents.inherit")}</option>
                      {withConfiguredModel(models, agentModels[agent.name]).map((m) => (
                        <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                          {m.provider}/{m.id}
                        </option>
                      ))}
                    </select>
                  </label>
                ),
              )}
            </div>
          </section>

          <section className={sectionClass} aria-label={t("settings.config.entry")}>
            <button
              type="button"
              className="flex h-9 w-full items-center gap-2 rounded-[10px] px-4 py-2 text-[13px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-grey-100"
              onClick={onOpenConfigPage}
            >
              <FileJson size={14} className="text-v2-text-text-muted" aria-hidden />
              {t("settings.config.entry")}
            </button>
          </section>

          {error && (
            <p
              className="rounded-md border border-v2-status-error/30 bg-v2-status-error/5 px-3 py-2 text-[13px] text-v2-status-error"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
