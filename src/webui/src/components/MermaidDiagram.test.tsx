import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => vi.unstubAllGlobals());
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
    await waitFor(() => expect(screen.getAllByTestId("mermaid-svg")).toHaveLength(2));

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

  it("renders distinct diagram identities across mounts and source changes without secure-context crypto", async () => {
    vi.stubGlobal("crypto", { randomUUID: undefined });
    mermaidMock.runtime.render.mockImplementation(async (_id: string, source: string) => ({
      ...svgResult,
      svg: `<svg data-testid="mermaid-svg" data-source="${source}" />`,
    }));
    const errors = vi.fn();
    window.addEventListener("error", errors);
    window.addEventListener("unhandledrejection", errors);
    try {
      const first = render(<MermaidDiagram source="graph TD; First-->Second" />);
      render(<MermaidDiagram source="graph TD; Other-->Diagram" />);
      await waitFor(() => expect(screen.getAllByTestId("mermaid-svg")).toHaveLength(2));
      first.rerender(<MermaidDiagram source="graph TD; Changed-->Source" />);
      await waitFor(() => {
        expect(screen.getAllByTestId("mermaid-svg")).toHaveLength(2);
        expect(first.container.querySelector("svg")).toHaveAttribute("data-source", "graph TD; Changed-->Source");
      });
      first.unmount();
      render(<MermaidDiagram source="graph TD; Remounted-->Diagram" />);
      await waitFor(() => expect(screen.getAllByTestId("mermaid-svg")).toHaveLength(2));
      const calls = mermaidMock.runtime.render.mock.calls as unknown as [string, string][];
      expect(calls.map(([, source]) => source)).toEqual([
        "graph TD; First-->Second",
        "graph TD; Other-->Diagram",
        "graph TD; Changed-->Source",
        "graph TD; Remounted-->Diagram",
      ]);
      const ids = calls.map(([id]) => id);
      expect(new Set(ids).size).toBe(4);
      expect(ids.every((id) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id))).toBe(true);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("error", errors);
      window.removeEventListener("unhandledrejection", errors);
    }
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
