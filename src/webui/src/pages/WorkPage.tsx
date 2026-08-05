import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { abortSession, connectSessionEvents, getSnapshot, restartSession, sendPrompt, stopSession } from "../api";
import { fromSnapshot, reduceSessionEvent, type SessionViewState } from "../session-reducer";
import { ChatTranscript } from "../components/ChatTranscript";
import { ChatComposer } from "../components/ChatComposer";

export interface WorkPageProps {
  id: string;
  cwd: string;
  onBack: () => void;
}

export function WorkPage({ id, cwd, onBack }: WorkPageProps) {
  const [view, setView] = useState<SessionViewState>({ messages: [], isStreaming: false, activity: null, error: null });
  const [status, setStatus] = useState<string>("starting");
  const [sessionId, setSessionId] = useState(id);
  const [accepting, setAccepting] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);

  const hydrate = useCallback(async (targetId: string) => {
    const snapshot = await getSnapshot(targetId);
    setSessionId(snapshot.session.id);
    setView(fromSnapshot(snapshot));
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
      onEvent: (event) => setView((prev) => reduceSessionEvent(prev, event as Parameters<typeof reduceSessionEvent>[1])),
      onError: () => setStatusText("Connection lost — events will resume when the browser reconnects."),
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [id, hydrate]);

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
      setView((prev) => ({ ...prev, isStreaming: false }));
      setStatus("ready");
    } catch (e) {
      setStatusText(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  const stop = useCallback(async () => {
    if (!window.confirm("Stop this session? It can be resumed later from the home page.")) return;
    setStatusText(null);
    try {
      await stopSession(sessionId);
      setView((prev) => ({ ...prev, isStreaming: false }));
      setStatus("stopped");
    } catch (e) {
      setStatusText(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId]);

  const restart = useCallback(async () => {
    setStatusText(null);
    setStatus("starting");
    try {
      const dto = await restartSession(sessionId);
      await hydrate(dto.id);
    } catch (e) {
      setStatus("error");
      setStatusText(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId, hydrate]);

  return (
    <main className="work-page">
      <header className="work-page__header">
        <button className="icon-button" aria-label="Back to home" title="Back to home" onClick={onBack}>
          <ArrowLeft size={16} />
        </button>
        <div className="work-page__identity">
          <h1 className="work-page__title">Orchestrator</h1>
          <p className="work-page__cwd" title={cwd}>{cwd}</p>
        </div>
        <span className={`status-pill status-pill--${status}`}>{status}</span>
        <button className="button button--ghost" aria-label="Stop session" title="Stop this session" onClick={stop}>
          Stop
        </button>
      </header>
      {statusText && <p className="work-page__status-text" role="alert">{statusText}</p>}
      <ChatTranscript messages={view.messages} activity={view.activity} />
      <footer className="work-page__footer">
        <ChatComposer
          disabled={accepting}
          streaming={view.isStreaming}
          onSend={send}
          onAbort={abort}
          onRestart={restart}
        />
      </footer>
    </main>
  );
}
