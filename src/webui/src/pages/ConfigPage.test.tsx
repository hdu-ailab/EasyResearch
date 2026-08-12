import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { ApiError } from "../api";
import { ConfigPage } from "./ConfigPage";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listConfigProjects: vi.fn(),
    listConfig: vi.fn(),
    readConfigFile: vi.fn(),
    writeConfigFile: vi.fn(),
    createConfigDirectory: vi.fn(),
  };
});

describe("ConfigPage", () => {
  beforeEach(() => {
    vi.mocked(api.listConfigProjects)
      .mockReset()
      .mockResolvedValue({
        home: "/home/u",
        projects: [{ cwd: "/home/u/proj" }, { cwd: "/tmp/other" }],
      });
    vi.mocked(api.listConfig)
      .mockReset()
      .mockResolvedValue([
        { name: "settings.json", path: "settings.json", type: "file" },
        { name: "notes.md", path: "notes.md", type: "file" },
        { name: "agents", path: "agents", type: "directory" },
      ]);
    vi.mocked(api.readConfigFile).mockReset().mockResolvedValue({ path: "notes.md", content: "# Notes\n" });
    vi.mocked(api.writeConfigFile).mockReset().mockResolvedValue();
    vi.mocked(api.createConfigDirectory).mockReset().mockResolvedValue();
  });

  it("lists the global root before project roots", async () => {
    render(<ConfigPage onBack={() => {}} />);
    const list = await screen.findByRole("list", { name: /project folder/i });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/Global/);
    expect(items[0]).toHaveTextContent("/home/u");
    expect(items[1]).toHaveTextContent("/home/u/proj");
  });

  it("opens a project and reads a Markdown file without JSON parsing", async () => {
    const user = userEvent.setup();
    render(<ConfigPage onBack={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    expect(api.readConfigFile).toHaveBeenCalledWith("project", "/home/u/proj", "notes.md");

    vi.mocked(api.listConfig).mockResolvedValueOnce([{ name: "notes.md", path: "notes.md", type: "file" }]);
    await user.click(screen.getByRole("button", { name: /back to files/i }));
    await user.click(screen.getByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    expect(await screen.findByRole("textbox", { name: /editor/i })).toHaveValue("# Notes\n");
  });

  it("saves Markdown verbatim", async () => {
    const user = userEvent.setup();
    render(<ConfigPage onBack={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "notes.md" }));
    const editor = await screen.findByRole("textbox", { name: /editor/i });
    fireEvent.change(editor, { target: { value: "---\nname: reviewer\n---\n# Draft\n" } });
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(api.writeConfigFile).toHaveBeenCalledWith(
      "project",
      "/home/u/proj",
      "notes.md",
      "---\nname: reviewer\n---\n# Draft\n",
    );
  });

  it("rejects malformed JSON while allowing other text", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readConfigFile).mockResolvedValue({ path: "settings.json", content: "{\n" });
    render(<ConfigPage onBack={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "settings.json" }));
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid json/i);
    expect(api.writeConfigFile).not.toHaveBeenCalled();
  });

  it("creates a directory under the current config path", async () => {
    const user = userEvent.setup();
    render(<ConfigPage onBack={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByTitle("New folder"));
    await user.type(screen.getByRole("dialog").querySelector("input")!, "skills/reviewer");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /confirm/i }));
    expect(api.createConfigDirectory).toHaveBeenCalledWith("project", "/home/u/proj", "skills/reviewer");
  });

  it("keeps the editor error visible when a file read fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readConfigFile).mockRejectedValueOnce(new ApiError(500, { error: "boom" }));
    render(<ConfigPage onBack={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /\/home\/u\/proj/ }));
    await user.click(screen.getByRole("button", { name: "settings.json" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
