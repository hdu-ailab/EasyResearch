import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { AgentList } from "./AgentList";

vi.mock("../api", () => ({
  getEffectiveModels: vi.fn(),
  listAgents: vi.fn(),
  listModels: vi.fn(),
  setAgentModel: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(api.listAgents).mockReset();
  vi.mocked(api.listModels).mockReset();
  vi.mocked(api.getEffectiveModels).mockReset();
  vi.mocked(api.setAgentModel).mockReset();
  vi.mocked(api.listAgents).mockResolvedValue([
    { name: "orchestrator", description: "Coordinates work" },
    { name: "search", description: "Finds papers" },
  ]);
  vi.mocked(api.listModels).mockResolvedValue([{ provider: "openai", id: "gpt-4o" }]);
  vi.mocked(api.getEffectiveModels).mockResolvedValue([
    { name: "orchestrator", model: "openai/gpt-4o", source: "inherit" },
    { name: "search", model: "custom/model", source: "override" },
  ]);
  vi.mocked(api.setAgentModel).mockResolvedValue(undefined);
});

describe("AgentList", () => {
  it("renders the orchestrator card and preserves an effective model absent from the catalog", async () => {
    render(<AgentList statusByAgent={{ orchestrator: "idle", search: "working" }} sessionId="s1" />);

    expect(await screen.findByText("Research Mentor")).toBeVisible();
    expect(screen.getAllByRole("combobox")[1]).toHaveDisplayValue("custom/model");
    expect(screen.getAllByRole("combobox")[1]).toHaveTextContent("custom/model");
  });

  it("sends null when a stage agent is reset to the default model", async () => {
    const user = userEvent.setup();
    render(<AgentList statusByAgent={{ orchestrator: "idle", search: "idle" }} sessionId="s1" />);

    const searchSelect = await screen.findByDisplayValue("custom/model");
    await user.selectOptions(searchSelect, "");

    await waitFor(() => expect(api.setAgentModel).toHaveBeenCalledWith("s1", "search", null));
  });

  it("keeps its header mounted when agent data fails", async () => {
    vi.mocked(api.listAgents).mockRejectedValue(new Error("unavailable"));
    render(<AgentList statusByAgent={{ orchestrator: "idle" }} sessionId="s1" />);

    expect(screen.getByText("Agents")).toBeVisible();
  });
});
