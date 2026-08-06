// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigPage } from "./ConfigPage";
import * as api from "../api";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, listConfigProjects: vi.fn(), readConfigFile: vi.fn(), writeConfigFile: vi.fn() };
});

describe("ConfigPage", () => {
  beforeEach(() => {
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
});
