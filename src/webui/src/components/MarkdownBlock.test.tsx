import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ControlledMarkdownWorker } from "../testing/markdownWorker";
import { MarkdownBlock } from "./MarkdownBlock";
import {
  configureMarkdownWorkerFactoryForTests,
  type MarkdownWorkerLike,
  resetMarkdownRuntimeForTests,
} from "./markdown/client";
import { FileReferenceBatch } from "./markdown/file-reference-batch";
import { parseMarkdownBlocks } from "./markdown/parse";
import type { MarkdownParseRequest, MarkdownWorkerResponse } from "./markdown/protocol";
import { clearCompletedMarkdownCacheForTests, getCompletedMarkdown } from "./markdown/render";
import { FileReferenceResolutionContext, TranscriptFileContext } from "./markdown/TranscriptFileLink";

function VerifiedFiles({ children }: { children: ReactNode }) {
  return (
    <FileReferenceResolutionContext
      value={
        new FileReferenceBatch(async (paths) => ({
          references: paths.map((reference) => ({ reference, paths: [`/p/${reference}`], truncated: false })),
        }))
      }
    >
      {children}
    </FileReferenceResolutionContext>
  );
}

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg data-testid='mermaid-svg' />" }),
  },
}));

class ParsingWorker implements MarkdownWorkerLike {
  requests = 0;
  readonly message = new Set<(event: MessageEvent<unknown>) => void>();

  postMessage(request: MarkdownParseRequest) {
    this.requests += 1;
    void parseMarkdownBlocks(request.source).then((blocks) => {
      const response: MarkdownWorkerResponse = { ...request, type: "parsed", blocks };
      for (const listener of this.message) listener({ data: response } as MessageEvent<unknown>);
    });
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    if (type === "message") this.message.add(listener as (event: MessageEvent<unknown>) => void);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    if (type === "message") this.message.delete(listener as (event: MessageEvent<unknown>) => void);
  }

  terminate() {}
}

