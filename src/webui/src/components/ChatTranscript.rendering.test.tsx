import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiUsageRecordDto } from "../../../web/contracts";
import { STORAGE_KEY, writePreferences } from "../preferences";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import type { SessionCompletionView, SessionMessageView, SessionSummaryView, ToolView } from "../session-reducer";
import { hydrateTranscript } from "../testing/transcriptTest";
import { TIMELINE_CATEGORIES, TIMELINE_PRESETS, type TimelineDetail } from "../timeline-detail";
import * as Usage from "./ApiUsageLine";
import { ChatTranscript } from "./ChatTranscript";
import { MarkdownBlock, type MarkdownBlockProps } from "./MarkdownBlock";
import * as Thinking from "./ThinkingPreview";
import * as Activities from "./TranscriptActivityRows";

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

const message = (key: string, order: number, text: string, reasoning?: string): SessionMessageView => ({
  key,
  order,
  role: "assistant",
  text,
  reasoning,
  streaming: false,
  error: false,
});

function usage(key: string): ApiUsageRecordDto {
  return {
    id: key,
    sessionId: "root",
    source: "assistant",
    timestamp: "2026-11-06T00:00:00Z",
    anchor: { kind: "message", messageEntryId: key },
    usage: {
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 12,
      cacheHitRate: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("transcript render isolation", () => {
  it("updates concealment of a reused live thinking source while retaining its answer", () => {
    const expanded = TIMELINE_PRESETS.find((preset) => preset.id === "everything")!.value;
    const hidden = TIMELINE_PRESETS.find((preset) => preset.id === "text-only")!.value;
    const store = (timelineDetail: TimelineDetail) =>
      writePreferences(window.localStorage, {
        chatFontSize: 13,
        filesFontSize: 12,
        language: "en",
        studioTheme: "light",
        autoExpandThinking: false,
        autoExpandTools: false,
        expandSubagentOutput: false,
        timelineDetail,
      });
    store(expanded);
    const source = Object.freeze({
      ...message("live", 0, "Visible answer", "LIVE_THOUGHT"),
      streaming: true,
      isThinking: true,
    });
    const view = render(<ChatTranscript messages={[source]} tools={[]} hydrationScope="live-policy" />, {
      wrapper: PreferencesProvider,
    });
    hydrateTranscript(view.container);
    expect(screen.getByText("LIVE_THOUGHT")).toBeVisible();
    const answer = screen.getByText("Visible answer").closest("[data-message-body]");
    store(hidden);
    fireEvent(window, new StorageEvent("storage", { key: STORAGE_KEY }));
    expect(screen.queryByText("LIVE_THOUGHT")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(screen.getByText("Visible answer").closest("[data-message-body]")).toBe(answer);
    store(expanded);
    fireEvent(window, new StorageEvent("storage", { key: STORAGE_KEY }));
    expect(screen.getByText("LIVE_THOUGHT")).toBeVisible();
    expect(screen.getByText("Visible answer").closest("[data-message-body]")).toBe(answer);
    expect(source.reasoning).toBe("LIVE_THOUGHT");
  });

  it.each([
    { placement: "grouped", open: false },
    { placement: "grouped", open: true },
    { placement: "separate", open: false },
    { placement: "separate", open: true },
  ] as const)(
    "isolates unchanged historical $placement rows (open=$open) without freezing changed members",
    ({ placement, open }) => {
      const policy = Object.fromEntries(
        TIMELINE_CATEGORIES.map((category) => [category, { placement, details: open ? "expanded" : "collapsed" }]),
      ) as TimelineDetail;
      writePreferences(window.localStorage, {
        chatFontSize: 13,
        filesFontSize: 12,
        language: "en",
        studioTheme: "light",
        autoExpandThinking: false,
        autoExpandTools: false,
        expandSubagentOutput: false,
        timelineDetail: policy,
      });
      // Passthrough spies invoke the real render functions. The virtualizer,
      // virtual-row memo boundary and original Markdown memo comparator stay live.
      const activityRender = vi.spyOn(Activities, "TranscriptActivity");
      const thinkingRender = vi.spyOn(Thinking, "ThinkingPreview");
      const usageRender = vi.spyOn(Usage, "ApiUsageLine");
      const markdownRender = vi.spyOn(
        MarkdownBlock as unknown as { type: (props: MarkdownBlockProps) => unknown },
        "type",
      );
      let outputReads = 0;
      const historical: SessionMessageView[] = [];
      const tools: ToolView[] = [];
      const groups = 4;
      const toolsPerGroup = 12;
      const deltas = 20;
      for (let group = 0; group < groups; group++) {
        const offset = group * 100;
        for (let index = 0; index < toolsPerGroup; index++) {
          tools.push(
            Object.freeze({
              key: `old-tool-${group}-${index}`,
              order: offset + index,
              name: "read",
              args: `evidence-${group}-${index}.md`,
              running: false,
              done: true,
              error: false,
              get output() {
                outputReads++;
                return `HISTORICAL_OUTPUT_${group}_${index}`;
              },
            }),
          );
        }
        // Mixed messages exercise both the thinking wrapper and stripped answer.
        // ApiUsageLine is a real child render counter for the otherwise private MessageRow.
        const key = `old-message-${group}`;
        historical.push(
          Object.freeze({
            ...message(key, offset + 20, `HISTORICAL_ANSWER_${group}`, `HISTORICAL_THOUGHT_${group}`),
            apiUsage: usage(key),
          }),
        );
      }
      const summaries: SessionSummaryView[] = [];
      const completions: SessionCompletionView[] = [];
      const base = {
        summaries,
        completions,
        hydrationScope: "render-root",
        hydrationRevision: 1,
        showApiUsageDetails: true,
      };
      const live = { ...message("current", 1000, "LIVE_0"), streaming: true };
      const initialMessages = [...historical, live];
      const view = render(<ChatTranscript {...base} tools={tools} messages={initialMessages} />, {
        wrapper: PreferencesProvider,
      });
      hydrateTranscript(view.container);
      const mounted = [...view.container.querySelectorAll("[data-row-key]")];
      expect(screen.getByText("LIVE_0")).toBeVisible();
      expect(screen.getAllByLabelText("API usage details")).toHaveLength(groups);
      if (placement === "grouped")
        expect(screen.getAllByRole("button", { name: /13 activities/ })).toHaveLength(groups);
      else expect(screen.getAllByRole("button", { name: "Thinking process" })).toHaveLength(groups);
      if (open) expect(screen.getByText("HISTORICAL_THOUGHT_0")).toBeVisible();

      const clear = () => {
        activityRender.mockClear();
        thinkingRender.mockClear();
        usageRender.mockClear();
        markdownRender.mockClear();
        outputReads = 0;
      };
      clear();
      view.rerender(<ChatTranscript {...base} tools={tools} messages={initialMessages} />);
      expect(activityRender).not.toHaveBeenCalled();
      expect(usageRender).not.toHaveBeenCalled();
      for (let index = 1; index <= deltas; index++)
        view.rerender(
          <ChatTranscript {...base} tools={tools} messages={[...historical, { ...live, text: `LIVE_${index}` }]} />,
        );
      expect(screen.getByText(`LIVE_${deltas}`)).toBeVisible();
      const after = [...view.container.querySelectorAll("[data-row-key]")];
      expect(after).toHaveLength(mounted.length);
      mounted.forEach((node, index) => {
        expect(after[index]).toBe(node);
      });
      expect(activityRender).not.toHaveBeenCalled();
      expect(thinkingRender).not.toHaveBeenCalled();
      expect(usageRender).not.toHaveBeenCalled();
      expect(outputReads).toBe(0);
      expect(markdownRender.mock.calls.filter(([props]) => props.cacheKey?.startsWith("old-"))).toHaveLength(0);
      expect(markdownRender.mock.calls.filter(([props]) => props.cacheKey === "current:text")).toHaveLength(deltas);

      // A changed member must update its own row/group while the others stay isolated.
      const updatedTools = tools.map((tool, index) =>
        index === 0 ? { ...tool, output: "UPDATED_TOOL_OUTPUT" } : tool,
      );
      const tail = { ...live, text: `LIVE_${deltas}` };
      clear();
      view.rerender(<ChatTranscript {...base} tools={updatedTools} messages={[...historical, tail]} />);
      expect(activityRender.mock.calls.map(([props]) => props.entry.key)).toEqual([
        placement === "grouped" ? "activity:old-tool-0-0" : "old-tool-0-0",
      ]);
      expect(usageRender).not.toHaveBeenCalled();
      const changed = historical.map((entry, index) =>
        index === 0 ? { ...entry, reasoning: "UPDATED_THOUGHT" } : entry,
      );
      clear();
      view.rerender(<ChatTranscript {...base} tools={updatedTools} messages={[...changed, tail]} />);
      expect(activityRender.mock.calls.map(([props]) => props.entry.key)).toEqual([
        placement === "grouped" ? "activity:old-tool-0-0" : "old-message-0:thinking",
      ]);
      // Changing only thought text must not rerender its unchanged stripped answer.
      expect(usageRender).not.toHaveBeenCalled();
      expect(historical[0]?.reasoning).toBe("HISTORICAL_THOUGHT_0");
      const firstRow = () =>
        view.container.querySelector(
          `[data-row-key="${placement === "grouped" ? "activity:old-tool-0-0" : "old-tool-0-0"}"]`,
        ) as HTMLElement;
      if (!open) {
        if (placement === "grouped") fireEvent.click(within(firstRow()).getByRole("button", { name: /13 activities/ }));
        fireEvent.click(within(firstRow()).getByRole("button", { name: /^read evidence-0-0.md/ }));
        fireEvent.click(screen.getAllByRole("button", { name: "Thinking process" })[0]!);
      }
      expect(screen.getByText("UPDATED_TOOL_OUTPUT")).toBeVisible();
      expect(screen.getByText("UPDATED_THOUGHT")).toBeVisible();

      const inserted: ToolView = {
        key: "inserted",
        name: "web-search",
        args: "new evidence",
        order: 0.5,
        running: false,
        done: true,
        error: false,
        output: "new result",
      };
      view.rerender(
        <ChatTranscript
          {...base}
          tools={[updatedTools[0]!, inserted, ...updatedTools.slice(1)]}
          messages={[...changed, tail]}
        />,
      );
      if (placement === "grouped") expect(screen.getByRole("button", { name: /14 activities/ })).toBeVisible();
      expect(screen.getByRole("button", { name: /^web-search new evidence/ })).toBeVisible();
      const changedUsage = changed.map((entry, index) =>
        index === 0 && entry.apiUsage
          ? { ...entry, apiUsage: { ...entry.apiUsage, usage: { ...entry.apiUsage.usage, input: 27 } } }
          : entry,
      );
      view.rerender(<ChatTranscript {...base} tools={updatedTools} messages={[...changedUsage, tail]} />);
      expect(screen.getAllByLabelText("API usage details")).toHaveLength(groups);
      expect(screen.getByText(/In 27/)).toBeVisible();
    },
  );
});
