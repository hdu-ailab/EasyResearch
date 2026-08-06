import { useState } from "react";
import { Square } from "lucide-react";
import { useI18n } from "../i18n/useI18n";

export interface ChatComposerProps {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

/**
 * Chat composer. The Send button turns into Stop while the agent is
 * streaming (opencode prompt-input behavior); multiline input preserved.
 */
export function ChatComposer({ disabled, streaming, onSend, onAbort }: ChatComposerProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText("");
    onSend(trimmed);
  };

  return (
    <form
      className="mx-auto flex w-full max-w-[1000px] items-end gap-2 md:max-w-200 2xl:max-w-[1000px]"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-v2-grey-200 bg-v2-background-bg-base transition-colors focus-within:border-v2-blue-600">
        <textarea
          className="max-h-[160px] min-h-[52px] w-full resize-none bg-transparent px-3 py-2 text-[13px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
          aria-label={t("composer.message")}
          placeholder={t("composer.placeholder")}
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
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {streaming ? (
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md bg-v2-grey-1100 text-v2-grey-50 transition-opacity hover:opacity-90"
            aria-label={t("composer.stop")}
            title={t("composer.stopTitle")}
            onClick={onAbort}
          >
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            className="flex size-8 items-center justify-center rounded-md bg-v2-grey-1100 text-v2-grey-50 transition-opacity hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40"
            aria-label={t("composer.send")}
            disabled={disabled || !text.trim()}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}
