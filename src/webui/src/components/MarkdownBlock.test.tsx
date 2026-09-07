import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownBlock } from "./MarkdownBlock";
import {
  configureMarkdownWorkerFactoryForTests,
  type MarkdownWorkerLike,
  resetMarkdownRuntimeForTests,
} from "./markdown/client";
import { parseMarkdownBlocks } from "./markdown/parse";
import type { MarkdownParseRequest, MarkdownWorkerResponse } from "./markdown/protocol";
import { clearCompletedMarkdownCacheForTests } from "./markdown/render";

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

class DelayedWorker extends ParsingWorker {
  pending: MarkdownParseRequest[] = [];

  override postMessage(request: MarkdownParseRequest) {
    this.pending.push(request);
  }

  async respond() {
    await Promise.resolve();
    const request = this.pending.shift();
    if (!request) throw new Error("No pending Markdown parse");
    const blocks = await parseMarkdownBlocks(request.source);
    const response: MarkdownWorkerResponse = { ...request, type: "parsed", blocks };
    for (const listener of this.message) listener({ data: response } as MessageEvent<unknown>);
  }
}

describe("MarkdownBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMarkdownRuntimeForTests();
    clearCompletedMarkdownCacheForTests();
  });

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

  it("shows every unparsed streaming suffix while preserving blocks and rejecting stale results", async () => {
    const worker = new DelayedWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const { container, rerender } = render(
      <MarkdownBlock scope="session" cacheKey="message" text="**seed**" streaming />,
    );
    await act(() => worker.respond());
    const seed = container.querySelector("strong");
    expect(seed?.textContent).toBe("seed");
    let suffix = "\n\none";
    const update = () =>
      rerender(<MarkdownBlock scope="session" cacheKey="message" text={`**seed**${suffix}`} streaming />);
    update();
    for (const token of [" two", " three", " <img src=x onerror=alert(1)>"]) {
      suffix += token;
      update();
      // Complete the previous request only after a newer source is already queued.
      await act(() => worker.respond());
      expect(container.textContent).toBe(`seed${suffix}`);
      expect(container.querySelector("strong")).toBe(seed);
      expect(container.querySelector("img")).toBeNull();
    }
    await act(() => worker.respond());
    expect(container.querySelector("[data-markdown-source-length]")?.getAttribute("data-markdown-source-length")).toBe(
      String(`**seed**${suffix}`.length),
    );
    expect(container.querySelector("strong")).toBe(seed);
    expect(container.textContent).toContain("one two three");
  });

  it("does not retain a parsed prefix when the source is replaced", async () => {
    const worker = new DelayedWorker();
    configureMarkdownWorkerFactoryForTests(() => worker);
    const { container, rerender } = render(
      <MarkdownBlock scope="session" cacheKey="message" text="**old**" streaming />,
    );
    await act(() => worker.respond());
    rerender(<MarkdownBlock scope="session" cacheKey="message" text="**replacement**" streaming />);
    expect(container.textContent).toBe("**replacement**");
    expect(container.querySelector("strong")).toBeNull();
    await act(() => worker.respond());
    expect(container.querySelector("strong")?.textContent).toBe("replacement");
  });
});
