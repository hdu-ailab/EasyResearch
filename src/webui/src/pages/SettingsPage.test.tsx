// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import * as api from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import { STORAGE_KEY } from "../preferences";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    getWebuiSettings: vi.fn(),
    updateWebuiSettings: vi.fn(),
    listAgents: vi.fn(),
    listModels: vi.fn(),
  };
});

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.getWebuiSettings).mockReset();
  vi.mocked(api.updateWebuiSettings).mockReset();
  vi.mocked(api.listAgents).mockReset();
  vi.mocked(api.listModels).mockReset();
  vi.mocked(api.getWebuiSettings).mockResolvedValue({ agentModels: { search: "openai/gpt-4o" } } as never);
  vi.mocked(api.listAgents).mockResolvedValue([
    { name: "orchestrator", description: "Coordinates" },
    { name: "search", description: "Searches" },
    { name: "writing", description: "Writes" },
  ] as never);
  vi.mocked(api.listModels).mockResolvedValue([
    { provider: "openai", id: "gpt-4o" },
    { provider: "anthropic", id: "claude-sonnet-4" },
  ] as never);
});

describe("SettingsPage", () => {
  it("renders default font sizes with steppers and a preview", async () => {
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    expect(screen.getByText("Chat font size")).toBeTruthy();
    expect(screen.getByText("Files font size")).toBeTruthy();
    expect(screen.getByText("13px")).toBeTruthy();
    expect(screen.getByText("12px")).toBeTruthy();
    expect(screen.getByText("Preview")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decrease chat font size" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Increase chat font size" })).not.toBeDisabled();
  });

  it("reads stored font sizes from localStorage", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ chatFontSize: 16, filesFontSize: 11, language: "en" }));
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    expect(screen.getByText("16px")).toBeTruthy();
    expect(screen.getByText("11px")).toBeTruthy();
  });

  it("persists and applies font size changes without a backend call", async () => {
    const user = userEvent.setup();
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Increase chat font size" }));
    expect(screen.getByText("14px")).toBeTruthy();
    expect(document.documentElement.style.getPropertyValue("--v2-chat-font-size")).toBe("14px");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({ chatFontSize: 14 });
    expect(api.updateWebuiSettings).not.toHaveBeenCalled();
  });

  it("disables the increase button at the max bound", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ chatFontSize: 20, filesFontSize: 12, language: "en" }));
    const user = userEvent.setup();
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    expect(screen.getByRole("button", { name: "Increase chat font size" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Decrease chat font size" }));
    expect(screen.getByText("19px")).toBeTruthy();
  });

  it("disables the decrease button at the min bound", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ chatFontSize: 10, filesFontSize: 12, language: "en" }));
    const user = userEvent.setup();
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    expect(screen.getByRole("button", { name: "Decrease chat font size" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Increase chat font size" }));
    expect(screen.getByText("11px")).toBeTruthy();
  });

  it("switches the interface language and persists it", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />
      </I18nProvider>,
    );
    await user.click(screen.getByRole("button", { name: "简体中文" }));
    expect(screen.getByText("外观")).toBeTruthy();
    expect(screen.getByText("语言")).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({ language: "zh-CN" });
  });

  it("shows stage agents with their configured model and the orchestrator read-only", async () => {
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByRole("combobox", { name: "search model" });
    expect(screen.getByRole("combobox", { name: "search model" })).toHaveValue("openai/gpt-4o");
    expect(screen.getByRole("combobox", { name: "writing model" })).toHaveValue("");
    expect(screen.queryByRole("combobox", { name: "orchestrator model" })).toBeNull();
    expect(screen.getByText(/session model/i)).toBeTruthy();
  });

  it("sets a stage agent model via agentModels patch", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockResolvedValue({
      agentModels: { search: "openai/gpt-4o", writing: "anthropic/claude-sonnet-4" },
    } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByRole("combobox", { name: "writing model" });
    await user.selectOptions(screen.getByRole("combobox", { name: "writing model" }), "anthropic/claude-sonnet-4");
    await waitFor(() =>
      expect(api.updateWebuiSettings).toHaveBeenCalledWith({
        agentModels: { search: "openai/gpt-4o", writing: "anthropic/claude-sonnet-4" },
      }),
    );
  });

  it("surfaces an agentModels update failure", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockRejectedValueOnce(new Error("boom"));
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByRole("combobox", { name: "search model" });
    await user.selectOptions(screen.getByRole("combobox", { name: "search model" }), "");
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });

  it("opens the JSON config editor from its button", async () => {
    const user = userEvent.setup();
    const onOpenConfigPage = vi.fn();
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={onOpenConfigPage} />);
    await user.click(screen.getByRole("button", { name: /edit.*json/i }));
    expect(onOpenConfigPage).toHaveBeenCalled();
  });
});
