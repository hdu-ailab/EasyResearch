import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import type { ActiveSessionDto, SessionSnapshotDto } from "../../../web/contracts";
import { abortSession, connectSessionEvents, getSnapshot, isUnknownSession, openSession, sendPrompt } from "../api";
import { useI18n } from "../i18n/useI18n";
import { emptyState, fromSnapshot, mergeSnapshot, reduceSessionEvent, type SessionViewState } from "../session-reducer";

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
  setView: Dispatch<SetStateAction<SessionViewState>>;
}

interface PendingStreamReady {
  sessionId: string;
  generation: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

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
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [sessionPath, setSessionPath] = useState<string | null>(null);
  const sessionPathRef = useRef<string | null>(null);
  const [subscribeEpoch, setSubscribeEpoch] = useState(0);
  const [accepting, setAccepting] = useState(false);
  const [pendingOutput, setPendingOutput] = useState(false);
  const pendingBaseline = useRef<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const eventsReceivedRef = useRef(false);
  const streamGenerationRef = useRef(0);
  const pendingStreamReadyRef = useRef<PendingStreamReady | null>(null);

  const updateSessionPath = useCallback((path: string | null) => {
    sessionPathRef.current = path;
    setSessionPath(path);
  }, []);

  const hydrate = useCallback(
    async (targetId: string) => {
      const snapshot = await getSnapshot(targetId);
      updateSessionPath(snapshot.session.sessionFile ?? null);
      setSessionId(snapshot.session.id);
      setStatus(snapshot.session.status);
      return snapshot;
    },
    [updateSessionPath],
  );

  useEffect(() => {
    void subscribeEpoch;
    let active = true;
    const connectionGeneration = ++streamGenerationRef.current;
    eventsReceivedRef.current = false;
    hydrate(sessionId)
      .then((snapshot) => {
        if (active && !eventsReceivedRef.current) setView(fromSnapshot(snapshot));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStatus("error");
        setNotice(error instanceof Error ? error.message : String(error));
      });
    const unsubscribe = connectSessionEvents(sessionId, {
      onEvent: (event) => {
        eventsReceivedRef.current = true;
        setNotice((current) => (current === tRef.current("work.connectionLost") ? null : current));
        if (onEventRef.current?.(event)) return;
        if (isSnapshotEvent(event)) {
          const pending = pendingStreamReadyRef.current;
          if (pending?.sessionId === sessionId && pending.generation === connectionGeneration) {
            pendingStreamReadyRef.current = null;
            pending.resolve();
          }
          if (typeof event.session.sessionFile === "string") updateSessionPath(event.session.sessionFile);
          setView((current) => mergeSnapshot(current, { ...event, subagents: event.subagents ?? [] }));
          return;
        }
        const type = eventType(event);
        if (type === "error") {
          const pending = pendingStreamReadyRef.current;
          if (pending?.sessionId === sessionId && pending.generation === connectionGeneration) {
            pendingStreamReadyRef.current = null;
            const error = (event as { error?: unknown }).error;
            pending.reject(new Error(typeof error === "string" ? error : "Session stream failed"));
          }
          return;
        }
        if (type === "session_deactivated") return;
        if (isAgentSessionEvent(event)) setView((current) => reduceSessionEvent(current, event));
      },
      onError: () => setNotice(tRef.current("work.connectionLost")),
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [hydrate, sessionId, subscribeEpoch, updateSessionPath]);

  const send = useCallback(
    async (text: string) => {
      setAccepting(true);
      setNotice(null);
      pendingBaseline.current = assistantOutputCount(viewRef.current);
      setPendingOutput(true);
      try {
        await sendPrompt(sessionId, text);
        setAccepting(false);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const path = sessionPathRef.current;
        if (isUnknownSession(error) && path) {
          try {
            const dto = await openSession(path);
            updateSessionPath(dto.sessionFile ?? path);
            const generation = streamGenerationRef.current + 1;
            const streamReady = new Promise<void>((resolve, reject) => {
              pendingStreamReadyRef.current = {
                sessionId: dto.id,
                generation,
                resolve,
                reject: (streamError) => reject(streamError),
              };
            });
            if (dto.id === sessionId) setSubscribeEpoch((epoch) => epoch + 1);
            else setSessionId(dto.id);
            const snapshot = await getSnapshot(dto.id);
            setView(fromSnapshot(snapshot));
            await streamReady;
            await sendPrompt(dto.id, text);
            setAccepting(false);
            return;
          } catch (reopenError: unknown) {
            setNotice(reopenError instanceof Error ? reopenError.message : String(reopenError));
          }
        }
        setAccepting(false);
        setPendingOutput(false);
        pendingBaseline.current = null;
        setNotice(message);
      }
    },
    [sessionId, updateSessionPath],
  );

  useEffect(() => {
    if (!pendingOutput || pendingBaseline.current === null) return;
    if (view.isStreaming || assistantOutputCount(view) > pendingBaseline.current) {
      setPendingOutput(false);
      pendingBaseline.current = null;
    }
  }, [pendingOutput, view]);

  const abort = useCallback(async () => {
    try {
      await abortSession(sessionId);
      setView((current) => ({ ...current, isStreaming: false }));
      setStatus("ready");
      setPendingOutput(false);
      pendingBaseline.current = null;
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [sessionId]);

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
    setView,
  };
}
