import { Activity, KeyRound, Languages, Minus, Plus, RefreshCw, UserPlus } from "lucide-react";
import { useId } from "react";
import type { AgentDto, SkillResourceDto } from "../../../../web/contracts";
import { agentDisplayName, type Translate } from "../../i18n/agents";
import { useI18n } from "../../i18n/useI18n";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, FILES_FONT_MAX, FILES_FONT_MIN } from "../../preferences";
import { usePreferences } from "../../preferences/PreferencesProvider";
import { ApiUsageDetailsSetting } from "../ApiUsageDetailsSetting";
import { CompactionThresholdSetting } from "../CompactionThresholdSetting";

const sectionClass = "rounded-[10px] border border-v2-grey-200 bg-v2-background-bg-base";
const buttonClass =
  "flex h-7 w-7 items-center justify-center rounded-md border border-v2-grey-200 text-v2-text-text-base transition-colors hover:bg-v2-grey-100 disabled:opacity-40";

function PanelHeading({ children }: { children: string }) {
  return (
    <h2
      tabIndex={-1}
      data-settings-panel-heading
      className="text-[15px] font-semibold text-v2-text-text-base outline-none"
    >
      {children}
    </h2>
  );
}

interface FontStepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  decreaseLabel: string;
  increaseLabel: string;
  preview: string;
  previewClassName: string;
  onDecrease(): void;
  onIncrease(): void;
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
}: FontStepperProps) {
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
  onChange(checked: boolean): void;
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
        className={`relative h-[20px] w-[36px] shrink-0 overflow-hidden rounded-full transition-colors ${
          checked ? "bg-v2-blue-600" : "bg-v2-grey-400"
        }`}
      >
        <span
          aria-hidden
          className={`absolute left-0 top-[2px] size-[16px] rounded-full bg-v2-background-bg-base transition-transform ${
            checked ? "translate-x-[18px]" : "translate-x-[2px]"
          }`}
        />
      </button>
    </div>
  );
}

