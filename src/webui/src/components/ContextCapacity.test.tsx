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

  it("preserves unknown usage during compaction and describes the active threshold", () => {
    render(<ContextCapacity usage={usage(null, null)} compactionState="running" compactionPolicy={policy()} />);

    const progress = screen.getByRole("progressbar", { name: /context capacity/i });
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(progress).toHaveAttribute("aria-valuetext", expect.stringMatching(/unknown.*70%.*compacting/i));
    expect(screen.getByText("—")).toBeVisible();
  });

  it("uses one neutral arc and exposes actual usage above the clamped ring maximum", () => {
    render(<ContextCapacity usage={usage(112, 112_000)} compactionState="idle" compactionPolicy={policy()} />);

    const progress = screen.getByRole("progressbar");
    expect(progress).toHaveAttribute("aria-valuenow", "100");
    expect(progress).toHaveAttribute("aria-valuetext", expect.stringMatching(/112k \/ 100k.*112%.*70%/i));
    expect(progress).not.toHaveAttribute("data-context-severity");
    expect(screen.getByText("112%")).toBeVisible();
    expect(progress.querySelector("[data-progress-arc]")).toHaveClass("stroke-v2-blue-600");
  });

  it("places the threshold tick radially inside the ring", () => {
    render(<ContextCapacity usage={usage(20)} compactionState="idle" compactionPolicy={policy(25)} />);

    const tick = screen.getByTestId("context-threshold-tick");
    expect(Number(tick.getAttribute("y1"))).toBeCloseTo(Number(tick.getAttribute("y2")), 5);
    expect(Number(tick.getAttribute("x1"))).toBeGreaterThan(Number(tick.getAttribute("x2")));
  });

  it("omits the threshold tick when native automatic compaction is disabled", () => {
    render(<ContextCapacity usage={usage(20)} compactionState="idle" compactionPolicy={policy(70, false)} />);

    expect(screen.queryByTestId("context-threshold-tick")).toBeNull();
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
