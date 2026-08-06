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
import { ChatTranscript } from "../components/ChatTranscript";
import { ChatComposer } from "../components/ChatComposer";
import { FileBrowser } from "../components/FileBrowser";
import { BackButton, ProductMark, Topbar, TopbarIconButton } from "../components/Topbar";

export interface WorkPageProps {
  id: string;
  cwd: string;
  onBack: () => void;
}

type Panel = "files" | "agents" | null;

const emptyView: SessionViewState = { messages: [], tools: [], isStreaming: false, error: null };

const PANEL_MIN = 240;
const PANEL_DEFAULT = 320;
const CHAT_MIN = 400;

/** The conversation-first band. Matches the WebUI tabs threshold (below 820px the
 * Work surface is Chat-default, `.docs/webui.md`); the `md:` layout breakpoint
 * (768px) governs sidebar-vs-overlay geometry only. */
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
  const [sessionView, setSessionView] = useState<SessionViewState>(emptyView);
  const [status, setStatus] = useState<string>("starting");
  const [sessionId, setSessionId] = useState(id);
  const [accepting, setAccepting] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(defaultPanel);
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
    const onResize = () => {
      if (window.innerWidth < CONVERSATION_FIRST_BREAKPOINT) setPanel(null);
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

  const panelMax = available === undefined ? 480 : Math.max(PANEL_MIN, available - CHAT_MIN - 8);
  const defaultPanelWidth = available === undefined ? PANEL_DEFAULT : Math.max(PANEL_MIN, Math.round(available / 2));
  const clampedPanelWidth = available === undefined
    ? panelWidth
    : panelWidthTouched
      ? Math.min(panelWidth, panelMax)
      : Math.min(defaultPanelWidth, panelMax);
  const activeMessages = sessionView.messages.filter((m) => (m.agentId ?? "orchestrator") === activeAgent);

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
        setStatusText((current) => (current?.startsWith("Connection lost") ? null : current));
        const typed = event as { type?: string };
        if (typed.type === "snapshot") {
          setSessionView(fromSnapshot(typed as never));
          return;
        }
        setSessionView((prev) => reduceSessionEvent(prev, event as Parameters<typeof reduceSessionEvent>[1]));
      },
      onError: () => setStatusText("Connection lost — events will resume when the browser reconnects."),
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
        const next = Math.min(panelMax, Math.max(PANEL_MIN, startWidth + startX - moveEvent.clientX));
        setPanelWidth(Math.round(next));
        setPanelWidthTouched(true);
      };

      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
    },
    [panelMax, clampedPanelWidth],
  );

  const send = useCallback(
    async (text: string) => {
      setAccepting(true);
      setStatusText(null);
      try {
        await sendPrompt(sessionId, text);
        setAccepting(false);
      } catch (e) {
        setAccepting(false);
        setStatusText(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId],
  );

  const abort = useCallback(async () => {
    try {
      await abortSession(sessionId);
      setSessionView((prev) => ({ ...prev, isStreaming: false }));
      setStatus("ready");
    } catch (e) {
      setStatusText(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  const togglePanel = (next: Exclude<Panel, null>) => {
    setPanel((current) => (current === next ? null : next));
  };

  const statusColor =
    status === "error" ? "bg-v2-status-error" : status === "running" || sessionView.isStreaming ? "bg-v2-status-success" : "bg-v2-grey-400";

  return (
    <div className="flex h-full flex-col">
      <Topbar
        leading={
          <>
            <BackButton onClick={onBack} />
            <ProductMark />
          </>
        }
        center={<span className="max-w-[50vw] truncate font-mono text-[12px] text-v2-text-text-muted" title={cwd}>{cwd}</span>}
        actions={
          <>
            <span className="mr-1 flex items-center gap-1.5 text-[12px] text-v2-text-text-muted">
              <span className={`size-1.5 rounded-full ${statusColor}`} aria-hidden />
              {status}
            </span>
            <span className="mx-1 h-4 w-px bg-v2-grey-200" aria-hidden />
            <TopbarIconButton
              active={panel === "files"}
              label="Files browser"
              title="Files browser"
              onClick={() => togglePanel("files")}
            >
              <FileSearch size={15} />
            </TopbarIconButton>
            <TopbarIconButton
              active={panel === "agents"}
              label="Agent list"
              title="Agent list"
              onClick={() => togglePanel("agents")}
            >
              <Bot size={15} />
            </TopbarIconButton>
          </>
        }
      />
      {statusText && (
        <p className="border-b border-v2-grey-200 bg-v2-status-error/5 px-4 py-1.5 text-[13px] text-v2-status-error" role="alert">
          {statusText}
        </p>
      )}
      <div ref={rowRef} className="relative flex min-h-0 flex-1 gap-2 p-2">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] h-full">
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
                  aria-label={`Agent ${agent.name}`}
                  onClick={() => setActiveAgent(agent.id)}
                  title={focused ? `Viewing ${agent.name}` : `Focus ${agent.name}`}
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
            emptyHint={activeAgent === "orchestrator" ? undefined : "No messages from this agent yet."}
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
          className={`absolute inset-0 z-30 flex w-full flex-col overflow-hidden bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)] md:relative md:inset-auto md:z-0 md:shrink-0 md:w-(--panel-w) md:translate-x-0 md:rounded-[10px] md:shadow-[var(--v2-elevation-raised)] ${
            sizing
              ? ""
              : "transition-[translate,opacity] duration-v2-panel ease-v2-panel md:transition-[width,opacity] md:duration-v2-panel md:ease-v2-panel motion-reduce:transition-none"
          } ${
            panelPhase === "open"
              ? "translate-x-0 opacity-100 md:opacity-100"
              : "translate-x-full opacity-0 md:w-0 md:opacity-0"
          } ${panelInvisible ? "invisible" : ""} ${panelInteractive ? "" : "pointer-events-none"}`}
          style={{ "--panel-w": `${clampedPanelWidth}px` } as React.CSSProperties}
          aria-label={panel === "agents" ? "Agent list" : "File browser"}
          role="region"
        >
          <button
            type="button"
            aria-label="Resize panel"
            title="Resize panel"
            onPointerDown={startResize}
            className="absolute inset-y-0 left-[-0.5rem] z-30 hidden w-2 cursor-col-resize md:block"
          />
          <div
            key={panel ?? "none"}
            className="min-h-0 flex-1 animate-v2-fade-in overflow-hidden rounded-t-[10px] md:rounded-[10px] motion-reduce:animate-none"
          >
            {panel === "files" && (
              <>
                <FileBrowser root={cwd} />
              </>
            )}
            {panel === "agents" && <AgentList streaming={sessionView.isStreaming} sessionId={sessionId} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function AgentList({ streaming, sessionId }: { streaming: boolean; sessionId: string }) {
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
        <span className="text-[13px] font-semibold text-v2-text-text-base">Agents</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="rounded-md border border-v2-grey-200 bg-v2-background-bg-base p-3">
          <div className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${streaming ? "bg-v2-status-success" : "bg-v2-grey-400"}`} aria-hidden />
            <span className="text-[13px] font-medium text-v2-text-text-base">
              {orchestrator ? orchestrator.name : "Orchestrator"}
            </span>
            <span className="ml-auto text-[12px] text-v2-text-text-faint">{streaming ? "working…" : "idle"}</span>
          </div>
          <dl className="mt-2 flex flex-col gap-1 text-[12px]">
            <div className="flex justify-between gap-2">
              <dt className="text-v2-text-text-faint">Role</dt>
              <dd className="text-v2-text-text-muted">{orchestrator?.description ?? "Runs the paper pipeline"}</dd>
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
                <dt className="text-v2-text-text-faint">Role</dt>
                <dd className="text-v2-text-text-muted">{agent.description}</dd>
              </div>
              {agent.subagents && agent.subagents.length > 0 && (
                <div className="flex justify-between gap-2">
                  <dt className="text-v2-text-text-faint">Subagents</dt>
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
          Subagents run strictly serially; their cards appear here as they run.
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
  const badge =
    entry?.source === "override" ? (
      <span className="rounded-full bg-v2-blue-100/50 px-1.5 py-px text-[10px] text-v2-blue-600">session</span>
    ) : entry?.source === "project" || entry?.source === "global" ? (
      <span className="rounded-full bg-v2-grey-100 px-1.5 py-px text-[10px] text-v2-text-text-muted">config</span>
    ) : null;

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <dt className="text-v2-text-text-faint">Model</dt>
        <dd className="flex items-center gap-1.5 text-v2-text-text-muted">
          {entry?.model ?? "inherits session"}
          {badge}
        </dd>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <select
          aria-label="Select model"
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          disabled={busy}
          className="h-6 min-w-0 flex-1 rounded-md border border-v2-grey-200 bg-v2-background-bg-base px-1 text-[11px] text-v2-text-text-base outline-none focus:border-v2-blue-600"
        >
          <option value="">Models…</option>
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
          Set
        </button>
        {entry?.source === "override" && (
          <button
            type="button"
            onClick={onReset}
            disabled={busy}
            className="rounded-md border border-v2-grey-200 px-2 py-0.5 text-[11px] text-v2-text-text-base transition-colors hover:bg-v2-grey-100 disabled:opacity-50"
          >
            Reset
          </button>
        )}
      </div>
    </>
  );
}
