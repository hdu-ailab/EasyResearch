// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigPage } from "./ConfigPage";
import { ApiError } from "../api";
import * as api from "../api";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, listConfigProjects: vi.fn(), readConfigFile: vi.fn(), writeConfigFile: vi.fn() };
});

describe("ConfigPage", () => {
  beforeEach(() => {
    vi.mocked(api.listConfigProjects).mockReset();
    vi.mocked(api.readConfigFile).mockReset();
    vi.mocked(api.writeConfigFile).mockReset();
    vi.mocked(api.listConfigProjects).mockResolvedValue({ home: "/home/u", projects: [{ cwd: "/home/u/proj" }, { cwd: "/tmp/other" }] });
    vi.mocked(api.readConfigFile).mockResolvedValue({ path: "settings.json", content: '{"lazyresearch":{"agentModels":{"search":"a/1"}}}' });
  });

  it("pins home on top labeled 全局配置", async () => {
    render(<ConfigPage onBack={() => {}} />);
    const list = await screen.findByRole("list", { name: /project folders/i });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent(/全局配置/);
    expect(items[0]).toHaveTextContent("/home/u");
    expect(items[1]).toHaveTextContent("/home/u/proj");
  });

  it("opens settings.json editor when a project is clicked, preserves other fields on save", async () => {
    const user = userEvent.setup();
    render(<ConfigPage onBack={() => {}} />);
    await user.click(await screen.findByText("/home/u/proj"));
    const editor = await screen.findByRole("textbox", { name: /settings.json/i });
    expect(editor).toHaveValue(JSON.stringify({ lazyresearch: { agentModels: { search: "a/1" } } }, null, 2));
    await user.clear(editor);
    fireEvent.change(editor, { target: { value: '{"lazyresearch":{"agentModels":{"search":"b/2"}},"theme":"light"}' } });
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(api.writeConfigFile).toHaveBeenCalledWith("project", "/home/u/proj", "settings.json", '{"lazyresearch":{"agentModels":{"search":"b/2"}},"theme":"light"}');
  });

  it("shows field help when ? is clicked", async () => {
    const user = userEvent.setup();
    render(<ConfigPage onBack={() => {}} />);
    await user.click(await screen.findByText("/home/u/proj"));
    await user.click(await screen.findByRole("button", { name: /\?/i }));
    const dialog = await screen.findByRole("dialog", { name: /settings help/i });
    expect(within(dialog).getAllByText(/agentModels/i).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/example/i)).toBeTruthy();
  });

  it("stays on the projects list when a read fails with a non-404 error, hiding the stale editor", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readConfigFile)
      .mockResolvedValueOnce({ path: "settings.json", content: '{"old":1}' })
      .mockRejectedValueOnce(new ApiError(500, { error: "boom" }));
    render(<ConfigPage onBack={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /全局配置/ }));
    expect(await screen.findByRole("textbox", { name: /settings.json/i })).toHaveValue(
      JSON.stringify({ old: 1 }, null, 2),
    );
    await user.click(screen.getByRole("button", { name: /back to projects/i }));
    await user.click(await screen.findByText("/home/u/proj"));
    expect(await screen.findByRole("list", { name: /project folders/i })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /settings.json/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(/boom/);
  });

  it("opens an empty editor when the file does not exist (404)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readConfigFile).mockRejectedValueOnce(new ApiError(404, { error: "not found" }));
    render(<ConfigPage onBack={() => {}} />);
    await user.click(await screen.findByText("/home/u/proj"));
    expect(await screen.findByRole("textbox", { name: /settings.json/i })).toHaveValue("{}");
  });
});
