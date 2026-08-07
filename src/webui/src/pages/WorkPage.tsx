import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, FileSearch, FolderOpen } from "lucide-react";
import type { AgentDto, AgentEffectiveModelDto } from "../../../web/contracts";
import {
  abortSession,
  connectSessionEvents,
  getEffectiveModels,
  getSnapshot,
  listAgents,
  listModels,
  readFileContent,
  sendPrompt,
  setAgentModel,
} from "../api";
import { fromSnapshot, reduceSessionEvent, type SessionViewState } from "../session-reducer";
import { usePanelTransition } from "../hooks/usePanelTransition";
import { useI18n } from "../i18n/useI18n";
import { ChatTranscript } from "../components/ChatTranscript";
import { ChatComposer } from "../components/ChatComposer";
import { FileBrowser } from "../components/FileBrowser";
import { BackButton, ProductMark, Topbar, TopbarIconButton } from "../components/Topbar";
import { WorkMobileTabs, type WorkView } from "../components/WorkMobileTabs";

export interface WorkPageProps {
  id: string;
  cwd: string;
  onBack: () => void;
}

type Panel = "files" | "agents" | null;

const emptyView: SessionViewState = { messages: [], tools: [], isStreaming: false, error: null, nextOrder: 0 };

const PANEL_MIN = 240;
const PANEL_DEFAULT = 320;
const CHAT_MIN = 400;

const CONVERSATION_FIRST_BREAKPOINT = 820;

function defaultPanel(): Panel {
  return typeof window !== "undefined" && window.innerWidth >= CONVERSATION_FIRST_BREAKPOINT ? "files" : null;
}

interface AgentChip {
  id: string;
  name: string;
  count: number;
  status: "idle" | "working" | "error";
}

const ORCHESTRATOR_AGENT: AgentChip = { id: "orchestrator", name: "Orchestrator", count: 0, status: "idle" };

