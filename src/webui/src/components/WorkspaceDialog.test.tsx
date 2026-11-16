import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMutationResultDto } from "../../../web/contracts";
import * as api from "../api";
import { I18nContext } from "../i18n/I18nProvider";
import { messages } from "../i18n/messages";
import { ViewActivityProvider } from "../view-activity";
import { WorkspaceDialog, type WorkspaceDialogProps } from "./WorkspaceDialog";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  renameWorkspace: vi.fn(),
  relocateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
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
  vi.mocked(api.deleteWorkspace).mockReset();
  vi.mocked(api.listDirectories)
    .mockReset()
    .mockImplementation(async (path) => ({ path, entries: [] }));
  vi.mocked(api.listDirectoryRoots)
    .mockReset()
    .mockResolvedValue([{ name: "/", path: "/" }]);
});

describe("WorkspaceDialog retained ownership", () => {
  it("replaces acknowledged scopes and waits for a new force click when deletion scope expands", async () => {
    const initial = ["/project", "/migrated/a"];
    const expanded = [...initial, "/migrated/b"];
    vi.mocked(api.deleteWorkspace)
      .mockRejectedValueOnce(new api.ApiError(409, { code: "WORKSPACE_BUSY", error: "busy", affectedCwds: initial }))
      .mockRejectedValueOnce(
        new api.ApiError(409, { code: "WORKSPACE_BUSY", error: "scopes expanded", affectedCwds: expanded }),
      )
      .mockResolvedValueOnce({ cwd: "/project", sessionIds: ["root"] });
    const complete = vi.fn();
    const user = userEvent.setup();
    render(<RetainedWorkspace active mode="delete" onComplete={complete} />);
    await user.click(screen.getByRole("button", { name: "open workspace" }));
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(api.deleteWorkspace).toHaveBeenCalledExactlyOnceWith("/project", false, undefined);
    expect(screen.getByText("/migrated/a")).toBeVisible();
    expect(screen.queryByText("/migrated/b")).not.toBeInTheDocument();
    await user.dblClick(screen.getByRole("button", { name: "Stop and continue" }));
    expect(api.deleteWorkspace).toHaveBeenCalledTimes(2);
    expect(api.deleteWorkspace).toHaveBeenNthCalledWith(2, "/project", true, initial);
    expect(screen.getByText("/migrated/a")).toBeVisible();
    expect(screen.getByText("/migrated/b")).toBeVisible();
    expect(complete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Stop and continue" }));
    expect(api.deleteWorkspace).toHaveBeenNthCalledWith(3, "/project", true, expanded);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("clears old scope authorization after malformed busy data and supports a fresh legacy confirmation", async () => {
    const scopes = ["/project", "/migrated/a"];
    vi.mocked(api.deleteWorkspace)
      .mockRejectedValueOnce(new api.ApiError(409, { code: "WORKSPACE_BUSY", error: "busy", affectedCwds: scopes }))
      .mockRejectedValueOnce(
        new api.ApiError(409, { code: "WORKSPACE_BUSY", error: "Malformed busy scopes", affectedCwds: {} }),
      )
      .mockRejectedValueOnce(new api.ApiError(409, { code: "WORKSPACE_BUSY", error: "legacy busy" }))
      .mockResolvedValueOnce({ cwd: "/project", sessionIds: ["root"] });
    const user = userEvent.setup();
    render(<RetainedWorkspace active mode="delete" />);
    await user.click(screen.getByRole("button", { name: "open workspace" }));
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    await user.click(screen.getByRole("button", { name: "Stop and continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Malformed busy scopes");
    expect(screen.queryByText("/migrated/a")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop and continue" })).not.toBeInTheDocument();
    expect(api.deleteWorkspace).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(api.deleteWorkspace).toHaveBeenNthCalledWith(3, "/project", false, undefined);
    await user.click(screen.getByRole("button", { name: "Stop and continue" }));
    expect(api.deleteWorkspace).toHaveBeenNthCalledWith(4, "/project", true, undefined);
  });

  it("discloses migrated scopes before an explicit force and blocks duplicate submit and dismissal", async () => {
    const request = Promise.withResolvers<WorkspaceMutationResultDto>();
    vi.mocked(api.deleteWorkspace)
      .mockReturnValueOnce(request.promise)
      .mockResolvedValueOnce({ cwd: "/project", sessionIds: ["root"] });
    const user = userEvent.setup();
    const complete = vi.fn();
    render(<RetainedWorkspace active mode="delete" onComplete={complete} />);
    await user.click(screen.getByRole("button", { name: "open workspace" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.submit(dialog);
    fireEvent.submit(dialog);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(api.deleteWorkspace).toHaveBeenCalledExactlyOnceWith("/project", false, undefined);
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () =>
      request.reject(
        new api.ApiError(409, {
          code: "WORKSPACE_BUSY",
          error: "busy",
          affectedCwds: ["/project", "/migrated/project", "/migrated/project"],
        }),
      ),
    );
    expect(within(dialog).getAllByText("/migrated/project")).toHaveLength(1);
    expect(within(dialog).getAllByText("/project")).toHaveLength(1);
    expect(dialog).toHaveTextContent("Active work in these workspaces will also stop");
    expect(api.deleteWorkspace).toHaveBeenCalledOnce();
    await user.click(within(dialog).getByRole("button", { name: "Stop and continue" }));
    expect(api.deleteWorkspace).toHaveBeenNthCalledWith(2, "/project", true, ["/project", "/migrated/project"]);
    expect(complete).toHaveBeenCalledExactlyOnceWith({ cwd: "/project", sessionIds: ["root"] }, true);
  });

  it("does not turn a double click into force confirmation", async () => {
    vi.mocked(api.deleteWorkspace).mockRejectedValue(
      new api.ApiError(409, {
        code: "WORKSPACE_BUSY",
        error: "busy",
        affectedCwds: ["/migrated/project"],
      }),
    );
    const user = userEvent.setup();
    render(<RetainedWorkspace active mode="delete" />);
    await user.click(screen.getByRole("button", { name: "open workspace" }));
    await user.dblClick(screen.getByRole("button", { name: "Delete workspace" }));
    expect(api.deleteWorkspace).toHaveBeenCalledExactlyOnceWith("/project", false, undefined);
    expect(screen.getByRole("button", { name: "Stop and continue" })).toBeEnabled();
  });

  it.each(["en", "zh-CN"] as const)(
    "shows actionable %s history conflicts without forcing or retrying automatically",
    async (language) => {
      vi.mocked(api.deleteWorkspace).mockRejectedValue(
        new api.ApiError(409, {
          code: "SESSION_HISTORY_CONFLICT",
          error: "identity mismatch",
        }),
      );
      const user = userEvent.setup();
      render(
        <I18nContext.Provider value={{ language, setLanguage: () => {}, t: (key) => messages[language][key] }}>
          <RetainedWorkspace active mode="delete" />
        </I18nContext.Provider>,
      );
      await user.click(screen.getByRole("button", { name: "open workspace" }));
      await user.click(screen.getByRole("button", { name: messages[language]["workspace.delete"] }));
      expect(screen.getByRole("alert")).toHaveTextContent(messages[language]["history.conflict"]);
      expect(screen.getByRole("alert")).not.toHaveTextContent(/refresh|刷新/i);
      expect(
        screen.queryByRole("button", { name: messages[language]["workspace.stopAndContinue"] }),
      ).not.toBeInTheDocument();
      expect(api.deleteWorkspace).toHaveBeenCalledExactlyOnceWith("/project", false, undefined);
    },
  );

  it("clears discovered scopes and force after a persistent conflict", async () => {
    vi.mocked(api.deleteWorkspace)
      .mockRejectedValueOnce(
        new api.ApiError(409, { code: "WORKSPACE_BUSY", error: "busy", affectedCwds: ["/migrated/project"] }),
      )
      .mockRejectedValue(new api.ApiError(409, { code: "SESSION_HISTORY_CONFLICT", error: "identity mismatch" }));
    const user = userEvent.setup();
    render(<RetainedWorkspace active mode="delete" />);
    await user.click(screen.getByRole("button", { name: "open workspace" }));
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    await user.click(screen.getByRole("button", { name: "Stop and continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/repair the history records before deleting/i);
    expect(screen.queryByText("/migrated/project")).not.toBeInTheDocument();
    expect(api.deleteWorkspace).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(vi.mocked(api.deleteWorkspace).mock.calls).toEqual([
      ["/project", false, undefined],
      ["/project", true, ["/migrated/project"]],
      ["/project", false, undefined],
    ]);
  });

  it("preserves unknown error messages and rejects malformed scopes without offering force", async () => {
    vi.mocked(api.deleteWorkspace)
      .mockRejectedValueOnce(
        new api.ApiError(409, {
          code: "WORKSPACE_BUSY",
          error: "Invalid scope response",
          affectedCwds: [{}],
        }),
      )
      .mockRejectedValueOnce(new api.ApiError(409, { code: "UNKNOWN", error: "History is locked" }));
    const user = userEvent.setup();
    render(<RetainedWorkspace active mode="delete" />);
    await user.click(screen.getByRole("button", { name: "open workspace" }));
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid scope response");
    expect(screen.queryByRole("button", { name: "Stop and continue" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(screen.getByRole("alert")).toHaveTextContent("History is locked");
    expect(vi.mocked(api.deleteWorkspace).mock.calls).toEqual([
      ["/project", false, undefined],
      ["/project", false, undefined],
    ]);
  });

  it("clears scopes for a fresh dialog and when switching recovery to deletion", async () => {
    const busy = new api.ApiError(409, { code: "WORKSPACE_BUSY", error: "busy", affectedCwds: ["/migrated/project"] });
    vi.mocked(api.renameWorkspace)
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(
        new api.ApiError(404, {
          code: "WORKSPACE_MISSING",
          cwd: "/project",
          error: "missing",
        }),
      );
    vi.mocked(api.deleteWorkspace).mockRejectedValue(busy);
    const user = userEvent.setup();
    render(<RetainedWorkspace active />);
    await user.click(screen.getByRole("button", { name: "open workspace" }));
    await user.click(screen.getByRole("button", { name: "Edit workspace name" }));
    expect(screen.getByText("/migrated/project")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Stop and continue" }));
    expect(screen.getByRole("dialog", { name: "Workspace folder not found" })).toBeVisible();
    expect(screen.queryByText("/migrated/project")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(api.deleteWorkspace).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(api.deleteWorkspace).toHaveBeenCalledExactlyOnceWith("/project", false, undefined);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "open workspace" }));
    expect(screen.queryByText("/migrated/project")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop and continue" })).not.toBeInTheDocument();
    const input = screen.getByLabelText("Folder name");
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(false);
    expect(api.renameWorkspace).toHaveBeenCalledTimes(2);
  });

  it("resets confirmation when its target or entry mode changes", async () => {
    vi.mocked(api.deleteWorkspace).mockRejectedValue(
      new api.ApiError(409, {
        code: "WORKSPACE_BUSY",
        error: "busy",
        affectedCwds: ["/migrated/project"],
      }),
    );
    const props = { cwd: "/project", homeDir: "/home/user", onComplete: vi.fn(), onClose: vi.fn() };
    const user = userEvent.setup();
    const view = render(<WorkspaceDialog {...props} mode="delete" />);
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    view.rerender(<WorkspaceDialog {...props} mode="missing" />);
    expect(screen.queryByText("/migrated/project")).not.toBeInTheDocument();
    view.rerender(<WorkspaceDialog {...props} cwd="/another" mode="delete" />);
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(api.deleteWorkspace).toHaveBeenNthCalledWith(2, "/another", false, undefined);
  });

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
