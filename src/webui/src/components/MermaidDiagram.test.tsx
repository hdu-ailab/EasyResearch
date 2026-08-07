// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MermaidDiagram } from "./MermaidDiagram";

const svgResult = vi.hoisted(() => ({
  svg: "<svg data-testid='mermaid-svg' />",
  diagramType: "flowchart-v2",
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue(svgResult),
  },
}));

import mermaid from "mermaid";

describe("MermaidDiagram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mermaid.render).mockResolvedValue(svgResult);
  });

  it("renders the diagram svg for a valid source", async () => {
    render(<MermaidDiagram source="graph TD; A-->B" />);
    expect(await screen.findByTestId("mermaid-svg")).toBeTruthy();
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), "graph TD; A-->B");
  });

  it("falls back to the raw source on render error", async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error("parse failed"));
    render(<MermaidDiagram source="not a diagram" />);
    expect(await screen.findByText("not a diagram")).toBeTruthy();
  });
});
