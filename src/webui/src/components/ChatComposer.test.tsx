import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntryDto } from "../../../web/contracts";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { ViewActivityProvider } from "../view-activity";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listEntries: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(api.listEntries).mockReset().mockResolvedValue([]);
});

const commands = [
  { name: "arxiv", description: "arXiv metadata", source: "skill" as const },
  { name: "drawio", description: "Diagrams", source: "skill" as const },
  { name: "name", description: "Set the session display name", source: "extension" as const },
];

async function renderComposer(props: Partial<React.ComponentProps<typeof ChatComposer>> = {}) {
  const user = userEvent.setup();
  const utils = render(
    <PreferencesProvider>
      <I18nProvider>
        <ChatComposer
          disabled={false}
          streaming={false}
          onSend={() => {}}
          onCommand={() => {}}
          onAbort={() => {}}
          commands={commands}
          {...props}
        />
      </I18nProvider>
    </PreferencesProvider>,
  );
  return { user, ...utils };
}

describe("ChatComposer slash popover", () => {
  it("aborts and dismisses inactive file suggestions without reopening them on activation", async () => {
    const pending = Promise.withResolvers<FileEntryDto[]>();
    vi.mocked(api.listEntries).mockReturnValue(pending.promise);
    const composer = (active: boolean) => (
      <ViewActivityProvider visible={active} interactive={active}>
        <ChatComposer
          cwd="/p"
          disabled={false}
          streaming={false}
          onSend={() => {}}
          onAbort={() => {}}
          commands={commands}
        />
      </ViewActivityProvider>
    );
    const view = render(composer(true));
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "@" } });
    expect(api.listEntries).toHaveBeenCalledOnce();
    const signal = vi.mocked(api.listEntries).mock.calls[0]?.[1];
    view.rerender(composer(false));
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve([{ kind: "file", name: "late.txt", path: "/p/late.txt" }]));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveValue("@");
    view.rerender(composer(true));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(api.listEntries).toHaveBeenCalledOnce();
  });

  it.each(["plain draft", "/na", "/ar", "/name draft"])(
    "does not submit or complete %s during IME confirmation, but accepts ordinary Enter",
    async (draft) => {
      const onSend = vi.fn();
      const onCommand = vi.fn();
      const { user } = await renderComposer({ onSend, onCommand });
      const input = screen.getByRole("textbox", { name: "Message" });
      await user.click(input);
      await user.keyboard(draft);
      for (const event of [
        { isComposing: true, keyCode: 13 },
        { isComposing: false, keyCode: 229 },
      ]) {
        fireEvent.keyDown(input, { key: "Enter", ...event });
        expect(input).toHaveValue(draft);
        expect(onSend).not.toHaveBeenCalled();
        expect(onCommand).not.toHaveBeenCalled();
      }
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
      expect(input).toHaveValue(draft);
      expect(onSend).not.toHaveBeenCalled();
      expect(onCommand).not.toHaveBeenCalled();
      fireEvent.compositionEnd(input);
      fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
      expect(input).toHaveValue(draft);
      await user.keyboard("{Enter}");
      if (draft === "/ar") expect(input).toHaveValue("/arxiv ");
      else if (draft.startsWith("/na")) expect(onCommand).toHaveBeenCalledOnce();
      else expect(onSend).toHaveBeenCalledWith(draft);
    },
  );

  it("preserves Shift+Enter newlines after composition finishes", async () => {
    const onSend = vi.fn();
    const { user } = await renderComposer({ onSend });
    const input = screen.getByRole("textbox", { name: "Message" });
    await user.click(input);
    await user.keyboard("draft");
    fireEvent.compositionStart(input);
    fireEvent.compositionEnd(input);
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(input).toHaveValue("draft\n");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("opens on a leading slash and lists skill commands", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/");
    expect(await screen.findByText("/arxiv")).toBeTruthy();
    expect(screen.getByText("/drawio")).toBeTruthy();
    const activeId = input.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    expect(document.getElementById(activeId ?? "")).toHaveRole("option");
    expect(screen.getAllByRole("option").every((option) => option.tabIndex === -1)).toBe(true);
  });

  it("does not open when the slash is not at the line start", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i);
    await user.click(input);
    await user.keyboard("help /");
    expect(screen.queryByText("/arxiv")).toBeNull();
  });

  it("filters as the query grows", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i);
    await user.click(input);
    await user.keyboard("/dr");
    expect(screen.queryByText("/arxiv")).toBeNull();
    expect(screen.getByText("/drawio")).toBeTruthy();
  });

  it("inserts the friendly Skill command on Enter and closes", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/ar");
    await user.keyboard("{Enter}");
    expect(input.value).toBe("/arxiv ");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("executes the selected command on Enter instead of inserting it", async () => {
    const onCommand = vi.fn();
    const { user } = await renderComposer({ onCommand });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/nam");
    await user.keyboard("{Enter}");
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "name", source: "extension" }), "");
    expect(input.value).toBe("");
  });

  it("executes a clicked command through the same action path", async () => {
    const onCommand = vi.fn();
    const { user } = await renderComposer({ onCommand });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/nam");
    await user.click(await screen.findByRole("option", { name: /\/name/ }));

    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "name" }), "");
    expect(input.value).toBe("");
  });

  it("executes typed commands with their trailing arguments", async () => {
    const onCommand = vi.fn();
    const onSend = vi.fn();
    const { user } = await renderComposer({ onCommand, onSend });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/name Paper v2{Enter}");

    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "name" }), "Paper v2");
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("navigates across command and Skill groups with ArrowDown", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(input.value).toBe("/arxiv ");
  });

  it("moves command selection to Home and End", async () => {
    const onCommand = vi.fn();
    const { user } = await renderComposer({ onCommand });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/{End}");
    expect(document.getElementById(input.getAttribute("aria-activedescendant") ?? "")).toHaveTextContent("/drawio");
    await user.keyboard("{Home}");
    expect(document.getElementById(input.getAttribute("aria-activedescendant") ?? "")).toHaveTextContent("/name");
    await user.keyboard("{Enter}");
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "name" }), "");
  });

  it("displays and inserts the native prefix when a Skill collides with another command", async () => {
    const { user } = await renderComposer({
      commands: [
        ...commands,
        { name: "name", description: "A colliding Skill", source: "skill", requiresPrefix: true },
      ],
    });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/skill:nam");
    await user.click(await screen.findByRole("option", { name: /\/skill:name/ }));

    expect(input.value).toBe("/skill:name ");
  });

  it("does not open when commands are empty", async () => {
    const { user } = await renderComposer({ commands: [] });
    const input = screen.getByLabelText(/message/i);
    await user.click(input);
    await user.keyboard("/");
    expect(screen.queryByText("/arxiv")).toBeNull();
  });

  it("sends a plain message through onSend unchanged", async () => {
    const onSend = vi.fn();
    const { user } = await renderComposer({ onSend });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("write a summary");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("write a summary");
  });

  it("labels executable commands separately from editable Skills", async () => {
    const { user } = await renderComposer();
    await user.type(screen.getByRole("textbox"), "/");
    expect(within(screen.getByRole("group", { name: "Commands" })).getByRole("option")).toHaveTextContent("/name");
    expect(within(screen.getByRole("group", { name: "Skills" })).getAllByRole("option")).toHaveLength(2);
  });

  it("Escape dismisses suggestions without changing the draft or caret", async () => {
    const { user } = await renderComposer();
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.type(input, "/ar");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input).toHaveValue("/ar");
    expect(input.selectionStart).toBe(3);
    await user.keyboard("x");
    expect(screen.getByRole("option")).toHaveTextContent("/arxiv");
  });

  it.each([false, true])(
    "keeps arguments and the suffix caret when completing a Skill (collision=%s)",
    async (collision) => {
      const onSend = vi.fn();
      const { user } = await renderComposer({
        onSend,
        commands: [{ name: "arxiv", source: "skill", requiresPrefix: collision }],
      });
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      const prefix = collision ? "/skill:ar" : "/ar";
      fireEvent.change(input, { target: { value: `${prefix} 1706.03762\nkeep this suffix` } });
      input.focus();
      input.setSelectionRange(prefix.length, prefix.length);
      fireEvent.select(input);
      await user.keyboard("{Enter}");
      const invocation = collision ? "/skill:arxiv" : "/arxiv";
      expect(input).toHaveValue(`${invocation} 1706.03762\nkeep this suffix`);
      expect(input.selectionStart).toBe(invocation.length + 1);
      expect(onSend).not.toHaveBeenCalled();
      await user.keyboard("{Enter}");
      expect(onSend).toHaveBeenCalledWith(`${invocation} 1706.03762\nkeep this suffix`);
    },
  );

  it("selected commands retain arguments after the slash token", async () => {
    const onCommand = vi.fn();
    const { user } = await renderComposer({ onCommand });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/na New name" } });
    input.focus();
    input.setSelectionRange(3, 3);
    fireEvent.select(input);
    await user.click(screen.getByRole("option", { name: /\/name/ }));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "name" }), "New name");
  });

  it("preserves Shift+Enter while suggestions are open", async () => {
    const onCommand = vi.fn();
    const { user } = await renderComposer({ onCommand });
    const input = screen.getByRole("textbox");
    await user.type(input, "/na");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(input).toHaveValue("/na\n");
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("scrolls keyboard selection into view and accepts a touch-style click", async () => {
    const scroll = vi.fn();
    const { user } = await renderComposer();
    await user.type(screen.getByRole("textbox"), "/");
    const options = screen.getAllByRole("option");
    options.at(-1)!.scrollIntoView = scroll;
    await user.keyboard("{End}");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    fireEvent.click(options.at(-1)!);
    expect(screen.getByRole("textbox")).toHaveValue("/drawio ");
  });

  it("opens Commands from the toolbar while keeping a populated draft as Skill arguments", async () => {
    const onSend = vi.fn();
    const { user } = await renderComposer({ onSend });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.type(input, "1706.03762");
    await user.click(screen.getByRole("button", { name: "Commands" }));
    await user.click(screen.getByRole("option", { name: /\/arxiv/ }));
    expect(input).toHaveValue("/arxiv 1706.03762");
    expect(input.selectionStart).toBe("/arxiv ".length);
    expect(input).toHaveFocus();
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("ChatComposer file references", () => {
  it.each([
    { path: "/name draft/file.md", cwd: "/name draft", commands: [], method: "drop" },
    { path: "/name draft/file.md", cwd: "/name draft", commands: [], method: "suggestion" },
    {
      path: "/skill:arxiv refs/paper.md",
      cwd: "/skill:arxiv refs",
      commands: [{ name: "arxiv", source: "skill" as const }],
      method: "drop",
    },
    {
      path: "/skill:arxiv refs/paper.md",
      cwd: "/skill:arxiv refs",
      commands: [{ name: "arxiv", source: "skill" as const }],
      method: "suggestion",
    },
  ])(
    "preserves literal file intent for $path via $method independently of command discovery",
    async ({ path, cwd, commands: availableCommands, method }) => {
      const ref = createRef<ChatComposerHandle>();
      const onSend = vi.fn();
      const onCommand = vi.fn();
      vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", path, name: path.split("/").at(-1)! }]);
      const { user } = await renderComposer({ ref, cwd, commands: availableCommands, onSend, onCommand });
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      if (method === "drop") act(() => ref.current?.insertPath(path));
      else {
        await user.type(input, "@");
        await user.click(await screen.findByRole("option", { name: path.split("/").at(-1)! }));
      }
      expect(input).toHaveValue(`"${path}" `);
      expect(screen.getByRole("list", { name: "File references" })).toHaveTextContent(path);
      // Copying the real textarea representation also preserves Pi-safe intent.
      input.select();
      const copied = await user.copy();
      expect(copied?.getData("text/plain")).toBe(`"${path}" `);
      await user.click(screen.getByRole("button", { name: "Send" }));
      expect(onCommand).not.toHaveBeenCalled();
      const submitted = onSend.mock.calls[0]![0] as string;
      expect(submitted).toBe(`"${path}"`);
      expect(submitted.startsWith("/")).toBe(false);
      expect(submitted.startsWith("/skill:")).toBe(false);
    },
  );

  it.each([
    { value: "README notes", start: 0, end: 0, expected: '"/p/a" README notes' },
    { value: "Readme notes", start: 4, end: 4, expected: "Read /p/a me notes" },
    { value: "Read OLDplease", start: 5, end: 8, expected: "Read /p/a please" },
  ])("Files toolbar preserves the unselected suffix in $value", async ({ value, start, end, expected }) => {
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", name: "a", path: "/p/a" }]);
    const { user } = await renderComposer({ cwd: "/p" });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.type(input, value);
    input.setSelectionRange(start, end);
    fireEvent.select(input);
    await user.click(screen.getByRole("button", { name: "Files" }));
    await user.click(await screen.findByRole("option", { name: "a" }));
    expect(input).toHaveValue(expected);
    expect(input).toHaveFocus();
  });

  it.each([
    { annotated: 0, deleted: 0 },
    { annotated: 0, deleted: 1 },
    { annotated: 1, deleted: 0 },
    { annotated: 1, deleted: 1 },
  ])(
    "textarea deletion of duplicate $deleted keeps only the actual annotated occurrence $annotated",
    async ({ annotated, deleted }) => {
      const ref = createRef<ChatComposerHandle>();
      const { user } = await renderComposer({ ref });
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      act(() => ref.current?.setDraft("Read /p/a /p/a"));
      const referenceStart = annotated === 0 ? 5 : 10;
      input.setSelectionRange(referenceStart, referenceStart + 4);
      fireEvent.select(input);
      act(() => ref.current?.insertPath("/p/a"));
      const start = deleted === 0 ? 5 : 9;
      const end = deleted === 0 ? 10 : 14;
      const expected = input.value.slice(0, start) + input.value.slice(end);
      input.setSelectionRange(start, end);
      fireEvent.select(input);
      await user.keyboard("{Backspace}");
      expect(input).toHaveValue(expected);
      if (annotated === deleted) expect(screen.queryByRole("button", { name: "Remove reference /p/a" })).toBeNull();
      else {
        await user.click(screen.getByRole("button", { name: "Remove reference /p/a" }));
        expect(input).toHaveValue(expected.replace("/p/a", ""));
      }
    },
  );

  it.each(["cut", "paste"] as const)("keeps duplicate reference ownership through native %s", async (operation) => {
    const ref = createRef<ChatComposerHandle>();
    const { user } = await renderComposer({ ref });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    act(() => ref.current?.setDraft("Read /p/a /p/a"));
    input.setSelectionRange(10, 14);
    act(() => ref.current?.insertPath("/p/a"));
    input.setSelectionRange(5, 9);
    fireEvent.select(input);
    if (operation === "cut") await user.cut();
    else await user.paste("replacement");
    expect(input).toHaveValue(operation === "cut" ? "Read  /p/a " : "Read replacement /p/a ");
    await user.click(screen.getByRole("button", { name: "Remove reference /p/a" }));
    expect(input).toHaveValue(operation === "cut" ? "Read   " : "Read replacement  ");
  });

  it("tracks composition replacement ranges while preserving a later duplicate reference", async () => {
    const ref = createRef<ChatComposerHandle>();
    const { user } = await renderComposer({ ref });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    act(() => ref.current?.setDraft("Read /p/a /p/a"));
    input.setSelectionRange(10, 14);
    act(() => ref.current?.insertPath("/p/a"));
    input.setSelectionRange(5, 9);
    fireEvent.compositionStart(input);
    for (const text of ["中", "中文"]) {
      fireEvent(
        input,
        new InputEvent("beforeinput", {
          bubbles: true,
          inputType: "insertCompositionText",
          isComposing: true,
          data: text,
        }),
      );
      fireEvent.input(input, {
        target: { value: `Read ${text} /p/a `, selectionStart: 5 + text.length, selectionEnd: 5 + text.length },
        inputType: "insertCompositionText",
        isComposing: true,
        data: text,
      });
    }
    fireEvent.compositionEnd(input);
    expect(input).toHaveValue("Read 中文 /p/a ");
    expect(input.selectionStart).toBe(7);
    await user.click(screen.getByRole("button", { name: "Remove reference /p/a" }));
    expect(input).toHaveValue("Read 中文  ");
  });

  it.each(["historyUndo", "historyRedo", "missing-beforeinput"])(
    "preserves native text/caret and discards unverified annotations on %s",
    async (inputType) => {
      const ref = createRef<ChatComposerHandle>();
      await renderComposer({ ref });
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      act(() => ref.current?.setDraft("Read /p/a /p/a"));
      input.setSelectionRange(5, 9);
      act(() => ref.current?.insertPath("/p/a"));
      if (inputType !== "missing-beforeinput")
        fireEvent(input, new InputEvent("beforeinput", { bubbles: true, inputType }));
      fireEvent.input(input, { target: { value: "Read /p/a", selectionStart: 5, selectionEnd: 5 }, inputType });
      expect(input).toHaveValue("Read /p/a");
      expect(input.selectionStart).toBe(5);
      expect(screen.queryByRole("button", { name: "Remove reference /p/a" })).toBeNull();
    },
  );

  it.each([false, true])(
    "owns only a non-cancelled native edit across the beforeinput microtask checkpoint (cancelled=%s)",
    async (cancelled) => {
      const ref = createRef<ChatComposerHandle>();
      const { user } = await renderComposer({ ref });
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      act(() => ref.current?.setDraft("Read /p/a /p/a"));
      input.setSelectionRange(10, 14);
      act(() => ref.current?.insertPath("/p/a"));
      input.setSelectionRange(5, 10);
      const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteByCut" });
      if (cancelled) before.preventDefault();
      fireEvent(input, before);
      await Promise.resolve();
      fireEvent.input(input, {
        target: { value: "Read /p/a ", selectionStart: 5, selectionEnd: 5 },
        inputType: "deleteByCut",
      });
      expect(input).toHaveValue("Read /p/a ");
      if (cancelled) expect(screen.queryByRole("button", { name: "Remove reference /p/a" })).toBeNull();
      else {
        await user.click(screen.getByRole("button", { name: "Remove reference /p/a" }));
        expect(input).toHaveValue("Read  ");
      }
    },
  );

  it.each(["/name", "/compact"])(
    "keeps a dropped root file %s literal through caret movement and submission",
    async (path) => {
      const ref = createRef<ChatComposerHandle>();
      const onSend = vi.fn();
      const onCommand = vi.fn();
      const { user } = await renderComposer({
        ref,
        cwd: "/",
        onSend,
        onCommand,
        commands: [{ name: path.slice(1), source: "extension" }],
      });
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      act(() => ref.current?.insertPath(path));
      expect(input).toHaveValue(`"${path}" `);
      input.setSelectionRange(3, 3);
      fireEvent.select(input);
      expect(screen.queryByRole("listbox")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Send" }));
      expect(onCommand).not.toHaveBeenCalled();
      expect(onSend).toHaveBeenCalledWith(`"${path}"`);
      expect(onSend.mock.calls[0]![0]).not.toMatch(/^\//);
      await user.type(input, `${path}{Enter}`);
      expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ name: path.slice(1) }), "");
    },
  );

  it("quotes a selected root file and removes its entire literal while keeping its exact path chip", async () => {
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", name: "name", path: "/name" }]);
    const onCommand = vi.fn();
    const { user } = await renderComposer({ cwd: "/", onCommand });
    const input = screen.getByRole("textbox");
    await user.type(input, "@na");
    await user.click(await screen.findByRole("option", { name: "name" }));
    expect(input).toHaveValue('"/name" ');
    expect(screen.getByRole("list", { name: "File references" })).toHaveTextContent("/name");
    await user.click(screen.getByRole("button", { name: "Remove reference /name" }));
    expect(input).toHaveValue(" ");
    expect(screen.queryByRole("list", { name: "File references" })).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("quotes a leading spaced root filename whose first token is a Pi command", async () => {
    const ref = createRef<ChatComposerHandle>();
    const onSend = vi.fn();
    const onCommand = vi.fn();
    const { user } = await renderComposer({ ref, cwd: "/", onSend, onCommand });
    act(() => ref.current?.insertPath("/name with spaces"));
    expect(screen.getByRole("textbox")).toHaveValue('"/name with spaces" ');
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith('"/name with spaces"');
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("preserves file intent when editing away the text before a reference", async () => {
    const ref = createRef<ChatComposerHandle>();
    const onSend = vi.fn();
    const onCommand = vi.fn();
    const { user } = await renderComposer({ ref, cwd: "/", onSend, onCommand });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    act(() => ref.current?.setDraft("Read "));
    act(() => ref.current?.insertPath("/name"));
    expect(input).toHaveValue("Read /name ");
    input.setSelectionRange(0, 5);
    fireEvent.select(input);
    await user.keyboard("{Backspace}");
    expect(input).toHaveValue('"/name" ');
    expect(input.selectionStart).toBe(0);
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith('"/name"');
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("opens Files from the toolbar at the saved selection", async () => {
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", name: "notes.md", path: "/p/notes.md" }]);
    const { user } = await renderComposer({ cwd: "/p" });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.type(input, "Read OLD please");
    input.setSelectionRange(5, 8);
    fireEvent.select(input);
    await user.click(screen.getByRole("button", { name: "Files" }));
    await user.click(await screen.findByRole("option", { name: "notes.md" }));
    expect(input).toHaveValue("Read /p/notes.md please");
    expect(screen.getByRole("list", { name: "File references" })).toHaveTextContent("/p/notes.md");
  });

  it("lists only requested directories, navigates folders and inserts exact text without sending", async () => {
    const onSend = vi.fn();
    const onCommand = vi.fn();
    vi.mocked(api.listEntries).mockImplementation(async (path) =>
      path === "/p"
        ? [
            { kind: "directory", name: "results", path: "/p/results" },
            { kind: "file", name: "notes.md", path: "/p/notes.md" },
          ]
        : [{ kind: "file", name: "table 1.csv", path: "/p/results/table 1.csv" }],
    );
    const { user } = await renderComposer({ cwd: "/p", onSend, onCommand });
    expect(api.listEntries).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox");
    await user.type(input, "Compare @res");
    expect(api.listEntries).toHaveBeenCalledExactlyOnceWith("/p", expect.any(AbortSignal));
    await user.click(await screen.findByRole("option", { name: "results" }));
    expect(input).toHaveValue("Compare @/p/results/");
    await user.click(await screen.findByRole("option", { name: "table 1.csv" }));
    expect(input).toHaveValue("Compare /p/results/table 1.csv ");
    expect(screen.getByText("/p/results/table 1.csv")).toBeVisible();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("Compare /p/results/table 1.csv");
    expect(screen.queryByText("/p/results/table 1.csv")).toBeNull();
  });

  it("completes a typed subdirectory at the caret without reading the root or replacing the suffix", async () => {
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", name: "plot.svg", path: "/p/results/plot.svg" }]);
    const { user } = await renderComposer({ cwd: "/p" });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Read @results/pl then compare" } });
    input.focus();
    input.setSelectionRange(16, 16);
    fireEvent.select(input);
    await user.click(await screen.findByRole("option", { name: "plot.svg" }));
    expect(api.listEntries).toHaveBeenCalledExactlyOnceWith("/p/results", expect.any(AbortSignal));
    expect(input).toHaveValue("Read /p/results/plot.svg then compare");
    expect(input.selectionStart).toBe("Read /p/results/plot.svg".length);
    expect(input).toHaveFocus();
  });

  it("navigates a directory with spaces while preserving a draft suffix", async () => {
    vi.mocked(api.listEntries).mockImplementation(async (path) =>
      path === "/p"
        ? [{ kind: "directory", name: "my results", path: "/p/my results" }]
        : [{ kind: "file", name: "plot.svg", path: "/p/my results/plot.svg" }],
    );
    const { user } = await renderComposer({ cwd: "/p" });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Read @my then compare" } });
    input.focus();
    input.setSelectionRange(8, 8);
    fireEvent.select(input);
    await user.click(await screen.findByRole("option", { name: "my results" }));
    await user.click(await screen.findByRole("option", { name: "plot.svg" }));
    expect(input).toHaveValue("Read /p/my results/plot.svg then compare");
  });

  it("aborts superseded directory requests and ignores late results after Escape and unmount", async () => {
    const requests: { path: string; signal?: AbortSignal; resolve: (entries: FileEntryDto[]) => void }[] = [];
    vi.mocked(api.listEntries).mockImplementation(
      (path, signal) => new Promise((resolve) => requests.push({ path, signal, resolve })),
    );
    const { user, unmount } = await renderComposer({ cwd: "/p" });
    const input = screen.getByRole("textbox");
    await user.type(input, "@");
    expect(requests).toHaveLength(1);
    fireEvent.change(input, { target: { value: "@results/" } });
    expect(requests[0]!.signal?.aborted).toBe(true);
    expect(requests[1]!.path).toBe("/p/results");
    await act(async () => requests[1]!.resolve([{ kind: "file", path: "/p/results/new.md", name: "new.md" }]));
    await act(async () => requests[0]!.resolve([{ kind: "file", path: "/p/old.md", name: "old.md" }]));
    expect(screen.queryByRole("option", { name: "old.md" })).toBeNull();
    expect(screen.getByRole("option", { name: "new.md" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("@results/");
    expect(requests[1]!.signal?.aborted).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.keyboard("n");
    expect(requests).toHaveLength(3);
    unmount();
    expect(requests[2]!.signal?.aborted).toBe(true);
    await act(async () => requests[2]!.resolve([]));
  });

  it("removes only the selected inserted range and follows edits before duplicate paths", async () => {
    const ref = createRef<ChatComposerHandle>();
    const { user } = await renderComposer({ ref });
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    act(() => ref.current?.setDraft("already /p/notes.md; read "));
    act(() => ref.current?.insertPath("/p/notes.md"));
    act(() => ref.current?.insertPath("/p/notes.md"));
    input.setSelectionRange(0, 0);
    fireEvent.select(input);
    await user.keyboard("Please ");
    const removals = screen.getAllByRole("button", { name: /\/p\/notes.md/ });
    await user.click(removals[0]!);
    expect(input).toHaveValue("Please already /p/notes.md; read  /p/notes.md ");
    expect(screen.getAllByRole("button", { name: /\/p\/notes.md/ })).toHaveLength(1);
    fireEvent.change(input, { target: { value: input.value.replace(/notes.md $/, "edited.md ") } });
    expect(screen.queryByRole("button", { name: /\/p\/notes.md/ })).toBeNull();
    expect(input.value).toContain("/p/edited.md");
  });

  it("does not interpret email addresses or traverse outside the session cwd", async () => {
    const { user } = await renderComposer({ cwd: "/p" });
    const input = screen.getByRole("textbox");
    await user.type(input, "person@example.com");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(input, { target: { value: "@../" } });
    expect(api.listEntries).not.toHaveBeenCalled();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("aborts file suggestions when the composer is disabled", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(api.listEntries).mockImplementation((_path, nextSignal) => {
      signal = nextSignal;
      return new Promise(() => {});
    });
    const user = userEvent.setup();
    function Harness() {
      const [disabled, setDisabled] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setDisabled(true)}>
            Disable
          </button>
          <ChatComposer cwd="/p" disabled={disabled} streaming={false} onSend={() => {}} onAbort={() => {}} />
        </>
      );
    }
    render(
      <PreferencesProvider>
        <I18nProvider>
          <Harness />
        </I18nProvider>
      </PreferencesProvider>,
    );
    await user.type(screen.getByRole("textbox"), "@");
    await user.click(screen.getByRole("button", { name: "Disable" }));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("textbox")).toHaveValue("@");
  });
});

describe("ChatComposer sizing", () => {
  it("remeasures typed, restored and inserted drafts, then shrinks after submit", async () => {
    const ref = createRef<ChatComposerHandle>();
    await renderComposer({ ref });
    const input = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    // jsdom has no layout: provide the browser's content measurement, including
    // the current height floor so shrinking requires resetting height first.
    Object.defineProperties(input, {
      clientWidth: { configurable: true, value: 300 },
      scrollHeight: {
        configurable: true,
        get: () => Math.max(52 + input.value.length, Number.parseFloat(input.style.height) || 0),
      },
    });
    fireEvent.change(input, { target: { value: "typed draft" } });
    expect(input).toHaveStyle({ height: "63px" });
    act(() => ref.current?.setDraft("restored draft\nwith another line"));
    expect(input).toHaveStyle({ height: "84px" });
    input.setSelectionRange(input.value.length, input.value.length);
    act(() => ref.current?.insertPath("/paper.md"));
    expect(input).toHaveStyle({ height: "95px" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("");
    expect(input).toHaveStyle({ height: "52px" });
  });
});

describe("ChatComposer single running-state button (ADR-083)", () => {
  it("darkens the shell's one grey border without drawing another focus frame", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i);
    await user.tab();

    expect(input).toHaveFocus();
    expect(input).toHaveStyle({ outline: "none" });
    const shell = input.closest("form");
    expect(shell).toHaveClass("rounded-xl", "max-w-[920px]", "border-v2-grey-200", "focus-within:border-v2-grey-400");
    expect(shell).toContainElement(screen.getByRole("button", { name: /send/i }));
    expect(shell?.className).not.toContain("has-[textarea:focus-visible]:outline");
    expect(shell?.className).not.toContain("focus-within:border-v2-blue-600");
  });

  it("sends while streaming whenever the input has content", async () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    const { user } = await renderComposer({ streaming: true, onSend, onAbort });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("steer note");
    expect(screen.getByLabelText(/send/i)).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("steer note");
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("stops the run while streaming when the input is empty", async () => {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    const { user } = await renderComposer({ streaming: true, onSend, onAbort });
    const stop = screen.getByLabelText(/stop/i);
    await user.click(stop);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps focus in the textarea after sending", async () => {
    const onSend = vi.fn();
    const { user } = await renderComposer({ onSend });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("hello");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(input).toHaveFocus();
  });

  it("keeps focus in the textarea after stopping the run", async () => {
    const { user } = await renderComposer({ streaming: true });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    const stop = screen.getByLabelText(/stop/i);
    await user.click(stop);
    expect(input).toHaveFocus();
  });

  it("restores focus once the composer re-enables after a disabling send cycle", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [busy, setBusy] = useState(false);
      return (
        <ChatComposer
          disabled={busy}
          streaming={false}
          commands={[]}
          onAbort={() => {}}
          onSend={() => {
            setBusy(true);
            setTimeout(() => setBusy(false), 0);
          }}
        />
      );
    }
    render(
      <PreferencesProvider>
        <I18nProvider>
          <Harness />
        </I18nProvider>
      </PreferencesProvider>,
    );
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("hello");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(input).toHaveFocus());
  });
});
