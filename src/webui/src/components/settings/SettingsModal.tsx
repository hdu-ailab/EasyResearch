import { ChevronLeft, X } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { AgentDto, AgentResourceDto, SkillResourceDto } from "../../../../web/contracts";
import { RESEARCH_ASSISTANT_AGENT } from "../../agent-identity";
import {
  createAgentResource,
  listAgentResources,
  listAgents,
  listAuthProviders,
  listConfigProjects,
  listModels,
  listSkillResources,
  patchAgent,
  readAgentResource,
  readSkillResource,
  writeAgentResource,
  writeSkillResource,
} from "../../api";
import type { ModelOption } from "../../api/parsers";
import type { SettingsCloseGuard } from "../../hooks/useHashRoute";
import { hasModalAbove, type ModalLayerResult, requestModalCloseAbove, useModalLayer } from "../../hooks/useModalLayer";
import { agentDisplayName } from "../../i18n/agents";
import { useI18n } from "../../i18n/useI18n";
import { AgentConfigModal } from "../AgentConfigModal";
import { AgentMarkdownEditor } from "../AgentMarkdownEditor";
import { AgentResourceDetailsDialog } from "../AgentResourceDetailsDialog";
import { ProviderConnectModal } from "../ProviderConnectModal";
import { SkillResourceEditor } from "../SkillResourceEditor";
import { thinkingLevelsForModel } from "../ThinkingLevelSelect";
import { type SettingsCategory, SettingsNavigation } from "./SettingsNavigation";
import {
  AgentSettingsPanel,
  ConversationSettingsPanel,
  GeneralSettingsPanel,
  type MissingSkillDiagnostic,
  ProviderSettingsPanel,
  ResourceSettingsPanel,
} from "./SettingsPanels";

export interface SettingsModalProps {
  configurationGeneration: number;
  configurationError: string | null;
  onClose(): void;
  onOpenConfig(): void;
  registerRouteCloseGuard(guard: SettingsCloseGuard): () => void;
}

interface SettingsLayerFrameProps {
  dialogRef: RefObject<HTMLElement | null>;
  layer: ModalLayerResult;
  onBackdrop(event: MouseEvent<HTMLDivElement>): void;
  children: ReactNode;
  nestedLayers: ReactNode;
}

function SettingsLayerFrame({ dialogRef, layer, onBackdrop, children, nestedLayers }: SettingsLayerFrameProps) {
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: only a direct desktop scrim press dismisses this dialog. */}
      <div
        role="presentation"
        className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/30 p-0 min-[820px]:p-4"
        style={{ zIndex: layer.zIndex }}
        onMouseDown={layer.isTop ? onBackdrop : undefined}
      >
        <section
          ref={dialogRef}
          role="dialog"
          {...layer.dialogProps}
          aria-labelledby="settings-dialog-title"
          className="flex h-full w-full flex-col bg-v2-background-bg-base min-[820px]:max-h-[min(720px,calc(100vh-32px))] min-[820px]:max-w-[1080px] min-[820px]:rounded-[10px] min-[820px]:shadow-[var(--v2-elevation-floating)]"
        >
          {children}
        </section>
      </div>
      {nestedLayers}
    </>
  );
}

