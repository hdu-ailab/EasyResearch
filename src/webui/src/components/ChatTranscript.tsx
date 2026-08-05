import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { AlertTriangle, Check, ChevronDown } from "lucide-react";
import type { SessionMessageView, ToolView } from "../session-reducer";

export interface ChatTranscriptProps {
  messages: SessionMessageView[];
  tools: ToolView[];
  emptyHint?: string;
}

const ROLE_LABELS: Record<string, string> = {
  user: "You",
  assistant: "Orchestrator",
};

function ToolRow({ tool }: { tool: ToolView }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors ${
          tool.done
            ? tool.error
              ? "border-v2-status-error/30 text-v2-status-error hover:bg-v2-status-error/5"
              : "border-v2-grey-200 text-v2-text-text-muted hover:bg-v2-grey-100"
            : "border-v2-blue-200 text-v2-blue-600 hover:bg-v2-blue-100/50"
        }`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {tool.running ? <span className="v2-spinner" aria-hidden /> : null}
        {tool.done && !tool.error ? <Check size={13} aria-hidden /> : null}
        {tool.error ? <AlertTriangle size={13} aria-hidden /> : null}
        <span>
          {tool.running ? "Running tool: " : ""}
          {tool.name}
        </span>
        <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
    </li>
  );
}

/**
 * Streaming chat transcript. Each message is a stable row keyed by the
 * reducer's message key; streaming text updates in place. Tool executions
 * render as collapsible rows below the messages.
 */
export function ChatTranscript({ messages, tools, emptyHint = "Send a message to start." }: ChatTranscriptProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversation">
      {messages.length === 0 && tools.length === 0 && (
        <p className="px-4 pt-6 text-center text-[13px] text-v2-text-text-faint">{emptyHint}</p>
      )}
      <ul className="mx-auto flex w-full max-w-[1000px] flex-col gap-3 p-4 md:max-w-200 2xl:max-w-[1000px]">
        {messages.map((message) => (
          <li key={message.key} className={`flex flex-col gap-1 ${message.role === "user" ? "items-end" : "items-start"}`}>
            <span className="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">
              {ROLE_LABELS[message.role] ?? message.role}
            </span>
            {message.role === "assistant" || message.role === "user" ? (
              <div
                className={`v2-md max-w-full rounded-lg px-3 py-2 text-[13px] ${
                  message.role === "user" ? "bg-v2-blue-100/60 text-v2-text-text-base" : "bg-v2-background-bg-deep text-v2-text-text-base"
                } ${message.error ? "text-v2-status-error" : ""}`}
              >
                <ReactMarkdown
                  components={{
                    a: ({ children }) => <span>{children}</span>,
                  }}
                >
                  {message.text}
                </ReactMarkdown>
                {message.streaming && <span className="v2-caret" aria-hidden />}
              </div>
            ) : (
              <span
                className={`rounded-md px-2 py-1 font-mono text-[12px] ${
                  message.error ? "text-v2-status-error" : "text-v2-text-text-muted"
                }`}
              >
                {message.text}
                {message.streaming && <span className="v2-caret" aria-hidden />}
              </span>
            )}
          </li>
        ))}
        {tools.map((tool) => (
          <ToolRow key={tool.key} tool={tool} />
        ))}
      </ul>
    </div>
  );
}
