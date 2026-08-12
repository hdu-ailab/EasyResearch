import { Bot, FileSearch } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileWatcherEvent } from "../../../web/contracts";
import {
  abortSession,
  connectSessionEvents,
  getChildSnapshot,
  getSnapshot,
  isUnknownSession,
  openSession,
  sendPrompt,
} from "../api";
import { AgentList, type AgentStatus } from "../components/AgentList";
import { AgentTabBar } from "../components/AgentTabBar";
import { ChatComposer } from "../components/ChatComposer";
import { ChatTranscript } from "../components/ChatTranscript";
import { FileBrowser } from "../components/FileBrowser";
import { ProductMark, Topbar, TopbarIconButton } from "../components/Topbar";
import { WorkMobileTabs, type WorkView } from "../components/WorkMobileTabs";
import { parseFileWatcherEvent } from "../file-watcher";
import { usePanelTransition } from "../hooks/usePanelTransition";
import { useI18n } from "../i18n/useI18n";
import {
  fromSnapshot,
  mergeSnapshot,
  nestedSubagentEvent,
  reduceSessionEvent,
  type SessionViewState,
} from "../session-reducer";
import {
  closeSubagentTab,
  promoteSubagentTab,
  retainSubagentTab,
  type SubagentTabsState,
  syncRunningSubagentTabs,
  temporarySubagentTabKey,
} from "../subagent-tabs";

export interface WorkPageProps {
  id: string;
  cwd: string;
  onBack: () => void;
}

type Panel = "files" | "agents" | null;

const emptyView: SessionViewState = { messages: [], tools: [], isStreaming: false, error: null, nextOrder: 0 };

function mergeChildView(snapshot: SessionViewState, live: SessionViewState): SessionViewState {
  const entries = [
    ...snapshot.messages.map((value) => ({ kind: "message" as const, value })),
    ...snapshot.tools.map((value) => ({ kind: "tool" as const, value })),
  ].sort((a, b) => a.value.order - b.value.order);
  const positions = new Map(entries.map((entry, index) => [`${entry.kind}:${entry.value.key}`, index]));
  for (const entry of [
    ...live.messages.map((value) => ({ kind: "message" as const, value })),
    ...live.tools.map((value) => ({ kind: "tool" as const, value })),
  ].sort((a, b) => a.value.order - b.value.order)) {
    const key = `${entry.kind}:${entry.value.key}`;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, entries.length);
      entries.push(entry);
    } else {
      entries[position] = entry;
    }
  }
  const ordered = entries.map((entry, order) => ({ kind: entry.kind, value: { ...entry.value, order } }));
  return {
    ...snapshot,
    messages: ordered
      .filter((entry) => entry.kind === "message")
      .map((entry) => entry.value as SessionViewState["messages"][number]),
    tools: ordered
      .filter((entry) => entry.kind === "tool")
      .map((entry) => entry.value as SessionViewState["tools"][number]),
    isStreaming: live.isStreaming,
    error: live.error,
    nextOrder: ordered.length,
    activeMessageKey: live.activeMessageKey,
  };
}

const PANEL_MIN = 240;
const PANEL_DEFAULT = 320;
const CHAT_MIN = 400;

const CONVERSATION_FIRST_BREAKPOINT = 820;

function defaultPanel(): Panel {
  return typeof window !== "undefined" && window.innerWidth >= CONVERSATION_FIRST_BREAKPOINT ? "files" : null;
}

