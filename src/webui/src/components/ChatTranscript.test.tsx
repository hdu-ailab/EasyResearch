import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEY, type WebUiPreferences, writePreferences } from "../preferences";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import type { SessionMessageView, ToolView } from "../session-reducer";
import {
  fireTranscriptGrowth,
  hydrateTranscript,
  metricStub,
  smallTranscript,
  transcriptContentObserver,
  wheelUp,
} from "../testing/transcriptTest";
import { ChatTranscript, type ChatTranscriptHandle } from "./ChatTranscript";

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

const defaultPreferences: WebUiPreferences = {
  chatFontSize: 13,
  filesFontSize: 12,
  language: "en",
  autoExpandThinking: false,
  autoExpandTools: false,
  expandSubagentOutput: false,
};

let frames: FrameRequestCallback[] = [];
let scrollIntoViewSpy: ReturnType<typeof vi.spyOn>;
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

function flushFollowFrame() {
  const pending = frames;
  frames = [];
  for (const callback of pending) act(() => callback(0));
}

function renderTranscript(ui: ReactElement, preferences: Partial<WebUiPreferences> = {}) {
  writePreferences(window.localStorage, { ...defaultPreferences, ...preferences });
  const result = render(ui, { wrapper: PreferencesProvider });
  hydrateTranscript(result.container);
  return result;
}

function scrollContainer(): HTMLDivElement {
  return screen.getByLabelText("Conversation") as HTMLDivElement;
}

