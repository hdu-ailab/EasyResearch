import { Square } from "lucide-react";
import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { SkillCommandDto } from "../../../web/contracts";
import { useI18n } from "../i18n/useI18n";

export interface ChatComposerProps {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string) => void;
  /** Non-Skill slash commands execute immediately; Skills remain editable completions. */
  onCommand?: (command: SkillCommandDto, args: string) => void;
  onAbort: () => void;
  /** Public slash commands of the current session agent; popover hidden when empty. */
  commands?: SkillCommandDto[];
}

export interface ChatComposerHandle {
  setDraft(text: string): void;
  focus(): void;
}

const SLASH_PREFIX = /^(\s*)\/(\S*)$/;

/**
 * Chat composer. The Send button turns into Stop while the agent is
 * streaming (opencode prompt-input behavior); multiline input preserved.
 * A leading `/` opens a command popover (ADR-066/078). Skills use the friendly
 * `/<name>` form unless a command collision requires Pi's `/skill:<name>` form.
 */
export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  { disabled, streaming, onSend, onCommand, onAbort, commands = [] },
  ref,
) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [selectionStart, setSelectionStart] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  /** Set on submit/stop; the effect below restores focus once the composer is
   * (re)enabled, covering the disable-then-enable send cycle (ADR-083). */
  const [pendingFocus, setPendingFocus] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandListId = `composer-commands-${useId().replaceAll(":", "")}`;

  useImperativeHandle(
    ref,
    () => ({
      setDraft(nextText: string) {
        setText(nextText);
        setSelectionStart(nextText.length);
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          textarea?.focus();
          textarea?.setSelectionRange(nextText.length, nextText.length);
        });
      },
      focus() {
        textareaRef.current?.focus();
      },
    }),
    [],
  );

  useEffect(() => {
    if (!pendingFocus || disabled) return;
    setPendingFocus(false);
    textareaRef.current?.focus();
  }, [pendingFocus, disabled]);

  const slash = useMemo(() => {
    const prefix = text.slice(0, selectionStart);
    const match = SLASH_PREFIX.exec(prefix);
    if (!match || commands.length === 0 || disabled) return undefined;
    return { prefixLength: match[0].length, query: (match[2] ?? "").toLowerCase() };
  }, [text, selectionStart, commands, disabled]);

  const filtered = useMemo(() => {
    if (!slash) return [];
    return commands.filter((command) => {
      const invocation = slashInvocation(command, commands).slice(1).toLowerCase();
      const name = command.name.toLowerCase();
      return invocation.startsWith(slash.query) || invocation.includes(slash.query) || name.includes(slash.query);
    });
  }, [slash, commands]);

  const insertSlash = (command: SkillCommandDto) => {
    if (slash === undefined) return;
    const before = text.slice(0, selectionStart - slash.prefixLength);
    const after = text.slice(selectionStart);
    const invocation = slashInvocation(command, commands);
    const next = `${before}${invocation} ${after}`;
    setText(next);
    setSelectionStart(next.length);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const executeCommand = (command: SkillCommandDto, args: string) => {
    setText("");
    setSelectionStart(0);
    setPendingFocus(true);
    if (onCommand) {
      onCommand(command, args);
      return;
    }
    const invocation = slashInvocation(command, commands);
    onSend(args ? `${invocation} ${args}` : invocation);
  };

  const selectSlash = (command: SkillCommandDto) => {
    if (command.source === "skill") {
      insertSlash(command);
      return;
    }
    executeCommand(command, "");
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    const commandMatch = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (commandMatch) {
      const command = commands.find(
        (candidate) => candidate.source !== "skill" && slashInvocation(candidate, commands) === commandMatch[1],
      );
      if (command) {
        executeCommand(command, commandMatch[2]?.trim() ?? "");
        return;
      }
    }
    setText("");
    setSelectionStart(0);
    setPendingFocus(true);
    onSend(trimmed);
  };

  // Single primary button (ADR-083): while streaming, non-empty input sends a
  // steer and empty input stops the run; when idle it is always Send.
  const canSend = text.trim().length > 0;
  const showStop = streaming && !canSend;

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
          id={commandListId}
          role="listbox"
          aria-label={t("composer.slashHint")}
          className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-64 overflow-y-auto rounded-lg border border-v2-grey-200 bg-v2-background-bg-base p-1 shadow-lg"
        >
          {filtered.map((command, index) => (
            <button
              key={`${command.source}:${command.name}`}
              id={`${commandListId}-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
                index === activeIndex ? "bg-v2-grey-100 text-v2-text-text-base" : "text-v2-text-text-muted"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                selectSlash(command);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span className="shrink-0 font-mono text-v2-blue-600">{slashInvocation(command, commands)}</span>
              {command.description ? (
                <span className="truncate text-[12px] text-v2-text-text-faint">{command.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-v2-grey-200 bg-v2-background-bg-base transition-colors focus-within:border-v2-grey-400">
        <textarea
          ref={textareaRef}
          className="max-h-[160px] min-h-[52px] w-full resize-none bg-transparent px-3 py-2 text-[13px] text-v2-text-text-base placeholder:text-v2-text-text-faint"
          style={{ outline: "none" }}
          aria-label={t("composer.message")}
          aria-autocomplete="list"
          aria-controls={slash && filtered.length > 0 ? commandListId : undefined}
          aria-activedescendant={
            slash && filtered.length > 0
              ? `${commandListId}-option-${Math.min(activeIndex, filtered.length - 1)}`
              : undefined
          }
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
                setActiveIndex(
                  (current) => (current + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length,
                );
                return;
              }
              if (e.key === "Home" || e.key === "End") {
                e.preventDefault();
                setActiveIndex(e.key === "Home" ? 0 : filtered.length - 1);
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
                if (command) selectSlash(command);
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
        {showStop ? (
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md bg-v2-grey-1100 text-v2-grey-50 transition-opacity hover:opacity-90"
            aria-label={t("composer.stop")}
            title={t("composer.stopTitle")}
            onClick={() => {
              setPendingFocus(true);
              onAbort();
            }}
          >
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            className="flex size-8 items-center justify-center rounded-md bg-v2-grey-1100 text-v2-grey-50 transition-opacity hover:opacity-90 disabled:opacity-40 disabled:hover:opacity-40"
            aria-label={t("composer.send")}
            disabled={disabled || !canSend}
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
});

function slashInvocation(command: SkillCommandDto, commands: SkillCommandDto[]): string {
  if (command.source !== "skill") return `/${command.name}`;
  const collides =
    command.requiresPrefix ||
    commands.some((candidate) => candidate.source !== "skill" && candidate.name === command.name);
  return collides ? `/skill:${command.name}` : `/${command.name}`;
}
