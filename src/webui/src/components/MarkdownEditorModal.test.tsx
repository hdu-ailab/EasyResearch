import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { MarkdownEditorModal } from "./MarkdownEditorModal";

function renderModal(onSave = vi.fn(), onClose = vi.fn()) {
  return render(
    <PreferencesProvider>
      <I18nProvider>
        <MarkdownEditorModal
          title="Edit search"
          filePath="agents/search.md"
          content="# Prompt"
          saveLabel="Save changes"
          onSave={onSave}
          onClose={onClose}
        />
      </I18nProvider>
    </PreferencesProvider>,
  );
}

describe("MarkdownEditorModal", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses the full mobile viewport and keeps its desktop editor geometry at 820px", () => {
    renderModal();

    const dialog = screen.getByRole("dialog", { name: "Edit search" });
    expect(dialog.parentElement).toHaveClass("p-0", "min-[820px]:p-6");
    expect(dialog).toHaveClass(
      "h-full",
      "w-full",
      "min-[820px]:h-auto",
      "min-[820px]:max-h-[min(900px,calc(100vh-24px))]",
      "min-[820px]:max-w-[1000px]",
      "min-[820px]:rounded-[10px]",
    );
    expect(dialog).not.toHaveClass("max-h-[min(900px,calc(100vh-24px))]", "max-w-[1000px]", "rounded-[10px]");
    expect(screen.getByRole("textbox", { name: "Markdown editor" })).toHaveClass(
      "h-full",
      "min-h-0",
      "min-[820px]:h-[min(68vh,680px)]",
      "min-[820px]:min-h-[320px]",
    );
  });

  it("saves edited Markdown from a large modal", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderModal(onSave);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("min-[820px]:max-w-[1000px]");
    const editor = screen.getByRole("textbox", { name: "Markdown editor" });
    expect(editor).toHaveFocus();
    await user.clear(editor);
    await user.type(editor, "# Updated");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith("# Updated");
  });

  it("confirms before discarding dirty edits", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderModal(vi.fn(), onClose);
    const editor = screen.getByRole("textbox", { name: "Markdown editor" });
    await user.type(editor, "\nchanged");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
