// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import * as api from "../api";

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

const baseSettings = {
  chatFontSize: 13,
  filesFontSize: 12,
  agentModels: { search: "openai/gpt-4o" },
  orchestratorModel: null,
  effectiveOrchestratorModel: null,
};

beforeEach(() => {
  vi.mocked(api.getWebuiSettings).mockReset();
  vi.mocked(api.updateWebuiSettings).mockReset();
  vi.mocked(api.listAgents).mockReset();
  vi.mocked(api.listModels).mockReset();
  vi.mocked(api.getWebuiSettings).mockResolvedValue({ ...baseSettings } as never);
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
  it("renders appearance selects with the current values", async () => {
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    expect(await screen.findByLabelText("Chat font size")).toHaveValue("13");
    expect(screen.getByLabelText("Files font size")).toHaveValue("12");
  });

  it("shows stage agents with their configured model and a blank orchestrator model", async () => {
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByLabelText("Chat font size");
    expect(screen.getByRole("combobox", { name: "search model" })).toHaveValue("openai/gpt-4o");
    expect(screen.getByRole("combobox", { name: "writing model" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "orchestrator model" })).toHaveValue("");
    expect(screen.getByText(/global default model/i)).toBeTruthy();
  });

  it("applies font size changes live and persists them", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockResolvedValue({ ...baseSettings, chatFontSize: 14 } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByLabelText("Chat font size");
    await user.selectOptions(screen.getByLabelText("Chat font size"), "14");
    await waitFor(() => expect(api.updateWebuiSettings).toHaveBeenCalledWith({ chatFontSize: 14 }));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--v2-chat-font-size")).toBe("14px"));
  });

  it("sets a stage agent model via agentModels patch", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockResolvedValue({
      ...baseSettings,
      agentModels: { search: "openai/gpt-4o", writing: "anthropic/claude-sonnet-4" },
    } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByLabelText("Chat font size");
    await user.selectOptions(screen.getByRole("combobox", { name: "writing model" }), "anthropic/claude-sonnet-4");
    await waitFor(() =>
      expect(api.updateWebuiSettings).toHaveBeenCalledWith({
        agentModels: { search: "openai/gpt-4o", writing: "anthropic/claude-sonnet-4" },
      }),
    );
  });

  it("clears an agent model when inherit is chosen", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockResolvedValue({ ...baseSettings, agentModels: {} } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByLabelText("Chat font size");
    await user.selectOptions(screen.getByRole("combobox", { name: "search model" }), "");
    await waitFor(() => expect(api.updateWebuiSettings).toHaveBeenCalledWith({ agentModels: {} }));
  });

  it("shows the Pi fallback model hint when the orchestrator is unconfigured", async () => {
    vi.mocked(api.getWebuiSettings).mockResolvedValue({
      ...baseSettings,
      effectiveOrchestratorModel: "oc/deepseek-v4-flash-free",
    } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByLabelText("Chat font size");
    expect(screen.getByText("Pi will use: oc/deepseek-v4-flash-free")).toBeTruthy();
  });

  it("hides the fallback hint once the orchestrator model is configured", async () => {
    vi.mocked(api.getWebuiSettings).mockResolvedValue({
      ...baseSettings,
      orchestratorModel: "anthropic/claude-sonnet-4",
      effectiveOrchestratorModel: "anthropic/claude-sonnet-4",
    } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByLabelText("Chat font size");
    expect(screen.getByRole("combobox", { name: "orchestrator model" })).toHaveValue("anthropic/claude-sonnet-4");
    expect(screen.queryByText(/Pi will use:/)).toBeNull();
  });

  it("sets the orchestrator model via an orchestratorModel patch", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockResolvedValue({
      ...baseSettings,
      orchestratorModel: "openai/gpt-4o",
    } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByLabelText("Chat font size");
    await user.selectOptions(screen.getByRole("combobox", { name: "orchestrator model" }), "openai/gpt-4o");
    await waitFor(() => expect(api.updateWebuiSettings).toHaveBeenCalledWith({ orchestratorModel: "openai/gpt-4o" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "orchestrator model" })).toHaveValue("openai/gpt-4o"));
  });

  it("clears the orchestrator model when the blank option is chosen", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockResolvedValue({
      ...baseSettings,
      orchestratorModel: "anthropic/claude-sonnet-4",
    } as never);
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByLabelText("Chat font size");
    await user.selectOptions(screen.getByRole("combobox", { name: "orchestrator model" }), "anthropic/claude-sonnet-4");
    await user.selectOptions(screen.getByRole("combobox", { name: "orchestrator model" }), "");
    await waitFor(() => expect(api.updateWebuiSettings).toHaveBeenCalledWith({ orchestratorModel: null }));
  });

  it("surfaces an update failure and keeps the last good value", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateWebuiSettings).mockRejectedValueOnce(new Error("boom"));
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={() => {}} />);
    await screen.findByLabelText("Chat font size");
    await user.selectOptions(screen.getByLabelText("Chat font size"), "14");
    expect(await screen.findByText(/boom/)).toBeTruthy();
    expect(screen.getByLabelText("Chat font size")).toHaveValue("13");
  });

  it("opens the JSON config editor from its button", async () => {
    const user = userEvent.setup();
    const onOpenConfigPage = vi.fn();
    render(<SettingsPage onBack={() => {}} onOpenConfigPage={onOpenConfigPage} />);
    await screen.findByLabelText("Chat font size");
    await user.click(screen.getByRole("button", { name: /edit.*json/i }));
    expect(onOpenConfigPage).toHaveBeenCalled();
  });
});
