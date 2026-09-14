import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { allObservers } from "../testing/transcriptTest";
import { FileTreeSplit } from "./FileTreeSplit";

it("coalesces width updates without re-rendering unchanged file-tree and preview content", () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  let contentRenders = 0;
  function Content({ name }: { name: string }) {
    contentRenders++;
    return <p>{name}</p>;
  }
  const view = render(
    <FileTreeSplit isMobile={false} treeOpened tree={<Content name="Tree" />}>
      <Content name="Preview" />
    </FileTreeSplit>,
  );
  try {
    const handle = screen.getByRole("separator", { name: "Resize file tree" });
    const tree = screen.getByText("Tree").parentElement as HTMLElement;
    Object.defineProperties(handle, {
      setPointerCapture: { value: () => {} },
      hasPointerCapture: { value: () => false },
    });
    act(() => allObservers()[0]!.__fire(700));
    const initialRenders = contentRenders;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 240, button: 0, isPrimary: true });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 280, buttons: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, buttons: 1 });
    expect(tree.style.width).toBe("240px");
    act(() => vi.advanceTimersToNextFrame());
    expect(tree.style.width).toBe("300px");
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 310 });
    expect(tree.style.width).toBe("310px");
    expect(contentRenders).toBe(initialRenders);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
