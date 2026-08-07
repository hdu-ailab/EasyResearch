// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "./ChatTranscript";
import type { SessionMessageView, ToolView } from "../session-reducer";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mermaid-svg' />" }),
  },
}));

const msg = (overrides: Partial<SessionMessageView>): SessionMessageView => ({
  key: "k",
  role: "assistant",
  text: "hello",
  streaming: false,
  error: false,
  order: 0,
  ...overrides,
});

const tool = (overrides: Partial<ToolView>): ToolView => ({
  key: "t1",
  name: "grep",
  args: "pattern",
  running: false,
  done: true,
  error: false,
  output: "matched lines",
  order: 1,
  ...overrides,
});

function scrollContainer(): HTMLDivElement {
  const el = screen.getByLabelText("Conversation") as HTMLDivElement;
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => 400,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => 200,
  });
  return el;
}

/**
 * Stubs the container metrics after render, then forces the pin effect to
 * re-run with real scroll metrics (jsdom reports scrollHeight 0 until the
 * stub is in place).
 */
function pinnedContainer(rerender: (ui: ReactElement) => void): HTMLDivElement {
  const el = scrollContainer();
  rerender(<ChatTranscript messages={[]} tools={[]} />);
  return el;
}

describe("ChatTranscript", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the empty hint only when nothing is pending", () => {
    const { rerender } = render(<ChatTranscript messages={[]} tools={[]} />);
    expect(screen.getByText("Send a message to start.")).toBeTruthy();
    rerender(<ChatTranscript messages={[]} tools={[]} pending />);
    expect(screen.queryByText("Send a message to start.")).toBeNull();
  });

  it("renders a working agent row while pending", () => {
    render(<ChatTranscript messages={[]} tools={[]} pending />);
    const row = screen.getByLabelText("Working");
    expect(row.textContent).toContain("Working…");
    expect(row.textContent).toContain("Orchestrator");
  });

  it("pins to the bottom on content change, unpins on manual scroll, and re-pins at the bottom", () => {
    const first = [msg({ key: "a", text: "one" })];
    const { rerender } = render(<ChatTranscript messages={first} tools={[]} />);
    const el = pinnedContainer(rerender);
    expect(el.scrollTop).toBe(400);

    rerender(<ChatTranscript messages={[...first, msg({ key: "b", text: "two" })]} tools={[]} />);
    expect(el.scrollTop).toBe(400);

    el.scrollTop = 100;
    fireEvent.scroll(el);
    rerender(<ChatTranscript messages={[...first, msg({ key: "b" }), msg({ key: "c", text: "three" })]} tools={[]} />);
    expect(el.scrollTop).toBe(100);

    el.scrollTop = 400;
    fireEvent.scroll(el);
    rerender(<ChatTranscript messages={[...first, msg({ key: "b" }), msg({ key: "c" }), msg({ key: "d", text: "four" })]} tools={[]} />);
    expect(el.scrollTop).toBe(400);
  });

  it("stays at the bottom when a tool event arrives while pinned", () => {
    const first = [msg({ key: "a" })];
    const { rerender } = render(<ChatTranscript messages={first} tools={[]} />);
    const el = pinnedContainer(rerender);
    rerender(<ChatTranscript messages={first} tools={[tool({ key: "t2" })]} />);
    expect(el.scrollTop).toBe(400);
  });

  it("expands the reasoning body with a pop-down animation and retracts it with a collapse-up animation", () => {
    vi.useFakeTimers();
    render(<ChatTranscript messages={[msg({ key: "a", reasoning: "deep thought" })]} tools={[]} />);
    const toggle = screen.getByRole("button", { name: /show details/i });
    fireEvent.click(toggle);
    expect(screen.getByText("deep thought").closest(".animate-v2-expand-down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /hide details/i }));
    expect(screen.getByText("deep thought").closest(".animate-v2-collapse-up")).toBeTruthy();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText("deep thought")).toBeNull();
  });

  it("expands the tool output body with a pop-down animation", () => {
    vi.useFakeTimers();
    render(<ChatTranscript messages={[]} tools={[tool({ key: "t1", output: "tool output here" })]} />);
    const toggle = screen.getByRole("button", { name: /grep/i });
    fireEvent.click(toggle);
    expect(screen.getByText("tool output here").closest(".animate-v2-expand-down")).toBeTruthy();
  });

  it("interleaves tool rows at their stream position between messages", () => {
    render(
      <ChatTranscript
        messages={[
          msg({ key: "a", role: "assistant", text: "first", order: 1 }),
          msg({ key: "c", role: "assistant", text: "second", order: 4 }),
        ]}
        tools={[tool({ key: "t1", name: "bash", args: "ls", order: 2 })]}
      />,
    );
    const container = screen.getByLabelText("Conversation");
    const texts = [...container.querySelectorAll("li")]
      .map((li) => li.textContent ?? "")
      .filter((t) => t.trim().length > 0);
    const first = texts.findIndex((t) => t.includes("first"));
    const toolIndex = texts.findIndex((t) => t.includes("bash") && t.includes("ls"));
    const second = texts.findIndex((t) => t.includes("second"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(toolIndex);
  });

  it("renders math in assistant messages", () => {
    render(<ChatTranscript messages={[msg({ key: "m", text: "Euler: $e^{i\\pi} + 1 = 0$" })]} tools={[]} />);
    expect(document.querySelector(".katex")).toBeTruthy();
  });

  it("renders subagent dispatch under the orchestrator label, never as You", () => {
    render(
      <ChatTranscript
        messages={[
          msg({ key: "d", role: "user", text: "Task: search papers", label: "Orchestrator", order: 0 }),
          msg({ key: "r", role: "assistant", text: "found 3 papers", label: "search", order: 1 }),
        ]}
        tools={[]}
      />,
    );
    const container = screen.getByLabelText("Conversation");
    expect(container.textContent).not.toContain("You");
    expect(container.textContent).toContain("Orchestrator");
    expect(container.textContent).toContain("Search");
  });
});
