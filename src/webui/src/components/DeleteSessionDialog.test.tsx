import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { DeleteSessionDialog } from "./DeleteSessionDialog";

const session = { id: "root-1", cwd: "/paper", sessionName: "Paper", status: "ready" as const, isStreaming: false };

describe("DeleteSessionDialog", () => {
  it("requires renewed explicit confirmation when the server expands the complete scope set", async () => {
    const initial = [session.cwd, "/migrated/a"];
    const expanded = [...initial, "/migrated/b"];
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, { code: "SESSION_BUSY", error: "busy", affectedCwds: initial }))
      .mockRejectedValueOnce(
        new ApiError(409, { code: "SESSION_BUSY", error: "scopes expanded", affectedCwds: expanded }),
      )
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DeleteSessionDialog session={session} onDelete={onDelete} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(false, undefined);
    expect(screen.getByText("/migrated/a")).toBeVisible();
    expect(screen.queryByText("/migrated/b")).not.toBeInTheDocument();
    expect(screen.getAllByText(session.cwd)).toHaveLength(1);
    await user.dblClick(screen.getByRole("button", { name: "Stop and delete" }));
    expect(onDelete.mock.calls).toEqual([
      [false, undefined],
      [true, initial],
    ]);
    expect(screen.getByText("/migrated/a")).toBeVisible();
    expect(screen.getByText("/migrated/b")).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Stop and delete" }));
    expect(onDelete.mock.calls).toEqual([
      [false, undefined],
      [true, initial],
      [true, expanded],
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("discards prior authorization when a forced request receives malformed scopes", async () => {
    const scopes = [session.cwd, "/migrated/a"];
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, { code: "SESSION_BUSY", error: "busy", affectedCwds: scopes }))
      .mockRejectedValueOnce(
        new ApiError(409, { code: "SESSION_BUSY", error: "Malformed busy scopes", affectedCwds: ["/migrated/a", {}] }),
      )
      .mockRejectedValueOnce(new ApiError(409, { code: "SESSION_BUSY", error: "legacy busy" }))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<DeleteSessionDialog session={session} onDelete={onDelete} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Stop and delete" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Malformed busy scopes");
    expect(screen.queryByText("/migrated/a")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop and delete" })).not.toBeInTheDocument();
    expect(onDelete).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Retry deletion" }));
    expect(onDelete).toHaveBeenNthCalledWith(3, false, undefined);
    await user.click(screen.getByRole("button", { name: "Stop and delete" }));
    expect(onDelete).toHaveBeenNthCalledWith(4, true, undefined);
  });

  it("lets a user cancel busy escalation without authorizing force", async () => {
    const onDelete = vi.fn().mockRejectedValue(new ApiError(409, { code: "SESSION_BUSY", error: "Active work" }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DeleteSessionDialog session={session} onDelete={onDelete} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Stop and delete" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(false, undefined);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("preserves generic errors and retries without stale stop authorization", async () => {
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, { code: "SESSION_BUSY", error: "busy", affectedCwds: ["/new/paper"] }))
      .mockRejectedValueOnce(new Error("History is locked"))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DeleteSessionDialog session={{ ...session, status: "running" }} onDelete={onDelete} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(false, undefined);
    expect(screen.getByText("/new/paper")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Stop and delete" }));
    expect(screen.getByRole("alert")).toHaveTextContent("History is locked");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("/new/paper")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry deletion" }));
    expect(onDelete.mock.calls).toEqual([
      [false, undefined],
      [true, ["/new/paper"]],
      [false, undefined],
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not treat a double click as confirmation of newly discovered scopes", async () => {
    const onDelete = vi.fn().mockRejectedValue(
      new ApiError(409, {
        code: "SESSION_BUSY",
        error: "busy",
        affectedCwds: ["/new/paper"],
      }),
    );
    const user = userEvent.setup();
    render(<DeleteSessionDialog session={{ ...session, status: "running" }} onDelete={onDelete} onClose={vi.fn()} />);
    await user.dblClick(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(false, undefined);
    expect(screen.getByText("/new/paper")).toBeVisible();
  });

  it("clears force and scope disclosure after a persistent conflict, preserving explicit non-forcing recovery", async () => {
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, { code: "SESSION_BUSY", error: "busy", affectedCwds: ["/new/paper"] }))
      .mockRejectedValue(new ApiError(409, { code: "SESSION_HISTORY_CONFLICT", error: "mapping mismatch" }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DeleteSessionDialog session={session} onDelete={onDelete} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Stop and delete" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/repair the history records before deleting/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/refresh/i);
    expect(screen.queryByText("/new/paper")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop and delete" })).not.toBeInTheDocument();
    expect(onDelete.mock.calls).toEqual([
      [false, undefined],
      [true, ["/new/paper"]],
    ]);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete.mock.calls).toEqual([
      [false, undefined],
      [true, ["/new/paper"]],
      [false, undefined],
    ]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("never offers force for an initial history conflict or an invalid busy scope list", async () => {
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, { code: "SESSION_HISTORY_CONFLICT", error: "identity mismatch" }))
      .mockRejectedValueOnce(
        new ApiError(409, { code: "SESSION_BUSY", error: "Invalid scope response", affectedCwds: [{}] }),
      );
    const user = userEvent.setup();
    render(<DeleteSessionDialog session={{ ...session, status: "running" }} onDelete={onDelete} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/history paths or references conflict/i);
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(false, undefined);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid scope response");
    expect(screen.queryByRole("button", { name: "Stop and delete" })).not.toBeInTheDocument();
    expect(onDelete.mock.calls).toEqual([
      [false, undefined],
      [false, undefined],
    ]);
  });

  it("starts fresh for a different session and respects IME cancellation", async () => {
    const onDelete = vi.fn().mockRejectedValue(
      new ApiError(409, {
        code: "SESSION_BUSY",
        error: "busy",
        affectedCwds: ["/new/paper"],
      }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    const view = render(<DeleteSessionDialog session={session} onDelete={onDelete} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    view.rerender(<DeleteSessionDialog session={{ ...session, id: "root-2" }} onDelete={onDelete} onClose={onClose} />);
    expect(screen.queryByText("/new/paper")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(screen.getByRole("button", { name: "Delete" }), { key: "Enter", isComposing: true })).toBe(
      false,
    );
    expect(onDelete).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete.mock.calls).toEqual([
      [false, undefined],
      [false, undefined],
    ]);
  });

  it("admits only one submit even before React commits the pending state", async () => {
    let resolve!: () => void;
    const onDelete = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const onClose = vi.fn();
    render(<DeleteSessionDialog session={session} onDelete={onDelete} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    act(() => {
      fireEvent.submit(dialog);
      fireEvent.submit(dialog);
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(false, undefined);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
