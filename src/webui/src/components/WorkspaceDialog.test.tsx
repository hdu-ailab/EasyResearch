import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMutationResultDto } from "../../../web/contracts";
import * as api from "../api";
import { ViewActivityProvider } from "../view-activity";
import { WorkspaceDialog, type WorkspaceDialogProps } from "./WorkspaceDialog";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  renameWorkspace: vi.fn(),
  relocateWorkspace: vi.fn(),
  listDirectories: vi.fn(),
  listDirectoryRoots: vi.fn(),
}));

function RetainedWorkspace({
  active,
  mode = "rename",
  onComplete = () => {},
}: {
  active: boolean;
  mode?: WorkspaceDialogProps["mode"];
  onComplete?: WorkspaceDialogProps["onComplete"];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">other root</button>
      <ViewActivityProvider visible={active} interactive={active}>
        <button type="button" onClick={() => setOpen(true)}>
          open workspace
        </button>
        {open && (
          <WorkspaceDialog
            cwd="/project"
            homeDir="/home/user"
            mode={mode}
            onComplete={onComplete}
            onClose={() => setOpen(false)}
          />
        )}
      </ViewActivityProvider>
    </>
  );
}

beforeEach(() => {
  vi.mocked(api.renameWorkspace).mockReset();
  vi.mocked(api.relocateWorkspace).mockReset();
  vi.mocked(api.listDirectories)
    .mockReset()
    .mockImplementation(async (path) => ({ path, entries: [] }));
  vi.mocked(api.listDirectoryRoots)
    .mockReset()
    .mockResolvedValue([{ name: "/", path: "/" }]);
});

describe("WorkspaceDialog retained ownership", () => {
  it("hides its outer backdrop and retains an editable name while its root is inactive", async () => {
    const user = userEvent.setup();
    const view = render(<RetainedWorkspace active />);
    const opener = screen.getByRole("button", { name: "open workspace" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Edit workspace name" });
    const backdrop = dialog.parentElement!;
    const name = within(dialog).getByLabelText("Folder name");
    fireEvent.change(name, { target: { value: "unsaved project name" } });
    const restore = vi.spyOn(opener, "focus");
    view.rerender(<RetainedWorkspace active={false} />);
    expect(backdrop).toHaveStyle({ visibility: "hidden" });
    expect(backdrop).toHaveAttribute("inert");
    expect(name).not.toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const other = screen.getByRole("button", { name: "other root" });
    other.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(other).toHaveFocus();
    expect(restore).not.toHaveBeenCalled();
    view.rerender(<RetainedWorkspace active />);
    expect(within(screen.getByRole("dialog")).getByLabelText("Folder name")).toBe(name);
    expect(name).toHaveValue("unsaved project name");
    expect(backdrop).not.toHaveAttribute("inert");
    expect(name).toBeVisible();
  });

  it("finishes an admitted rename in its original root while hidden without focusing its connected opener", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<WorkspaceMutationResultDto>();
    vi.mocked(api.renameWorkspace).mockReturnValue(pending.promise);
    const complete = vi.fn();
    const view = render(<RetainedWorkspace active onComplete={complete} />);
    const opener = screen.getByRole("button", { name: "open workspace" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Folder name"), { target: { value: "renamed" } });
    fireEvent.submit(dialog);
    expect(api.renameWorkspace).toHaveBeenCalledExactlyOnceWith("/project", "renamed", false);
    expect(dialog).toHaveAttribute("aria-busy", "true");
    view.rerender(<RetainedWorkspace active={false} onComplete={complete} />);
    expect(dialog.parentElement).toHaveStyle({ visibility: "hidden" });
    const other = screen.getByRole("button", { name: "other root" });
    other.focus();
    const restore = vi.spyOn(opener, "focus");
    const result = { cwd: "/renamed", sessionIds: ["root-a"] };
    await act(async () => pending.resolve(result));
    expect(complete).toHaveBeenCalledExactlyOnceWith(result, false);
    expect(dialog).not.toBeInTheDocument();
    expect(restore).not.toHaveBeenCalled();
    expect(other).toHaveFocus();
    view.rerender(<RetainedWorkspace active onComplete={complete} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.renameWorkspace).toHaveBeenCalledOnce();
  });

  it("suspends the nested directory chooser with its outer owner while preserving the path draft", async () => {
    const user = userEvent.setup();
    const view = render(<RetainedWorkspace active mode="missing" />);
    await user.click(screen.getByRole("button", { name: "open workspace" }));
    const recovery = screen.getByRole("dialog", { name: "Workspace folder not found" });
    await user.click(within(recovery).getByRole("button", { name: "Choose new folder" }));
    const picker = screen.getByRole("dialog", { name: "Choose new folder" });
    const path = within(picker).getByRole("combobox");
    fireEvent.change(path, { target: { value: "/draft/target" } });
    await waitFor(() => expect(api.listDirectories).toHaveBeenCalledWith("/draft"));
    view.rerender(<RetainedWorkspace active={false} mode="missing" />);
    expect(recovery.parentElement).toHaveStyle({ visibility: "hidden" });
    expect(path).not.toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const other = screen.getByRole("button", { name: "other root" });
    other.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(other).toHaveFocus();
    view.rerender(<RetainedWorkspace active mode="missing" />);
    expect(screen.getByRole("dialog", { name: "Choose new folder" })).toBe(picker);
    expect(path).toHaveValue("/draft/target");
    expect(path).toBeVisible();
    expect(api.relocateWorkspace).not.toHaveBeenCalled();
  });
});
