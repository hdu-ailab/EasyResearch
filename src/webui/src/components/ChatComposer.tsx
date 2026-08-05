import { useState } from "react";
import { RotateCcw, Send, Square } from "lucide-react";

export interface ChatComposerProps {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  onRestart: () => void;
}

/**
 * Chat composer. Send is disabled while a request is being accepted; while
 * the agent is streaming the primary action becomes Abort (steering is not
 * part of the MVP backend). Multiline input is preserved.
 */
export function ChatComposer({ disabled, streaming, onSend, onAbort, onRestart }: ChatComposerProps) {
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText("");
    onSend(trimmed);
  };

  return (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        className="chat-composer__input"
        aria-label="Message"
        placeholder="Describe the paper you want to write…"
        rows={2}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="chat-composer__actions">
        <button
          type="button"
          className="icon-button"
          aria-label="Restart session"
          title="Restart session"
          onClick={onRestart}
        >
          <RotateCcw size={16} />
        </button>
        {streaming ? (
          <button
            type="button"
            className="button button--danger"
            aria-label="Abort"
            title="Abort the running agent"
            onClick={onAbort}
          >
            <Square size={14} />
            Abort
          </button>
        ) : (
          <button
            type="submit"
            className="button button--primary"
            aria-label="Send"
            disabled={disabled || !text.trim()}
          >
            <Send size={14} />
            Send
          </button>
        )}
      </div>
    </form>
  );
}
