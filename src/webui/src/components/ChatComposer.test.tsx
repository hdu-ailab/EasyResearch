import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";

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

  it("navigates with ArrowDown and escapes", async () => {
    const { user } = await renderComposer();
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(input.value).toBe("/drawio ");
  });

  it("moves command selection to Home and End", async () => {
    const onCommand = vi.fn();
    const { user } = await renderComposer({ onCommand });
    const input = screen.getByLabelText(/message/i) as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard("/{End}");
    expect(document.getElementById(input.getAttribute("aria-activedescendant") ?? "")).toHaveTextContent("/name");
    await user.keyboard("{Home}");
    expect(document.getElementById(input.getAttribute("aria-activedescendant") ?? "")).toHaveTextContent("/arxiv");
    await user.keyboard("{End}{Enter}");
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
    expect(input.parentElement).toHaveClass("border-v2-grey-200", "focus-within:border-v2-grey-400");
    expect(input.parentElement?.className).not.toContain("has-[textarea:focus-visible]:outline");
    expect(input.parentElement?.className).not.toContain("focus-within:border-v2-blue-600");
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
