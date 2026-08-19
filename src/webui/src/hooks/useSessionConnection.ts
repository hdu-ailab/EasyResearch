import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import type { ActiveSessionDto, SessionSnapshotDto } from "../../../web/contracts";
import {
  abortSession,
  connectSessionEvents,
  getSnapshot,
  isUnknownSession,
  navigateSessionTree,
  openSession,
  sendPrompt,
} from "../api";
import { useI18n } from "../i18n/useI18n";
import {
  emptyState,
  fromSnapshot,
  mergeSnapshot,
  reduceSessionEvent,
  type SessionViewState,
  terminateSessionRun,
} from "../session-reducer";

export interface UseSessionConnectionOptions {
  initialSessionId: string;
  cwd: string;
  onEvent?: (event: unknown) => boolean;
}

export interface SessionConnection {
  sessionId: string;
  sessionPath: string | null;
  view: SessionViewState;
  status: ActiveSessionDto["status"];
  notice: string | null;
  accepting: boolean;
  pendingOutput: boolean;
  send(text: string): Promise<void>;
  abort(): Promise<void>;
  /** Move the session leaf to an entry in place, then refresh the view. */
  navigateTree(entryId: string): Promise<void>;
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
  return value.type === "snapshot" && Boolean(value.session) && Array.isArray(value.messages);
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
  const { initialSessionId, onEvent } = options;
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const [view, setView] = useState<SessionViewState>(freshEmptyState);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [status, setStatus] = useState<ActiveSessionDto["status"]>("starting");
  const statusRef = useRef<ActiveSessionDto["status"]>(status);
  statusRef.current = status;
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

  const clearTerminalState = useCallback(
    (nextStatus: ActiveSessionDto["status"]) => {
      cancelOperation(sendOperationRef.current);
      setAccepting(false);
      setPendingOutput(false);
      pendingBaseline.current = null;
      setView((current) => terminateSessionRun(current));
      setStatus(nextStatus);
    },
    [cancelOperation],
  );

  useEffect(() => {
    const connectionToken: ConnectionToken = {
      generation: connectionTarget.generation,
      active: true,
      receivedStreamData: false,
    };
    connectionTokenRef.current = connectionToken;
    const isCurrentConnection = () =>
      mountedRef.current && connectionToken.active && connectionTokenRef.current === connectionToken;
    getSnapshot(sessionId)
      .then((snapshot) => {
        if (!isCurrentConnection()) return;
        updateSessionPath(snapshot.session.sessionFile ?? null);
        if (connectionToken.receivedStreamData) return;
        setStatus(snapshot.session.status);
        setView(fromSnapshot(snapshot));
      })
      .catch((error: unknown) => {
        if (!isCurrentConnection() || connectionToken.receivedStreamData) return;
        setStatus("error");
        setNotice(error instanceof Error ? error.message : String(error));
      });
    const unsubscribe = connectSessionEvents(sessionId, {
      onEvent: (event) => {
        if (!isCurrentConnection()) return;
        connectionToken.receivedStreamData = true;
        setNotice((current) => (current === tRef.current("work.connectionLost") ? null : current));
        if (onEventRef.current?.(event)) return;
        if (isSnapshotEvent(event)) {
          const pending = pendingStreamReadyRef.current;
          if (
            pending?.sessionId === sessionId &&
            pending.connectionGeneration === connectionToken.generation &&
            pending.operation.active
          ) {
            pendingStreamReadyRef.current = null;
            pending.resolve();
          }
          if (typeof event.session.sessionFile === "string") updateSessionPath(event.session.sessionFile);
          setStatus(event.session.status);
          setView((current) => mergeSnapshot(current, { ...event, subagents: event.subagents ?? [] }));
          return;
        }
        const type = eventType(event);
        if (type === "error") {
          const pending = pendingStreamReadyRef.current;
          if (pending?.connectionGeneration === connectionToken.generation) {
            const error = (event as { error?: unknown }).error;
            rejectPendingStream(new Error(typeof error === "string" ? error : "Session stream failed"));
          }
          clearTerminalState("error");
          return;
        }
        if (type === "session_deactivated") {
          clearTerminalState("stopped");
          return;
        }
        if (isAgentSessionEvent(event)) {
          if (type === "agent_start") {
            runGenerationRef.current += 1;
            setStatus("running");
          }
          if (type === "agent_settled") {
            clearTerminalState("ready");
            return;
          }
          setView((current) => reduceSessionEvent(current, event));
        }
      },
      onError: () => {
        if (!isCurrentConnection()) return;
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
  }, [clearTerminalState, connectionTarget.generation, rejectPendingStream, sessionId, updateSessionPath]);

  const send = useCallback(
    async (text: string) => {
      // While a run is active, the message is queued as a steer (ADR-083):
      // POST with no accepting/pendingOutput lifecycle, since the run owns
      // the stream. When idle, run the full prompt lifecycle below.
      if (statusRef.current === "running") {
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
      clearTerminalState("ready");
    } catch (error: unknown) {
      if (!ownsAbort()) return;
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [cancelOperation, clearTerminalState]);

  const navigateTree = useCallback(
    async (entryId: string) => {
      await navigateSessionTree(sessionIdRef.current, entryId);
      const snapshot = await getSnapshot(sessionIdRef.current);
      if (!mountedRef.current) return;
      updateSessionPath(snapshot.session.sessionFile ?? null);
      setStatus(snapshot.session.status);
      setView((current) => mergeSnapshot(current, snapshot));
    },
    [updateSessionPath],
  );

  return {
    sessionId,
    sessionPath,
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
