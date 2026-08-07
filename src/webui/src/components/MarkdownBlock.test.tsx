// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownBlock } from "./MarkdownBlock";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mermaid-svg' />" }),
  },
}));

describe("MarkdownBlock", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders math via KaTeX", () => {
    render(<MarkdownBlock text={"Euler: $e^{i\\pi} + 1 = 0$"} />);
    expect(screen.getByText(/e\^\{i\\pi\}/)).toBeTruthy();
  });

  it("renders mermaid fences through MermaidDiagram", async () => {
    render(<MarkdownBlock text={"```mermaid\ngraph TD; A-->B\n```"} />);
    expect(await screen.findByTestId("mermaid-svg")).toBeTruthy();
  });

  it("keeps non-mermaid code fences as code", () => {
    render(<MarkdownBlock text={"```ts\nconst x = 1;\n```"} />);
    expect(screen.getByText("const x = 1;")).toBeTruthy();
  });
});
