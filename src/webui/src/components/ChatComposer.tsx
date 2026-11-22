import { AtSign, FileText, Slash, Sparkles, Square, X } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SkillCommandDto } from "../../../web/contracts";
import { canFocusElement } from "../hooks/useModalLayer";
import { useI18n } from "../i18n/useI18n";
import { useViewActivityRef } from "../view-activity";
import { type ComposerSuggestion, ComposerSuggestions } from "./composer/ComposerSuggestions";
import {
  type ComposerDraft,
  directoryTrigger,
  fileQuery,
  promptWithContext,
  protectLeadingReference,
  referenceLiteral,
  replaceDraftRange,
  slashInvocation,
  slashQuery,
} from "./composer/draft";
import { useComposerFiles } from "./composer/useComposerFiles";
import { useDraftInput } from "./composer/useDraftInput";
import { ActionGlyph } from "./studio/ActionGlyph";

export interface ChatComposerProps {
  cwd?: string;
  /** The Work owner's font preference invalidates fallback sizing after CSS application. */
  chatFontSize?: number;
  disabled: boolean;
  streaming: boolean;
  /** Owned work can be stopped while the model is paused awaiting recovery. */
  canAbort?: boolean;
  onSend: (text: string) => void;
  /** Slash commands execute immediately; Skill context is sent through onSend. */
  onCommand?: (command: SkillCommandDto, args: string) => void;
  onAbort: () => void;
  /** Public slash commands of the current session agent; popover hidden when empty. */
  commands?: SkillCommandDto[];
}

export interface ChatComposerHandle {
  setDraft(text: string): void;
  insertPath(path: string): void;
  focus(): void;
}

/**
 * Chat composer. The Send button turns into Stop while the agent is
 * streaming (opencode prompt-input behavior); multiline input preserved.
 * A leading `/` executes commands; `@` supplies files and Skill context.
 */
