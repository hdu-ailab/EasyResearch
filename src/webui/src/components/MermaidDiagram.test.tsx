import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidDiagram } from "./MermaidDiagram";

const svgResult = vi.hoisted(() => ({
  svg: "<svg data-testid='mermaid-svg' />",
  diagramType: "flowchart-v2",
}));

const mermaidMock = vi.hoisted(() => ({
  moduleLoads: 0,
  runtime: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue(svgResult),
  },
}));

vi.mock("mermaid", () => {
  mermaidMock.moduleLoads += 1;
  return { default: mermaidMock.runtime };
});

describe("MermaidDiagram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mermaidMock.runtime.render.mockResolvedValue(svgResult);
  });

  it("loads Mermaid on the first diagram and reuses the initialized runtime", async () => {
    expect(mermaidMock.moduleLoads).toBe(0);
    const first = render(<MermaidDiagram source="graph TD; A-->B" />);
    expect(first.container.textContent).toContain("…");
    expect(await screen.findByTestId("mermaid-svg")).toBeTruthy();

    render(<MermaidDiagram source="graph TD; B-->C" />);
    await waitFor(() => expect(mermaidMock.runtime.render).toHaveBeenCalledTimes(2));

    expect(mermaidMock.moduleLoads).toBe(1);
    expect(mermaidMock.runtime.initialize).toHaveBeenCalledTimes(1);
    expect(mermaidMock.runtime.render).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^mermaid-/),
      "graph TD; A-->B",
    );
    expect(mermaidMock.runtime.render).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^mermaid-/),
      "graph TD; B-->C",
    );
  });

  it("falls back to the raw source on render error", async () => {
    mermaidMock.runtime.render.mockRejectedValue(new Error("parse failed"));
    render(<MermaidDiagram source="not a diagram" />);
    expect(await screen.findByText("not a diagram")).toBeTruthy();
  });

  it("does not apply a render result after unmount", async () => {
    let resolveRender!: (value: typeof svgResult) => void;
    const pending = new Promise<typeof svgResult>((resolve) => {
      resolveRender = resolve;
    });
    mermaidMock.runtime.render.mockReturnValueOnce(pending);

    const view = render(<MermaidDiagram source="graph TD; A-->B" />);
    await waitFor(() => expect(mermaidMock.runtime.render).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      resolveRender(svgResult);
      await pending;
    });

    expect(screen.queryByTestId("mermaid-svg")).toBeNull();
  });
});
