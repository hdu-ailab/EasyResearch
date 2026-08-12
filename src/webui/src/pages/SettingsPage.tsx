import { Activity, FileJson, Languages, MessageSquare, Minus, Plus, Settings2, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentDto, AgentResourceDto, SkillResourceDto } from "../../../web/contracts";
import {
  createAgentResource,
  getWebuiSettings,
  listAgentResources,
  listAgents,
  listConfigProjects,
  listModels,
  listSkillResources,
  readAgentResource,
  readSkillResource,
  updateWebuiSettings,
  writeAgentResource,
  writeSkillResource,
} from "../api";
import { AgentMarkdownEditor } from "../components/AgentMarkdownEditor";
import { AgentResourceDetailsDialog } from "../components/AgentResourceDetailsDialog";
import { SkillResourceEditor } from "../components/SkillResourceEditor";
import { ProductMark, Topbar } from "../components/Topbar";
import type { Translate } from "../i18n/agents";
import { agentDisplayName } from "../i18n/agents";
import { useI18n } from "../i18n/useI18n";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, FILES_FONT_MAX, FILES_FONT_MIN } from "../preferences";
import { usePreferences } from "../preferences/PreferencesProvider";
import { PAPER_ASSISTANT_AGENT } from "../agent-identity";

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
  showLabel = true,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  showLabel?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      {showLabel && <span className="text-[13px] text-v2-text-text-base">{label}</span>}
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

function formatToolsSkills(t: Translate, agent: AgentDto): string {
  return t("settings.agents.toolsSkills")
    .replace("{tools}", String(agent.effectiveTools?.length ?? agent.tools?.length ?? 0))
    .replace("{skills}", String(agent.effectiveSkills?.length ?? agent.skills?.length ?? 0));
}

function setEnableFrontmatter(content: string, enabled: boolean): string {
  const value = `enable: ${enabled ? "true" : "false"}`;
  if (!content.startsWith("---\n")) return `---\n${value}\n---\n${content}`;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return content;
  const header = content.slice(4, end);
  const next = /^enable:\s*.*$/m.test(header) ? header.replace(/^enable:\s*.*$/m, value) : `${header}\n${value}`;
  return `---\n${next}\n---${content.slice(end + 4)}`;
}

