import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlledMarkdownWorker } from "../testing/markdownWorker";
import { MarkdownBlock } from "./MarkdownBlock";
import { configureMarkdownWorkerFactoryForTests, resetMarkdownRuntimeForTests } from "./markdown/client";
import { clearCompletedMarkdownCacheForTests } from "./markdown/render";

beforeEach(() => {
  resetMarkdownRuntimeForTests();
  clearCompletedMarkdownCacheForTests();
});
afterEach(() => {
  resetMarkdownRuntimeForTests();
  vi.unstubAllGlobals();
});

function setupWorker(mode: string) {
  if (mode !== "worker") return async () => {};
  const worker = new ControlledMarkdownWorker();
  configureMarkdownWorkerFactoryForTests(() => worker);
  return () => act(() => worker.respond());
}

describe.each(["worker", "fallback"])("assistant text motion (%s)", (mode) => {
  it("fades only newly mounted words, preserving a growing partial word and the paragraph through completion", async () => {
    const parsed = setupWorker(mode);
    const props = { scope: "motion", cacheKey: "body", animateText: true };
    const view = render(<MarkdownBlock {...props} text="Early par" streaming />);
    await parsed();
    const paragraph = view.container.querySelector("p");
    const partial = screen.getByText("par");
    expect(view.container.querySelector("[data-entering]")).toBeNull();

    view.rerender(<MarkdownBlock {...props} text="Early partial new" streaming />);
    await parsed();
    expect(view.container.querySelector("p")).toBe(paragraph);
    expect(screen.getByText("partial")).toBe(partial);
    expect(partial).not.toHaveAttribute("data-entering");
    const added = screen.getByText("new");
    expect(added).toHaveAttribute("data-entering", "true");
    // jsdom lacks AnimationEvent; React selects its prefixed event in that environment.
    fireEvent(added, new Event("AnimationEvent" in window ? "animationend" : "webkitAnimationEnd", { bubbles: true }));
    expect(added).not.toHaveAttribute("data-entering");

    view.rerender(<MarkdownBlock {...props} text="Early partial newer next" streaming />);
    await parsed();
    expect(screen.getByText("newer")).toBe(added);
    expect(added).not.toHaveAttribute("data-entering");
    const next = screen.getByText("next");
    expect(next).toHaveAttribute("data-entering", "true");
    view.rerender(<MarkdownBlock {...props} text="Early partial newer next" streaming={false} />);
    expect(view.container.querySelector("p")).toBe(paragraph);
    expect(screen.getByText("next")).toBe(next);
    expect(view.container.querySelector("[data-entering]")).toBeNull();
    expect(paragraph?.textContent).toBe("Early partial newer next");
  });

  it("does not animate syntax-only reinterpretation or source replacement", async () => {
    const parsed = setupWorker(mode);
    const props = { scope: "syntax", cacheKey: "body", animateText: true };
    const view = render(<MarkdownBlock {...props} text="**word" streaming />);
    await parsed();
    view.rerender(<MarkdownBlock {...props} text="**word**" streaming />);
    await parsed();
    expect(view.container.querySelector("strong")).toHaveTextContent("word");
    expect(view.container.querySelector("[data-entering]")).toBeNull();
    view.rerender(<MarkdownBlock {...props} text="**word** next" streaming />);
    await parsed();
    expect(screen.getByText("next")).toHaveAttribute("data-entering", "true");
    view.rerender(<MarkdownBlock {...props} text="Replacement words" streaming />);
    await parsed();
    expect(view.container.querySelector("p")).toHaveTextContent("Replacement words");
    expect(view.container.querySelector("[data-entering]")).toBeNull();
  });

  it("leaves code, KaTeX and authored HTML semantic and inert", async () => {
    const parsed = setupWorker(mode);
    const source = 'Prose here.\n\n`two words`\n\n```text\nmany code words\n```\n\n$x+1$\n\n<img src=x onerror="boom">';
    const view = render(<MarkdownBlock text={source} scope="semantics" cacheKey="body" animateText streaming />);
    await parsed();
    expect(view.container.querySelectorAll("pre")).toHaveLength(1);
    expect(view.container.querySelector("code [data-markdown-word]")).toBeNull();
    expect(view.container.querySelector(".katex [data-markdown-word]")).toBeNull();
    expect(view.container.querySelector(".katex annotation")?.textContent).toBe("x+1");
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container).toHaveTextContent('<img src=x onerror="boom">');
    expect(view.container.querySelectorAll("[data-markdown-word]")).toHaveLength(2);
  });

  it("preserves whitespace, CJK and emoji with word-bounded rather than character-bounded DOM", async () => {
    const parsed = setupWorker(mode);
    const props = { scope: "unicode", cacheKey: "body", animateText: true };
    const first = "中文👩‍💻".repeat(500);
    const view = render(<MarkdownBlock {...props} text={first} streaming />);
    await parsed();
    const word = view.container.querySelector("[data-markdown-word]");
    const second = `${first}继续🔬`;
    view.rerender(<MarkdownBlock {...props} text={second} streaming />);
    await parsed();
    expect(view.container.querySelectorAll("[data-markdown-word]")).toHaveLength(1);
    expect(view.container.querySelector("[data-markdown-word]")).toBe(word);
    expect(word?.textContent).toBe(second);
    expect(word).not.toHaveAttribute("data-entering");
    const final = `${second}  English\tword\u00a0😀`;
    view.rerender(<MarkdownBlock {...props} text={final} streaming />);
    await parsed();
    expect(view.container.querySelector("p")?.textContent).toBe(final);
    expect(view.container.querySelectorAll("[data-markdown-word]")).toHaveLength(4);
    expect(view.container.querySelectorAll("[data-entering]")).toHaveLength(3);
  });

  it("keeps history and non-assistant Markdown static without word-span expansion", async () => {
    const parsed = setupWorker(mode);
    const view = render(<MarkdownBlock text="Historical body" scope="history" cacheKey="body" animateText />);
    await parsed();
    expect(screen.getByText("Historical body")).toBeTruthy();
    expect(view.container.querySelector("[data-markdown-word]")).toBeNull();
    view.rerender(<MarkdownBlock text="Reasoning body" scope="history" cacheKey="body" streaming />);
    await parsed();
    expect(screen.getByText("Reasoning body")).toBeTruthy();
    expect(view.container.querySelector("[data-markdown-word]")).toBeNull();
  });
});

