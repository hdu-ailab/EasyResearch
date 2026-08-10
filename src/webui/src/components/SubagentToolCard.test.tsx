// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyState, reduceSessionEvent, type ToolView } from "../session-reducer";
import { SubagentToolCard, subagentMessagePreview } from "./SubagentToolCard";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mermaid-svg' />" }),
  },
}));

const subagentTool = (patch: Partial<ToolView> = {}): ToolView => ({
  key: "sub-1",
  name: "subagent",
  running: true,
  done: false,
  error: false,
  agentName: "search",
  step: 2,
  order: 1,
  ...patch,
});

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function stubReducedMotion(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    get matches() {
      return matches;
    },
    media: REDUCED_MOTION_QUERY,
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    }),
    removeEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn((query: string) => {
    expect(query).toBe(REDUCED_MOTION_QUERY);
    return mediaQuery;
  }));
  return {
    mediaQuery,
    listenerCount: () => listeners.size,
    setMatches(next: boolean) {
      matches = next;
      act(() => {
        for (const listener of listeners) {
          listener({ matches: next, media: REDUCED_MOTION_QUERY } as MediaQueryListEvent);
        }
      });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subagentMessagePreview", () => {
  it("normalizes whitespace and bounds only the collapsed preview", () => {
    expect(subagentMessagePreview("  alpha\n\t beta gamma  ", 12)).toBe("alpha beta …");
  });
});

describe("SubagentToolCard", () => {
  it("renders retained progress from an aborted reducer transition", () => {
    let state = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "sub-abort",
      toolName: "subagent",
      args: { agent: "search" },
    } as never);
    state = reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "sub-abort",
      partialResult: { details: { subagent: { agent: "search", latestMessage: "complete progress before abort" } } },
    } as never);
    state = reduceSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "sub-abort",
      result: { content: [{ type: "text", text: "\n\t" }] },
      isError: true,
    } as never);

    const failedTool = state.tools[0]!;
    expect(failedTool).toMatchObject({ running: false, done: true, error: true });
    render(<SubagentToolCard tool={failedTool} initialOpen />);

    expect(screen.getByText("Failed")).toBeVisible();
    expect(screen.getByText("complete progress before abort")).toBeVisible();
  });

  it("uses the animated running edge when reduced motion is not requested", () => {
    stubReducedMotion(false);

    render(<SubagentToolCard tool={subagentTool()} initialOpen={false} />);

    expect(screen.getByRole("article")).toHaveClass("v2-subagent-card-running");
  });

  it("uses a static low-contrast running border when reduced motion is requested", () => {
    stubReducedMotion(true);

    render(<SubagentToolCard tool={subagentTool()} initialOpen={false} />);

    const card = screen.getByRole("article");
    expect(card).not.toHaveClass("v2-subagent-card-running");
    expect(card).toHaveClass("border", "border-v2-blue-200");
    expect(screen.getByText("Running…")).toBeVisible();
  });

  it("responds to reduced-motion changes and removes its listener on unmount", () => {
    const motion = stubReducedMotion(false);
    const { unmount } = render(<SubagentToolCard tool={subagentTool()} initialOpen={false} />);
    const card = screen.getByRole("article");
    expect(motion.listenerCount()).toBe(1);

    motion.setMatches(true);
    expect(card).not.toHaveClass("v2-subagent-card-running");
    expect(card).toHaveClass("border-v2-blue-200");

    unmount();
    expect(motion.mediaQuery.removeEventListener).toHaveBeenCalledOnce();
    expect(motion.listenerCount()).toBe(0);
  });

  it("shows a bounded preview while collapsed and the complete Markdown message when expanded", async () => {
    const user = userEvent.setup();
    const longText = `Progress **report**: ${"complete evidence ".repeat(30)}`.trim();
    render(<SubagentToolCard tool={subagentTool({ latestMessage: longText })} initialOpen={false} />);

    expect(screen.getByText("Search")).toBeVisible();
    expect(screen.getByText("Running…")).toBeVisible();
    expect(screen.getByText("Step 2")).toBeVisible();
    const preview = screen.getByText(/^Progress \*\*report\*\*:.*…$/);
    expect(preview).toHaveClass("line-clamp-3");
    expect(preview).not.toHaveTextContent(longText);
    expect(screen.queryByText(longText)).toBeNull();

    await user.click(screen.getByRole("button", { name: /show.*search.*running.*step 2/i }));

    const card = screen.getByRole("article");
    expect(card).toHaveTextContent(longText.replaceAll("**", ""));
    expect(card).toHaveClass("v2-subagent-card-running");
  });

  it.each([
    { state: "completed", patch: { running: false, done: true, error: false } },
    { state: "failed", patch: { running: false, done: true, error: true } },
  ])("keeps the final message on a $state card without the running edge", ({ state, patch }) => {
    const finalText = `${state} final message`;
    render(
      <SubagentToolCard
        tool={subagentTool({ ...patch, latestMessage: finalText })}
        initialOpen
      />,
    );

    expect(screen.getByText(finalText)).toBeVisible();
    expect(screen.getByText(new RegExp(`^${state}$`, "i"))).toBeVisible();
    expect(screen.getByRole("article")).not.toHaveClass("v2-subagent-card-running");
  });

  it.each([
    {
      state: "running",
      patch: { running: true, done: false, error: false },
      accessibleName: /show.*search.*running.*step 2/i,
    },
    {
      state: "completed",
      patch: { running: false, done: true, error: false },
      accessibleName: /show.*search.*completed.*step 2/i,
    },
    {
      state: "failed",
      patch: { running: false, done: true, error: true },
      accessibleName: /show.*search.*failed.*step 2/i,
    },
  ])("names the $state toggle from its localized agent, state, and step", ({ patch, accessibleName }) => {
    render(<SubagentToolCard tool={subagentTool(patch)} initialOpen={false} />);

    expect(screen.getByRole("button", { name: accessibleName })).toBeVisible();
  });

  it("does not reposition the transcript when expanded", () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      render(<SubagentToolCard tool={subagentTool({ latestMessage: "progress" })} initialOpen />);

      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      if (originalScrollIntoView) {
        HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      }
    }
  });
});