export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  { cwd, chatFontSize, disabled, streaming, canAbort = streaming, onSend, onCommand, onAbort, commands = [] },
  ref,
) {
  const { t } = useI18n();
  const activity = useViewActivityRef();
  const { visible, interactive } = activity.current;
  const [draft, setDraft] = useState<ComposerDraft>({ text: "", references: [] });
  const { text } = draft;
  const [selectionStart, setSelectionStart] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  /** Set on submit/stop; the effect below restores focus once the composer is
   * (re)enabled, covering the disable-then-enable send cycle (ADR-083). */
  const [pendingFocus, setPendingFocus] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftInput = useDraftInput(textareaRef);
  const composing = useRef(false);
  const insertedCaret = useRef<number | null>(null);
  const referenceId = useRef(0);
  const commandListId = `composer-commands-${useId().replaceAll(":", "")}`;
  const [nativeSizing] = useState(
    () => typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content") === true,
  );

  const resizeFallback = useCallback(
    (contentWidth?: number) => {
      const textarea = textareaRef.current;
      if (nativeSizing || !activity.current.visible || !textarea || (contentWidth ?? textarea.clientWidth) <= 0) return;
      // Reset first so deleting text can shrink; CSS owns the height limits.
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    },
    [nativeSizing, activity],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Remeasure the committed DOM whenever the controlled draft changes.
  useLayoutEffect(() => {
    if (visible) resizeFallback();
  }, [text, visible, resizeFallback]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (nativeSizing || !textarea || !visible) return;
    let width: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!activity.current.visible) return;
      const nextWidth = entry?.contentRect.width;
      if (nextWidth === undefined) return;
      if (nextWidth === width) return;
      width = nextWidth;
      resizeFallback(nextWidth);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [visible, nativeSizing, activity, resizeFallback]);

  // The parent PreferencesProvider applies font CSS in its passive effect, after
  // child effects. Measure on the next frame with those accepted styles in place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The font preference invalidates layout without changing draft text or the observer's box.
  useEffect(() => {
    if (nativeSizing || !visible) return;
    const frame = requestAnimationFrame(() => resizeFallback());
    return () => cancelAnimationFrame(frame);
  }, [chatFontSize, visible, nativeSizing, resizeFallback]);

  useLayoutEffect(() => {
    if (interactive) return;
    insertedCaret.current = null;
    setPendingFocus(false);
    setDismissed(true);
    composing.current = false;
  }, [interactive]);

  useImperativeHandle(
    ref,
    () => ({
      setDraft(nextText: string) {
        setDraft({ text: nextText, references: [] });
        setSelectionStart(nextText.length);
        insertedCaret.current = activity.current.interactive ? nextText.length : null;
        setDismissed(!activity.current.interactive);
      },
      focus() {
        if (activity.current.interactive && canFocusElement(textareaRef.current)) textareaRef.current.focus();
      },
      insertPath(path: string) {
        const textarea = textareaRef.current;
        if (!activity.current.interactive || disabled || !textarea) return;
        const before = textarea.value.slice(0, textarea.selectionStart);
        const after = textarea.value.slice(textarea.selectionEnd);
        const literal = referenceLiteral(path, !before.trim());
        const insertion = `${before && !/\s$/.test(before) ? " " : ""}${literal}${/^\s/.test(after) ? "" : " "}`;
        insertedCaret.current = before.length + insertion.length;
        const start = before.length + (before && !/\s$/.test(before) ? 1 : 0);
        const reference = { id: ++referenceId.current, path, start, end: start + literal.length };
        const end = textarea.selectionEnd;
        setDraft((current) => {
          const next = replaceDraftRange(current, before.length, end, insertion);
          return { ...next, references: [...next.references, reference] };
        });
        setSelectionStart(insertedCaret.current);
        setActiveIndex(0);
        setDismissed(true);
      },
    }),
    [disabled, activity],
  );

  useLayoutEffect(() => {
    if (insertedCaret.current === null) return;
    const caret = insertedCaret.current;
    insertedCaret.current = null;
    if (!activity.current.interactive || !canFocusElement(textareaRef.current)) return;
    textareaRef.current.focus();
    textareaRef.current?.setSelectionRange(caret, caret);
  });

  useEffect(() => {
    if (!pendingFocus || disabled || !interactive) return;
    setPendingFocus(false);
    if (canFocusElement(textareaRef.current)) textareaRef.current.focus();
  }, [pendingFocus, disabled, interactive]);

  const slash = useMemo(() => {
    if (commands.length === 0 || disabled || dismissed || !interactive) return undefined;
    const query = slashQuery(text, selectionStart);
    return query && !draft.references.some((reference) => reference.start <= query.start && reference.end > query.start)
      ? query
      : undefined;
  }, [text, selectionStart, commands, disabled, dismissed, draft.references, interactive]);

  const file = useMemo(() => {
    if (disabled || dismissed || !interactive) return undefined;
    const query = fileQuery(text, selectionStart, cwd);
    return query && !draft.references.some((reference) => reference.start <= query.start && reference.end > query.start)
      ? query
      : undefined;
  }, [text, selectionStart, cwd, disabled, dismissed, interactive, draft.references]);
  const files = useComposerFiles(file?.directory, file?.query ?? "");

  const filtered = useMemo(() => {
    if (!slash) return [];
    return commands.filter((command) => {
      if (command.source === "skill") return false;
      const invocation = slashInvocation(command).slice(1).toLowerCase();
      const name = command.name.toLowerCase();
      return invocation.startsWith(slash.query) || invocation.includes(slash.query) || name.includes(slash.query);
    });
  }, [slash, commands]);

  const skills = useMemo(() => {
    const query = file?.skillQuery;
    return query === undefined
      ? []
      : commands.filter((command) => command.source === "skill" && command.name.toLowerCase().includes(query));
  }, [file?.skillQuery, commands]);

  const executeCommand = (command: SkillCommandDto, args: string) => {
    setDraft({ text: "", references: [] });
    setSelectionStart(0);
    setPendingFocus(true);
    if (onCommand) {
      onCommand(command, args);
      return;
    }
    const invocation = slashInvocation(command);
    onSend(args ? `${invocation} ${args}` : invocation);
  };

  const suggestions: ComposerSuggestion[] = file
    ? [
        ...skills.map((skill) => ({
          id: `skill:${skill.name}`,
          kind: "skill" as const,
          label: `@skill:${skill.name}`,
          description: skill.description,
        })),
        ...files.entries.map((entry) => ({ id: entry.path, kind: entry.kind, label: entry.name })),
      ]
    : filtered.map((command) => ({
        id: `${command.source}:${command.name}`,
        kind: "command",
        label: slashInvocation(command),
        description: command.description,
      }));
  const selectedIndex = Math.min(activeIndex, Math.max(0, suggestions.length - 1));
  const popover = file ? "context" : slash ? "slash" : undefined;
  const selectSuggestion = (index: number) => {
    if (!activity.current.interactive) return;
    if (!file) {
      const command = filtered[index];
      if (command) executeCommand(command, slash?.args ?? "");
      return;
    }
    const skill = skills[index];
    if (skill) {
      const literal = `@skill:${skill.name}`;
      const insertion = literal + (/^\s/.test(text.slice(file.end)) ? "" : " ");
      const id = ++referenceId.current;
      let next = replaceDraftRange(draft, file.start, file.end, insertion);
      next.references.push({ id, kind: "skill", path: literal, start: file.start, end: file.start + literal.length });
      // Pi expands one Skill per prompt. Replace the previous context in this
      // same draft, retaining all other text and reference-range ownership.
      for (const previous of next.references
        .filter((reference) => reference.kind === "skill" && reference.id !== id)
        .sort((a, b) => b.start - a.start)) {
        next = replaceDraftRange(next, previous.start, previous.end, "");
      }
      const inserted = next.references.find((reference) => reference.id === id);
      if (!inserted) return;
      insertedCaret.current = Math.min(inserted.end + 1, next.text.length);
      setDraft(next);
      setSelectionStart(insertedCaret.current);
      setActiveIndex(0);
      setDismissed(true);
      return;
    }
    const entry = files.entries[index - skills.length];
    if (!entry) return;
    const directory = entry.kind === "directory";
    const literal = referenceLiteral(entry.path, !text.slice(0, file.start).trim());
    const insertion = directory
      ? directoryTrigger(entry.path)
      : literal + (/^\s/.test(text.slice(file.end)) ? "" : " ");
    const reference = {
      id: ++referenceId.current,
      path: entry.path,
      start: file.start,
      end: file.start + literal.length,
    };
    setDraft((current) => {
      const next = replaceDraftRange(current, file.start, file.end, insertion);
      return directory ? next : { ...next, references: [...next.references, reference] };
    });
    insertedCaret.current = file.start + insertion.length - (directory && insertion.startsWith('@"') ? 1 : 0);
    setSelectionStart(insertedCaret.current);
    setActiveIndex(0);
    setDismissed(!directory);
  };

  const openSuggestions = (trigger: "/" | "@") => {
    const textarea = textareaRef.current;
    if (!textarea || disabled || !activity.current.interactive) return;
    if (trigger === "/") {
      const existing = /^(\s*)\/\S*/.exec(text);
      if (existing) insertedCaret.current = existing[0].length;
      else {
        setDraft((current) => replaceDraftRange(current, 0, 0, text ? "/ " : "/"));
        insertedCaret.current = 1;
      }
    } else {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const prefix = `${start && !/\s/.test(text.charAt(start - 1)) ? " " : ""}@`;
      const insertion = prefix + (text.slice(end) && !/^\s/.test(text.slice(end)) ? " " : "");
      setDraft((current) => replaceDraftRange(current, start, end, insertion));
      insertedCaret.current = start + prefix.length;
    }
    setSelectionStart(insertedCaret.current);
    setActiveIndex(0);
    setDismissed(false);
  };

  const submit = () => {
    const literalDraft = protectLeadingReference(draft);
    const trimmed = promptWithContext(literalDraft);
    if (!trimmed || disabled || !activity.current.interactive) return;
    const commandMatch = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    const startsWithReference = literalDraft.references.some(
      (reference) => reference.start === literalDraft.text.search(/\S/),
    );
    if (commandMatch && !startsWithReference) {
      const command = commands.find(
        (candidate) => candidate.source !== "skill" && slashInvocation(candidate) === commandMatch[1],
      );
      if (command) {
        executeCommand(command, commandMatch[2]?.trim() ?? "");
        return;
      }
    }
    setDraft({ text: "", references: [] });
    setSelectionStart(0);
    setPendingFocus(true);
    onSend(trimmed);
  };

  // Single primary button (ADR-083): while streaming, non-empty input sends a
  // steer and empty input stops the run; when idle it is always Send.
  const canSend = text.trim().length > 0;
  const showStop = canAbort && !canSend;

  return (
    <form
      data-chat-composer
      className="relative mx-auto flex w-full max-w-[920px] flex-col rounded-xl border border-v2-grey-200 bg-v2-background-bg-deep p-2 shadow-[0_4px_20px_-12px_rgba(15,23,42,0.2)] transition-colors focus-within:border-v2-grey-400"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDismissed(true);
      }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {popover ? (
        <ComposerSuggestions
          id={commandListId}
          surface={popover}
          items={suggestions}
          activeIndex={selectedIndex}
          status={file ? files.status : undefined}
          replacesSkill={draft.references.some((reference) => reference.kind === "skill")}
          onActive={setActiveIndex}
          onSelect={selectSuggestion}
        />
      ) : null}
      <div className="flex min-w-0 w-full flex-col">
        {draft.references.length ? (
          <ul className="flex flex-wrap gap-1.5 px-2 pt-1" aria-label={t("composer.references")}>
            {draft.references.map((reference) => (
              <li
                key={reference.id}
                data-composer-reference
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-v2-grey-200 bg-v2-background-bg-base py-1 pr-1 pl-2 text-[12px] text-v2-text-text-muted"
                title={reference.path}
              >
                {reference.kind === "skill" ? (
                  <Sparkles size={13} className="shrink-0" aria-hidden />
                ) : (
                  <FileText size={13} className="shrink-0" aria-hidden />
                )}
                <span className="truncate">{reference.path}</span>
                <button
                  type="button"
                  disabled={disabled}
                  className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-v2-grey-100 disabled:opacity-50"
                  aria-label={`${t("composer.removeReference")} ${reference.path}`}
                  onClick={() => {
                    setDraft((current) => replaceDraftRange(current, reference.start, reference.end, ""));
                    insertedCaret.current = reference.start;
                    setSelectionStart(reference.start);
                    setDismissed(true);
                  }}
                >
                  <X size={12} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={textareaRef}
          data-composer-sizing={nativeSizing ? "native" : "fallback"}
          className="max-h-[160px] min-h-[76px] w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-[14px] leading-6 text-v2-text-text-base placeholder:text-v2-text-text-faint disabled:opacity-60"
          style={{ outline: "none" }}
          aria-label={t("composer.message")}
          aria-autocomplete="list"
          aria-controls={popover ? commandListId : undefined}
          aria-activedescendant={
            popover && suggestions.length > 0 ? `${commandListId}-option-${selectedIndex}` : undefined
          }
          placeholder={t("composer.placeholder")}
          rows={2}
          value={text}
          disabled={disabled}
          onChange={(e) => {
            const nextText = e.target.value;
            const edited = draftInput.apply(draft, nextText, e.nativeEvent);
            const next = composing.current ? edited : protectLeadingReference(edited);
            const leading = edited.references.find((reference) => reference.start === nextText.search(/\S/));
            let caret = e.target.selectionStart;
            if (next !== edited && leading) {
              caret += (caret > leading.start ? 1 : 0) + (caret >= leading.end ? 1 : 0);
              insertedCaret.current = caret;
            }
            setDraft(next);
            setSelectionStart(caret);
            setActiveIndex(0);
            setDismissed(false);
          }}
          onSelect={(e) => {
            if (selectionStart !== e.currentTarget.selectionStart) {
              setSelectionStart(e.currentTarget.selectionStart);
              setActiveIndex(0);
              setDismissed(false);
            }
          }}
          onCompositionStart={() => {
            composing.current = true;
            draftInput.startComposition();
          }}
          onCompositionEnd={() => {
            composing.current = false;
            draftInput.endComposition();
          }}
          onBlur={() => {
            composing.current = false;
            draftInput.endComposition();
          }}
          onKeyDown={(e) => {
            // Safari may end composition before its confirmation keydown (229).
            if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (popover) {
              if (e.key === "Tab") {
                setDismissed(true);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setActiveIndex(0);
                setDismissed(true);
                return;
              }
              if (suggestions.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setActiveIndex(
                  (selectedIndex + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length,
                );
                return;
              }
              if (suggestions.length > 0 && (e.key === "Home" || e.key === "End")) {
                e.preventDefault();
                setActiveIndex(e.key === "Home" ? 0 : suggestions.length - 1);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && (file || suggestions.length > 0)) {
                e.preventDefault();
                selectSuggestion(selectedIndex);
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
      <div className="flex w-full shrink-0 items-center gap-1 px-1 pt-1">
        <button
          type="button"
          aria-label={t("composer.commands")}
          title={t("composer.commands")}
          disabled={disabled || !commands.some((command) => command.source !== "skill")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openSuggestions("/")}
          className="flex size-8 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-grey-100 disabled:opacity-40"
        >
          <Slash size={15} aria-hidden />
        </button>
        {cwd || commands.some((command) => command.source === "skill") ? (
          <button
            type="button"
            aria-label={t("composer.context")}
            title={t("composer.context")}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => openSuggestions("@")}
            className="flex size-8 items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-grey-100 disabled:opacity-40"
          >
            <AtSign size={15} aria-hidden />
          </button>
        ) : null}
        <span className="flex-1" />
        {showStop ? (
          <button
            type="button"
            data-composer-action
            className="flex size-8 items-center justify-center rounded-lg bg-v2-text-text-base text-v2-background-bg-base transition-opacity hover:opacity-80"
            aria-label={t("composer.stop")}
            title={t("composer.stopTitle")}
            onClick={() => {
              if (!activity.current.interactive) return;
              setPendingFocus(true);
              onAbort();
            }}
          >
            <ActionGlyph label={t("composer.stop")}>
              <Square size={13} fill="currentColor" />
            </ActionGlyph>
          </button>
        ) : (
          <button
            type="submit"
            data-composer-action
            className="flex size-8 items-center justify-center rounded-lg bg-v2-text-text-base text-v2-background-bg-base transition-opacity hover:opacity-80 disabled:opacity-40 disabled:hover:opacity-40"
            aria-label={t("composer.send")}
            title={t("composer.send")}
            disabled={disabled || !canSend}
          >
            <ActionGlyph label={t("composer.send")}>
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
            </ActionGlyph>
          </button>
        )}
      </div>
    </form>
  );
});
