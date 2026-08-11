import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mermaid-svg' />" }),
  },
}));

describe("MarkdownPreview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders mermaid fences", async () => {
    render(<MarkdownPreview path="/p/paper.md" content={"```mermaid\ngraph TD; A-->B\n```"} onOpenFile={() => {}} />);
    expect(await screen.findByTestId("mermaid-svg")).toBeTruthy();
  });

  it("renders math via KaTeX", () => {
    render(<MarkdownPreview path="/p/paper.md" content={"The energy is $E = mc^2$."} onOpenFile={() => {}} />);
    expect(document.querySelector(".katex")).toBeTruthy();
  });
});
