// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
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
  vi.mocked(api.getWebuiSettings).mockResolvedValue({
    agentModels: { search: "openai/gpt-4o" },
    orchestratorModel: null,
    effectiveOrchestratorModel: "openai/gpt-4o",
  } as never);
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
    expect(screen.getByText(/lazy dog/)).toBeTruthy();
    expect(screen.getByText(/index\.ts/)).toBeTruthy();
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

  it("shows stage agents with their configured model and the orchestrator settable", async () => {
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByRole("combobox", { name: "search model" });
    expect(screen.getByRole("combobox", { name: "search model" })).toHaveValue("openai/gpt-4o");
    expect(screen.getByRole("combobox", { name: "writing model" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "orchestrator model" })).toHaveValue("openai/gpt-4o");
  });

  it("shows the configured orchestrator default without any inherit option", async () => {
    vi.mocked(api.getWebuiSettings).mockResolvedValue({
      agentModels: { search: "openai/gpt-4o" },
      orchestratorModel: "openai/gpt-4o",
      effectiveOrchestratorModel: "openai/gpt-4o",
    } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    const combobox = await screen.findByRole("combobox", { name: "orchestrator model" });
    expect(combobox).toHaveValue("openai/gpt-4o");
    expect(within(combobox).queryAllByRole("option", { name: /inherit/i })).toHaveLength(0);
  });

  it("auto-selects the effective Pi model when no orchestrator default is configured", async () => {
    vi.mocked(api.getWebuiSettings).mockResolvedValue({
      agentModels: {},
      orchestratorModel: null,
      effectiveOrchestratorModel: "anthropic/claude-opus-4-8",
    } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    const combobox = await screen.findByRole("combobox", { name: "orchestrator model" });
    expect(combobox).toHaveValue("anthropic/claude-opus-4-8");
    expect(within(combobox).getAllByRole("option", { name: "anthropic/claude-opus-4-8" })).toHaveLength(1);
    expect(within(combobox).queryAllByRole("option", { name: /inherit/i })).toHaveLength(0);
  });

  it("auto-selects a default already in the catalog without duplicating it", async () => {
    vi.mocked(api.getWebuiSettings).mockResolvedValue({
      agentModels: {},
      orchestratorModel: null,
      effectiveOrchestratorModel: "openai/gpt-4o",
    } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    const combobox = await screen.findByRole("combobox", { name: "orchestrator model" });
    expect(combobox).toHaveValue("openai/gpt-4o");
    expect(within(combobox).queryAllByRole("option", { name: "openai/gpt-4o" })).toHaveLength(1);
  });

  it("sets the orchestrator default via an orchestratorModel patch", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockResolvedValue({
      agentModels: { search: "openai/gpt-4o" },
      orchestratorModel: "anthropic/claude-sonnet-4",
      effectiveOrchestratorModel: "anthropic/claude-sonnet-4",
    } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByRole("combobox", { name: "orchestrator model" });
    await user.selectOptions(screen.getByRole("combobox", { name: "orchestrator model" }), "anthropic/claude-sonnet-4");
    await waitFor(() =>
      expect(api.updateWebuiSettings).toHaveBeenCalledWith({ orchestratorModel: "anthropic/claude-sonnet-4" }),
    );
    expect(screen.getByRole("combobox", { name: "orchestrator model" })).toHaveValue("anthropic/claude-sonnet-4");
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
