import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { FilesPanel } from "./FilesPanel";

vi.mock("../api", () => ({
  listEntries: vi.fn(),
}));

describe("FilesPanel", () => {
  beforeEach(() => {
    vi.mocked(api.listEntries).mockReset();
  });

  it("activates a failed directory retry with the keyboard without collapsing the row", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listEntries).mockImplementation(async (path) => {
      if (path === "/p") return [{ kind: "directory", name: "folder", path: "/p/folder" }];
      throw new Error("boom");
    });
    render(<FilesPanel root="/p" onOpenFile={() => {}} />);

    await user.click(await screen.findByText("folder"));
    const retry = await screen.findByRole("button", { name: "Retry folder" });
    vi.mocked(api.listEntries).mockResolvedValue([{ kind: "file", name: "nested.txt", path: "/p/folder/nested.txt" }]);

    retry.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByText("nested.txt")).toBeVisible();
  });
});
