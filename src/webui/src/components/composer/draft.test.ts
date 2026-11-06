import { describe, expect, it } from "vitest";
import { directoryTrigger, editDraft, fileQuery, replaceDraftRange, slashQuery } from "./draft";

describe("composer draft ranges and paths", () => {
  it.each([
    { cwd: "/p", text: "Read @results/ta", directory: "/p/results", query: "ta" },
    {
      cwd: String.raw`C:\papers`,
      text: String.raw`Read @results\ta`,
      directory: String.raw`C:\papers\results`,
      query: "ta",
    },
    {
      cwd: String.raw`\\server\papers`,
      text: "@results/ta",
      directory: String.raw`\\server\papers\results`,
      query: "ta",
    },
  ])("resolves the requested directory using the cwd path style ($cwd)", ({ cwd, text, directory, query }) => {
    expect(fileQuery(text, text.length, cwd)).toMatchObject({ directory, query });
  });

  it.each(["@../", "@/other/", "@results/../../"])(
    'keeps "%s" outside the project out of directory requests',
    (text) => {
      expect(fileQuery(text, text.length, "/p")?.directory).toBeNull();
    },
  );

  it("quotes a navigated space-containing directory without swallowing text after its token", () => {
    const trigger = directoryTrigger(String.raw`C:\my papers\results`);
    const text = `${trigger} compare next`;
    const query = fileQuery(text, trigger.length - 1, String.raw`C:\my papers`);
    expect(query).toMatchObject({ directory: `${String.raw`C:\my papers\results`}\\`, end: trigger.length });
    expect(text.slice(query!.end)).toBe(" compare next");
  });

  it("completes the whole slash token but preserves its argument suffix when the caret is inside it", () => {
    const text = "  /arxiv more\narguments";
    expect(slashQuery(text, 5)).toEqual({ start: 2, end: 8, query: "ar", args: "more\narguments" });
  });

  it("drops overlapping reference metadata and shifts only untouched later references", () => {
    const draft = {
      text: "Read /p/a /p/b",
      references: [
        { id: 1, path: "/p/a", start: 5, end: 9 },
        { id: 2, path: "/p/b", start: 10, end: 14 },
      ],
    };
    const edited = replaceDraftRange(draft, 7, 9, "new-name");
    expect(edited.references.map((reference) => reference.id)).toEqual([2]);
    expect(edited.text.slice(edited.references[0]!.start, edited.references[0]!.end)).toBe("/p/b");
    const prefixed = editDraft(draft, `Please ${draft.text}`, {
      text: draft.text,
      start: 0,
      end: 0,
      inputType: "insertText",
    });
    for (const reference of prefixed.references) {
      expect(prefixed.text.slice(reference.start, reference.end)).toBe(reference.path);
    }
  });
});