describe("ChatTranscript", () => {
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    if (!originalScrollIntoView) {
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: () => {},
      });
    }
    scrollIntoViewSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    scrollIntoViewSpy.mockRestore();
    if (!originalScrollIntoView) delete (Element.prototype as Partial<Element>).scrollIntoView;
    vi.unstubAllGlobals();
    window.localStorage.removeItem(STORAGE_KEY);
  });

  it("renders the empty hint only when nothing is pending", () => {
    const { rerender } = renderTranscript(<ChatTranscript messages={[]} tools={[]} />);
    expect(screen.getByText("Send a message to start.")).toBeTruthy();
    rerender(<ChatTranscript messages={[]} tools={[]} pending />);
    expect(screen.queryByText("Send a message to start.")).toBeNull();
  });

  it("renders a working agent row while pending", () => {
    renderTranscript(<ChatTranscript messages={[]} tools={[]} pending />);
    const row = screen.getByLabelText("Working");
    expect(row.textContent).toContain("Working…");
    expect(row.textContent).toContain("Paper Assistant");
  });

  it("pins to the bottom on content change, unpins on a wheel gesture, and re-pins at the bottom", () => {
    const first = [msg({ key: "a", text: "one" })];
    const { rerender, container } = renderTranscript(<ChatTranscript messages={first} tools={[]} />);
    const el = scrollContainer();
    smallTranscript(container, 400);
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(400);

    rerender(<ChatTranscript messages={[...first, msg({ key: "b", text: "two" })]} tools={[]} />);
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(400);

    el.scrollTop = 100;
    fireEvent.scroll(el);
    wheelUp(el);
    rerender(<ChatTranscript messages={[...first, msg({ key: "b" }), msg({ key: "c", text: "three" })]} tools={[]} />);
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(100);

    el.scrollTop = 400;
    wheelUp(el);
    fireEvent.scroll(el);
    rerender(
      <ChatTranscript
        messages={[...first, msg({ key: "b" }), msg({ key: "c" }), msg({ key: "d", text: "four" })]}
        tools={[]}
      />,
    );
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(400);
  });

  it("stays at the bottom when a tool event arrives while pinned", () => {
    const first = [msg({ key: "a" })];
    const { rerender, container } = renderTranscript(<ChatTranscript messages={first} tools={[]} />);
    const el = scrollContainer();
    smallTranscript(container, 400);
    fireTranscriptGrowth(container);
    rerender(<ChatTranscript messages={first} tools={[tool({ key: "t2" })]} />);
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(400);
  });

  it("follows observed content growth while pinned", () => {
    const { container } = renderTranscript(<ChatTranscript messages={[msg({ key: "a" })]} tools={[]} />);
    const el = scrollContainer();
    smallTranscript(container, 400);
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(400);

    el.scrollTop = 200;
    metricStub(el, { scrollHeight: 600, clientHeight: 200 });
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(600);
  });

  it("preserves the reading position when content grows while unpinned", () => {
    const { container } = renderTranscript(<ChatTranscript messages={[msg({ key: "a" })]} tools={[]} />);
    const el = scrollContainer();
    smallTranscript(container, 400);
    fireTranscriptGrowth(container);

    el.scrollTop = 100;
    fireEvent.scroll(el);
    wheelUp(el);
    metricStub(el, { scrollHeight: 600, clientHeight: 200 });
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(100);
  });

  it("re-engages following after scrolling within 10px of the bottom", () => {
    const { container } = renderTranscript(<ChatTranscript messages={[msg({ key: "a" })]} tools={[]} />);
    const el = scrollContainer();
    smallTranscript(container, 400);
    fireTranscriptGrowth(container);

    el.scrollTop = 100;
    fireEvent.scroll(el);
    wheelUp(el);
    expect(el.scrollTop).toBe(100);

    wheelUp(el);
    el.scrollTop = 196;
    fireEvent.scroll(el);
    metricStub(el, { scrollHeight: 600, clientHeight: 200 });
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(600);
  });

  it("jumps to the bottom when scrollToLatest is called while unpinned and re-follows growth", () => {
    const ref = createRef<ChatTranscriptHandle>();
    const { container } = renderTranscript(
      <ChatTranscript ref={ref} messages={[msg({ key: "a", text: "one" })]} tools={[]} />,
    );
    const el = scrollContainer();
    smallTranscript(container, 400);
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(400);

    el.scrollTop = 100;
    fireEvent.scroll(el);
    wheelUp(el);

    ref.current?.scrollToLatest();
    expect(el.scrollTop).toBe(400);

    el.scrollTop = 200;
    metricStub(el, { scrollHeight: 600, clientHeight: 200 });
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(600);
  });

  it("shows the jump-to-latest button only when scrolled far from the bottom", () => {
    renderTranscript(<ChatTranscript messages={[msg({ key: "a" }), msg({ key: "b" })]} tools={[]} />);
    const el = scrollContainer();
    metricStub(el, { scrollHeight: 1000, clientHeight: 200 });

    el.scrollTop = 1000;
    fireEvent.scroll(el);
    flushFollowFrame();
    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();

    el.scrollTop = 100;
    fireEvent.scroll(el);
    flushFollowFrame();
    expect(screen.getByRole("button", { name: /jump to latest/i })).toBeVisible();

    el.scrollTop = 780;
    fireEvent.scroll(el);
    flushFollowFrame();
    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();

    el.scrollTop = 100;
    fireEvent.scroll(el);
    flushFollowFrame();
    fireEvent.click(screen.getByRole("button", { name: /jump to latest/i }));
    expect(el.scrollTop).toBe(1000);
  });

  it("arms a scroll gesture on scroll keys over the transcript", () => {
    const { container } = renderTranscript(<ChatTranscript messages={[msg({ key: "a" })]} tools={[]} />);
    const el = scrollContainer();
    smallTranscript(container, 400);
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(400);

    fireEvent.keyDown(el, { key: "End" });
    el.scrollTop = 100;
    fireEvent.scroll(el);
    metricStub(el, { scrollHeight: 600, clientHeight: 200 });
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(100);
  });

  it("does not arm a page scroll gesture when the target is an interactive control", () => {
    const { container } = renderTranscript(
      <ChatTranscript messages={[msg({ key: "a", reasoning: "deep thought" })]} tools={[]} />,
    );
    const el = scrollContainer();
    smallTranscript(container, 400);
    fireTranscriptGrowth(container);

    const toggle = screen.getByRole("button", { name: /show details/i });
    fireEvent.keyDown(toggle, { key: "PageDown" });
    el.scrollTop = 100;
    fireEvent.scroll(el);
    metricStub(el, { scrollHeight: 600, clientHeight: 200 });
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(600);
  });

  it("does not unpin when wheel-scrolling inside a nested data-scrollable region", () => {
    const { container } = renderTranscript(
      <ChatTranscript messages={[]} tools={[tool({ key: "t1", output: "tool output here" })]} />,
      { autoExpandTools: true },
    );
    const el = scrollContainer();
    smallTranscript(container, 400);
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(400);

    const output = screen.getByText("tool output here").closest("[data-scrollable]") as HTMLElement;
    metricStub(output, { scrollHeight: 400, clientHeight: 200, scrollTop: 200 });
    wheelUp(output);
    el.scrollTop = 200;
    metricStub(el, { scrollHeight: 600, clientHeight: 200 });
    fireTranscriptGrowth(container);
    expect(el.scrollTop).toBe(600);
  });

  it("never forces reasoning or generic tool expansion into view", () => {
    renderTranscript(
      <ChatTranscript
        messages={[msg({ key: "a", reasoning: "deep thought" })]}
        tools={[tool({ key: "t1", output: "tool output here" })]}
      />,
      { autoExpandThinking: true, autoExpandTools: true },
    );
    scrollIntoViewSpy.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /hide details/i }));
    fireEvent.click(screen.getByRole("button", { name: /grep/i }));
    fireEvent.click(screen.getByRole("button", { name: /show details/i }));
    fireEvent.click(screen.getByRole("button", { name: /grep/i }));

    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });

  it("disconnects the content observer on unmount", () => {
    const { unmount, container } = renderTranscript(<ChatTranscript messages={[msg({ key: "a" })]} tools={[]} />);
    const contentObserver = transcriptContentObserver(container);
    expect(contentObserver).toBeTruthy();
    const disconnect = vi.spyOn(contentObserver!, "disconnect");
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("expands the reasoning body with a pop-down animation and retracts it with a collapse-up animation", () => {
    vi.useFakeTimers();
    renderTranscript(<ChatTranscript messages={[msg({ key: "a", reasoning: "deep thought" })]} tools={[]} />);
    const toggle = screen.getByRole("button", { name: /show details/i });
    fireEvent.click(toggle);
    expect(screen.getByText("deep thought").closest(".animate-v2-expand-down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /hide details/i }));
    expect(screen.getByText("deep thought").closest(".animate-v2-collapse-up")).toBeTruthy();
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText("deep thought")).toBeNull();
  });

  it("shows the animated thinking label only while reasoning is active", () => {
    const active = msg({ key: "a", reasoning: "deep thought", isThinking: true });
    const { rerender } = renderTranscript(<ChatTranscript messages={[active]} tools={[]} />);

    expect(screen.getByText("Thinking")).toHaveClass("v2-thinking-active");

    rerender(
      <ChatTranscript
        messages={[msg({ key: "a", reasoning: "deep thought", isThinking: false, text: "answer" })]}
        tools={[]}
      />,
    );

    expect(screen.queryByText("Thinking")).toBeNull();
    expect(screen.getByRole("button", { name: /show details/i })).toBeVisible();
  });

  it("shows active thinking before the first reasoning token arrives", () => {
    renderTranscript(
      <ChatTranscript
        messages={[msg({ key: "starting", reasoning: undefined, isThinking: true, text: "..." })]}
        tools={[]}
      />,
    );

    expect(screen.getByText("Thinking")).toHaveClass("v2-thinking-active");
    expect(screen.queryByRole("button", { name: /details/i })).toBeNull();
  });

  it("does not label historical reasoning as active thinking", () => {
    renderTranscript(
      <ChatTranscript messages={[msg({ key: "history", reasoning: "stored thought", streaming: false })]} tools={[]} />,
    );

    expect(screen.queryByText("Thinking")).toBeNull();
    expect(screen.getByRole("button", { name: /show details/i })).toBeVisible();
  });

  it("expands the tool output body with a pop-down animation", () => {
    vi.useFakeTimers();
    renderTranscript(<ChatTranscript messages={[]} tools={[tool({ key: "t1", output: "tool output here" })]} />);
    const toggle = screen.getByRole("button", { name: /grep/i });
    fireEvent.click(toggle);
    expect(screen.getByText("tool output here").closest(".animate-v2-expand-down")).toBeTruthy();
  });

  it("does not render subagent-only latestMessage data in a generic tool row", () => {
    renderTranscript(
      <ChatTranscript
        messages={[]}
        tools={[
          tool({
            name: "grep",
            running: true,
            done: false,
            output: undefined,
            latestMessage: "private subagent progress",
          }),
        ]}
      />,
      { autoExpandTools: true },
    );

    expect(screen.getByText("Running…")).toBeVisible();
    expect(screen.queryByText("private subagent progress")).toBeNull();
  });

  it("interleaves tool rows at their stream position between messages", () => {
    renderTranscript(
      <ChatTranscript
        messages={[
          msg({ key: "a", role: "assistant", text: "first", order: 1 }),
          msg({ key: "c", role: "assistant", text: "second", order: 4 }),
        ]}
        tools={[tool({ key: "t1", name: "bash", args: "ls", order: 2 })]}
      />,
    );
    const container = scrollContainer();
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
    renderTranscript(<ChatTranscript messages={[msg({ key: "m", text: "Euler: $e^{i\\pi} + 1 = 0$" })]} tools={[]} />);
    expect(document.querySelector(".katex")).toBeTruthy();
  });

  it("renders subagent dispatch under the assistant label, never as You", () => {
    renderTranscript(
      <ChatTranscript
        messages={[
          msg({ key: "d", role: "user", text: "Task: search papers", label: "paper-assistant", order: 0 }),
          msg({ key: "r", role: "assistant", text: "found 3 papers", label: "search", order: 1 }),
        ]}
        tools={[]}
      />,
    );
    const container = scrollContainer();
    expect(container.textContent).not.toContain("You");
    expect(container.textContent).toContain("Paper Assistant");
    expect(container.textContent).toContain("Search");
  });

  it("keeps a collapsed subagent row closed while later rows use the expansion default", async () => {
    const user = userEvent.setup();
    const first = tool({
      key: "sub-1",
      name: "subagent",
      agentName: "search",
      latestMessage: "first progress",
      running: true,
      done: false,
    });
    const second = tool({
      key: "sub-2",
      name: "subagent",
      agentName: "experiment",
      latestMessage: "second progress",
      running: true,
      done: false,
      order: 2,
    });
    const { rerender } = renderTranscript(<ChatTranscript messages={[]} tools={[first, second]} />, {
      expandSubagentOutput: true,
    });

    const firstToggle = screen.getByRole("button", { name: /hide.*search.*running/i });
    expect(firstToggle).toHaveAttribute("aria-expanded", "true");
    await user.click(firstToggle);
    expect(firstToggle).toHaveAttribute("aria-expanded", "false");

    const third = tool({
      key: "sub-3",
      name: "subagent",
      agentName: "writing",
      latestMessage: "third progress",
      running: true,
      done: false,
      order: 3,
    });
    rerender(<ChatTranscript messages={[]} tools={[first, second, third]} />);

    expect(screen.getByRole("button", { name: /show.*search.*running/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /hide.*writing.*running/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("initializes each new reasoning and generic-tool row from preferences only once", async () => {
    const user = userEvent.setup();
    const firstMessage = msg({ key: "reason-1", reasoning: "first thought", order: 1 });
    const firstTool = tool({ key: "tool-1", name: "grep", output: "first tool output", order: 2 });
    const { rerender } = renderTranscript(<ChatTranscript messages={[firstMessage]} tools={[firstTool]} />, {
      autoExpandThinking: true,
      autoExpandTools: true,
    });

    const firstReasoningToggle = screen.getByRole("button", { name: /hide details/i });
    const firstToolToggle = screen.getByRole("button", { name: /grep/i });
    expect(screen.getByText("first thought")).toBeVisible();
    expect(screen.getByText("first tool output")).toBeVisible();
    await user.click(firstReasoningToggle);
    await user.click(firstToolToggle);

    rerender(
      <ChatTranscript
        messages={[firstMessage, msg({ key: "reason-2", reasoning: "second thought", text: "second", order: 3 })]}
        tools={[firstTool, tool({ key: "tool-2", name: "bash", output: "second tool output", order: 4 })]}
      />,
    );

    const reasoningToggles = screen.getAllByRole("button", { name: /details/i });
    expect(reasoningToggles[0]).toHaveAttribute("aria-expanded", "false");
    expect(reasoningToggles[1]).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /grep/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /bash/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("forwards View details with the exact subagent tool key", async () => {
    const onViewDetails = vi.fn();
    renderTranscript(
      <ChatTranscript
        messages={[]}
        tools={[tool({ key: "child-call", name: "subagent", agentName: "search", running: true, done: false })]}
        onViewDetails={onViewDetails}
      />,
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "View details" }));
    expect(onViewDetails).toHaveBeenCalledWith("child-call");
  });

  it("does not render an enabled no-op details action without a callback", () => {
    renderTranscript(
      <ChatTranscript
        messages={[]}
        tools={[tool({ key: "nested-subagent", name: "subagent", agentName: "search", running: true, done: false })]}
      />,
    );

    expect(screen.queryByRole("button", { name: "View details" })).toBeNull();
  });

  it("keeps a row's collapsed state across rerenders that remove and re-add it", () => {
    const reasoning = msg({ key: "reason-1", reasoning: "deep thought", text: "answer", order: 1 });
    const { rerender } = renderTranscript(<ChatTranscript messages={[reasoning]} tools={[]} />, {
      autoExpandThinking: true,
    });
    const toggle = screen.getByRole("button", { name: /hide details/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    rerender(<ChatTranscript messages={[]} tools={[]} />);
    rerender(<ChatTranscript messages={[reasoning]} tools={[]} />);

    expect(screen.getByRole("button", { name: /show details/i })).toHaveAttribute("aria-expanded", "false");
  });
});
