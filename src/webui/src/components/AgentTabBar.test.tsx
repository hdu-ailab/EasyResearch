// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SubagentTabState } from "../subagent-tabs";
import { AgentTabBar } from "./AgentTabBar";

function tab(patch: Partial<SubagentTabState> = {}): SubagentTabState {
  return {
    key: "tool:call-1",
    toolCallId: "call-1",
    agent: "search",
    retained: false,
    running: true,
    latestMessage: "finding papers",
    ...patch,
  };
}

describe("AgentTabBar", () => {
  it("keeps Orchestrator first and fixed while a temporary tab has sibling select and Stop controls", async () => {
    const onSelect = vi.fn();
    const onStop = vi.fn();
    render(<AgentTabBar
      tabs={[tab()]}
      activeKey="orchestrator"
      orchestratorStatus="idle"
      onSelect={onSelect}
      onClose={vi.fn()}
      onStop={onStop}
    />);

    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveAccessibleName("Agent Orchestrator");
    expect(screen.queryByRole("button", { name: "Close agent tab" })).toBeNull();
    const select = screen.getByRole("button", { name: "Agent Search" });
    const stop = screen.getByRole("button", { name: "Stop agent" });
    expect(select.contains(stop)).toBe(false);
    expect(select.parentElement).toBe(stop.parentElement);
    expect(withinText(select)).toContain("finding papers");
    await userEvent.setup().click(stop);
    expect(onStop).toHaveBeenCalledWith("call-1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders UUID tabs with close separate from Stop and close never stops", async () => {
    const onClose = vi.fn();
    const onStop = vi.fn();
    render(<AgentTabBar
      tabs={[tab({ key: "session:child-uuid", sessionId: "child-uuid", retained: true, running: false })]}
      activeKey="session:child-uuid"
      orchestratorStatus="working"
      onSelect={vi.fn()}
      onClose={onClose}
      onStop={onStop}
    />);

    expect(screen.queryByRole("button", { name: "Stop agent" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Close agent tab: Search" }));
    expect(onClose).toHaveBeenCalledWith("session:child-uuid");
    expect(onStop).not.toHaveBeenCalled();
  });

  it("localizes agent names and disambiguates duplicate UUIDs", () => {
    render(<AgentTabBar
      tabs={[
        tab({ key: "session:11111111-aaaa", sessionId: "11111111-aaaa", retained: true }),
        tab({ key: "session:22222222-bbbb", toolCallId: "call-2", sessionId: "22222222-bbbb", retained: true }),
      ]}
      activeKey="orchestrator"
      orchestratorStatus="error"
      onSelect={vi.fn()}
      onClose={vi.fn()}
      onStop={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "Agent Search · 11111111" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Agent Search · 22222222" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close agent tab: Search · 11111111" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close agent tab: Search · 22222222" })).toBeVisible();
  });
});

function withinText(element: HTMLElement): string {
  return element.textContent ?? "";
}
