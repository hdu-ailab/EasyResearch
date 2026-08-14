import { Square } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { SkillCommandDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";

export interface ChatComposerProps {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  /** Skill commands of the current session agent; popover hidden when empty. */
  commands?: SkillCommandDto[];
}

const SLASH_PREFIX = /^(\s*)\/(\S*)$/;

/**
 * Chat composer. The Send button turns into Stop while the agent is
 * streaming (opencode prompt-input behavior); multiline input preserved.
 * A leading `/` opens a skill command popover (ADR-066): selecting a command
 * inserts `/skill:<name> `, which pi expands server-side; the transcript
 * renders the expansion as a compact card.
 */
export function ChatComposer({ disabled, streaming, onSend, onAbort, commands = [] }: ChatComposerProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [selectionStart, setSelectionStart] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const slash = useMemo(() => {
    const prefix = text.slice(0, selectionStart);
    const match = SLASH_PREFIX.exec(prefix);
    if (!match || commands.length === 0 || disabled) return undefined;
    return { prefixLength: match[0].length, query: match[2]!.toLowerCase() };
  }, [text, selectionStart, commands, disabled]);

  const filtered = useMemo(() => {
    if (!slash) return [];
    return commands.filter(
      (command) =>
        command.name.toLowerCase().startsWith(slash.query) || command.name.toLowerCase().includes(slash.query),
    );
  }, [slash, commands]);

  const insertSlash = (command: SkillCommandDto) => {
    if (slash === undefined) return;
    const before = text.slice(0, selectionStart - slash.prefixLength);
    const after = text.slice(selectionStart);
    const next = `${before}/skill:${command.name} ${after}`;
    setText(next);
    setSelectionStart(next.length);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText("");
    setSelectionStart(0);
    onSend(trimmed);
  };

  return (
    <form
      className="relative mx-auto flex w-full max-w-[1000px] items-end gap-2 md:max-w-200 2xl:max-w-[1000px]"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {slash && filtered.length > 0 ? (
        <div
          role="listbox"
          aria-label={t("composer.slashHint")}
          className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-64 overflow-y-auto rounded-lg border border-v2-grey-200 bg-v2-background-bg-base p-1 shadow-lg"
        >
          {filtered.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
                index === activeIndex ? "bg-v2-grey-100 text-v2-text-text-base" : "text-v2-text-text-muted"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertSlash(command);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span className="shrink-0 font-mono text-v2-blue-600">/{command.name}</span>
              {command.description ? (
                <span className="truncate text-[12px] text-v2-text-text-faint">{command.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-v2-grey-200 bg-v2-background-bg-base transition-colors focus-within:border-v2-blue-600">
        <textarea
          ref={textareaRef}
          className="max-h-[160px] min-h-[52px] w-full resize-none bg-transparent px-3 py-2 text-[13px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
          aria-label={t("composer.message")}
          placeholder={t("composer.placeholder")}
          rows={2}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setSelectionStart(e.target.selectionStart);
            setActiveIndex(0);
          }}
          onSelect={(e) => setSelectionStart(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (slash && filtered.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((current) => (current + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setActiveIndex(0);
                setText(text.slice(0, selectionStart - slash.prefixLength) + text.slice(selectionStart));
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const command = filtered[Math.min(activeIndex, filtered.length - 1)];
                if (command) insertSlash(command);
                return;
              }
            }
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
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              role="presentation"
            >
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}
