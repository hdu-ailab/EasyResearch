import { type RefObject, useLayoutEffect, useRef } from "react";
import { type ComposerDraft, type DraftInputEdit, draftEditRange, editDraft } from "./draft";

/** Native beforeinput covers typing, deletion, paste/cut and composition in textareas. */
export function useDraftInput(textareaRef: RefObject<HTMLTextAreaElement | null>) {
  const pending = useRef<{ edit: DraftInputEdit; event: InputEvent } | undefined>(undefined);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composition = useRef<{ start: number; end: number } | undefined>(undefined);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const beforeInput = (event: InputEvent) => {
      const range = event.isComposing || event.inputType.includes("Composition") ? composition.current : undefined;
      const edit = {
        text: textarea.value,
        start: range?.start ?? textarea.selectionStart,
        end: range?.end ?? textarea.selectionEnd,
        inputType: event.inputType,
      };
      const owner = { edit, event };
      pending.current = owner;
      if (expiry.current !== undefined) clearTimeout(expiry.current);
      // Expire next task, not microtask: native beforeinput's default action still
      // needs to dispatch input after the listener's microtask checkpoint.
      expiry.current = setTimeout(() => {
        if (pending.current === owner) pending.current = undefined;
        expiry.current = undefined;
      }, 0);
    };
    textarea.addEventListener("beforeinput", beforeInput);
    return () => {
      textarea.removeEventListener("beforeinput", beforeInput);
      if (expiry.current !== undefined) clearTimeout(expiry.current);
      pending.current = undefined;
    };
  }, [textareaRef]);

  return {
    apply(draft: ComposerDraft, text: string, event: Event) {
      const owner = pending.current;
      const edit =
        owner && !owner.event.defaultPrevented && owner.edit.inputType === (event as InputEvent).inputType
          ? owner.edit
          : undefined;
      pending.current = undefined;
      if (expiry.current !== undefined) clearTimeout(expiry.current);
      expiry.current = undefined;
      if (composition.current) {
        const range = draftEditRange(draft.text, text, edit);
        composition.current = range ? { start: range.start, end: range.insertedEnd } : undefined;
      }
      return editDraft(draft, text, edit);
    },
    startComposition() {
      const textarea = textareaRef.current;
      if (textarea) composition.current = { start: textarea.selectionStart, end: textarea.selectionEnd };
    },
    endComposition() {
      composition.current = undefined;
      pending.current = undefined;
    },
  };
}
