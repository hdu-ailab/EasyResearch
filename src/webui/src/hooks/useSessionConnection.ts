import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveSessionDto,
  SessionSnapshotDto,
  SubagentSupervisorEventDto,
  TreeNavigationOptionsDto,
  TreeNavigationResultDto,
} from "../../../web/contracts";
import {
  abortSession,
  connectSessionEvents,
  getSnapshot,
  isUnknownSession,
  navigateSessionTree,
  openSession,
  sendPrompt,
} from "../api";
import {
  parseApiUsageChangedEvent,
  parseCompactionStateChangedEvent,
  parseRuntimeConfigurationAppliedEvent,
  parseSessionActivityChangedEvent,
  parseSessionSnapshot,
  parseSessionStatsChangedEvent,
  parseSubagentSupervisorEvent,
} from "../api/parsers";
import { useI18n } from "../i18n/useI18n";
import {
  emptyState,
  fromSnapshot,
  mergeSnapshot,
  reduceSessionEvent,
  reduceSubagentSupervisorEvent,
  replaceApiUsageStatistics,
  type SessionViewState,
  terminateSessionRun,
} from "../session-reducer";

export interface UseSessionConnectionOptions {
  initialSessionId: string;
  cwd: string;
  onEvent?: (event: unknown) => boolean;
  onSupervisorEvent?: (event: SubagentSupervisorEventDto) => void;
}

export interface SessionConnection {
  sessionId: string;
  sessionPath: string | null;
  fileWatchLeaseId: string | null;
  view: SessionViewState;
  status: ActiveSessionDto["status"];
  notice: string | null;
  accepting: boolean;
  pendingOutput: boolean;
  send(text: string): Promise<void>;
  abort(): Promise<void>;
  /** Move the session leaf to an entry in place, then refresh the view. */
  navigateTree(entryId: string, options?: TreeNavigationOptionsDto): Promise<TreeNavigationResultDto>;
  setView: Dispatch<SetStateAction<SessionViewState>>;
}

interface PendingStreamReady {
  sessionId: string;
  connectionGeneration: number;
  operation: GenerationToken;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface GenerationToken {
  generation: number;
  active: boolean;
}

interface ConnectionToken extends GenerationToken {
  receivedStreamData: boolean;
}

interface ConnectionTarget {
  sessionId: string;
  generation: number;
}

const OPERATION_CANCELLED = new Error("Session operation cancelled");

type SnapshotEvent = Omit<SessionSnapshotDto, "subagents"> & {
  type: "snapshot";
  subagents?: SessionSnapshotDto["subagents"];
};

function isSnapshotEvent(event: unknown): event is SnapshotEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Partial<SnapshotEvent>;
  return value.type === "snapshot" && Boolean(value.session) && Array.isArray(value.timeline);
}