export function WorkPage({ id, cwd, onBack }: WorkPageProps) {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const [sessionView, setSessionView] = useState<SessionViewState>(emptyView);
  const [status, setStatus] = useState<string>("starting");
  const [fileEvent, setFileEvent] = useState<FileWatcherEvent | null>(null);
  const [sessionId, setSessionId] = useState(id);
  const [subscribeEpoch, setSubscribeEpoch] = useState(0);
  const [accepting, setAccepting] = useState(false);
  const [pendingOutput, setPendingOutput] = useState(false);
  const pendingBaseline = useRef<number | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const sessionPathRef = useRef<string | null>(null);
  // Any event-stream delivery (the connection snapshot or live deltas) makes
  // the stream the authoritative view; later HTTP snapshot resolutions must
  // not overwrite it with a stale earlier state (ADR-037 race).
  const eventsReceivedRef = useRef(false);
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
  const [tabsState, setTabsState] = useState<SubagentTabsState>({ tabs: [], hiddenRunningToolCalls: [] });
  const [childViews, setChildViews] = useState<Record<string, SessionViewState>>({});
  const [childErrors, setChildErrors] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState("orchestrator");
  const tabsStateRef = useRef(tabsState);
  const childSessionByTool = useRef(new Map<string, string>());
  const childLoaded = useRef(new Set<string>());
  const childRequests = useRef(new Map<string, Promise<void>>());
  const childRefreshPending = useRef(new Set<string>());
  const loadChildRef = useRef<(childId: string, refresh?: boolean) => Promise<void>>(async () => {});
  const resizing = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tabsStateRef.current = tabsState;
  }, [tabsState]);

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

  // Keep temporary tabs synchronized with the parent tool stream, then promote
  // retained invocations as soon as an exact child UUID is known.
  useEffect(() => {
    setTabsState((current) => {
      let next = syncRunningSubagentTabs(current, sessionView.tools);
      for (const tool of sessionView.tools) {
        if (tool.name !== "subagent" || !tool.sessionId) continue;
        next = promoteSubagentTab(next, {
          toolCallId: tool.key,
          childSessionId: tool.sessionId,
          agent: tool.agentName ?? "subagent",
          ...(tool.step !== undefined ? { step: tool.step } : {}),
          ...(tool.latestMessage !== undefined ? { latestMessage: tool.latestMessage } : {}),
        });
      }
      return next;
    });
    setActiveTab((current) => {
      if (!current.startsWith("tool:")) return current;
      const tab = tabsStateRef.current.tabs.find((candidate) => candidate.key === current);
      const tool = tab
        ? sessionView.tools.find(
            (candidate) =>
              candidate.key === tab.toolCallId &&
              (candidate.step === tab.step || (tab.step === undefined && tab.sessionId === undefined)),
          )
        : sessionView.tools.find((candidate) => temporarySubagentTabKey(candidate.key, candidate.step) === current);
      return tool?.sessionId ? `session:${tool.sessionId}` : current;
    });
  }, [sessionView.tools]);

  useEffect(() => {
    if (activeTab !== "orchestrator" && !tabsState.tabs.some((tab) => tab.key === activeTab)) {
      setActiveTab("orchestrator");
    }
  }, [tabsState.tabs, activeTab]);

  const panelMin = Math.max(PANEL_MIN, window.innerWidth / 3);
  const panelMax = available === undefined ? 480 : Math.max(panelMin, available - CHAT_MIN - 8);
  const defaultPanelWidth = available === undefined ? PANEL_DEFAULT : Math.max(panelMin, Math.round(available / 2));
  const clampedPanelWidth =
    available === undefined
      ? panelWidth
      : panelWidthTouched
        ? Math.min(panelWidth, panelMax)
        : Math.min(defaultPanelWidth, panelMax);
  const activeChildId = activeTab.startsWith("session:") ? activeTab.slice(8) : undefined;
  const activeView = activeChildId ? childViews[activeChildId] : undefined;
  const activeMessages = activeTab === "orchestrator" ? sessionView.messages : (activeView?.messages ?? []);
  const activeTools = activeTab === "orchestrator" ? sessionView.tools : activeChildId ? (activeView?.tools ?? []) : [];
  const statusByAgent = Object.fromEntries([
    ["orchestrator", sessionView.error !== null ? "error" : sessionView.isStreaming ? "working" : "idle"],
    ...tabsState.tabs.map((tab) => [tab.agent, tab.running ? "working" : "idle"]),
  ]) as Record<string, AgentStatus>;
  const projectName = cwd.split("/").filter(Boolean).at(-1) ?? cwd;
  const chatHidden = isMobile && mobileView !== "chat";
  const filesHidden = isMobile ? mobileView !== "files" : panel !== "files";
  const agentsHidden = isMobile ? mobileView !== "agents" : panel !== "agents";

  const hydrate = useCallback(async (targetId: string) => {
    const snapshot = await getSnapshot(targetId);
    sessionPathRef.current = snapshot.session.sessionFile ?? null;
    setSessionId(snapshot.session.id);
    setStatus(snapshot.session.status);
    return snapshot;
  }, []);

  const loadChild = useCallback(
    (childId: string, refresh = false): Promise<void> => {
      const requestKey = `${sessionId}:${childId}`;
      const inFlight = childRequests.current.get(requestKey);
      if (inFlight) {
        if (refresh) childRefreshPending.current.add(requestKey);
        return inFlight;
      }
      if (!refresh && childLoaded.current.has(requestKey)) return Promise.resolve();

      setChildErrors((current) => (current[childId] ? { ...current, [childId]: false } : current));
      const request = getChildSnapshot(sessionId, childId)
        .then((snapshot) => {
          const hydrated = fromSnapshot({
            session: {
              ...snapshot.session,
              isStreaming: false,
              status: "ready",
            },
            messages: snapshot.messages,
            subagents: [],
          });
          childLoaded.current.add(requestKey);
          setChildErrors((current) => {
            if (!(childId in current)) return current;
            const next = { ...current };
            delete next[childId];
            return next;
          });
          setChildViews((current) => ({
            ...current,
            [childId]: current[childId]
              ? refresh
                ? mergeChildView(current[childId], hydrated)
                : mergeChildView(hydrated, current[childId])
              : hydrated,
          }));
        })
        .catch(() => {
          childLoaded.current.delete(requestKey);
          setChildErrors((current) => ({ ...current, [childId]: true }));
        })
        .finally(() => {
          childRequests.current.delete(requestKey);
          if (childRefreshPending.current.delete(requestKey)) {
            void loadChildRef.current(childId, true);
          }
        });
      childRequests.current.set(requestKey, request);
      return request;
    },
    [sessionId],
  );
  loadChildRef.current = loadChild;

  useEffect(() => {
    void subscribeEpoch;
    let active = true;
    eventsReceivedRef.current = false;
    setFileEvent(null);
    hydrate(sessionId)
      .then((snapshot) => {
        if (active && !eventsReceivedRef.current) {
          setSessionView(fromSnapshot(snapshot));
        }
      })
      .catch((e: unknown) => {
        if (active) {
          setStatus("error");
          setStatusText(e instanceof Error ? e.message : String(e));
        }
      });
    const unsubscribe = connectSessionEvents(sessionId, {
      onEvent: (event) => {
        eventsReceivedRef.current = true;
        setStatusText((current) => (current === tRef.current("work.connectionLost") ? null : current));
        const fileWatcherEvent = parseFileWatcherEvent(event, cwd);
        if (fileWatcherEvent) {
          setFileEvent(fileWatcherEvent);
          return;
        }
        const typed = event as { type?: string };
        if (typed.type === "snapshot") {
          const snapshotEvent = typed as { session?: { sessionFile?: string } };
          if (typeof snapshotEvent.session?.sessionFile === "string") {
            sessionPathRef.current = snapshotEvent.session.sessionFile;
          }
          setSessionView((current) => mergeSnapshot(current, typed as never));
          for (const tab of tabsStateRef.current.tabs) {
            if (tab.sessionId) void loadChild(tab.sessionId, true);
          }
          return;
        }
        if (typed.type === "session_deactivated") {
          return;
        }
        const agentEvent = event as Parameters<typeof reduceSessionEvent>[1];
        const nested = nestedSubagentEvent(agentEvent);
        if (nested?.sessionId) childSessionByTool.current.set(nested.toolCallId, nested.sessionId);
        const nestedSessionId =
          nested?.sessionId ?? (nested ? childSessionByTool.current.get(nested.toolCallId) : undefined);
        const nestedEvent = nested?.event;
        if (nestedSessionId && nestedEvent) {
          setChildViews((current) => ({
            ...current,
            [nestedSessionId]: reduceSessionEvent(
              current[nestedSessionId] ?? { ...emptyView, subagentName: nested.agent },
              nestedEvent,
            ),
          }));
        }
        setSessionView((prev) => reduceSessionEvent(prev, agentEvent));
      },
      onError: () => setStatusText(tRef.current("work.connectionLost")),
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [sessionId, hydrate, loadChild, subscribeEpoch, cwd]);

  useEffect(() => {
    if (activeTab.startsWith("session:")) loadChild(activeTab.slice(8));
  }, [activeTab, loadChild]);

  const openSubagentTool = useCallback(
    (toolCallId: string, requestedStep?: number) => {
      const tool = sessionView.tools.find((candidate) => candidate.name === "subagent" && candidate.key === toolCallId);
      if (!tool) return;
      const link =
        requestedStep === undefined
          ? tool.sessionLinks?.length === 1
            ? tool.sessionLinks[0]
            : tool.sessionLinks?.find((candidate) => candidate.step === tool.step)
          : tool.sessionLinks?.find((candidate) => candidate.step === requestedStep);
      const step = link?.step ?? requestedStep ?? tool.step;
      const childId = link?.childSessionId ?? (step === tool.step ? tool.sessionId : undefined);
      const existingTab = tabsState.tabs.find((tab) => tab.toolCallId === toolCallId && tab.step === step);
      setTabsState((current) => {
        let next = current;
        if (!next.tabs.some((tab) => tab.toolCallId === toolCallId && tab.step === step)) {
          next = {
            ...next,
            tabs: [
              ...next.tabs,
              {
                key: temporarySubagentTabKey(toolCallId, step),
                toolCallId,
                agent: link?.agent ?? tool.agentName ?? "subagent",
                ...(step !== undefined ? { step } : {}),
                retained: false,
                running: tool.running,
                ...(tool.latestMessage !== undefined ? { latestMessage: tool.latestMessage } : {}),
              },
            ],
          };
        }
        next = retainSubagentTab(next, toolCallId, step);
        return childId
          ? promoteSubagentTab(next, {
              toolCallId,
              childSessionId: childId,
              agent: link?.agent ?? tool.agentName ?? "subagent",
              ...(step !== undefined ? { step } : {}),
              ...((link?.latestMessage ?? tool.latestMessage)
                ? { latestMessage: link?.latestMessage ?? tool.latestMessage }
                : {}),
            })
          : next;
      });
      const key = childId ? `session:${childId}` : (existingTab?.key ?? temporarySubagentTabKey(toolCallId, step));
      setActiveTab(key);
      if (childId) void loadChild(childId);
    },
    [sessionView.tools, tabsState.tabs, loadChild],
  );

  const selectAgentTab = useCallback(
    (key: string) => {
      if (key === "orchestrator") {
        setActiveTab(key);
        return;
      }
      const tab = tabsState.tabs.find((candidate) => candidate.key === key);
      if (!tab) return;
      const tool = sessionView.tools.find((candidate) => candidate.key === tab.toolCallId);
      const link = tool?.sessionLinks?.find((candidate) => candidate.step === tab.step);
      const childId =
        tab.sessionId ?? link?.childSessionId ?? (tool && tool.step === tab.step ? tool.sessionId : undefined);
      setTabsState((current) => {
        const retained = retainSubagentTab(current, tab.toolCallId, tab.step);
        return childId
          ? promoteSubagentTab(retained, {
              toolCallId: tab.toolCallId,
              childSessionId: childId,
              agent: link?.agent ?? tool?.agentName ?? tab.agent,
              ...(tab.step !== undefined ? { step: tab.step } : {}),
              ...((link?.latestMessage ?? tool?.latestMessage)
                ? { latestMessage: link?.latestMessage ?? tool?.latestMessage }
                : {}),
            })
          : retained;
      });
      setActiveTab(childId ? `session:${childId}` : key);
      if (childId) void loadChild(childId);
    },
    [tabsState.tabs, sessionView.tools, loadChild],
  );

  const closeAgentTab = useCallback((key: string) => {
    setTabsState((current) => closeSubagentTab(current, key));
    setActiveTab("orchestrator");
  }, []);

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
        const error = e instanceof Error ? e.message : String(e);
        const path = sessionPathRef.current;
        if (isUnknownSession(e) && path) {
          try {
            const dto = await openSession(path);
            sessionPathRef.current = dto.sessionFile ?? path;
            setSessionId(dto.id);
            setSubscribeEpoch((epoch) => epoch + 1);
            const snapshot = await getSnapshot(dto.id);
            if (!eventsReceivedRef.current) setSessionView(fromSnapshot(snapshot));
            await sendPrompt(dto.id, text);
            setAccepting(false);
            return;
          } catch (reopenError) {
            setStatusText(reopenError instanceof Error ? reopenError.message : String(reopenError));
          }
        }
        setAccepting(false);
        setPendingOutput(false);
        pendingBaseline.current = null;
        setStatusText(error);
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
    status === "error"
      ? "bg-v2-status-error"
      : status === "running" || sessionView.isStreaming
        ? "bg-v2-status-success"
        : "bg-v2-grey-400";
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
        home={{ active: false, onClick: onBack }}
        leading={!isMobile && <ProductMark />}
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
        <p
          className="border-b border-v2-grey-200 bg-v2-status-error/5 px-4 py-1.5 text-[13px] text-v2-status-error"
          role="alert"
        >
          {statusText}
        </p>
      )}
      <WorkMobileTabs active={mobileView} onChange={setMobileView} />
      <div ref={rowRef} className="relative flex min-h-0 flex-1 gap-2 overflow-x-clip px-2 pb-2 pt-[4px]">
        <section
          id="work-panel-chat"
          role="tabpanel"
          aria-labelledby="work-tab-chat"
          hidden={chatHidden}
          className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
        >
          <AgentTabBar
            tabs={tabsState.tabs}
            activeKey={activeTab}
            orchestratorStatus={sessionView.error !== null ? "error" : sessionView.isStreaming ? "working" : "idle"}
            onSelect={selectAgentTab}
            onClose={closeAgentTab}
            onStop={() => abort()}
          />
          {activeChildId && childErrors[activeChildId] ? (
            <p className="px-4 py-3 text-[13px] text-v2-text-text-muted">{t("work.childUnavailable")}</p>
          ) : null}
          <ChatTranscript
            messages={activeMessages}
            tools={activeTools}
            emptyHint={activeTab === "orchestrator" ? undefined : t("work.noMessagesYet")}
            pending={pendingOutput && activeTab === "orchestrator"}
            onViewDetails={activeTab === "orchestrator" ? openSubagentTool : undefined}
          />
          <footer className="shrink-0 border-t border-v2-grey-200 p-3">
            {activeTab !== "orchestrator" || sessionView.subagentName ? (
              <p className="mb-2 text-[12px] text-v2-text-text-faint">{t("work.subagentLineNote")}</p>
            ) : null}
            <ChatComposer
              disabled={accepting || activeTab !== "orchestrator" || sessionView.subagentName !== undefined}
              streaming={activeTab === "orchestrator" && sessionView.isStreaming}
              onSend={send}
              onAbort={abort}
            />
          </footer>
        </section>

        <section
          hidden={isMobile && mobileView === "chat"}
          className={`flex h-full min-w-0 w-full flex-col bg-v2-background-bg-base min-[820px]:relative min-[820px]:shrink-0 min-[820px]:w-(--panel-w) min-[820px]:rounded-[10px] min-[820px]:shadow-[var(--v2-elevation-raised)] ${
            sizing
              ? ""
              : "min-[820px]:transition-[width,opacity] min-[820px]:duration-v2-panel min-[820px]:ease-v2-panel motion-reduce:transition-none"
          } ${
            panelPhase === "open" ? "min-[820px]:opacity-100" : "min-[820px]:w-0 min-[820px]:opacity-0"
          } ${!isMobile && panelInvisible ? "invisible" : ""} ${!isMobile && !panelInteractive ? "pointer-events-none" : ""}`}
          style={{ "--panel-w": `${clampedPanelWidth}px` } as React.CSSProperties}
          aria-label={
            (isMobile ? mobileView === "agents" : panel === "agents") ? t("work.agentList") : t("work.fileBrowser")
          }
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
            <FileBrowser root={cwd} fileEvent={fileEvent} />
          </div>
          <div
            id="work-panel-agents"
            role="tabpanel"
            aria-labelledby="work-tab-agents"
            hidden={agentsHidden}
            className={`h-full min-h-0 overflow-hidden min-[820px]:rounded-[10px] ${!agentsHidden ? "animate-v2-fade-in motion-reduce:animate-none" : ""}`}
          >
            <AgentList statusByAgent={statusByAgent} sessionId={sessionId} />
          </div>
        </section>
      </div>
    </div>
  );
}