export function SettingsPage({ onBack, onOpenConfigPage }: SettingsPageProps) {
  const { t, language, setLanguage } = useI18n();
  const { preferences: prefs, updatePreferences } = usePreferences();
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [models, setModels] = useState<Array<{ provider: string; id: string }>>([]);
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [paperAssistantModel, setPaperAssistantModelState] = useState<string | null>(null);
  const [effectivePaperAssistantModel, setEffectivePaperAssistantModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resourceAgents, setResourceAgents] = useState<AgentResourceDto[]>([]);
  const [skills, setSkills] = useState<SkillResourceDto[]>([]);
  const [diagnosticScope, setDiagnosticScope] = useState("global");
  const [diagnosticAgents, setDiagnosticAgents] = useState<AgentDto[]>([]);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Array<{ cwd: string }>>([]);
  const diagnosticRequest = useRef(0);
  const [agentEditor, setAgentEditor] = useState<AgentResourceDto | null>(null);
  const [skillEditor, setSkillEditor] = useState<SkillResourceDto | null>(null);
  const [detailsAgent, setDetailsAgent] = useState<AgentDto | null>(null);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");

  useEffect(() => {
    Promise.all([getWebuiSettings(), listAgentResources(), listAgents(), listModels(), listSkillResources()])
      .then(([s, globalAgents, fallbackAgents, m, skillRows]) => {
        setAgentModels(s.agentModels);
        setPaperAssistantModelState(s.paperAssistantModel);
        setEffectivePaperAssistantModel(s.effectivePaperAssistantModel);
        setResourceAgents(globalAgents);
        setAgents(globalAgents.length > 0 ? globalAgents : fallbackAgents);
        if (diagnosticRequest.current === 0) setDiagnosticAgents(fallbackAgents);
        setModels(m);
        setSkills(skillRows);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    listConfigProjects()
      .then((configProjects) => setProjects(configProjects.projects))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const refreshAgents = async () => {
    const next = await listAgentResources();
    setResourceAgents(next);
    setAgents(next);
  };

  const refreshDiagnostics = async (scope = diagnosticScope) => {
    const request = ++diagnosticRequest.current;
    setDiagnosticAgents([]);
    setDiagnosticError(null);
    try {
      const next = await listAgents(scope === "global" ? undefined : scope);
      if (request === diagnosticRequest.current) setDiagnosticAgents(next);
    } catch (e) {
      if (request === diagnosticRequest.current) {
        setDiagnosticError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const openAgentEditor = async (name: string) => {
    setError(null);
    try {
      setAgentEditor(await readAgentResource(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveAgent = async (content: string) => {
    if (!agentEditor) return;
    setBusy(true);
    try {
      await writeAgentResource(agentEditor.name, content);
      await Promise.all([refreshAgents(), refreshDiagnostics()]);
      setAgentEditor(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async (agent: AgentDto) => {
    try {
      const resource = await readAgentResource(agent.name);
      const content = setEnableFrontmatter(resource.content ?? "", !agent.enabled);
      const savedAgent = await writeAgentResource(agent.name, content);
      setResourceAgents((current) => current.map((item) => (item.name === savedAgent.name ? savedAgent : item)));
      setAgents((current) => current.map((item) => (item.name === savedAgent.name ? savedAgent : item)));
      await refreshDiagnostics();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addAgent = async () => {
    const name = newAgentName.trim().replace(/\.md$/i, "");
    if (!name || /[\\/\0]/.test(name) || name === "." || name === "..") return;
    setBusy(true);
    try {
      const created = await createAgentResource(name);
      setAddAgentOpen(false);
      setNewAgentName("");
      setAgentEditor(created);
      setResourceAgents((current) => [...current.filter((item) => item.name !== created.name), created]);
      setAgents((current) => [...current.filter((item) => item.name !== created.name), created]);
      await Promise.all([refreshAgents(), refreshDiagnostics()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openSkillEditor = async (name: string) => {
    try {
      setSkillEditor(await readSkillResource(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveSkill = async (content: string) => {
    if (!skillEditor) return;
    setBusy(true);
    try {
      await writeSkillResource(skillEditor.name, content);
      await Promise.all([listSkillResources().then(setSkills), refreshDiagnostics()]);
      setSkillEditor(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectDiagnosticScope = async (scope: string) => {
    setDiagnosticScope(scope);
    await refreshDiagnostics(scope);
  };

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

  const setPaperAssistantModel = (value: string) => {
    setBusy(true);
    setError(null);
    updateWebuiSettings({ paperAssistantModel: value === "" ? null : value })
      .then((s) => {
        setPaperAssistantModelState(s.paperAssistantModel);
        setEffectivePaperAssistantModel(s.effectivePaperAssistantModel);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const paperAssistantValue = paperAssistantModel ?? effectivePaperAssistantModel ?? "";
  const paperAssistantOptions =
    effectivePaperAssistantModel !== null && !models.some((m) => `${m.provider}/${m.id}` === effectivePaperAssistantModel)
      ? [
          ...models,
          {
            provider: effectivePaperAssistantModel.slice(0, effectivePaperAssistantModel.indexOf("/")),
            id: effectivePaperAssistantModel.slice(effectivePaperAssistantModel.indexOf("/") + 1),
          },
        ]
      : models;

  /** Pin the assistant to the first row, keeping the rest in API order. */
  const roster = [...(resourceAgents.length > 0 ? resourceAgents : agents)].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    if (a.name === PAPER_ASSISTANT_AGENT) return -1;
    if (b.name === PAPER_ASSISTANT_AGENT) return 1;
    return a.name.localeCompare(b.name);
  });
  const toolInventory = [...new Set(roster.flatMap((agent) => agent.effectiveTools ?? agent.tools ?? []))].sort(
    (a, b) => a.localeCompare(b),
  );
  const missingSkills = new Map<string, string[]>();
  for (const agent of diagnosticAgents) {
    for (const skill of agent.missingSkills ?? []) {
      const names = missingSkills.get(skill) ?? [];
      names.push(agentDisplayName(t, agent.name));
      missingSkills.set(skill, names);
    }
  }

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
              <button
                type="button"
                aria-label={t("settings.agents.add")}
                className="ml-auto flex h-7 items-center gap-1 rounded-md border border-v2-grey-200 px-2 text-[12px] hover:bg-v2-grey-100"
                onClick={() => setAddAgentOpen(true)}
              >
                <UserPlus size={13} aria-hidden />
                {t("settings.agents.add")}
              </button>
            </header>
            <div className="flex flex-col gap-3 px-4 py-4">
              {roster.map((agent) =>
                agent.name === PAPER_ASSISTANT_AGENT ? (
                  <div key={agent.name} className="rounded-md border border-v2-grey-200 p-3">
                    <div className="flex items-center gap-2">
                      <span className="size-2 rounded-full bg-v2-grey-400" aria-hidden />
                      <span className="text-[13px] font-medium text-v2-text-text-base">
                        {agentDisplayName(t, agent.name)}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] text-v2-text-text-muted">{agent.description}</p>
                    <button
                      type="button"
                      className="mt-1 rounded-md bg-v2-grey-100 px-2 py-1 text-left text-[11px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-200"
                      onClick={() => setDetailsAgent(agent)}
                    >
                      {formatToolsSkills(t, agent)}
                    </button>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <button
                        type="button"
                        className="text-[12px] text-v2-blue-600 hover:underline"
                        aria-label={t("settings.agents.edit").replace("{name}", agentDisplayName(t, agent.name))}
                        onClick={() => void openAgentEditor(agent.name)}
                      >
                        {t("settings.agents.edit").replace("{name}", agentDisplayName(t, agent.name))}
                      </button>
                      <label className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 text-[12px] text-v2-text-text-muted">
                          {t("settings.agents.model")}
                        </span>
                        <select
                          className="h-8 min-w-0 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600 disabled:opacity-50"
                          aria-label={`${t("settings.agents.selectModelFor")} ${agentDisplayName(t, agent.name)}`}
                          value={paperAssistantValue}
                          onChange={(e) => setPaperAssistantModel(e.target.value)}
                          disabled={busy}
                        >
                          {paperAssistantOptions.map((m) => (
                            <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                              {m.provider}/{m.id}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {agentEditor?.name === agent.name && (
                      <AgentMarkdownEditor
                        resource={agentEditor}
                        busy={busy}
                        onSave={(content) => void saveAgent(content)}
                        onClose={() => setAgentEditor(null)}
                      />
                    )}
                  </div>
                ) : (
                  <div
                    key={agent.name}
                    className={`rounded-md border border-v2-grey-200 p-3 ${agent.enabled === false ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="size-2 rounded-full bg-v2-grey-400" aria-hidden />
                      <span className="text-[13px] font-medium text-v2-text-text-base">
                        {agentDisplayName(t, agent.name)}
                      </span>
                      <div className="ml-auto flex items-center">
                        <PreferenceSwitch
                          label={agentDisplayName(t, agent.name)}
                          checked={agent.enabled !== false}
                          onChange={() => void toggleAgent(agent)}
                          showLabel={false}
                        />
                      </div>
                    </div>
                    <p className="mt-1 text-[12px] text-v2-text-text-muted">{agent.description}</p>
                    <button
                      type="button"
                      className="mt-1 rounded-md bg-v2-grey-100 px-2 py-1 text-left text-[11px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-200"
                      onClick={() => setDetailsAgent(agent)}
                    >
                      {formatToolsSkills(t, agent)}
                    </button>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <button
                        type="button"
                        className="text-[12px] text-v2-blue-600 hover:underline"
                        aria-label={t("settings.agents.edit").replace("{name}", agentDisplayName(t, agent.name))}
                        onClick={() => void openAgentEditor(agent.name)}
                      >
                        {t("settings.agents.edit").replace("{name}", agentDisplayName(t, agent.name))}
                      </button>
                      <label className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 text-[12px] text-v2-text-text-muted">
                          {t("settings.agents.model")}
                        </span>
                        <select
                          className="h-8 min-w-0 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[13px] text-v2-text-text-base outline-none focus:border-v2-blue-600 disabled:opacity-50"
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
                    </div>
                    {agentEditor?.name === agent.name && (
                      <AgentMarkdownEditor
                        resource={agentEditor}
                        busy={busy}
                        onSave={(content) => void saveAgent(content)}
                        onClose={() => setAgentEditor(null)}
                      />
                    )}
                  </div>
                ),
              )}
              <div className="border-t border-v2-grey-200 pt-4">
                <h3 className="text-[12px] font-semibold text-v2-text-text-base">{t("settings.resources.tools")}</h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {toolInventory.length > 0 ? (
                    toolInventory.map((tool) => (
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
              </div>
              <div className="border-t border-v2-grey-200 pt-4">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <h3 className="text-[12px] font-semibold text-v2-text-text-base">{t("settings.resources.skills")}</h3>
                  <select
                    aria-label={t("settings.resources.diagnosticScope")}
                    className="h-7 min-w-0 max-w-[240px] rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-2 text-[12px] text-v2-text-text-base outline-none focus:border-v2-blue-600 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
                    value={diagnosticScope}
                    onChange={(event) => void selectDiagnosticScope(event.target.value)}
                  >
                    <option value="global">{t("config.global")}</option>
                    {projects.map((project) => (
                      <option key={project.cwd} value={project.cwd}>
                        {project.cwd}
                      </option>
                    ))}
                  </select>
                </div>
                {missingSkills.size > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {[...missingSkills].map(([skill, agentNames]) => (
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
                    <div
                      key={skill.name}
                      className="flex items-center gap-2 rounded-md border border-v2-grey-200 px-3 py-2"
                    >
                      <span className="font-mono text-[12px]">{skill.name}</span>
                      <span className="text-[11px] text-v2-text-text-faint">{skill.source}</span>
                      <button
                        type="button"
                        className="ml-auto text-[12px] text-v2-blue-600 hover:underline"
                        aria-label={t("settings.resources.editSkill").replace("{name}", skill.name)}
                        onClick={() => void openSkillEditor(skill.name)}
                      >
                        {t("settings.resources.editSkill").replace("{name}", skill.name)}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              {agentEditor && !roster.some((agent) => agent.name === agentEditor.name) && (
                <AgentMarkdownEditor
                  resource={agentEditor}
                  busy={busy}
                  onSave={(content) => void saveAgent(content)}
                  onClose={() => setAgentEditor(null)}
                />
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
      {addAgentOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-v2-grey-1200/30 p-4">
          <div
            role="dialog"
            aria-label={t("settings.agents.add")}
            className="w-full max-w-[380px] rounded-[10px] bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-overlay)]"
          >
            <h2 className="mb-3 text-[13px] font-semibold text-v2-text-text-base">{t("settings.agents.add")}</h2>
            <input
              aria-label={t("settings.agents.agentName")}
              className="h-8 w-full rounded-md border border-v2-grey-200 px-2 font-mono text-[12px]"
              value={newAgentName}
              onChange={(event) => setNewAgentName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void addAgent()}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className="px-3 py-1 text-[12px]" onClick={() => setAddAgentOpen(false)}>
                {t("config.cancel")}
              </button>
              <button
                type="button"
                className="rounded-md bg-v2-grey-1100 px-3 py-1 text-[12px] text-v2-grey-50"
                onClick={() => void addAgent()}
              >
                {t("settings.agents.create")}
              </button>
            </div>
          </div>
        </div>
      )}
      {skillEditor && (
        <SkillResourceEditor
          resource={skillEditor}
          busy={busy}
          onSave={(content) => void saveSkill(content)}
          onClose={() => setSkillEditor(null)}
        />
      )}
      {detailsAgent && (
        <AgentResourceDetailsDialog
          agentName={agentDisplayName(t, detailsAgent.name)}
          tools={detailsAgent.effectiveTools ?? detailsAgent.tools ?? []}
          skills={detailsAgent.effectiveSkills ?? detailsAgent.skills ?? []}
          onClose={() => setDetailsAgent(null)}
        />
      )}
    </div>
  );
}
