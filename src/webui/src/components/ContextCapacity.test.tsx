import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ContextUsageDto } from "../../../web/contracts";
import { ContextCapacity } from "./ContextCapacity";

function usage(percent: number | null, tokens: number | null = 50_000): ContextUsageDto {
  return { tokens, contextWindow: 100_000, percent };
}

describe("ContextCapacity", () => {
  it("stays absent until Pi supplies usage or a compaction is active", () => {
    const { container } = render(<ContextCapacity compactionState="idle" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("preserves Pi's unknown post-compaction usage as an indeterminate value", () => {
    render(<ContextCapacity usage={usage(null, null)} compactionState="running" />);

    const progress = screen.getByRole("progressbar", { name: /context capacity/i });
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(progress).toHaveAttribute("aria-valuetext", "Unknown");
    expect(screen.getByText("Compacting")).toBeVisible();
  });

  it("starts warning above 70 percent and error above 90 percent", () => {
    const { rerender } = render(<ContextCapacity usage={usage(70)} compactionState="idle" />);
    const severity = () => screen.getByRole("progressbar").closest("[data-context-severity]");

    expect(severity()).toHaveAttribute("data-context-severity", "normal");
    rerender(<ContextCapacity usage={usage(70.1)} compactionState="idle" />);
    expect(severity()).toHaveAttribute("data-context-severity", "warning");
    rerender(<ContextCapacity usage={usage(90)} compactionState="idle" />);
    expect(severity()).toHaveAttribute("data-context-severity", "warning");
    rerender(<ContextCapacity usage={usage(90.1)} compactionState="idle" />);
    expect(severity()).toHaveAttribute("data-context-severity", "error");
  });
});