function eventType(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function isAgentSessionEvent(event: unknown): event is AgentSessionEvent {
  return [
    "agent_start",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "agent_settled",
    "queue_update",
    "auto_retry_start",
    "auto_retry_end",
    "session_info_changed",
    "entry_appended",
    "timeline_entry_appended",
  ].includes(eventType(event) ?? "");
}

function assistantOutputCount(view: SessionViewState): number {
  let count = view.tools.length;
  for (const message of view.messages) if (message.role !== "user") count += 1;
  return count;
}

function freshEmptyState(): SessionViewState {
  return { ...emptyState, messages: [], tools: [] };
}

export function useSessionConnection(options: UseSessionConnectionOptions): SessionConnection {
  const { initialSessionId, onEvent, onSupervisorEvent } = options;
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onSupervisorEventRef = useRef(onSupervisorEvent);
  onSupervisorEventRef.current = onSupervisorEvent;
  const [view, setView] = useState<SessionViewState>(freshEmptyState);
  const viewRef = useRef(view);
  viewRef.current = view;
  const rootStreamingRef = useRef(false);
  const [status, setStatus] = useState<ActiveSessionDto["status"]>("starting");
  const generationRef = useRef(1);
  const [connectionTarget, setConnectionTarget] = useState<ConnectionTarget>({
    sessionId: initialSessionId,
    generation: 1,
  });
  const sessionId = connectionTarget.sessionId;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const sessionPathRef = useRef<string | null>(null);
  const [fileWatchLeaseId, setFileWatchLeaseId] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [pendingOutput, setPendingOutput] = useState(false);
  const pendingBaseline = useRef<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const connectionTokenRef = useRef<ConnectionToken | null>(null);
  const sendOperationRef = useRef<GenerationToken | null>(null);
  const pendingStreamReadyRef = useRef<PendingStreamReady | null>(null);
  const runGenerationRef = useRef(0);

  const nextGeneration = useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  const isCurrentOperation = useCallback(
    (operation: GenerationToken) => mountedRef.current && operation.active && sendOperationRef.current === operation,
    [],
  );

  const rejectPendingStream = useCallback((error: Error, operation?: GenerationToken) => {
    const pending = pendingStreamReadyRef.current;
    if (!pending || (operation && pending.operation !== operation)) return;
    pendingStreamReadyRef.current = null;
    pending.reject(error);
  }, []);

  const cancelOperation = useCallback(
    (operation: GenerationToken | null) => {
      if (!operation?.active) return;
      operation.active = false;
      rejectPendingStream(OPERATION_CANCELLED, operation);
      if (sendOperationRef.current === operation) sendOperationRef.current = null;
    },
    [rejectPendingStream],
  );

  const updateSessionPath = useCallback((path: string | null) => {
    sessionPathRef.current = path;
    setSessionPath(path);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelOperation(sendOperationRef.current);
    };
  }, [cancelOperation]);

  const clearRootRun = useCallback(() => {
    rootStreamingRef.current = false;
    cancelOperation(sendOperationRef.current);
    setAccepting(false);
    setPendingOutput(false);
    pendingBaseline.current = null;
    setView((current) => terminateSessionRun(current));
  }, [cancelOperation]);

  useEffect(() => {
    const connectionToken: ConnectionToken = {
      generation: connectionTarget.generation,
      active: true,
      receivedStreamData: false,
    };
    connectionTokenRef.current = connectionToken;
    setFileWatchLeaseId(null);
    const isCurrentConnection = () =>
      mountedRef.current && connectionToken.active && connectionTokenRef.current === connectionToken;
    getSnapshot(sessionId)
      .then((snapshot) => {
        if (!isCurrentConnection()) return;
        updateSessionPath(snapshot.session.sessionFile ?? null);
        if (connectionToken.receivedStreamData) return;
        rootStreamingRef.current = snapshot.session.isStreaming;
        setStatus(snapshot.session.status);
        setView(fromSnapshot(snapshot, viewRef.current.hydrationRevision + 1));
      })
      .catch((error: unknown) => {
        if (!isCurrentConnection() || connectionToken.receivedStreamData) return;
        setStatus("error");
        setNotice(error instanceof Error ? error.message : String(error));
      });
    const unsubscribe = connectSessionEvents(sessionId, {
      onEvent: (event) => {
        if (!isCurrentConnection()) return;
        const hadReceivedStreamData = connectionToken.receivedStreamData;
        connectionToken.receivedStreamData = true;
        setNotice((current) => (current === tRef.current("work.connectionLost") ? null : current));
        if (eventType(event) === "session_activity_changed") {
          try {
            const activity = parseSessionActivityChangedEvent(event);
            setStatus(activity.status);
            if (activity.isStreaming && !rootStreamingRef.current) {
              rootStreamingRef.current = true;
              runGenerationRef.current += 1;
              setView((current) => ({ ...current, isStreaming: true }));
            } else if (!activity.isStreaming && rootStreamingRef.current) {
              clearRootRun();
            }
          } catch {
            connectionToken.receivedStreamData = hadReceivedStreamData;
          }
          return;
        }
        if (eventType(event) === "subagent_supervisor") {
          let supervisorEvent: SubagentSupervisorEventDto;
          try {
            supervisorEvent = parseSubagentSupervisorEvent(event);
          } catch {
            return;
          }
          if (supervisorEvent.ownerSessionId === sessionId) {
            setView((current) => reduceSubagentSupervisorEvent(current, supervisorEvent));
          }
          onSupervisorEventRef.current?.(supervisorEvent);
          return;
        }
        if (eventType(event) === "session_stats_changed") {
          try {
            const stats = parseSessionStatsChangedEvent(event);
            setView((current) => {
              if (stats.contextUsage !== undefined) {
                return {
                  ...current,
                  contextUsage: stats.contextUsage,
                  compactionPolicy: stats.compactionPolicy,
                };
              }
              const { contextUsage: _previous, ...next } = current;
              return { ...next, compactionPolicy: stats.compactionPolicy };
            });
          } catch {
            // Ignore malformed SSE frames and retain the last valid state.
          }
          return;
        }
        if (eventType(event) === "api_usage_changed") {
          try {
            const usage = parseApiUsageChangedEvent(event);
            setView((current) => replaceApiUsageStatistics(current, usage.statistics));
          } catch {
            // Ignore malformed SSE frames and retain the last valid projection.
          }
          return;
        }
        if (eventType(event) === "compaction_state_changed") {
          try {
            const compaction = parseCompactionStateChangedEvent(event);
            setView((current) => ({ ...current, compactionState: compaction.state }));
          } catch {
            // Ignore malformed SSE frames and retain the last valid state.
          }
          return;
        }
        if (eventType(event) === "runtime_configuration_applied") {
          try {
            const applied = parseRuntimeConfigurationAppliedEvent(event);
            setView((current) => reduceSessionEvent(current, applied));
          } catch {
            // Ignore malformed SSE frames and retain the last applied generation.
            connectionToken.receivedStreamData = hadReceivedStreamData;
          }
          return;
        }
        if (eventType(event) === "compaction_end") {
          const errorMessage = (event as { errorMessage?: unknown }).errorMessage;
          if (typeof errorMessage === "string" && errorMessage) setNotice(errorMessage);
          return;
        }
        if (onEventRef.current?.(event)) return;
        if (isSnapshotEvent(event)) {
          let snapshot: SessionSnapshotDto;
          try {
            snapshot = parseSessionSnapshot({ ...event, subagents: event.subagents ?? [] });
          } catch {
            // A malformed reconnect frame cannot replace the last valid snapshot.
            connectionToken.receivedStreamData = hadReceivedStreamData;
            return;
          }
          const pending = pendingStreamReadyRef.current;
          if (
            pending?.sessionId === sessionId &&
            pending.connectionGeneration === connectionToken.generation &&
            pending.operation.active
          ) {
            pendingStreamReadyRef.current = null;
            pending.resolve();
          }
          if (typeof snapshot.session.sessionFile === "string") updateSessionPath(snapshot.session.sessionFile);
          setFileWatchLeaseId(snapshot.fileWatchLeaseId ?? null);
          rootStreamingRef.current = snapshot.session.isStreaming;
          setStatus(snapshot.session.status);
          setView((current) => mergeSnapshot(current, snapshot));
          return;
        }
        const type = eventType(event);
        if (type === "error") {
          const pending = pendingStreamReadyRef.current;
          if (pending?.connectionGeneration === connectionToken.generation) {
            const error = (event as { error?: unknown }).error;
            rejectPendingStream(new Error(typeof error === "string" ? error : "Session stream failed"));
          }
          clearRootRun();
          setStatus("error");
          return;
        }
        if (type === "session_deactivated") {
          setFileWatchLeaseId(null);
          clearRootRun();
          setStatus("stopped");
          return;
        }
        if (isAgentSessionEvent(event)) {
          if (type === "agent_start") {
            if (!rootStreamingRef.current) runGenerationRef.current += 1;
            rootStreamingRef.current = true;
            setStatus("running");
          }
          if (type === "agent_settled") {
            clearRootRun();
            return;
          }
          setView((current) => reduceSessionEvent(current, event));
        }
      },
      onError: () => {
        if (!isCurrentConnection()) return;
        setFileWatchLeaseId(null);
        const message = tRef.current("work.connectionLost");
        if (pendingStreamReadyRef.current?.connectionGeneration === connectionToken.generation) {
          rejectPendingStream(new Error(message));
        }
        setNotice(message);
      },
    });
    return () => {
      connectionToken.active = false;
      if (connectionTokenRef.current === connectionToken) connectionTokenRef.current = null;
      if (pendingStreamReadyRef.current?.connectionGeneration === connectionToken.generation) {
        rejectPendingStream(OPERATION_CANCELLED);
      }
      unsubscribe();
    };
  }, [clearRootRun, connectionTarget.generation, rejectPendingStream, sessionId, updateSessionPath]);

  const send = useCallback(
    async (text: string) => {
      // While a run is active, the message is queued as a steer (ADR-083):
      // POST with no accepting/pendingOutput lifecycle, since the run owns
      // the stream. When idle, run the full prompt lifecycle below.
      if (rootStreamingRef.current) {
        try {
          setNotice(null);
          await sendPrompt(sessionId, text);
        } catch (error: unknown) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      cancelOperation(sendOperationRef.current);
      runGenerationRef.current += 1;
      const operation: GenerationToken = { generation: nextGeneration(), active: true };
      sendOperationRef.current = operation;
      setAccepting(true);
      setNotice(null);
      pendingBaseline.current = assistantOutputCount(viewRef.current);
      setPendingOutput(true);
      try {
        await sendPrompt(sessionId, text);
        if (!isCurrentOperation(operation)) return;
        setAccepting(false);
        operation.active = false;
        sendOperationRef.current = null;
      } catch (error: unknown) {
        if (!isCurrentOperation(operation)) return;
        const message = error instanceof Error ? error.message : String(error);
        const path = sessionPathRef.current;
        if (isUnknownSession(error) && path) {
          try {
            const dto = await openSession(path);
            if (!isCurrentOperation(operation)) return;
            updateSessionPath(dto.sessionFile ?? path);
            sessionIdRef.current = dto.id;
            const connectionGeneration = nextGeneration();
            const streamReady = new Promise<void>((resolve, reject) => {
              pendingStreamReadyRef.current = {
                sessionId: dto.id,
                connectionGeneration,
                operation,
                resolve,
                reject,
              };
            });
            if (connectionTokenRef.current) connectionTokenRef.current.active = false;
            setConnectionTarget({ sessionId: dto.id, generation: connectionGeneration });
            await streamReady;
            if (!isCurrentOperation(operation)) return;
            await sendPrompt(dto.id, text);
            if (!isCurrentOperation(operation)) return;
            setAccepting(false);
            operation.active = false;
            sendOperationRef.current = null;
            return;
          } catch (reopenError: unknown) {
            if (!isCurrentOperation(operation)) return;
            setAccepting(false);
            setPendingOutput(false);
            pendingBaseline.current = null;
            setNotice(reopenError instanceof Error ? reopenError.message : String(reopenError));
            operation.active = false;
            sendOperationRef.current = null;
            return;
          }
        }
        if (!isCurrentOperation(operation)) return;
        setAccepting(false);
        setPendingOutput(false);
        pendingBaseline.current = null;
        setNotice(message);
        operation.active = false;
        sendOperationRef.current = null;
      }
    },
    [cancelOperation, isCurrentOperation, nextGeneration, sessionId, updateSessionPath],
  );

  useEffect(() => {
    if (!pendingOutput || pendingBaseline.current === null) return;
    if (view.isStreaming || assistantOutputCount(view) > pendingBaseline.current) {
      setPendingOutput(false);
      pendingBaseline.current = null;
    }
  }, [pendingOutput, view]);

  const abort = useCallback(async () => {
    const targetSessionId = sessionIdRef.current;
    const connectionGeneration = connectionTokenRef.current?.generation;
    const runGeneration = runGenerationRef.current;
    const ownsAbort = () =>
      mountedRef.current &&
      sessionIdRef.current === targetSessionId &&
      connectionTokenRef.current?.generation === connectionGeneration &&
      runGenerationRef.current === runGeneration;
    cancelOperation(sendOperationRef.current);
    if (mountedRef.current) {
      setAccepting(false);
      setPendingOutput(false);
      pendingBaseline.current = null;
    }
    try {
      await abortSession(targetSessionId);
      if (!ownsAbort()) return;
      clearRootRun();
    } catch (error: unknown) {
      if (!ownsAbort()) return;
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [cancelOperation, clearRootRun]);

  const navigateTree = useCallback(
    async (entryId: string, options: TreeNavigationOptionsDto = {}) => {
      const result = await navigateSessionTree(sessionIdRef.current, entryId, options);
      const snapshot = await getSnapshot(sessionIdRef.current);
      if (!mountedRef.current) return result;
      updateSessionPath(snapshot.session.sessionFile ?? null);
      rootStreamingRef.current = snapshot.session.isStreaming;
      setStatus(snapshot.session.status);
      setView((current) => mergeSnapshot(current, snapshot));
      return result;
    },
    [updateSessionPath],
  );

  return {
    sessionId,
    sessionPath,
    fileWatchLeaseId,
    view,
    status,
    notice,
    accepting,
    pendingOutput,
    send,
    abort,
    navigateTree,
    setView,
  };
}
