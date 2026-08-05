import { useEffect, useState } from "react";

interface AgentEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * Work page: fixed orchestrator chat tab + dynamic subagent tabs.
 *
 * MVP: shows the orchestrator chat tab wired to a live SSE stream of session
 * events. Dynamic subagent tabs and file browsing land with the full webui
 * spec in .docs/webui.md.
 */
export function WorkPage({ id, cwd, onBack }: { id: string; cwd: string; onBack: () => void }) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
    es.onmessage = (e) => {
      try {
        setEvents((prev) => [...prev.slice(-200), JSON.parse(e.data)]);
      } catch {
        /* ignore malformed */
      }
    };
    return () => es.close();
  }, []);

  const send = () => {
    if (!input.trim()) return;
    setInput("");
  };

  return (
    <div>
      <button onClick={onBack}>← Back</button>
      <h1>Orchestrator</h1>
      <p>
        Project: <code>{cwd}</code>
      </p>
      <div>
        <h2>Tabs</h2>
        <p>
          [orchestrator] <em>fixed</em>
        </p>
      </div>
      <div style={{ whiteSpace: "pre-wrap", maxHeight: 400, overflow: "auto" }}>
        {events.map((ev, i) => (
          <div key={i}>{JSON.stringify(ev)}</div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          placeholder="Message the orchestrator…"
          disabled
        />
        <button disabled>Send (MVP placeholder)</button>
      </form>
    </div>
  );
}
