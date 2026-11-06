import type { SkillCommandDto } from "../../../../web/contracts";
import { isAbsoluteFilesystemPath, isSameOrDescendantPath, joinFilesystemPath } from "../../filesystem-path";

export interface DraftReference {
  id: number;
  path: string;
  start: number;
  end: number;
}

export interface ComposerDraft {
  text: string;
  references: DraftReference[];
}

/** Pi recognizes slash syntax independently of the currently loaded command list. */
export function referenceLiteral(path: string, leading: boolean): string {
  return leading && path.startsWith("/") ? `"${path}"` : path;
}

export function protectLeadingReference(draft: ComposerDraft): ComposerDraft {
  const first = draft.text.search(/\S/);
  const reference = draft.references.find((candidate) => candidate.start === first);
  if (!reference || draft.text.slice(reference.start, reference.end) !== reference.path) return draft;
  const literal = referenceLiteral(reference.path, true);
  if (literal === reference.path) return draft;
  const delta = literal.length - reference.path.length;
  return {
    text: draft.text.slice(0, reference.start) + literal + draft.text.slice(reference.end),
    references: draft.references.map((candidate) =>
      candidate.id === reference.id
        ? { ...candidate, end: candidate.end + delta }
        : candidate.start >= reference.end
          ? { ...candidate, start: candidate.start + delta, end: candidate.end + delta }
          : candidate,
    ),
  };
}

export interface DraftInputEdit {
  text: string;
  start: number;
  end: number;
  inputType: string;
}

/** Use the browser's pre-input selection, never an ambiguous prefix/suffix diff. */
export function editDraft(draft: ComposerDraft, text: string, edit?: DraftInputEdit): ComposerDraft {
  if (draft.text === text) return draft;
  const range = draftEditRange(draft.text, text, edit);
  if (!range) return { text, references: [] };
  return replaceDraftRange(draft, range.start, range.end, text.slice(range.start, range.insertedEnd));
}

export function draftEditRange(before: string, after: string, edit?: DraftInputEdit) {
  if (!edit || edit.text !== before || /^(history|insertReplacement)/.test(edit.inputType)) return undefined;
  let { start, end } = edit;
  if (start === end && edit.inputType.startsWith("delete")) {
    const removed = before.length - after.length;
    if (removed <= 0) return undefined;
    if (edit.inputType.endsWith("Backward")) start -= removed;
    else if (edit.inputType.endsWith("Forward")) end += removed;
    else return undefined;
  }
  const insertedEnd = start + after.length - before.length + end - start;
  if (
    start < 0 ||
    end < start ||
    end > before.length ||
    insertedEnd < start ||
    before.slice(0, start) !== after.slice(0, start) ||
    before.slice(end) !== after.slice(insertedEnd)
  )
    return undefined;
  return { start, end, insertedEnd };
}

export function replaceDraftRange(draft: ComposerDraft, start: number, end: number, insertion: string): ComposerDraft {
  const delta = insertion.length - (end - start);
  return {
    text: draft.text.slice(0, start) + insertion + draft.text.slice(end),
    references: draft.references.flatMap((reference) => {
      if (reference.end <= start) return [reference];
      if (reference.start >= end) return [{ ...reference, start: reference.start + delta, end: reference.end + delta }];
      return [];
    }),
  };
}

export function slashInvocation(command: SkillCommandDto, commands: SkillCommandDto[]): string {
  if (command.source !== "skill") return `/${command.name}`;
  const collides =
    command.requiresPrefix ||
    commands.some((candidate) => candidate.source !== "skill" && candidate.name === command.name);
  return collides ? `/skill:${command.name}` : `/${command.name}`;
}

export function slashQuery(text: string, caret: number) {
  const match = /^(\s*)\/(\S*)$/.exec(text.slice(0, caret));
  if (!match) return undefined;
  const start = (match[1] ?? "").length;
  const end = caret + (/^\S*/.exec(text.slice(caret))?.[0].length ?? 0);
  return { start, end, query: (match[2] ?? "").toLowerCase(), args: text.slice(end).trim() };
}

export function fileQuery(text: string, caret: number, cwd: string) {
  const match = /(?:^|\s)@(?:"([^"\n]*)|([^\s@"]*))$/.exec(text.slice(0, caret));
  if (!match) return undefined;
  const quoted = match[1] !== undefined;
  const query = match[1] ?? match[2] ?? "";
  const start = caret - query.length - (quoted ? 2 : 1);
  const tail = text.slice(caret);
  const end = caret + (quoted ? (/^[^"\n]*"?/.exec(tail)?.[0].length ?? 0) : (/^[^\s@]*/.exec(tail)?.[0].length ?? 0));
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd);
  const slash = windows ? Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\")) : query.lastIndexOf("/");
  const prefix = query.slice(0, slash + 1);
  const directory = prefix ? (isAbsoluteFilesystemPath(prefix) ? prefix : joinFilesystemPath(cwd, prefix)) : cwd;
  return {
    start,
    end,
    query: query.slice(slash + 1).toLowerCase(),
    directory: isSameOrDescendantPath(cwd, directory) ? directory : null,
  };
}

export function directoryTrigger(path: string): string {
  const separator = /^[A-Za-z]:[\\/]|^\\\\/.test(path) ? "\\" : "/";
  const directory = path.endsWith(separator) ? path : `${path}${separator}`;
  return /[\s@]/.test(directory) ? `@"${directory}"` : `@${directory}`;
}
