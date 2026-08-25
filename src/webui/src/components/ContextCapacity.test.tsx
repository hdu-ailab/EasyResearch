import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CompactionPolicyDto, ContextUsageDto } from "../../../web/contracts";
import { ContextCapacity } from "./ContextCapacity";

function usage(percent: number | null, tokens: number | null = 50_000): ContextUsageDto {
  return { tokens, contextWindow: 100_000, percent };
}

function policy(triggerPercent = 70, enabled = true): CompactionPolicyDto {
  return { triggerPercent, enabled };
}

describe("ContextCapacity", () => {
  it("stays absent until Pi supplies usage or a compaction is active", () => {
    const { container } = render(<ContextCapacity compactionState="idle" compactionPolicy={policy()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("leaves unknown usage as a grey ring without drawing a percentage", () => {
    render(<ContextCapacity usage={usage(null, null)} compactionState="idle" compactionPolicy={policy()} />);

    const progress = screen.getByRole("progressbar", { name: /context capacity/i });
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(progress).toHaveAttribute("aria-valuetext", expect.stringMatching(/unknown.*70%/i));
    expect(progress.querySelector("[data-progress-arc]")).toHaveAttribute("stroke-dasharray", "0 100");
    expect(screen.queryByText("—")).toBeNull();
  });

  it("uses a 20px clockwise high-contrast cobalt arc over the matching grey track", () => {
    render(<ContextCapacity usage={usage(25, 25_000)} compactionState="idle" compactionPolicy={policy()} />);

    const progress = screen.getByRole("progressbar");
    const svg = screen.getByTestId("context-capacity-ring");
    const track = progress.querySelector("[data-context-track]");
    const arc = progress.querySelector("[data-progress-arc]");
    expect(svg).toHaveClass("size-5");
    expect(svg).not.toHaveClass("overflow-visible");
    expect(svg).toHaveAttribute("viewBox", "0 0 20 20");
    expect(track).toHaveClass("stroke-v2-grey-300");
    expect(arc).toHaveClass("stroke-v2-blue-600");
    expect(arc).toHaveAttribute("pathLength", "100");
    expect(arc).toHaveAttribute("stroke-dasharray", "25 100");
    expect(arc).toHaveAttribute("transform", "rotate(-90 10 10)");
    expect(arc).not.toHaveClass("origin-center");
    for (const attribute of ["cx", "cy", "r", "stroke-width"]) {
      expect(arc?.getAttribute(attribute)).toBe(track?.getAttribute(attribute));
    }
    expect(screen.queryByText("25%")).toBeNull();
    expect(screen.getByText("25k / 100k")).toBeInTheDocument();
  });

  it("keeps positive fractional usage visible instead of rounding the arc to zero", () => {
    render(<ContextCapacity usage={usage(0.4, 400)} compactionState="idle" compactionPolicy={policy()} />);

    const arc = screen.getByRole("progressbar").querySelector("[data-progress-arc]");
    expect(arc).toHaveAttribute("stroke-dasharray", "0.4 100");
  });

  it("exposes actual usage above the clamped ring maximum without visible percentage text", () => {
    render(<ContextCapacity usage={usage(112, 112_000)} compactionState="idle" compactionPolicy={policy()} />);

    const progress = screen.getByRole("progressbar");
    expect(progress).toHaveAttribute("aria-valuenow", "100");
    expect(progress).toHaveAttribute("aria-valuetext", expect.stringMatching(/112k \/ 100k.*112%.*70%/i));
    expect(progress).not.toHaveAttribute("data-context-severity");
    expect(screen.queryByText("112%")).toBeNull();
    expect(progress.querySelector("[data-progress-arc]")).toHaveAttribute("stroke-dasharray", "100 100");
  });

  it("never draws an inner threshold mark for enabled or disabled policy", () => {
    const view = render(<ContextCapacity usage={usage(20)} compactionState="idle" compactionPolicy={policy(25)} />);

    expect(screen.getByTestId("context-capacity-ring").querySelector("line")).toBeNull();
    view.rerender(<ContextCapacity usage={usage(20)} compactionState="idle" compactionPolicy={policy(70, false)} />);
    expect(screen.getByTestId("context-capacity-ring").querySelector("line")).toBeNull();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      expect.stringMatching(/automatic compaction disabled/i),
    );
  });

  it("shows a visible state indicator while compaction is queued", () => {
    const view = render(<ContextCapacity usage={usage(60)} compactionState="queued" compactionPolicy={policy()} />);

    expect(screen.getByTestId("context-compaction-state")).toBeVisible();
    expect(screen.getByTestId("context-compaction-state")).toHaveAttribute("data-state", "queued");
    expect(screen.getByTestId("context-compaction-state")).toHaveTextContent("Queued");

    view.rerender(<ContextCapacity usage={usage(60)} compactionState="running" compactionPolicy={policy()} />);
    expect(screen.getByTestId("context-compaction-state")).toHaveTextContent("Compacting");
  });
});