export function WorkPage({ id, cwd, onBack }: WorkPageProps) {
  const { t } = useI18n();
  const [sessionView, setSessionView] = useState<SessionViewState>(emptyView);
  const [status, setStatus] = useState<string>("starting");
  const [sessionId, setSessionId] = useState(id);
  const [accepting, setAccepting] = useState(false);
  const [pendingOutput, setPendingOutput] = useState(false);
  const pendingBaseline = useRef<number | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(defaultPanel);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < CONVERSATION_FIRST_BREAKPOINT);
  const [mobileView, setMobileView] = useState<WorkView>("chat");
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT);
  const [panelWidthTouched, setPanelWidthTouched] = useState(false);
  const [available, setAvailable] = useState<number | undefined>(undefined);
  const [sizing, setSizing] = useState(false);
  const panelOpen = panel !== null;
  const panelPhase = usePanelTransition(panelOpen);
  const panelInvisible = panelPhase === "closed";
  const panelInteractive = panelPhase === "open";
  const [agents, setAgents] = useState<AgentChip[]>([ORCHESTRATOR_AGENT]);
  const [activeAgent, setActiveAgent] = useState<string>("orchestrator");
  const resizing = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry?.contentRect.width));
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let wasMobile = window.innerWidth < CONVERSATION_FIRST_BREAKPOINT;
    const onResize = () => {
      const mobile = window.innerWidth < CONVERSATION_FIRST_BREAKPOINT;
      if (mobile === wasMobile) return;
      wasMobile = mobile;
      setIsMobile(mobile);
      if (mobile) {
        setMobileView("chat");
        setPanel(null);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    setAgents((current) => {
      const counts = new Map<string, number>();
      for (const message of sessionView.messages) {
        const id = message.agentId ?? "orchestrator";
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      let changed = false;
      const ids = new Set(current.map((a) => a.id));
      const next = [...current];
      for (const id of counts.keys()) {
        if (!ids.has(id)) {
          next.push({ id, name: id, count: 0, status: "idle" });
          changed = true;
        }
      }
      const mapped = next.map((agent) => {
        const count = counts.get(agent.id) ?? 0;
        const status: AgentChip["status"] =
          agent.id === "orchestrator"
            ? sessionView.error !== null
              ? "error"
              : sessionView.isStreaming
                ? "working"
                : "idle"
            : agent.status;
        if (agent.count === count && agent.status === status) return agent;
        changed = true;
        return { ...agent, count, status };
      });
      return changed ? mapped : current;
    });
  }, [sessionView]);

  const panelMin = Math.max(PANEL_MIN, window.innerWidth / 3);
  const panelMax = available === undefined ? 480 : Math.max(panelMin, available - CHAT_MIN - 8);
  const defaultPanelWidth = available === undefined ? PANEL_DEFAULT : Math.max(panelMin, Math.round(available / 2));
  const clampedPanelWidth = available === undefined
    ? panelWidth
    : panelWidthTouched
      ? Math.min(panelWidth, panelMax)
      : Math.min(defaultPanelWidth, panelMax);
  const activeMessages = sessionView.messages.filter((m) => (m.agentId ?? "orchestrator") === activeAgent);
  const projectName = cwd.split("/").filter(Boolean).at(-1) ?? cwd;
  const chatHidden = isMobile && mobileView !== "chat";
  const filesHidden = isMobile ? mobileView !== "files" : panel !== "files";
  const agentsHidden = isMobile ? mobileView !== "agents" : panel !== "agents";

  const hydrate = useCallback(async (targetId: string) => {
    const snapshot = await getSnapshot(targetId);
    setSessionId(snapshot.session.id);
    setSessionView(fromSnapshot(snapshot));
    setStatus(snapshot.session.status);
  }, []);

  useEffect(() => {
    let active = true;
    hydrate(id).catch((e: unknown) => {
      if (active) {
        setStatus("error");
        setStatusText(e instanceof Error ? e.message : String(e));
      }
    });
    const unsubscribe = connectSessionEvents(id, {
      onEvent: (event) => {
        setStatusText((current) => (current === t("work.connectionLost") ? null : current));
        const typed = event as { type?: string };
        if (typed.type === "snapshot") {
          setSessionView(fromSnapshot(typed as never));
          return;
        }
        setSessionView((prev) => reduceSessionEvent(prev, event as Parameters<typeof reduceSessionEvent>[1]));
      },
      onError: () => setStatusText(t("work.connectionLost")),
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [id, hydrate]);

  const startResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      resizing.current = true;
      setSizing(true);
      const startX = event.clientX;
      const startWidth = clampedPanelWidth;
      document.body.style.userSelect = "none";
      document.body.style.overflow = "hidden";

      const stop = () => {
        resizing.current = false;
        setSizing(false);
        document.body.style.userSelect = "";
        document.body.style.overflow = "";
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", stop);
      };

      const move = (moveEvent: PointerEvent) => {
        const next = Math.min(panelMax, Math.max(panelMin, startWidth + startX - moveEvent.clientX));
        setPanelWidth(Math.round(next));
        setPanelWidthTouched(true);
      };

      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
    },
    [panelMax, panelMin, clampedPanelWidth],
  );

  const assistantCount = useCallback(() => {
    let n = sessionView.tools.length;
    for (const m of sessionView.messages) if (m.role !== "user") n += 1;
    return n;
  }, [sessionView]);

  const send = useCallback(
    async (text: string) => {
      setAccepting(true);
      setStatusText(null);
      pendingBaseline.current = assistantCount();
      setPendingOutput(true);
      try {
        await sendPrompt(sessionId, text);
        setAccepting(false);
      } catch (e) {
        setAccepting(false);
        setPendingOutput(false);
        pendingBaseline.current = null;
        setStatusText(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId, assistantCount],
  );

  useEffect(() => {
    if (!pendingOutput || pendingBaseline.current === null) return;
    if (sessionView.isStreaming || assistantCount() > pendingBaseline.current) {
      setPendingOutput(false);
      pendingBaseline.current = null;
    }
  }, [sessionView, pendingOutput, assistantCount]);

  const abort = useCallback(async () => {
    try {
      await abortSession(sessionId);
      setSessionView((prev) => ({ ...prev, isStreaming: false }));
      setStatus("ready");
      setPendingOutput(false);
      pendingBaseline.current = null;
    } catch (e) {
      setStatusText(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  const togglePanel = (next: Exclude<Panel, null>) => {
    setPanel((current) => (current === next ? null : next));
  };

  const statusColor =
    status === "error" ? "bg-v2-status-error" : status === "running" || sessionView.isStreaming ? "bg-v2-status-success" : "bg-v2-grey-400";
  const statusLabel =
    status === "error"
      ? t("work.error")
      : status === "running"
        ? t("work.running")
        : status === "stopped"
          ? t("work.stopped")
          : status === "starting"
            ? t("work.starting")
            : t("work.ready");

  return (
    <div className="flex h-full flex-col">
      <Topbar
        leading={
          <>
            <BackButton onClick={onBack} />
            {!isMobile && <ProductMark />}
          </>
        }
        center={
          <span className="max-w-full truncate font-mono text-[12px] text-v2-text-text-muted" title={cwd}>
            {isMobile ? projectName : cwd}
          </span>
        }
        actions={
          <>
            <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-v2-text-text-muted min-[820px]:mr-1">
              <span className={`size-1.5 rounded-full ${statusColor}`} aria-hidden />
              {!isMobile && statusLabel}
            </span>
            {!isMobile && (
              <>
                <span className="mx-1 h-4 w-px bg-v2-grey-200" aria-hidden />
                <TopbarIconButton
                  active={panel === "files"}
                  label={t("work.filesBrowser")}
                  title={t("work.filesBrowser")}
                  onClick={() => togglePanel("files")}
                >
                  <FileSearch size={15} />
                </TopbarIconButton>
                <TopbarIconButton
                  active={panel === "agents"}
                  label={t("work.agentList")}
                  title={t("work.agentList")}
                  onClick={() => togglePanel("agents")}
                >
                  <Bot size={15} />
                </TopbarIconButton>
              </>
            )}
          </>
        }
      />
      {statusText && (
        <p className="border-b border-v2-grey-200 bg-v2-status-error/5 px-4 py-1.5 text-[13px] text-v2-status-error" role="alert">
          {statusText}
        </p>
      )}
      <WorkMobileTabs active={mobileView} onChange={setMobileView} />
      <div ref={rowRef} className="relative flex min-h-0 flex-1 gap-2 overflow-x-clip p-2">
        <section
          id="work-panel-chat"
          role="tabpanel"
          aria-labelledby="work-tab-chat"
          hidden={chatHidden}
          className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
        >
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-v2-grey-200 px-3 py-2">
            {agents.map((agent) => {
              const focused = agent.id === activeAgent;
              const dot =
                agent.status === "working"
                  ? "bg-v2-status-success"
                  : agent.status === "error"
                    ? "bg-v2-status-warning"
                    : "bg-v2-grey-400";
              return (
                <button
                  key={agent.id}
                  type="button"
                  aria-pressed={focused}
                  aria-label={`${t("work.agentChip")} ${agent.name}`}
                  onClick={() => setActiveAgent(agent.id)}
                  title={focused ? `${t("work.viewing")} ${agent.name}` : `${t("work.focus")} ${agent.name}`}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                    focused
                      ? "border-v2-blue-200 bg-v2-blue-100/50 text-v2-blue-600"
                      : "border-v2-grey-200 text-v2-text-text-muted hover:bg-v2-grey-100"
                  }`}
                >
                  <span className={`size-2 rounded-full ${dot}`} aria-hidden />
                  {agent.name}
                  {agent.count > 0 ? <span className="opacity-70">({agent.count})</span> : null}
                </button>
              );
            })}
          </div>
          <ChatTranscript
            messages={activeMessages}
            tools={sessionView.tools}
            emptyHint={activeAgent === "orchestrator" ? undefined : t("work.noMessagesYet")}
            pending={pendingOutput && activeAgent === "orchestrator"}
          />
          <footer className="shrink-0 border-t border-v2-grey-200 p-3">
            <ChatComposer
              disabled={accepting}
              streaming={sessionView.isStreaming}
              onSend={send}
              onAbort={abort}
            />
          </footer>
        </section>

        <aside
          hidden={isMobile && mobileView === "chat"}
          className={`flex h-full min-w-0 w-full flex-col bg-v2-background-bg-base min-[820px]:relative min-[820px]:shrink-0 min-[820px]:w-(--panel-w) min-[820px]:rounded-[10px] min-[820px]:shadow-[var(--v2-elevation-raised)] ${
            sizing
              ? ""
              : "min-[820px]:transition-[width,opacity] min-[820px]:duration-v2-panel min-[820px]:ease-v2-panel motion-reduce:transition-none"
          } ${
            panelPhase === "open"
              ? "min-[820px]:opacity-100"
              : "min-[820px]:w-0 min-[820px]:opacity-0"
          } ${!isMobile && panelInvisible ? "invisible" : ""} ${!isMobile && !panelInteractive ? "pointer-events-none" : ""}`}
          style={{ "--panel-w": `${clampedPanelWidth}px` } as React.CSSProperties}
          aria-label={(isMobile ? mobileView === "agents" : panel === "agents") ? t("work.agentList") : t("work.fileBrowser")}
          role="region"
        >
          <button
            type="button"
            aria-label={t("work.resizePanel")}
            title={t("work.resizePanel")}
            onPointerDown={startResize}
            className="absolute inset-y-0 left-[-0.5rem] z-30 hidden w-2 cursor-col-resize min-[820px]:block"
          />
          <div
            id="work-panel-files"
            role="tabpanel"
            aria-labelledby="work-tab-files"
            hidden={filesHidden}
            className={`h-full min-h-0 overflow-hidden min-[820px]:rounded-[10px] ${!filesHidden ? "animate-v2-fade-in motion-reduce:animate-none" : ""}`}
          >
            <FileBrowser root={cwd} />
          </div>
          <div
            id="work-panel-agents"
            role="tabpanel"
            aria-labelledby="work-tab-agents"
            hidden={agentsHidden}
            className={`h-full min-h-0 overflow-hidden min-[820px]:rounded-[10px] ${!agentsHidden ? "animate-v2-fade-in motion-reduce:animate-none" : ""}`}
          >
            <AgentList streaming={sessionView.isStreaming} sessionId={sessionId} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function AgentList({ streaming, sessionId }: { streaming: boolean; sessionId: string }) {
  const { t } = useI18n();
  const [roster, setRoster] = useState<AgentDto[] | null>(null);
  const [models, setModels] = useState<Array<{ provider: string; id: string }>>([]);
  const [effective, setEffective] = useState<AgentEffectiveModelDto[] | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([listAgents(), listModels(), getEffectiveModels(sessionId)])
      .then(([agents, catalog, eff]) => {
        if (!alive) return;
        setRoster(agents);
        setModels(catalog);
        setEffective(eff);
      })
      .catch(() => {
        if (alive) setRoster([]);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const applyModel = useCallback(
    async (agentName: string, model: string | null) => {
      setBusy(true);
      try {
        await setAgentModel(sessionId, agentName, model);
        setEffective(await getEffectiveModels(sessionId));
      } catch {
        // keep the last known models; the next interaction will retry
      } finally {
        setBusy(false);
      }
    },
    [sessionId],
  );

  const agents = roster ?? [];
  const orchestrator = agents.find((a) => a.name === "orchestrator");
  const subagents = agents.filter((a) => a.name !== "orchestrator");

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-v2-grey-200 px-3 py-2">
        <Bot size={14} className="text-v2-icon-icon-muted" />
        <span className="text-[13px] font-semibold text-v2-text-text-base">{t("work.agentsTab")}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="rounded-md border border-v2-grey-200 bg-v2-background-bg-base p-3">
          <div className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${streaming ? "bg-v2-status-success" : "bg-v2-grey-400"}`} aria-hidden />
            <span className="text-[13px] font-medium text-v2-text-text-base">
              {orchestrator ? orchestrator.name : "Orchestrator"}
            </span>
            <span className="ml-auto text-[12px] text-v2-text-text-faint">{streaming ? t("work.working") : t("work.idle")}</span>
          </div>
          <dl className="mt-2 flex flex-col gap-1 text-[12px]">
            <div className="flex justify-between gap-2">
              <dt className="text-v2-text-text-faint">{t("work.role")}</dt>
              <dd className="text-v2-text-text-muted">{orchestrator?.description ?? t("work.orchestratorFallback")}</dd>
            </div>
            <ModelRow
              entry={effective?.find((e) => e.name === "orchestrator")}
              models={models}
              selected={selected["orchestrator"] ?? ""}
              busy={busy}
              onSelect={(value) => setSelected((s) => ({ ...s, orchestrator: value }))}
              onSet={() => applyModel("orchestrator", selected["orchestrator"] ?? null)}
              onReset={() => applyModel("orchestrator", null)}
            />
          </dl>
        </div>
        {subagents.map((agent) => (
          <div key={agent.name} className="mt-3 rounded-md border border-v2-grey-200 bg-v2-background-bg-base p-3">
            <div className="flex items-center gap-2">
              <FolderOpen size={12} className="text-v2-icon-icon-muted" />
              <span className="text-[13px] font-medium text-v2-text-text-base">{agent.name}</span>
            </div>
            <dl className="mt-2 flex flex-col gap-1 text-[12px]">
              <div className="flex justify-between gap-2">
                <dt className="text-v2-text-text-faint">{t("work.role")}</dt>
                <dd className="text-v2-text-text-muted">{agent.description}</dd>
              </div>
              {agent.subagents && agent.subagents.length > 0 && (
                <div className="flex justify-between gap-2">
                  <dt className="text-v2-text-text-faint">{t("work.subagents")}</dt>
                  <dd className="text-v2-text-text-muted">{agent.subagents.join(", ")}</dd>
                </div>
              )}
              <ModelRow
                entry={effective?.find((e) => e.name === agent.name)}
                models={models}
                selected={selected[agent.name] ?? ""}
                busy={busy}
                onSelect={(value) => setSelected((s) => ({ ...s, [agent.name]: value }))}
                onSet={() => applyModel(agent.name, selected[agent.name] ?? null)}
                onReset={() => applyModel(agent.name, null)}
              />
            </dl>
          </div>
        ))}
        <p className="mt-3 flex items-center gap-2 text-[12px] text-v2-text-text-faint">
          <FolderOpen size={12} />
          {t("work.strictlySerialNote")}
        </p>
      </div>
    </div>
  );
}

interface ModelRowProps {
  entry: AgentEffectiveModelDto | undefined;
  models: Array<{ provider: string; id: string }>;
  selected: string;
  busy: boolean;
  onSelect: (value: string) => void;
  onSet: () => void;
  onReset: () => void;
}

function ModelRow({ entry, models, selected, busy, onSelect, onSet, onReset }: ModelRowProps) {
  const { t } = useI18n();
  const badge =
    entry?.source === "override" ? (
      <span className="rounded-full bg-v2-blue-100/50 px-1.5 py-px text-[10px] text-v2-blue-600">{t("work.sourceSession")}</span>
    ) : entry?.source === "project" || entry?.source === "global" ? (
      <span className="rounded-full bg-v2-grey-100 px-1.5 py-px text-[10px] text-v2-text-text-muted">{t("work.sourceConfig")}</span>
    ) : null;

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-v2-text-text-faint">{t("work.model")}</dt>
        <dd className="flex items-center gap-1.5 text-v2-text-text-muted">
          {entry?.model ?? t("work.inheritsSession")}
          {badge}
        </dd>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <select
          aria-label={t("work.selectModel")}
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          disabled={busy}
          className="h-6 min-w-0 flex-1 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
        >
          <option value="">{t("work.models")}</option>
          {models.map((m) => {
            const key = `${m.provider}/${m.id}`;
            return (
              <option key={key} value={key}>
                {key}
              </option>
            );
          })}
        </select>
        <button
          type="button"
          onClick={onSet}
          disabled={busy || !selected}
          className="rounded-md border border-v2-grey-200 px-2 py-0.5 text-[11px] text-v2-text-text-base transition-colors hover:bg-v2-grey-100 disabled:opacity-50"
        >
          {t("work.set")}
        </button>
        {entry?.source === "override" && (
          <button
            type="button"
            onClick={onReset}
            disabled={busy}
            className="rounded-md border border-v2-grey-200 px-2 py-0.5 text-[11px] text-v2-text-text-base transition-colors hover:bg-v2-grey-100 disabled:opacity-50"
          >
            {t("work.reset")}
          </button>
        )}
      </div>
    </>
  );
}
