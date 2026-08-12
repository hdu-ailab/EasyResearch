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
    {
      name: "assistant",
      description: "Coordinates work",
      enabled: true,
      builtin: true,
      source: "bundled",
      filePath: "assistant.md",
      effectiveTools: [],
      effectiveSkills: [],
    },
    {
      name: "search",
      description: "Finds papers",
      enabled: true,
      builtin: true,
      source: "bundled",
      filePath: "search.md",
      effectiveTools: [],
      effectiveSkills: [],
    },
  ]);
  vi.mocked(api.listModels).mockResolvedValue([{ provider: "openai", id: "gpt-4o" }]);
  vi.mocked(api.getEffectiveModels).mockResolvedValue([
    { name: "assistant", model: "openai/gpt-4o", source: "inherit" },
    { name: "search", model: "custom/model", source: "override" },
  ]);
  vi.mocked(api.setAgentModel).mockResolvedValue(undefined);
});

describe("AgentList", () => {
  it("renders the assistant card and preserves an effective model absent from the catalog", async () => {
    render(<AgentList cwd="/p" statusByAgent={{ assistant: "idle", search: "working" }} sessionId="s1" />);

    expect(await screen.findByText("Paper Assistant")).toBeVisible();
    expect(api.listAgents).toHaveBeenCalledWith("/p");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getAllByRole("combobox")[1]).toHaveDisplayValue("custom/model");
    expect(screen.getAllByRole("combobox")[1]).toHaveTextContent("custom/model");
  });

  it("reloads the effective roster when the project cwd changes", async () => {
    const { rerender } = render(
      <AgentList cwd="/p" statusByAgent={{ assistant: "idle", search: "idle" }} sessionId="s1" />,
    );
    await screen.findByText("Paper Assistant");

    rerender(<AgentList cwd="/other" statusByAgent={{ assistant: "idle", search: "idle" }} sessionId="s1" />);

    await waitFor(() => expect(api.listAgents).toHaveBeenCalledWith("/other"));
  });

  it("sends null when a stage agent is reset to the default model", async () => {
    const user = userEvent.setup();
    render(<AgentList cwd="/p" statusByAgent={{ assistant: "idle", search: "idle" }} sessionId="s1" />);

    const searchSelect = await screen.findByDisplayValue("custom/model");
    await user.selectOptions(searchSelect, "");

    await waitFor(() => expect(api.setAgentModel).toHaveBeenCalledWith("s1", "search", null));
  });

  it("keeps its header mounted when agent data fails", async () => {
    vi.mocked(api.listAgents).mockRejectedValue(new Error("unavailable"));
    render(<AgentList cwd="/p" statusByAgent={{ assistant: "idle" }} sessionId="s1" />);

    expect(screen.getByText("Agents")).toBeVisible();
  });
});