export function GeneralSettingsPanel() {
  const { t, language, setLanguage } = useI18n();
  const { preferences, updatePreferences } = usePreferences();

  return (
    <div className="flex flex-col gap-4">
      <PanelHeading>{t("settings.category.general")}</PanelHeading>
      <section className={sectionClass} aria-label={t("settings.appearance.title")}>
        <header className="flex items-center gap-2 border-b border-v2-grey-200 px-4 py-2.5">
          <Activity size={14} className="text-v2-icon-icon-muted" aria-hidden />
          <h3 className="text-[13px] font-semibold text-v2-text-text-base">{t("settings.appearance.title")}</h3>
        </header>
        <div className="flex flex-col gap-3 px-4 py-4">
          <FontStepper
            label={t("settings.appearance.chatFontSize")}
            value={preferences.chatFontSize}
            min={CHAT_FONT_MIN}
            max={CHAT_FONT_MAX}
            decreaseLabel={t("settings.appearance.decreaseChat")}
            increaseLabel={t("settings.appearance.increaseChat")}
            preview={t("settings.appearance.previewChat")}
            previewClassName="v2-md text-[length:var(--v2-chat-font-size)] leading-relaxed text-v2-text-text-faint"
            onDecrease={() =>
              updatePreferences({ chatFontSize: Math.max(CHAT_FONT_MIN, preferences.chatFontSize - 1) })
            }
            onIncrease={() =>
              updatePreferences({ chatFontSize: Math.min(CHAT_FONT_MAX, preferences.chatFontSize + 1) })
            }
          />
          <FontStepper
            label={t("settings.appearance.filesFontSize")}
            value={preferences.filesFontSize}
            min={FILES_FONT_MIN}
            max={FILES_FONT_MAX}
            decreaseLabel={t("settings.appearance.decreaseFiles")}
            increaseLabel={t("settings.appearance.increaseFiles")}
            preview={t("settings.appearance.previewFiles")}
            previewClassName="font-mono text-[length:var(--v2-files-font-size)] leading-[1.5] text-v2-text-text-faint"
            onDecrease={() =>
              updatePreferences({ filesFontSize: Math.max(FILES_FONT_MIN, preferences.filesFontSize - 1) })
            }
            onIncrease={() =>
              updatePreferences({ filesFontSize: Math.min(FILES_FONT_MAX, preferences.filesFontSize + 1) })
            }
          />
        </div>
      </section>
      <section className={sectionClass} aria-label={t("settings.language.title")}>
        <header className="flex items-center gap-2 border-b border-v2-grey-200 px-4 py-2.5">
          <Languages size={14} className="text-v2-icon-icon-muted" aria-hidden />
          <h3 className="text-[13px] font-semibold text-v2-text-text-base">{t("settings.language.title")}</h3>
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
                  language === lang ? "bg-v2-blue-600 text-v2-grey-50" : "text-v2-text-text-base hover:bg-v2-grey-100"
                }`}
              >
                {lang === "en" ? "English" : "简体中文"}
              </button>
            ))}
          </div>
          <p className="text-[12px] text-v2-text-text-muted">{t("settings.language.hint")}</p>
        </div>
      </section>
    </div>
  );
}

export interface ConversationSettingsPanelProps {
  configurationGeneration: number;
}

export function ConversationSettingsPanel({ configurationGeneration }: ConversationSettingsPanelProps) {
  const { t } = useI18n();
  const { preferences, updatePreferences } = usePreferences();

  return (
    <div className="flex flex-col gap-4">
      <PanelHeading>{t("settings.category.conversation")}</PanelHeading>
      <section className={sectionClass} aria-label={t("settings.conversation.title")}>
        <div className="flex flex-col gap-3 px-4 py-4">
          <CompactionThresholdSetting configurationGeneration={configurationGeneration} />
          <ApiUsageDetailsSetting configurationGeneration={configurationGeneration} />
          <PreferenceSwitch
            label={t("settings.conversation.autoExpandThinking")}
            checked={preferences.autoExpandThinking}
            onChange={(checked) => updatePreferences({ autoExpandThinking: checked })}
          />
          <PreferenceSwitch
            label={t("settings.conversation.autoExpandTools")}
            checked={preferences.autoExpandTools}
            onChange={(checked) => updatePreferences({ autoExpandTools: checked })}
          />
          <PreferenceSwitch
            label={t("settings.conversation.expandSubagentOutput")}
            checked={preferences.expandSubagentOutput}
            onChange={(checked) => updatePreferences({ expandSubagentOutput: checked })}
          />
        </div>
      </section>
    </div>
  );
}

export interface ProviderSettingsPanelProps {
  connectedCount: number | null;
  onOpen(): void;
}

export function ProviderSettingsPanel({ connectedCount, onOpen }: ProviderSettingsPanelProps) {
  const { t } = useI18n();
  const labelId = useId();
  const countId = useId();
  return (
    <div className="flex flex-col gap-4">
      <PanelHeading>{t("settings.category.providers")}</PanelHeading>
      <section className={sectionClass} aria-label={t("settings.connectProviders")}>
        <button
          type="button"
          aria-labelledby={connectedCount === null ? labelId : `${labelId} ${countId}`}
          className="flex min-h-10 w-full items-center gap-2 rounded-[10px] px-4 py-2 text-[13px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-grey-100"
          onClick={onOpen}
        >
          <KeyRound size={14} className="text-v2-text-text-muted" aria-hidden />
          <span id={labelId} className="min-w-0">
            {t("settings.connectProviders")}
          </span>
          {connectedCount !== null && (
            <span id={countId} className="ml-auto shrink-0 text-[12px] text-v2-text-text-muted">
              {t("settings.connectedCount").replace("{n}", String(connectedCount))}
            </span>
          )}
        </button>
      </section>
    </div>
  );
}

function formatToolsSkills(t: Translate, agent: AgentDto): string {
  return t("settings.agents.toolsSkills")
    .replace("{tools}", String(agent.effectiveTools?.length ?? agent.tools?.length ?? 0))
    .replace("{skills}", String(agent.effectiveSkills?.length ?? agent.skills?.length ?? 0));
}

export interface AgentSettingsPanelProps {
  roster: readonly AgentDto[];
  busy: boolean;
  onRefresh(): void;
  onAdd(): void;
  onConfigure(agent: AgentDto): void;
  onShowDetails(agent: AgentDto): void;
}

export function AgentSettingsPanel({
  roster,
  busy,
  onRefresh,
  onAdd,
  onConfigure,
  onShowDetails,
}: AgentSettingsPanelProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex min-w-0 items-center gap-2">
        <PanelHeading>{t("settings.category.agents")}</PanelHeading>
        <button
          type="button"
          aria-label={t("dialog.refresh")}
          className="ml-auto flex h-7 items-center gap-1 rounded-md border border-v2-grey-200 px-2 text-[12px] hover:bg-v2-grey-100 disabled:opacity-40"
          disabled={busy}
          onClick={onRefresh}
        >
          <RefreshCw size={13} aria-hidden />
          {t("dialog.refresh")}
        </button>
        <button
          type="button"
          aria-label={t("settings.agents.add")}
          className="flex h-7 items-center gap-1 rounded-md border border-v2-grey-200 px-2 text-[12px] hover:bg-v2-grey-100"
          onClick={onAdd}
        >
          <UserPlus size={13} aria-hidden />
          {t("settings.agents.add")}
        </button>
      </div>
      <section className={`${sectionClass} flex flex-col gap-2 p-3`} aria-label={t("settings.agents.title")}>
        {roster.map((agent) => (
          <div
            key={agent.name}
            className={`flex min-w-0 items-center gap-2 rounded-md border border-v2-grey-200 px-3 py-2 transition-colors hover:bg-v2-grey-100 ${
              agent.enabled === false ? "opacity-60" : ""
            }`}
          >
            <button
              type="button"
              aria-label={t("settings.agents.configure").replace("{name}", agentDisplayName(t, agent.name))}
              onClick={() => onConfigure(agent)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span
                className={`size-2 shrink-0 rounded-full ${
                  agent.enabled === false ? "bg-v2-grey-400" : "bg-v2-status-success"
                }`}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-v2-text-text-base">
                  {agentDisplayName(t, agent.name)}
                </span>
                {agent.description && (
                  <span className="block truncate text-[12px] text-v2-text-text-muted">{agent.description}</span>
                )}
              </span>
            </button>
            <button
              type="button"
              className="shrink-0 rounded-md bg-v2-grey-100 px-2 py-1 text-left text-[11px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-200"
              aria-label={t("settings.agents.viewDetailsFor").replace("{name}", agentDisplayName(t, agent.name))}
              onClick={() => onShowDetails(agent)}
            >
              {formatToolsSkills(t, agent)}
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

export interface MissingSkillDiagnostic {
  skill: string;
  agentNames: readonly string[];
}

export interface ResourceSettingsPanelProps {
  tools: readonly string[];
  skills: readonly SkillResourceDto[];
  projects: readonly { cwd: string }[];
  diagnosticScope: string;
  diagnostics: readonly MissingSkillDiagnostic[];
  diagnosticError: string | null;
  onScopeChange(scope: string): void;
  onEditSkill(name: string): void;
}

export function ResourceSettingsPanel({
  tools,
  skills,
  projects,
  diagnosticScope,
  diagnostics,
  diagnosticError,
  onScopeChange,
  onEditSkill,
}: ResourceSettingsPanelProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <PanelHeading>{t("settings.category.resources")}</PanelHeading>
      <section className={`${sectionClass} p-4`} aria-label={t("settings.resources.tools")}>
        <h3 className="text-[12px] font-semibold text-v2-text-text-base">{t("settings.resources.tools")}</h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tools.length > 0 ? (
            tools.map((tool) => (
              <span
                key={tool}
                className="rounded-md border border-v2-grey-200 px-2 py-1 font-mono text-[11px] text-v2-text-text-base"
              >
                {tool}
              </span>
            ))
          ) : (
            <span className="text-[12px] text-v2-text-text-faint">{t("settings.resources.noTools")}</span>
          )}
        </div>
      </section>
      <section className={`${sectionClass} p-4`} aria-label={t("settings.resources.skills")}>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h3 className="text-[12px] font-semibold text-v2-text-text-base">{t("settings.resources.skills")}</h3>
          <select
            aria-label={t("settings.resources.diagnosticScope")}
            className="h-7 min-w-0 max-w-[240px] rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[12px] text-v2-text-text-base outline-none focus:border-v2-blue-600 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
            value={diagnosticScope}
            onChange={(event) => onScopeChange(event.target.value)}
          >
            <option value="global">{t("config.global")}</option>
            {projects.map((project) => (
              <option key={project.cwd} value={project.cwd}>
                {project.cwd}
              </option>
            ))}
          </select>
        </div>
        {diagnostics.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            {diagnostics.map(({ skill, agentNames }) => (
              <div
                key={skill}
                className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-v2-grey-200 px-3 py-2"
              >
                <span className="font-mono text-[12px] text-v2-text-text-base">{skill}</span>
                <span className="min-w-0 text-right text-[11px] text-v2-text-text-muted">
                  {t("settings.resources.missingFor").replace("{agents}", agentNames.join(", "))}
                </span>
              </div>
            ))}
          </div>
        )}
        {diagnosticError && (
          <p className="mt-2 text-[12px] text-v2-status-error" role="alert">
            {diagnosticError}
          </p>
        )}
        <div className="mt-2 flex flex-col gap-2">
          {skills.map((skill) => (
            <div key={skill.name} className="flex items-center gap-2 rounded-md border border-v2-grey-200 px-3 py-2">
              <span className="font-mono text-[12px]">{skill.name}</span>
              <span className="text-[11px] text-v2-text-text-faint">{skill.source}</span>
              <button
                type="button"
                className="ml-auto text-[12px] text-v2-blue-600 hover:underline"
                aria-label={t("settings.resources.editSkill").replace("{name}", skill.name)}
                onClick={() => onEditSkill(skill.name)}
              >
                {t("settings.resources.editSkill").replace("{name}", skill.name)}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
