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
      missingSkills: [],
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
      missingSkills: [],
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
  it("loads the effective roster for the exact session cwd", async () => {
    vi.mocked(api.listAgents).mockImplementation(async (cwd) =>
      cwd === "/papers/project"
        ? [
            {
              name: "project-reviewer",
              description: "Project-only reviewer",
              enabled: true,
              builtin: false,
              source: "project",
              filePath: "/papers/project/.easyresearch/agents/project-reviewer.md",
              effectiveTools: [],
              effectiveSkills: [],
              missingSkills: [],
            },
          ]
        : [],
    );

    render(<AgentList cwd="/papers/project" statusByAgent={{ "project-reviewer": "idle" }} sessionId="s1" />);

    expect(await screen.findByText("project-reviewer")).toBeVisible();
    expect(screen.getByText("Project-only reviewer")).toBeVisible();
  });

  it("renders the assistant card and preserves an effective model absent from the catalog", async () => {
    render(<AgentList cwd="/papers/project" statusByAgent={{ assistant: "idle", search: "working" }} sessionId="s1" />);

    expect(await screen.findByText("Paper Assistant")).toBeVisible();
    expect(screen.getAllByRole("combobox")[1]).toHaveDisplayValue("custom/model");
    expect(screen.getAllByRole("combobox")[1]).toHaveTextContent("custom/model");
  });

  it("sends null when a stage agent is reset to the default model", async () => {
    const user = userEvent.setup();
    render(<AgentList cwd="/papers/project" statusByAgent={{ assistant: "idle", search: "idle" }} sessionId="s1" />);

    const searchSelect = await screen.findByDisplayValue("custom/model");
    await user.selectOptions(searchSelect, "");

    await waitFor(() => expect(api.setAgentModel).toHaveBeenCalledWith("s1", "search", null));
  });

  it("keeps its header mounted when agent data fails", async () => {
    vi.mocked(api.listAgents).mockRejectedValue(new Error("unavailable"));
    render(<AgentList cwd="/papers/project" statusByAgent={{ assistant: "idle" }} sessionId="s1" />);

    expect(screen.getByText("Agents")).toBeVisible();
  });
});
