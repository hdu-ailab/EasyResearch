import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { AlertTriangle, Check, ChevronDown, ChevronRight } from "lucide-react";
import type { SessionMessageView, ToolView } from "../session-reducer";
import { useExpandable } from "../hooks/useExpandable";

export interface ChatTranscriptProps {
  messages: SessionMessageView[];
  tools: ToolView[];
  emptyHint?: string;
  /** While true, renders a working agent row under the newest user message. */
  pending?: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  user: "You",
  assistant: "Orchestrator",
};

const STICK_THRESHOLD = 24;

/** Collapsible reasoning block; collapsed by default. */
function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { mounted, phase } = useExpandable(open);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phase === "enter" && open && typeof bodyRef.current?.scrollIntoView === "function") {
      bodyRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [phase, open]);

  return (
    <div className="flex w-full flex-col gap-1.5">
      <button
        type="button"
        className="flex items-center gap-1 text-[12px] font-medium text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <span>{open ? "Hide details" : "Show details"}</span>
        <span className="text-v2-text-text-faint/70">Thinking</span>
      </button>
      {mounted && (
        <div
          ref={bodyRef}
          className={`border-l-2 border-v2-blue-200 pl-3 ${
            phase === "enter" ? "animate-v2-expand-down" : "animate-v2-collapse-up"
          } motion-reduce:animate-none`}
        >
          <div className="v2-md text-[12.5px] text-v2-text-text-muted">
            <ReactMarkdown
              components={{
                a: ({ children }) => <span>{children}</span>,
              }}
            >
              {text}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolView }) {
  const [open, setOpen] = useState(false);
  const { mounted, phase } = useExpandable(open);
  const bodyRef = useRef<HTMLDivElement>(null);
  const statusClass = tool.done
    ? tool.error
      ? "border-v2-status-error/30 text-v2-status-error hover:bg-v2-status-error/5"
      : "border-v2-grey-200 text-v2-text-text-muted hover:bg-v2-grey-100"
    : "border-v2-blue-200 text-v2-blue-600 hover:bg-v2-blue-100/50";

  useEffect(() => {
    if (phase === "enter" && open && typeof bodyRef.current?.scrollIntoView === "function") {
      bodyRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [phase, open]);

  return (
    <li className="flex flex-col gap-1 items-start">
      <button
        type="button"
        className={`flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors ${statusClass}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {tool.running ? <span className="v2-spinner" aria-hidden /> : null}
        {tool.done && !tool.error ? <Check size={13} aria-hidden /> : null}
        {tool.error ? <AlertTriangle size={13} aria-hidden /> : null}
        <span className="truncate">
          {tool.running ? "Running tool: " : ""}
          {tool.name}
          {tool.args ? <span className="text-v2-text-text-faint"> {tool.args}</span> : null}
        </span>
        {open ? (
          <ChevronDown size={12} aria-hidden />
        ) : (
          <ChevronRight size={12} aria-hidden />
        )}
      </button>
      {mounted && (
        <div
          ref={bodyRef}
          className={`max-h-64 w-full overflow-y-auto rounded-md border border-v2-grey-200 bg-v2-background-bg-deep px-3 py-2 ${
            phase === "enter" ? "animate-v2-expand-down" : "animate-v2-collapse-up"
          } motion-reduce:animate-none`}
        >
          {tool.output ? (
            <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-v2-text-text-muted">
              {tool.output}
            </pre>
          ) : tool.running ? (
            <p className="text-[12px] text-v2-text-text-faint">Running…</p>
          ) : (
            <p className="text-[12px] text-v2-text-text-faint">No output.</p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Streaming chat transcript. Each message is a stable row keyed by the
 * reducer's message key; streaming text updates in place. Reasoning renders
 * as a collapsed "Thinking" block; tool executions render as collapsible
 * rows below the messages. The list pins to the bottom while the user stays
 * at the bottom; any manual scroll away unpins it, and returning to the
 * bottom re-pins.
 */
export function ChatTranscript({ messages, tools, emptyHint = "Send a message to start.", pending = false }: ChatTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, tools, pending]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" aria-label="Conversation" onScroll={onScroll}>
      {messages.length === 0 && tools.length === 0 && !pending && (
        <p className="px-4 pt-6 text-center text-[13px] text-v2-text-text-faint">{emptyHint}</p>
      )}
      <ul className="mx-auto flex w-full max-w-[1000px] flex-col gap-3 p-4 md:max-w-200 2xl:max-w-[1000px]">
        {messages.map((message) => (
          <li key={message.key} className={`flex flex-col gap-1 ${message.role === "user" ? "items-end" : "items-start"}`}>
            <span className="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">
              {ROLE_LABELS[message.role] ?? message.role}
            </span>
            {message.reasoning ? <ReasoningBlock text={message.reasoning} /> : null}
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
        {pending && (
          <li className="flex flex-col items-start gap-1" aria-label="Working">
            <span className="text-[11px] font-medium uppercase tracking-wide text-v2-text-text-faint">Orchestrator</span>
            <div className="v2-md flex items-center gap-2 rounded-lg bg-v2-background-bg-deep px-3 py-2 text-[13px] text-v2-text-text-base">
              <span className="v2-spinner" aria-hidden />
              <span className="text-[12px] text-v2-text-text-faint">Working…</span>
              <span className="v2-caret" aria-hidden />
            </div>
          </li>
        )}
        {tools.map((tool) => (
          <ToolRow key={tool.key} tool={tool} />
        ))}
      </ul>
    </div>
  );
}
