// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "./ChatTranscript";
import type { SessionMessageView, ToolView } from "../session-reducer";
import { STORAGE_KEY, writePreferences, type WebUiPreferences } from "../preferences";
import { PreferencesProvider } from "../preferences/PreferencesProvider";

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

let notifyResize: ResizeObserverCallback;
let flushFrame: FrameRequestCallback | undefined;
let observedContent: Element | undefined;
let resizeObserver: ResizeObserverStub;
let requestFrame: ReturnType<typeof vi.fn>;
let cancelFrame: ReturnType<typeof vi.fn>;
let scrollIntoViewSpy: ReturnType<typeof vi.spyOn>;
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

class ResizeObserverStub {
  constructor(callback: ResizeObserverCallback) {
    notifyResize = callback;
    resizeObserver = this;
  }

  observe = vi.fn((element: Element) => {
    observedContent = element;
  });

  disconnect = vi.fn();
}

function flushFollowFrame() {
  const callback = flushFrame;
  flushFrame = undefined;
  callback?.(0);
}

function fireContentResize() {
  notifyResize([], resizeObserver as unknown as ResizeObserver);
  flushFollowFrame();
}

function renderTranscript(ui: ReactElement, preferences: Partial<WebUiPreferences> = {}) {
  writePreferences(window.localStorage, { ...defaultPreferences, ...preferences });
  return render(ui, { wrapper: PreferencesProvider });
}

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
  beforeEach(() => {
    flushFrame = undefined;
    observedContent = undefined;
    requestFrame = vi.fn((callback: FrameRequestCallback) => {
      flushFrame = callback;
      return 1;
    });
    cancelFrame = vi.fn();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
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
    expect(row.textContent).toContain("Orchestrator");
  });

  it("pins to the bottom on content change, unpins on manual scroll, and re-pins at the bottom", () => {
    const first = [msg({ key: "a", text: "one" })];
    const { rerender } = renderTranscript(<ChatTranscript messages={first} tools={[]} />);
    const el = pinnedContainer(rerender);
    flushFollowFrame();
    expect(el.scrollTop).toBe(400);

    rerender(<ChatTranscript messages={[...first, msg({ key: "b", text: "two" })]} tools={[]} />);
    flushFollowFrame();
    expect(el.scrollTop).toBe(400);

    el.scrollTop = 100;
    fireEvent.scroll(el);
    rerender(<ChatTranscript messages={[...first, msg({ key: "b" }), msg({ key: "c", text: "three" })]} tools={[]} />);
    flushFollowFrame();
    expect(el.scrollTop).toBe(100);

    el.scrollTop = 400;
    fireEvent.scroll(el);
    rerender(<ChatTranscript messages={[...first, msg({ key: "b" }), msg({ key: "c" }), msg({ key: "d", text: "four" })]} tools={[]} />);
    flushFollowFrame();
    expect(el.scrollTop).toBe(400);
  });

  it("stays at the bottom when a tool event arrives while pinned", () => {
    const first = [msg({ key: "a" })];
    const { rerender } = renderTranscript(<ChatTranscript messages={first} tools={[]} />);
    const el = pinnedContainer(rerender);
    flushFollowFrame();
    rerender(<ChatTranscript messages={first} tools={[tool({ key: "t2" })]} />);
    flushFollowFrame();
    expect(el.scrollTop).toBe(400);
  });

  it("follows observed content growth while pinned and coalesces resize work per frame", () => {
    let scrollHeight = 400;
    renderTranscript(<ChatTranscript messages={[msg({ key: "a" })]} tools={[]} />);
    const el = screen.getByLabelText("Conversation") as HTMLDivElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
    flushFollowFrame();

    expect(observedContent).toBe(el.querySelector("ul"));
    scrollHeight = 600;
    notifyResize([], resizeObserver as unknown as ResizeObserver);
    notifyResize([], resizeObserver as unknown as ResizeObserver);

    expect(requestFrame).toHaveBeenCalledTimes(2);
    flushFollowFrame();
    expect(el.scrollTop).toBe(600);
  });

  it("shares one queued frame between a pending-row change and ResizeObserver notification", () => {
    const { rerender } = renderTranscript(<ChatTranscript messages={[]} tools={[]} />);
    flushFollowFrame();
    requestFrame.mockClear();

    rerender(<ChatTranscript messages={[]} tools={[]} pending />);
    notifyResize([], resizeObserver as unknown as ResizeObserver);

    expect(requestFrame).toHaveBeenCalledOnce();
    flushFollowFrame();
  });

  it("preserves the reading position when observed content grows while unpinned", () => {
    let scrollHeight = 400;
    renderTranscript(<ChatTranscript messages={[msg({ key: "a" })]} tools={[]} />);
    const el = screen.getByLabelText("Conversation") as HTMLDivElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
    flushFollowFrame();

    el.scrollTop = 100;
    fireEvent.scroll(el);
    scrollHeight = 600;
    fireContentResize();

    expect(el.scrollTop).toBe(100);
  });

  it("re-engages resize following after scrolling within 24px of the bottom", () => {
    let scrollHeight = 600;
    renderTranscript(<ChatTranscript messages={[msg({ key: "a" })]} tools={[]} />);
    const el = screen.getByLabelText("Conversation") as HTMLDivElement;
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
    flushFollowFrame();

    el.scrollTop = 100;
    fireEvent.scroll(el);
    el.scrollTop = 376;
    fireEvent.scroll(el);
    scrollHeight = 700;
    fireContentResize();

    expect(el.scrollTop).toBe(700);
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

  it("disconnects content observation and cancels queued follow work on unmount", () => {
    const { unmount } = renderTranscript(<ChatTranscript messages={[msg({ key: "a" })]} tools={[]} />);
    const observer = resizeObserver;

    unmount();

    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(cancelFrame).toHaveBeenCalledWith(1);
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
        tools={[tool({ name: "grep", running: true, done: false, output: undefined, latestMessage: "private subagent progress" })]}
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
    renderTranscript(<ChatTranscript messages={[msg({ key: "m", text: "Euler: $e^{i\\pi} + 1 = 0$" })]} tools={[]} />);
    expect(document.querySelector(".katex")).toBeTruthy();
  });

  it("renders subagent dispatch under the orchestrator label, never as You", () => {
    renderTranscript(
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
    const { rerender } = renderTranscript(
      <ChatTranscript messages={[]} tools={[first, second]} />,
      { expandSubagentOutput: true },
    );

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
    const { rerender } = renderTranscript(
      <ChatTranscript messages={[firstMessage]} tools={[firstTool]} />,
      { autoExpandThinking: true, autoExpandTools: true },
    );

    const firstReasoningToggle = screen.getByRole("button", { name: /hide details/i });
    const firstToolToggle = screen.getByRole("button", { name: /grep/i });
    expect(screen.getByText("first thought")).toBeVisible();
    expect(screen.getByText("first tool output")).toBeVisible();
    await user.click(firstReasoningToggle);
    await user.click(firstToolToggle);

    rerender(
      <ChatTranscript
        messages={[
          firstMessage,
          msg({ key: "reason-2", reasoning: "second thought", text: "second", order: 3 }),
        ]}
        tools={[
          firstTool,
          tool({ key: "tool-2", name: "bash", output: "second tool output", order: 4 }),
        ]}
      />,
    );

    const reasoningToggles = screen.getAllByRole("button", { name: /details/i });
    expect(reasoningToggles[0]).toHaveAttribute("aria-expanded", "false");
    expect(reasoningToggles[1]).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /grep/i })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /bash/i })).toHaveAttribute("aria-expanded", "true");
  });
});
