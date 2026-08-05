// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryPicker } from "./DirectoryPicker";
import * as api from "../api";

vi.mock("../api", () => ({
  listDirectories: vi.fn(),
}));

describe("DirectoryPicker", () => {
  beforeEach(() => {
    vi.mocked(api.listDirectories).mockReset();
    vi.mocked(api.listDirectories).mockResolvedValue([
      { name: "papers", path: "/home/user/papers" },
      { name: "notes", path: "/home/user/notes" },
    ]);
  });

  it("lists the home directory on mount", async () => {
    render(<DirectoryPicker homeDir="/home/user" onSelect={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(api.listDirectories).toHaveBeenCalledWith("/home/user"));
    expect(await screen.findByText("papers")).toBeTruthy();
    expect(screen.getByText("notes")).toBeTruthy();
  });

  it("navigates into a child directory and back to parent", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<DirectoryPicker homeDir="/home/user" onSelect={() => {}} onNavigate={onNavigate} />);
    await user.click(await screen.findByText("papers"));
    expect(api.listDirectories).toHaveBeenCalledWith("/home/user/papers");
    expect(onNavigate).toHaveBeenCalledWith("/home/user/papers");
  });

  it("disables Create until a directory is selected", async () => {
    const user = userEvent.setup();
    render(<DirectoryPicker homeDir="/home/user" onSelect={() => {}} onNavigate={() => {}} />);
    const create = screen.getByRole("button", { name: /create/i });
    expect(create).toBeDisabled();
    await user.click(await screen.findByText("papers"));
    expect(create).toBeEnabled();
  });

  it("emits the canonical selected path on Create", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<DirectoryPicker homeDir="/home/user" onSelect={onSelect} onNavigate={() => {}} />);
    await user.click(await screen.findByText("notes"));
    await user.click(screen.getByRole("button", { name: /create/i }));
    expect(onSelect).toHaveBeenCalledWith("/home/user/notes");
  });

  it("never renders file entries", async () => {
    vi.mocked(api.listDirectories).mockResolvedValue([
      { name: "paper.pdf", path: "/home/user/paper.pdf" },
      { name: "src", path: "/home/user/src" },
    ]);
    render(<DirectoryPicker homeDir="/home/user" onSelect={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.queryByText("paper.pdf")).toBeNull());
    expect(await screen.findByText("src")).toBeTruthy();
  });

  it("surfaces listing errors without breaking layout", async () => {
    vi.mocked(api.listDirectories).mockRejectedValueOnce(new Error("boom"));
    render(<DirectoryPicker homeDir="/home/user" onSelect={() => {}} onNavigate={() => {}} />);
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });
});
