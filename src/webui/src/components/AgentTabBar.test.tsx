import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SubagentTabState } from "../subagent-tabs";
import { AgentTabBar } from "./AgentTabBar";

function tab(patch: Partial<SubagentTabState> = {}): SubagentTabState {
  return {
    key: "tool:root:call-1",
    ownerSessionId: "root",
    toolCallId: "call-1",
    agent: "search",
    retained: false,
    running: true,
    error: false,
    latestMessage: "finding papers",
    ...patch,
  };
}

function renderTabs(tabs: SubagentTabState[], activeKey = "research-assistant") {
  const props = {
    tabs,
    activeKey,
    researchAssistantStatus: "idle" as const,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onStop: vi.fn(),
  };
  return { ...render(<AgentTabBar {...props} />), props };
}

describe("AgentTabBar", () => {
  it("keeps Research Assistant first and temporary select and Stop controls as siblings", async () => {
    const { props } = renderTabs([tab()]);

    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toHaveAccessibleName("Agent Research Assistant");
    const select = screen.getByRole("button", { name: "Agent Search" });
    const stop = screen.getByRole("button", { name: "Stop agent: Search" });
    expect(select.contains(stop)).toBe(false);
    expect(select.parentElement).toBe(stop.parentElement);
    await userEvent.setup().click(stop);
    expect(props.onStop).toHaveBeenCalledWith("call-1");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("renders separate Close and Stop controls for a running retained UUID tab", async () => {
    const retained = tab({
      key: "session:child-uuid",
      sessionId: "child-uuid",
      agentId: "search job #4",
      retained: true,
    });
    const { props } = renderTabs([retained], retained.key);

    const select = screen.getByRole("button", { name: "Agent search job #4" });
    const close = screen.getByRole("button", { name: "Close agent tab: search job #4" });
    const stop = screen.getByRole("button", { name: "Stop agent: search job #4" });
    expect(select.contains(close)).toBe(false);
    expect(select.contains(stop)).toBe(false);
    expect(select.parentElement).toBe(close.parentElement);
    expect(select.parentElement).toBe(stop.parentElement);

    const user = userEvent.setup();
    await user.click(close);
    expect(props.onClose).toHaveBeenCalledWith("session:child-uuid");
    expect(props.onStop).not.toHaveBeenCalled();
    await user.click(stop);
    expect(props.onStop).toHaveBeenCalledWith("call-1");
  });

  it("uses opaque Agent ids unchanged for unique accessible labels", () => {
    renderTabs([
      tab({ key: "session:first", sessionId: "first", agentId: "opaque::alpha/1", retained: true }),
      tab({
        key: "session:second",
        toolCallId: "call-2",
        sessionId: "second",
        agentId: "opaque::beta 2",
        retained: true,
      }),
    ]);

    expect(screen.getByRole("button", { name: "Agent opaque::alpha/1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Agent opaque::beta 2" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close agent tab: opaque::alpha/1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop agent: opaque::beta 2" })).toBeVisible();
  });

  it("shows terminal Error text and warning dot without a Stop control", () => {
    const failed = tab({
      key: "session:failed-child",
      sessionId: "failed-child",
      agentId: "search_8",
      retained: true,
      running: false,
      error: true,
    });
    renderTabs([failed], failed.key);

    const select = screen.getByRole("button", { name: "Agent search_8" });
    expect(withinButton(select, "Error")).toBeVisible();
    expect(select.querySelector(".bg-v2-status-warning")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /stop agent/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Close agent tab: search_8" })).toBeVisible();
  });

  it("retains keyboard focus when a temporary tab is promoted to its UUID", async () => {
    const temporary = tab({ agentId: "opaque focus id", retained: true });
    const props = {
      tabs: [temporary],
      activeKey: temporary.key,
      researchAssistantStatus: "idle" as const,
      onSelect: vi.fn(),
      onClose: vi.fn(),
      onStop: vi.fn(),
    };
    const { rerender } = render(<AgentTabBar {...props} />);
    const focused = screen.getByRole("button", { name: "Agent opaque focus id" });
    focused.focus();
    expect(focused).toHaveFocus();

    const promoted = { ...temporary, key: "session:child-focus", sessionId: "child-focus" };
    rerender(<AgentTabBar {...props} tabs={[promoted]} activeKey={promoted.key} />);

    expect(screen.getByRole("button", { name: "Agent opaque focus id" })).toHaveFocus();
  });

  it("keeps mobile tabs wrapping separately from the trailing meter slot", () => {
    vi.stubGlobal("innerWidth", 390);
    const { container } = renderTabs([
      tab({ agentId: "search_0" }),
      tab({ toolCallId: "call-2", agentId: "search_1" }),
    ]);

    const bar = container.firstElementChild;
    expect(bar).not.toHaveClass("flex-wrap");
    expect(screen.getByTestId("agent-tab-group")).toHaveClass("min-w-0", "flex-1", "flex-wrap");
    const select = screen.getByRole("button", { name: "Agent search_0" });
    expect(select.className).toContain("focus-visible:outline");
    vi.unstubAllGlobals();
  });

  it("keeps trailing content in a non-wrapping far-right slot", () => {
    render(
      <AgentTabBar
        tabs={[tab()]}
        activeKey="research-assistant"
        researchAssistantStatus="idle"
        onSelect={() => {}}
        onClose={() => {}}
        onStop={() => {}}
        trailing={<span>meter</span>}
      />,
    );

    const slot = screen.getByTestId("agent-tab-trailing");
    expect(slot).toHaveClass("ml-auto", "shrink-0");
    expect(slot).toHaveTextContent("meter");
  });
});

function withinButton(button: HTMLElement, text: string): HTMLElement {
  const match = [...button.querySelectorAll("span")].find((element) => element.textContent === text);
  if (!(match instanceof HTMLElement)) throw new Error(`Missing ${text} in button`);
  return match;
}
