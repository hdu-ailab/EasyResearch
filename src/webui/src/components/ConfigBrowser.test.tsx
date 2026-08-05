// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigBrowser } from "./ConfigBrowser";
import * as api from "../api";
import type { ConfigEntryDto } from "../types";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    listConfig: vi.fn(),
    readConfigFile: vi.fn(),
    writeConfigFile: vi.fn(),
    createConfigDirectory: vi.fn(),
    restartSession: vi.fn(),
  };
});

const settingsEntry: ConfigEntryDto = { name: "settings.json", path: "settings.json", type: "file" };
const modelsEntry: ConfigEntryDto = { name: "models.json", path: "models.json", type: "file" };
const authEntry: ConfigEntryDto = { name: "auth.json", path: "auth.json", type: "file" };
const dirEntry: ConfigEntryDto = { name: "sub", path: "sub", type: "directory" };

describe("ConfigBrowser", () => {
  beforeEach(() => {
    vi.mocked(api.listConfig).mockReset();
    vi.mocked(api.readConfigFile).mockReset();
    vi.mocked(api.writeConfigFile).mockReset();
    vi.mocked(api.createConfigDirectory).mockReset();
    vi.mocked(api.restartSession).mockReset();
    vi.mocked(api.listConfig).mockResolvedValue([settingsEntry, modelsEntry, authEntry, dirEntry]);
    vi.mocked(api.readConfigFile).mockResolvedValue({ path: "settings.json", content: "{\"a\":1}" });
  });

  it("defaults to project scope for the exact cwd and lists files", async () => {
    render(<ConfigBrowser cwd="/p" onSaveApplied={() => {}} />);
    expect(await screen.findByText("settings.json")).toBeTruthy();
    expect(api.listConfig).toHaveBeenCalledWith("project", "/p", undefined);
  });

  it("switches to global scope via the segmented control", async () => {
    const user = userEvent.setup();
    render(<ConfigBrowser cwd="/p" onSaveApplied={() => {}} />);
    await screen.findByText("settings.json");
    await user.click(screen.getByRole("tab", { name: /global/i }));
    await waitFor(() => expect(api.listConfig).toHaveBeenLastCalledWith("global", undefined, undefined));
  });

  it("navigates into directories and back up", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listConfig).mockResolvedValueOnce([dirEntry]).mockResolvedValueOnce([
      { name: "inner.json", path: "sub/inner.json", type: "file" },
    ]);
    render(<ConfigBrowser cwd="/p" onSaveApplied={() => {}} />);
    await screen.findByText(/sub\//);
    await user.click(screen.getByText(/sub\//));
    await waitFor(() => expect(api.listConfig).toHaveBeenLastCalledWith("project", "/p", "sub"));
    expect(await screen.findByText("inner.json")).toBeTruthy();
  });

  it("opens a file into the editor with a filename bar", async () => {
    const user = userEvent.setup();
    render(<ConfigBrowser cwd="/p" onSaveApplied={() => {}} />);
    await screen.findByText("settings.json");
    await user.click(screen.getByText("settings.json"));
    expect(api.readConfigFile).toHaveBeenCalledWith("project", "/p", "settings.json");
    expect(await screen.findByText("settings.json", { selector: ".config-browser__filename" })).toBeTruthy();
    const editor = screen.getByRole("textbox", { name: /editor/i });
    expect((editor as HTMLTextAreaElement).value).toContain('"a":1');
  });

  it("saves valid JSON via writeConfigFile without restarting the session", async () => {
    const user = userEvent.setup();
    render(<ConfigBrowser cwd="/p" onSaveApplied={() => {}} />);
    await screen.findByText("settings.json");
    await user.click(screen.getByText("settings.json"));
    const editor = (await screen.findByRole("textbox", { name: /editor/i })) as HTMLTextAreaElement;
    await user.clear(editor);
    fireEvent.change(editor, { target: { value: '{"b":2}' } });
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(api.writeConfigFile).toHaveBeenCalledWith("project", "/p", "settings.json", '{"b":2}'));
    expect(api.restartSession).not.toHaveBeenCalled();
    expect(await screen.findByText(/applies after restart/i)).toBeTruthy();
  });

  it("displays a 400 message for invalid JSON instead of saving", async () => {
    const user = userEvent.setup();
    vi.mocked(api.writeConfigFile).mockRejectedValue(new Error("HTTP 400: Invalid JSON at line 1"));
    render(<ConfigBrowser cwd="/p" onSaveApplied={() => {}} />);
    await screen.findByText("settings.json");
    await user.click(screen.getByText("settings.json"));
    const editor = (await screen.findByRole("textbox", { name: /editor/i })) as HTMLTextAreaElement;
    await user.clear(editor);
    fireEvent.change(editor, { target: { value: "{broken" } });
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/invalid json/i)).toBeTruthy();
    expect(api.restartSession).not.toHaveBeenCalled();
  });

  it("creates a directory via the folder action", async () => {
    const user = userEvent.setup();
    render(<ConfigBrowser cwd="/p" onSaveApplied={() => {}} />);
    await screen.findByText("settings.json");
    await user.click(screen.getByRole("button", { name: /new folder/i }));
    await user.type(await screen.findByLabelText(/folder name/i), "models");
    await user.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(api.createConfigDirectory).toHaveBeenCalledWith("project", "/p", "models"));
  });

  it("keeps secret-bearing auth.json content only in the editor value and API call", async () => {
    const user = userEvent.setup();
    vi.mocked(api.readConfigFile).mockResolvedValue({ path: "auth.json", content: "{\"apiKey\":\"sk-secret\"}" });
    render(<ConfigBrowser cwd="/p" onSaveApplied={() => {}} />);
    await screen.findByText("auth.json");
    await user.click(screen.getByText("auth.json"));
    const editor = (await screen.findByRole("textbox", { name: /editor/i })) as HTMLTextAreaElement;
    expect(editor.value).toContain("sk-secret");
    expect(screen.getByText("auth.json", { selector: ".config-browser__filename" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(api.writeConfigFile).toHaveBeenCalledWith("project", "/p", "auth.json", '{"apiKey":"sk-secret"}'),
    );
    expect(
      screen.queryByText(/sk-secret/, {
        selector: ".config-browser__filename, .config-browser__saved, .config-browser__error, .config-browser__entry, .config-browser__placeholder",
      }),
    ).toBeNull();
  });

  it("confirms before discarding unsaved changes when switching files", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ConfigBrowser cwd="/p" onSaveApplied={() => {}} />);
    await screen.findByText("settings.json");
    await user.click(screen.getByText("settings.json"));
    const editor = (await screen.findByRole("textbox", { name: /editor/i })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '{"c":3}' } });
    await user.click(screen.getByText("models.json"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(api.readConfigFile).not.toHaveBeenCalledWith("project", "/p", "models.json");
  });
});