it("reuses completed motion-capable blocks as static compact history after virtual remount", async () => {
  const worker = new ControlledMarkdownWorker();
  configureMarkdownWorkerFactoryForTests(() => worker);
  const props = { scope: "cache-motion", cacheKey: "body", animateText: true };
  const live = render(<MarkdownBlock {...props} text="First" streaming />);
  await act(() => worker.respond());
  live.rerender(<MarkdownBlock {...props} text="First second" streaming />);
  await act(() => worker.respond());
  expect(screen.getByText("second")).toHaveAttribute("data-entering", "true");
  live.rerender(<MarkdownBlock {...props} text="First second" />);
  const requests = worker.requests.length;
  live.unmount();
  const history = render(<MarkdownBlock {...props} text="First second" />);
  expect(screen.getByText("First second")).toBeTruthy();
  expect(history.container.querySelector("[data-markdown-word]")).toBeNull();
  expect(worker.requests).toHaveLength(requests);
});

it("snaps reduced motion to the visible state and never replays existing words when the preference changes", async () => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: true,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => query);
  const change = (matches: boolean) =>
    act(() => {
      query.matches = matches;
      for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
    });
  const props = { animateText: true, streaming: true };
  const view = render(<MarkdownBlock {...props} text="First" />);
  view.rerender(<MarkdownBlock {...props} text="First second" />);
  expect(view.container.querySelector("[data-entering]")).toBeNull();
  change(false);
  expect(view.container.querySelector("[data-entering]")).toBeNull();
  view.rerender(<MarkdownBlock {...props} text="First second third" />);
  expect(screen.getByText("third")).toHaveAttribute("data-entering", "true");
  change(true);
  expect(view.container.querySelector("[data-entering]")).toBeNull();
  change(false);
  expect(view.container.querySelector("[data-entering]")).toBeNull();
  view.unmount();
  expect(listeners.size).toBe(0);
});
