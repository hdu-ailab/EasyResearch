import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { DeleteSessionDialog } from "./DeleteSessionDialog";

const session = { id: "root-1", cwd: "/paper", sessionName: "Paper", status: "ready" as const, isStreaming: false };

describe("DeleteSessionDialog", () => {
  it("lets a user cancel busy escalation without authorizing force", async () => {
    const onDelete = vi.fn().mockRejectedValue(new ApiError(409, { code: "SESSION_BUSY", error: "Active work" }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DeleteSessionDialog session={session} onDelete={onDelete} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("button", { name: "Stop and delete" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("retains explicit stop authorization through a failed forced request and retry", async () => {
    const onDelete = vi.fn().mockRejectedValueOnce(new Error("History is locked")).mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DeleteSessionDialog session={{ ...session, status: "running" }} onDelete={onDelete} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Stop and delete" }));
    expect(screen.getByRole("alert")).toHaveTextContent("History is locked");
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Stop and delete" }));
    expect(onDelete.mock.calls).toEqual([[true], [true]]);
    expect(onClose).toHaveBeenCalledTimes(1);
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
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(false);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