function withConfiguredModel(models: ModelOption[], configured?: string): ModelOption[] {
  if (!configured || models.some((model) => `${model.provider}/${model.id}` === configured)) return models;
  const slash = configured.indexOf("/");
  return slash > 0
    ? [...models, { provider: configured.slice(0, slash), id: configured.slice(slash + 1), reasoning: false }]
    : models;
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

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function SettingsModal({
  configurationGeneration,
  configurationError,
  onClose,
  onOpenConfig,
  registerRouteCloseGuard,
}: SettingsModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const mobileButtons = useRef<Partial<Record<SettingsCategory, HTMLButtonElement | null>>>({});
  const restoreMobileCategory = useRef<SettingsCategory | null>(null);
  const focusMobileIndex = useRef(false);
  const focusDesktopTab = useRef(false);
  const initialFocusSet = useRef(false);
  const layer = useModalLayer(onClose, dialogRef);
  const [active, setActive] = useState<SettingsCategory>("general");
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 820);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [categoryErrors, setCategoryErrors] = useState<Partial<Record<SettingsCategory, string>>>({});
  const [resourceLoadError, setResourceLoadError] = useState<string | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [, setResourceAgents] = useState<AgentResourceDto[]>([]);
  const [skills, setSkills] = useState<SkillResourceDto[]>([]);
  const [diagnosticScope, setDiagnosticScope] = useState("global");
  const [diagnosticAgents, setDiagnosticAgents] = useState<AgentDto[]>([]);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Array<{ cwd: string }>>([]);
  const [providerConnectOpen, setProviderConnectOpen] = useState(false);
  const [providerConnectedCount, setProviderConnectedCount] = useState<number | null>(null);
  const [agentModal, setAgentModal] = useState<AgentDto | null>(null);
  const diagnosticRequest = useRef(0);
  const configurationRequest = useRef(0);
  const resourceRequest = useRef(0);
  const [agentEditor, setAgentEditor] = useState<AgentResourceDto | null>(null);
  const [skillEditor, setSkillEditor] = useState<SkillResourceDto | null>(null);
  const [detailsAgent, setDetailsAgent] = useState<AgentDto | null>(null);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");

  const setCategoryError = useCallback((category: SettingsCategory, cause: unknown | null) => {
    setCategoryErrors((current) => {
      if (cause === null) {
        if (!(category in current)) return current;
        const next = { ...current };
        delete next[category];
        return next;
      }
      return { ...current, [category]: messageFrom(cause) };
    });
  }, []);

  const refreshConfiguration = useCallback(async () => {
    const request = ++configurationRequest.current;
    try {
      const [globalAgents, fallbackAgents, nextModels] = await Promise.all([
        listAgentResources(),
        listAgents(),
        listModels(),
      ]);
      if (request !== configurationRequest.current) return;
      setResourceAgents(globalAgents);
      setAgents(fallbackAgents);
      setModels(nextModels);
      setAgentModal((current) =>
        current ? (fallbackAgents.find((agent) => agent.name === current.name) ?? null) : null,
      );
      setDetailsAgent((current) =>
        current ? (fallbackAgents.find((agent) => agent.name === current.name) ?? null) : null,
      );
      if (diagnosticRequest.current === 0) setDiagnosticAgents(fallbackAgents);
      setCategoryError("agents", null);
    } catch (cause) {
      if (request === configurationRequest.current) setCategoryError("agents", cause);
    }
  }, [setCategoryError]);

  const refreshResources = useCallback(async () => {
    const request = ++resourceRequest.current;
    setResourcesLoading(true);
    const [nextSkills, nextProjects] = await Promise.allSettled([listSkillResources(), listConfigProjects()]);
    if (request !== resourceRequest.current) return;

    if (nextSkills.status === "fulfilled") setSkills(nextSkills.value);
    if (nextProjects.status === "fulfilled") setProjects(nextProjects.value.projects);
    const failure =
      nextSkills.status === "rejected"
        ? nextSkills.reason
        : nextProjects.status === "rejected"
          ? nextProjects.reason
          : null;
    setResourceLoadError(failure === null ? null : messageFrom(failure));
    setResourcesLoading(false);
  }, []);

  useEffect(() => {
    void configurationGeneration;
    void refreshConfiguration();
    return () => {
      configurationRequest.current += 1;
    };
  }, [configurationGeneration, refreshConfiguration]);

  useEffect(() => {
    void refreshResources();
    return () => {
      resourceRequest.current += 1;
    };
  }, [refreshResources]);

  useEffect(() => {
    listAuthProviders()
      .then((providerList) =>
        setProviderConnectedCount(providerList.filter((provider) => provider.authStatus?.configured).length),
      )
      .catch(() => setProviderConnectedCount(null));
  }, []);

  useEffect(() => {
    let wasMobile = window.innerWidth < 820;
    const onResize = () => {
      const mobile = window.innerWidth < 820;
      if (mobile === wasMobile) return;
      wasMobile = mobile;
      setIsMobile(mobile);
      if (mobile) {
        restoreMobileCategory.current = null;
        focusMobileIndex.current = true;
        setMobileDetailOpen(false);
      } else {
        focusDesktopTab.current = true;
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(
    () =>
      registerRouteCloseGuard({
        shouldBlock: () => hasModalAbove(dialogRef.current),
        requestClose: () => {
          requestModalCloseAbove(dialogRef.current);
        },
      }),
    [registerRouteCloseGuard],
  );

  useLayoutEffect(() => {
    if (!initialFocusSet.current) {
      initialFocusSet.current = true;
      if (isMobile) titleRef.current?.focus({ preventScroll: true });
      else
        dialogRef.current
          ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
          ?.focus({ preventScroll: true });
      return;
    }
    if (isMobile && mobileDetailOpen) {
      dialogRef.current
        ?.querySelector<HTMLElement>(`#settings-panel-${active} [data-settings-panel-heading]`)
        ?.focus({ preventScroll: true });
      return;
    }
    if (isMobile && restoreMobileCategory.current) {
      const category = restoreMobileCategory.current;
      restoreMobileCategory.current = null;
      mobileButtons.current[category]?.focus({ preventScroll: true });
      return;
    }
    if (isMobile && focusMobileIndex.current) {
      focusMobileIndex.current = false;
      titleRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!isMobile && focusDesktopTab.current) {
      focusDesktopTab.current = false;
      dialogRef.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus({ preventScroll: true });
    }
  }, [active, isMobile, mobileDetailOpen]);

  const refreshAgents = async () => {
    const resources = await listAgentResources();
    const next = resources.map((resource) => ({
      ...resource,
      effectiveModel: agents.find((agent) => agent.name === resource.name)?.effectiveModel,
    }));
    setResourceAgents(resources);
    setAgents(next);
    setAgentModal((current) => (current ? (next.find((agent) => agent.name === current.name) ?? null) : null));
  };

  const refreshDiagnostics = async (scope = diagnosticScope) => {
    const request = ++diagnosticRequest.current;
    setDiagnosticAgents([]);
    setDiagnosticError(null);
    try {
      const next = await listAgents(scope === "global" ? undefined : scope);
      if (request === diagnosticRequest.current) setDiagnosticAgents(next);
    } catch (cause) {
      if (request === diagnosticRequest.current) setDiagnosticError(messageFrom(cause));
    }
  };

  const openAgentEditor = async (name: string) => {
    setCategoryError("agents", null);
    try {
      setAgentEditor(await readAgentResource(name));
    } catch (cause) {
      setCategoryError("agents", cause);
    }
  };

  const saveAgent = async (content: string) => {
    if (!agentEditor) return;
    setBusy(true);
    try {
      await writeAgentResource(agentEditor.name, content);
      await Promise.all([refreshAgents(), refreshDiagnostics()]);
      setAgentEditor(null);
    } catch (cause) {
      setCategoryError("agents", cause);
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
      setAgentModal((current) => (current?.name === savedAgent.name ? savedAgent : current));
      await refreshDiagnostics();
    } catch (cause) {
      setCategoryError("agents", cause);
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
      setAgentModal(created);
      setResourceAgents((current) => [...current.filter((item) => item.name !== created.name), created]);
      setAgents((current) => [...current.filter((item) => item.name !== created.name), created]);
      await Promise.all([refreshAgents(), refreshDiagnostics()]);
    } catch (cause) {
      setCategoryError("agents", cause);
    } finally {
      setBusy(false);
    }
  };

  const openSkillEditor = async (name: string) => {
    try {
      setSkillEditor(await readSkillResource(name));
    } catch (cause) {
      setCategoryError("resources", cause);
    }
  };

  const saveSkill = async (content: string) => {
    if (!skillEditor) return;
    setBusy(true);
    try {
      await writeSkillResource(skillEditor.name, content);
      await Promise.all([listSkillResources().then(setSkills), refreshDiagnostics()]);
      setSkillEditor(null);
    } catch (cause) {
      setCategoryError("resources", cause);
    } finally {
      setBusy(false);
    }
  };

  const selectDiagnosticScope = async (scope: string) => {
    setDiagnosticScope(scope);
    await refreshDiagnostics(scope);
  };

  const patchAgentConfiguration = async (
    name: string,
    patch: { model?: string | null; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null },
  ) => {
    setBusy(true);
    setCategoryError("agents", null);
    try {
      const saved = await patchAgent(name, patch);
      const replace = <T extends AgentDto>(rows: T[]): T[] =>
        rows.map((agent) => (agent.name === saved.name ? ({ ...agent, ...saved } as T) : agent));
      setAgents(replace);
      setResourceAgents(replace);
      setAgentModal((current) => (current?.name === saved.name ? saved : current));
      setDetailsAgent((current) => (current?.name === saved.name ? saved : current));
    } catch (cause) {
      setCategoryError("agents", cause);
    } finally {
      setBusy(false);
    }
  };

  const roster = [...agents].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    if (a.name === RESEARCH_ASSISTANT_AGENT) return -1;
    if (b.name === RESEARCH_ASSISTANT_AGENT) return 1;
    return a.name.localeCompare(b.name);
  });
  const researchAssistant = roster.find((agent) => agent.name === RESEARCH_ASSISTANT_AGENT);
  const researchAssistantModel = researchAssistant?.model ?? researchAssistant?.effectiveModel;
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
  const diagnostics: MissingSkillDiagnostic[] = [...missingSkills].map(([skill, agentNames]) => ({
    skill,
    agentNames,
  }));

  const selectCategory = (category: SettingsCategory) => {
    setActive(category);
    if (isMobile) setMobileDetailOpen(true);
  };

  const panels: Record<SettingsCategory, ReactNode> = {
    general: <GeneralSettingsPanel />,
    conversation: <ConversationSettingsPanel configurationGeneration={configurationGeneration} />,
    providers: (
      <ProviderSettingsPanel connectedCount={providerConnectedCount} onOpen={() => setProviderConnectOpen(true)} />
    ),
    agents: (
      <AgentSettingsPanel
        roster={roster}
        busy={busy}
        onRefresh={() => void refreshConfiguration()}
        onAdd={() => setAddAgentOpen(true)}
        onConfigure={setAgentModal}
        onShowDetails={setDetailsAgent}
      />
    ),
    resources: (
      <ResourceSettingsPanel
        tools={toolInventory}
        skills={skills}
        projects={projects}
        diagnosticScope={diagnosticScope}
        diagnostics={diagnostics}
        diagnosticError={diagnosticError}
        onScopeChange={(scope) => void selectDiagnosticScope(scope)}
        onEditSkill={(name) => void openSkillEditor(name)}
      />
    ),
  };
  const panelCategories: readonly SettingsCategory[] = ["general", "conversation", "providers", "agents", "resources"];
  const panelLayers = panelCategories.map((category) => {
    const visible = category === active && (!isMobile || mobileDetailOpen);
    return (
      <main
        key={category}
        id={`settings-panel-${category}`}
        role={isMobile ? undefined : "tabpanel"}
        aria-labelledby={isMobile ? undefined : `settings-tab-${category}`}
        hidden={!visible}
        className="min-h-0 flex-1 overflow-y-auto bg-v2-background-bg-base p-4"
      >
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-3">
          {category === active && configurationError && (
            <p
              className="rounded-md border border-v2-status-error/30 bg-v2-status-error/5 px-3 py-2 text-[13px] text-v2-status-error"
              role="alert"
            >
              {configurationError}
            </p>
          )}
          {categoryErrors[category] && (
            <p
              className="rounded-md border border-v2-status-error/30 bg-v2-status-error/5 px-3 py-2 text-[13px] text-v2-status-error"
              role="alert"
            >
              {categoryErrors[category]}
            </p>
          )}
          {category === "resources" && resourceLoadError && (
            <div
              className="flex items-center gap-2 rounded-md border border-v2-status-error/30 bg-v2-status-error/5 px-3 py-2 text-[13px] text-v2-status-error"
              role="alert"
            >
              <span>{resourceLoadError}</span>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 disabled:opacity-50"
                disabled={resourcesLoading}
                onClick={() => void refreshResources()}
              >
                {t("dialog.retry")}
              </button>
            </div>
          )}
          {panels[category]}
        </div>
      </main>
    );
  });

  const nestedLayers = (
    <>
      {addAgentOpen && (
        <AddAgentDialog
          newAgentName={newAgentName}
          onNameChange={setNewAgentName}
          onCreate={() => void addAgent()}
          onCancel={() => setAddAgentOpen(false)}
        />
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
      {providerConnectOpen && <ProviderConnectModal onClose={() => setProviderConnectOpen(false)} />}
      {agentEditor && !agentModal && !roster.some((agent) => agent.name === agentEditor.name) && (
        <AgentMarkdownEditor
          resource={agentEditor}
          busy={busy}
          onSave={(content) => void saveAgent(content)}
          onClose={() => setAgentEditor(null)}
        />
      )}
      {agentModal && (
        <AgentConfigModal
          agent={agentModal}
          busy={busy}
          isResearchAssistant={agentModal.name === RESEARCH_ASSISTANT_AGENT}
          modelOptions={withConfiguredModel(models, agentModal.model ?? agentModal.effectiveModel)}
          modelValue={
            agentModal.name === RESEARCH_ASSISTANT_AGENT
              ? (agentModal.model ?? agentModal.effectiveModel ?? "")
              : (agentModal.model ?? "")
          }
          modelError={
            agentModal.name === RESEARCH_ASSISTANT_AGENT && !agentModal.model && !agentModal.effectiveModel
              ? t("settings.agents.defaultModelUnavailable")
              : undefined
          }
          thinkingValue={agentModal.thinking ?? ""}
          thinkingLevels={thinkingLevelsForModel(
            models.find(
              (model) =>
                `${model.provider}/${model.id}` ===
                (agentModal.model ??
                  agentModal.effectiveModel ??
                  (agentModal.name === RESEARCH_ASSISTANT_AGENT ? undefined : researchAssistantModel)),
            ),
            agentModal.thinking,
            agentModal.model === undefined &&
              agentModal.effectiveModel === undefined &&
              (agentModal.name === RESEARCH_ASSISTANT_AGENT || researchAssistantModel === undefined),
          )}
          editorResource={agentEditor?.name === agentModal.name ? agentEditor : null}
          onClose={() => setAgentModal(null)}
          onToggle={() => void toggleAgent(agentModal)}
          onModelChange={(value) =>
            void patchAgentConfiguration(agentModal.name, { model: value === "" ? null : value })
          }
          onThinkingChange={(value) =>
            void patchAgentConfiguration(agentModal.name, {
              thinking:
                value === "" ? null : (value as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"),
            })
          }
          onEditMarkdown={() => void openAgentEditor(agentModal.name)}
          onSaveMarkdown={(content) => void saveAgent(content)}
          onCloseEditor={() => setAgentEditor(null)}
          onShowDetails={() => setDetailsAgent(agentModal)}
        />
      )}
    </>
  );

  const onBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (window.innerWidth >= 820 && event.target === event.currentTarget) onClose();
  };

  return (
    <SettingsLayerFrame dialogRef={dialogRef} layer={layer} onBackdrop={onBackdrop} nestedLayers={nestedLayers}>
      <header className="flex h-[50px] shrink-0 items-center gap-2 border-b border-v2-grey-200 px-3">
        {isMobile && mobileDetailOpen && (
          <button
            type="button"
            onClick={() => {
              restoreMobileCategory.current = active;
              setMobileDetailOpen(false);
            }}
            className="flex h-8 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
          >
            <ChevronLeft size={15} aria-hidden />
            {t("settings.backToCategories")}
          </button>
        )}
        <h1
          id="settings-dialog-title"
          ref={titleRef}
          tabIndex={isMobile && !mobileDetailOpen ? -1 : undefined}
          className="min-w-0 flex-1 truncate text-[14px] font-semibold text-v2-text-text-base outline-none"
        >
          {t("settings.title")}
        </h1>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 items-center gap-1 rounded-md px-2 text-[12px] text-v2-text-text-muted transition-colors hover:bg-v2-grey-100 focus:outline-2 focus:outline-offset-2 focus:outline-v2-blue-600"
        >
          <X size={14} aria-hidden />
          {t("settings.close")}
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <SettingsNavigation
          active={active}
          mobileDetailOpen={mobileDetailOpen}
          onSelect={selectCategory}
          onOpenConfig={onOpenConfig}
          registerMobileButton={(category, element) => {
            mobileButtons.current[category] = element;
          }}
        />
        {panelLayers}
      </div>
    </SettingsLayerFrame>
  );
}

function AddAgentDialog({
  newAgentName,
  onNameChange,
  onCreate,
  onCancel,
}: {
  newAgentName: string;
  onNameChange(value: string): void;
  onCreate(): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const { zIndex, dialogProps } = useModalLayer(onCancel, dialogRef);
  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-v2-grey-1200/30 p-0 min-[820px]:p-4"
      style={{ zIndex }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        {...dialogProps}
        aria-label={t("settings.agents.add")}
        className="h-full w-full bg-v2-background-bg-base p-4 shadow-[var(--v2-elevation-overlay)] min-[820px]:h-auto min-[820px]:max-w-[380px] min-[820px]:rounded-[10px]"
      >
        <h2 className="mb-3 text-[13px] font-semibold text-v2-text-text-base">{t("settings.agents.add")}</h2>
        <input
          aria-label={t("settings.agents.agentName")}
          className="h-8 w-full rounded-md border border-v2-grey-200 px-2 font-mono text-[12px]"
          value={newAgentName}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && onCreate()}
        />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="px-3 py-1 text-[12px]" onClick={onCancel}>
            {t("config.cancel")}
          </button>
          <button
            type="button"
            className="rounded-md bg-v2-grey-1100 px-3 py-1 text-[12px] text-v2-grey-50"
            onClick={onCreate}
          >
            {t("settings.agents.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