describe("MarkdownBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMarkdownRuntimeForTests();
    clearCompletedMarkdownCacheForTests();
  });

  it("renders math via KaTeX rather than leaving the source unparsed", async () => {
    const { container } = render(<MarkdownBlock text={"Euler: $e^{i\\pi} + 1 = 0$"} />);
    await waitFor(() => expect(container.querySelector(".katex .katex-html")).toBeInTheDocument());
    expect(container.querySelector(".katex math")).not.toBeNull();
    expect(container.querySelector(".katex annotation")?.textContent).toBe("e^{i\\pi} + 1 = 0");
    expect(container).not.toHaveTextContent("$e^{i\\pi} + 1 = 0$");
  });

  it("renders mermaid fences through MermaidDiagram", async () => {
    render(<MarkdownBlock text={"```mermaid\ngraph TD; A-->B\n```"} />);
    expect(await screen.findByTestId("mermaid-svg")).toBeTruthy();
  });

  it("recovers a retained Mermaid component when a partial streamed fence becomes valid", async () => {
    const mermaid = (await import("mermaid")).default;
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error("Incomplete diagram"));
    const worker = new ControlledMarkdownWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const view = render(
      <MarkdownBlock scope="diagram" cacheKey="body" text={"```mermaid\ngraph TD; A-->"} streaming />,
    );
    await act(() => worker.respond());
    expect(await screen.findByText("graph TD; A-->")).toBeTruthy();
    view.rerender(
      <MarkdownBlock scope="diagram" cacheKey="body" text={"```mermaid\ngraph TD; A-->B\n```"} streaming />,
    );
    await act(() => worker.respond());
    expect(await screen.findByTestId("mermaid-svg")).toBeTruthy();
    expect(view.container.querySelector(".er-rendered-diagram")).toBeTruthy();
  });

  it.each(["worker", "fallback"])(
    "resets asynchronous diagram state only when a non-append replacement is published (%s)",
    async (mode) => {
      const worker = new ControlledMarkdownWorker();
      if (mode === "worker") configureMarkdownWorkerFactoryForTests(() => worker);
      const parsed = async () => {
        if (mode === "worker") await act(() => worker.respond());
      };
      const mermaid = (await import("mermaid")).default;
      const lateOld = Promise.withResolvers<{ svg: string; diagramType: string }>();
      const newDiagram = Promise.withResolvers<{ svg: string; diagramType: string }>();
      vi.mocked(mermaid.render)
        .mockReset()
        .mockResolvedValue({ svg: '<svg data-testid="mermaid-svg" />', diagramType: "flowchart-v2" })
        .mockResolvedValueOnce({ svg: '<svg data-testid="old-diagram" />', diagramType: "flowchart-v2" })
        .mockReturnValueOnce(lateOld.promise)
        .mockReturnValueOnce(newDiagram.promise);
      const props = { scope: "replacement-diagram", cacheKey: "body", animateText: true };
      const oldSource = "Old caption\n\n```mermaid\ngraph TD; A-->B";
      const view = render(<MarkdownBlock {...props} text={oldSource} streaming />);
      await parsed();
      const oldDiagram = (await screen.findByTestId("old-diagram")).closest(".er-rendered-diagram");
      const oldCaption = view.container.querySelector("p");

      // An append keeps the last successful diagram while its own async render is pending.
      view.rerender(<MarkdownBlock {...props} text={`${oldSource}\nB-->C`} streaming />);
      await parsed();
      await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("old-diagram").closest(".er-rendered-diagram")).toBe(oldDiagram);
      expect(view.container.querySelector("p")).toBe(oldCaption);

      const replacement = "New caption\n\n```mermaid\ngraph TD; X-->Y";
      view.rerender(<MarkdownBlock {...props} text={replacement} streaming />);
      if (mode === "worker") {
        expect(view.container.querySelector("p")).toBe(oldCaption);
        expect(screen.getByTestId("old-diagram").closest(".er-rendered-diagram")).toBe(oldDiagram);
      }
      await parsed();
      await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(3));
      expect(view.container.querySelector("p")?.textContent).toBe("New caption");
      expect(screen.queryByTestId("old-diagram")).toBeNull();
      expect(oldDiagram?.isConnected).toBe(false);
      expect(view.container.querySelector("[data-entering]")).toBeNull();

      await act(async () => {
        newDiagram.resolve({ svg: '<svg data-testid="new-diagram" />', diagramType: "flowchart-v2" });
      });
      const currentDiagram = screen.getByTestId("new-diagram").closest(".er-rendered-diagram");
      await act(async () => {
        lateOld.resolve({ svg: '<svg data-testid="late-old-diagram" />', diagramType: "flowchart-v2" });
      });
      expect(screen.queryByTestId("late-old-diagram")).toBeNull();
      expect(screen.getByTestId("new-diagram").closest(".er-rendered-diagram")).toBe(currentDiagram);
      view.rerender(<MarkdownBlock {...props} text={replacement} />);
      expect(screen.getByTestId("new-diagram").closest(".er-rendered-diagram")).toBe(currentDiagram);
    },
  );

  it("keeps non-mermaid code fences as code", () => {
    render(<MarkdownBlock text={"```ts\nconst x = 1;\n```"} />);
    expect(screen.getByText("const x = 1;")).toBeTruthy();
  });

  it.each(["worker", "fallback"])("opens local references without navigating in %s mode", async (mode) => {
    if (mode === "worker") configureMarkdownWorkerFactoryForTests(() => new ParsingWorker());
    const open = vi.fn();
    const user = userEvent.setup();
    const before = window.location.hash;
    const { container } = render(
      <VerifiedFiles>
        <TranscriptFileContext value={open}>
          <MarkdownBlock
            scope="paths"
            cacheKey="body"
            text={
              "Read results/table.csv and `C:\\My Papers\\draft.md`. [Open](notes/report%20final.md) [web](https://example.com/a.md)\n\n```text\nresults/code.csv\n```"
            }
          />
        </TranscriptFileContext>
      </VerifiedFiles>,
    );
    const path = await screen.findByRole("button", { name: "results/table.csv" });
    path.focus();
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenLastCalledWith("results/table.csv");
    await user.click(screen.getByRole("button", { name: "C:\\My Papers\\draft.md" }));
    expect(open).toHaveBeenLastCalledWith("C:\\My Papers\\draft.md");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenLastCalledWith("notes/report final.md");
    expect(container.querySelector("pre button")).toBeNull();
    expect(screen.queryByRole("button", { name: "web" })).toBeNull();
    expect(window.location.hash).toBe(before);
  });

  it.each(["worker", "fallback"])("leaves escaped HTML inert in %s mode", async (mode) => {
    if (mode === "worker") configureMarkdownWorkerFactoryForTests(() => new ParsingWorker());
    const text = '<span title="notes.md">hello</span>\n\n<div>notes.md</div>';
    const { container } = render(
      <TranscriptFileContext value={vi.fn()}>
        <MarkdownBlock scope="html-paths" cacheKey="body" text={text} />
      </TranscriptFileContext>,
    );
    if (mode === "worker")
      await waitFor(() =>
        expect(container.querySelector("[data-markdown-source-length]")).toHaveAttribute(
          "data-markdown-source-length",
          String(text.length),
        ),
      );
    expect(container).toHaveTextContent('<span title="notes.md">hello</span>');
    expect(container).toHaveTextContent("<div>notes.md</div>");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("uses the current Work action after cached Markdown is remounted", async () => {
    const worker = new ParsingWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const oldOpen = vi.fn();
    const newOpen = vi.fn();
    const first = render(
      <VerifiedFiles>
        <TranscriptFileContext value={oldOpen}>
          <MarkdownBlock scope="same" cacheKey="same" text="results/table.csv" />
        </TranscriptFileContext>
      </VerifiedFiles>,
    );
    await screen.findByRole("button", { name: "results/table.csv" });
    first.unmount();
    render(
      <VerifiedFiles>
        <TranscriptFileContext value={newOpen}>
          <MarkdownBlock scope="same" cacheKey="same" text="results/table.csv" />
        </TranscriptFileContext>
      </VerifiedFiles>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "results/table.csv" }));
    expect(newOpen).toHaveBeenCalledWith("results/table.csv");
    expect(oldOpen).not.toHaveBeenCalled();
    expect(worker.requests).toBe(1);
  });

  it("reuses a completed worker render after virtual remount", async () => {
    const worker = new ParsingWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const first = render(<MarkdownBlock scope="session" cacheKey="message" text="**cached**" />);
    expect(await screen.findByText("cached")).toBeTruthy();
    first.unmount();
    render(<MarkdownBlock scope="session" cacheKey="message" text="**cached**" />);
    expect(await screen.findByText("cached")).toBeTruthy();
    expect(worker.requests).toBe(1);
  });

  it("publishes coherent prefix progress under continuous appends without raw tails or paragraph remounts", async () => {
    const worker = new ControlledMarkdownWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const { container, rerender } = render(
      <MarkdownBlock scope="session" cacheKey="message" text={"**seed**\n\none"} streaming />,
    );
    await act(() => worker.respond());
    const seed = container.querySelector("strong");
    expect(seed?.textContent).toBe("seed");
    const paragraph = container.querySelectorAll("p")[1];
    let suffix = "\n\none two";
    let accepted = "**seed**\n\none";
    const update = () =>
      rerender(<MarkdownBlock scope="session" cacheKey="message" text={`**seed**${suffix}`} streaming />);
    update();
    for (const token of [" three", " four", " <img src=x onerror=alert(1)>"]) {
      suffix += token;
      update();
      // The last rich snapshot remains whole while a newer source is pending.
      expect(container.querySelector("[data-markdown-source-length]")).toHaveAttribute(
        "data-markdown-source-length",
        String(accepted.length),
      );
      await act(async () => {
        accepted = (await worker.respond()).source;
      });
      expect(container.querySelector("[data-markdown-source-length]")).toHaveAttribute(
        "data-markdown-source-length",
        String(accepted.length),
      );
      expect(container.querySelectorAll("p")[1]).toBe(paragraph);
      expect(container.querySelector("strong")).toBe(seed);
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("[data-markdown-root] > div")).toBeNull();
    }
    await act(() => worker.respond());
    expect(container.querySelector("[data-markdown-source-length]")?.getAttribute("data-markdown-source-length")).toBe(
      String(`**seed**${suffix}`.length),
    );
    expect(container.querySelector("strong")).toBe(seed);
    expect(container.textContent).toContain("one two three");
    expect(container).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("atomically replaces rich content and rejects a prior non-append generation even when its source is a prefix again", async () => {
    const worker = new ControlledMarkdownWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const { container, rerender } = render(
      <MarkdownBlock scope="session" cacheKey="message" text="**old**" streaming />,
    );
    await act(() => worker.respond());
    const old = container.querySelector("strong");
    rerender(<MarkdownBlock scope="session" cacheKey="message" text="**old** pending" streaming />);
    await act(async () => {});
    rerender(<MarkdownBlock scope="session" cacheKey="message" text="**replacement**" streaming />);
    rerender(<MarkdownBlock scope="session" cacheKey="message" text="**old** pending returned" streaming />);
    // The old-generation reply is a textual prefix but no longer has authority.
    await act(() => worker.respond());
    expect(container.querySelector("strong")).toBe(old);
    expect(container.textContent).toBe("old");
    rerender(<MarkdownBlock scope="session" cacheKey="message" text="**replacement**" streaming />);
    await act(() => worker.respond());
    expect(container.textContent).toBe("old");
    await act(() => worker.respond());
    expect(container.querySelector("strong")?.textContent).toBe("replacement");
  });

  it("retains tables and headings through completion with parsing pending, then caches the exact final source", async () => {
    const worker = new ControlledMarkdownWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const prefix = "|A|B|\n|-|-|\n|one|two|\n\n## Heading\n\nAlready formatted";
    const props = { scope: "final", cacheKey: "body" };
    const view = render(<MarkdownBlock {...props} text={prefix} streaming />);
    await act(() => worker.respond());
    const table = screen.getByRole("table");
    const heading = screen.getByRole("heading", { name: "Heading" });
    const paragraph = view.container.querySelector("p");
    const final = `${prefix} prose.`;
    view.rerender(<MarkdownBlock {...props} text={final} streaming />);
    await act(async () => {});
    view.rerender(<MarkdownBlock {...props} text={final} streaming={false} />);
    expect(screen.getByRole("table")).toBe(table);
    expect(screen.getByRole("heading", { name: "Heading" })).toBe(heading);
    expect(view.container.querySelector("[data-markdown-root] > div")).toBeNull();
    await act(() => worker.respond());
    expect(screen.getByRole("table")).toBe(table);
    expect(view.container.querySelector("p")).toBe(paragraph);
    expect(paragraph).toHaveTextContent("Already formatted prose.");
    const requests = worker.requests.length;
    view.unmount();
    const remount = render(<MarkdownBlock {...props} text={final} />);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(remount.container.querySelector("[data-markdown-root] > div")).toBeNull();
    expect(worker.requests).toHaveLength(requests);
  });

  it("does not display another content owner's render or accept its late reply", async () => {
    const worker = new ControlledMarkdownWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const view = render(<MarkdownBlock scope="first" cacheKey="body" text="**foreign**" streaming />);
    await act(() => worker.respond());
    view.rerender(<MarkdownBlock scope="first" cacheKey="body" text="**foreign** pending" streaming />);
    await act(async () => {});
    view.rerender(<MarkdownBlock scope="second" cacheKey="body" text="**current**" streaming />);
    expect(view.container).not.toHaveTextContent("foreign");
    await act(() => worker.respond());
    expect(view.container).not.toHaveTextContent("foreign");
    await act(() => worker.respond());
    expect(view.container.querySelector("strong")).toHaveTextContent("current");
  });

  it("drains an active prefix and the queued final source after completion without caching the interim result", async () => {
    const worker = new ControlledMarkdownWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const props = { scope: "drain", cacheKey: "body" };
    const view = render(<MarkdownBlock {...props} text="Seed" streaming />);
    await act(() => worker.respond());
    const paragraph = view.container.querySelector("p");
    view.rerender(<MarkdownBlock {...props} text="Seed active" streaming />);
    await act(async () => {});
    view.rerender(<MarkdownBlock {...props} text="Seed active final" streaming={false} />);
    await act(() => worker.respond());
    expect(view.container.querySelector("p")).toBe(paragraph);
    expect(paragraph).toHaveTextContent("Seed active");
    expect(getCompletedMarkdown("drain", "body", "Seed active")).toBeUndefined();
    await act(() => worker.respond());
    expect(view.container.querySelector("p")).toBe(paragraph);
    expect(paragraph?.textContent).toBe("Seed active final");
    expect(getCompletedMarkdown("drain", "body", "Seed active final")?.source).toBe("Seed active final");
  });

  it("falls back safely after actual Worker failure, not after queued-request supersession", async () => {
    const worker = new ControlledMarkdownWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const view = render(<MarkdownBlock scope="failure" cacheKey="body" text="**seed**" streaming />);
    await act(() => worker.respond());
    for (const text of ["**seed** one", "**seed** one two", "**seed** one two three"])
      view.rerender(<MarkdownBlock scope="failure" cacheKey="body" text={text} streaming />);
    await act(async () => {});
    expect(view.container.querySelector("[data-markdown-root]")).not.toBeNull();
    expect(view.container).not.toHaveTextContent("three");
    await act(() => worker.fail());
    expect(view.container).toHaveTextContent("seed one two three");
    expect(view.container.querySelector("strong")).toHaveTextContent("seed");
  });
});
