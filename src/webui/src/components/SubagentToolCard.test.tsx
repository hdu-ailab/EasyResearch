import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyState, reduceSessionEvent, reduceSubagentSupervisorEvent, type ToolView } from "../session-reducer";
import { SubagentToolCard, subagentMessagePreview } from "./SubagentToolCard";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mermaid-svg' />" }),
  },
}));

const subagentTool = (patch: Partial<ToolView> = {}): ToolView => ({
  key: "sub-1",
  toolCallId: "sub-1",
  name: "subagent",
  running: true,
  done: false,
  error: false,
  ownerSessionId: "root",
  agentId: "search_0",
  supervised: true,
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
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      expect(query).toBe(REDUCED_MOTION_QUERY);
      return mediaQuery;
    }),
  );
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
  it("keeps a successful launch acknowledgement Working until a supervisor terminal", () => {
    const started = reduceSessionEvent(emptyState, {
      type: "tool_execution_start",
      toolCallId: "sub-launch",
      toolName: "subagent",
      args: { agent: "search" },
    } as never);
    const acknowledged = reduceSessionEvent(started, {
      type: "tool_execution_end",
      toolCallId: "sub-launch",
      toolName: "subagent",
      isError: false,
      result: {
        content: [{ type: "text", text: "search_7 is working." }],
        details: {
          mode: "single",
          background: true,
          job: {
            launchId: "launch-7",
            ownerSessionId: "root",
            toolCallId: "sub-launch",
            agent: "search",
            agentId: "search_7",
            childSessionId: "child-7",
            status: "working",
          },
        },
      },
    } as never);

    render(<SubagentToolCard tool={acknowledged.tools[0]!} initialOpen={false} />);

    expect(screen.getByText("Running…")).toBeVisible();
    expect(screen.getByText("search_7")).toBeVisible();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("becomes terminal only from supervisor status and prefers the full terminal message over stale activity", () => {
    const running = subagentTool({
      latestMessage: "older assistant progress",
      latestActivity: { kind: "tool", name: "bash", args: "long-running.sh", state: "running" },
    });
    const state = reduceSubagentSupervisorEvent(
      { ...emptyState, tools: [running], nextOrder: 1 },
      {
        type: "subagent_supervisor",
        launchId: "launch-0",
        ownerSessionId: "root",
        toolCallId: "sub-1",
        agent: "search",
        agentId: "search_0",
        childSessionId: "child-0",
        status: "error",
        latestMessage: "full terminal handoff",
      },
    );

    render(<SubagentToolCard tool={state.tools[0]!} initialOpen />);

    expect(screen.getByText("Failed")).toBeVisible();
    expect(screen.getByText("full terminal handoff")).toBeVisible();
    expect(screen.queryByText(/long-running\.sh/)).toBeNull();
  });

  it("never renders a child session path field", () => {
    const pathBearing = {
      ...subagentTool({ running: false, done: true, error: true, latestMessage: "launch failed" }),
      sessionPath: "/private/agent/sessions/child.jsonl",
    } as ToolView;

    render(<SubagentToolCard tool={pathBearing} initialOpen />);

    expect(screen.getByText("launch failed")).toBeVisible();
    expect(screen.queryByText(/child\.jsonl/)).toBeNull();
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
    render(<SubagentToolCard tool={subagentTool({ ...patch, latestMessage: finalText })} initialOpen />);

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

  it("offers View details as a separate action with the exact tool key", async () => {
    const onViewDetails = vi.fn();
    render(<SubagentToolCard tool={subagentTool()} initialOpen={false} onViewDetails={onViewDetails} />);

    const details = screen.getByRole("button", { name: "View details" });
    expect(details).not.toBe(screen.getByRole("button", { name: /show.*search.*running/i }));
    await userEvent.setup().click(details);
    expect(onViewDetails).toHaveBeenCalledOnce();
    expect(onViewDetails).toHaveBeenCalledWith("sub-1", 2);
  });

  it("hides View details when no callback is available in a nested child transcript", () => {
    render(<SubagentToolCard tool={subagentTool()} initialOpen={false} />);

    expect(screen.queryByRole("button", { name: "View details" })).toBeNull();
  });

  it("does not offer details for a settled tool without a saved child mapping", () => {
    render(
      <SubagentToolCard
        tool={subagentTool({ running: false, done: true })}
        initialOpen={false}
        onViewDetails={vi.fn()}
      />,
    );

    expect(screen.getByText("No progress was saved before this run ended.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "View details" })).toBeNull();
  });

  it("offers one accessible details action for every mapped chain step", async () => {
    const onViewDetails = vi.fn();
    render(
      <SubagentToolCard
        tool={subagentTool({
          running: false,
          done: true,
          sessionLinks: [
            {
              ownerSessionId: "root",
              toolCallId: "sub-1",
              childSessionId: "child-search",
              agent: "search",
              agentId: "search_0",
              status: "complete",
              step: 1,
            },
            {
              ownerSessionId: "root",
              toolCallId: "sub-1",
              childSessionId: "child-writing",
              agent: "writing",
              agentId: "writing_0",
              status: "complete",
              step: 2,
            },
          ],
        })}
        initialOpen={false}
        onViewDetails={onViewDetails}
      />,
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "View details: Step 1" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "View details: Step 2" }));
    expect(onViewDetails.mock.calls).toEqual([
      ["sub-1", 1],
      ["sub-1", 2],
    ]);
  });

  it("renders the opaque agent id directly from the supervised tool", () => {
    render(
      <SubagentToolCard
        tool={subagentTool({
          agentId: "review/run:alpha-7",
          sessionLinks: [
            {
              ownerSessionId: "root",
              toolCallId: "sub-1",
              childSessionId: "child-search",
              agent: "search",
              agentId: "stale-id",
              status: "working",
            },
          ],
        })}
        initialOpen={false}
      />,
    );

    expect(screen.getByText("review/run:alpha-7")).toBeVisible();
    expect(screen.queryByText("stale-id")).toBeNull();
  });

  it("describes missing settled progress without claiming it is waiting", () => {
    render(<SubagentToolCard tool={subagentTool({ running: false, done: true })} initialOpen={false} />);

    expect(screen.getByText("No progress was saved before this run ended.")).toBeVisible();
    expect(screen.queryByText(/waiting/i)).toBeNull();
  });

  it("shows a bounded preview of a tool activity and the full call when expanded", async () => {
    const user = userEvent.setup();
    const longArgs = `--input "${"abcdef ".repeat(40)}"`;
    render(
      <SubagentToolCard
        tool={subagentTool({ latestActivity: { kind: "tool", name: "bash", args: longArgs, state: "running" } })}
        initialOpen={false}
      />,
    );

    expect(screen.getByText("Search")).toBeVisible();
    const preview = screen.getByText(/^bash --input .*…$/);
    expect(preview).toHaveClass("line-clamp-3");
    expect(preview).not.toHaveTextContent(longArgs);

    await user.click(screen.getByRole("button", { name: /show.*search.*running.*step 2/i }));
    expect(screen.getByText(new RegExp(`^bash --input "${"abcdef ".repeat(40)}"`))).toBeVisible();
  });

  it("prefers the latest tool activity over an older assistant message", () => {
    render(
      <SubagentToolCard
        tool={subagentTool({
          latestMessage: "final summary",
          latestActivity: { kind: "tool", name: "webfetch", args: "https://example.com", state: "done" },
        })}
        initialOpen={false}
      />,
    );

    expect(screen.getByText(/^webfetch https:\/\/example.com$/)).toBeVisible();
    expect(screen.queryByText("final summary")).toBeNull();
  });

  it("renders a text activity like the assistant message preview", () => {
    render(
      <SubagentToolCard
        tool={subagentTool({ latestActivity: { kind: "text", text: "Searching repositories…" } })}
        initialOpen={false}
      />,
    );

    expect(screen.getByText("Searching repositories…")).toBeVisible();
  });
});
