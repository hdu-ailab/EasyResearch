import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TextSourcePreview } from "./TextSourcePreview";

describe("line-aware source preview", () => {
  it("reveals a distant selection, highlights its inclusive range and re-reveals repeated activations", async () => {
    const content = Array.from({ length: 2000 }, (_, i) => `source line ${i + 1}`).join("\n");
    const { container, rerender } = render(
      <TextSourcePreview content={content} selection={{ start: 1250, end: 1252 }} selectionKey={1} />,
    );
    await waitFor(() => expect(container.querySelector('[data-line="1250"]')).toHaveFocus());
    expect(container.querySelectorAll("mark")).toHaveLength(3);
    expect(container.querySelectorAll("[data-line]").length).toBeLessThanOrEqual(400);
    fireEvent.click(screen.getByRole("button", { name: "Previous lines" }));
    expect(container.querySelector('[data-line="1250"]')).toBeNull();
    rerender(<TextSourcePreview content={content} selection={{ start: 1250, end: 1252 }} selectionKey={2} />);
    await waitFor(() => expect(container.querySelector('[data-line="1250"]')).toHaveFocus());
  });
  it("renders text inertly and reports selections beyond the bounded loaded text", () => {
    const { container } = render(
      <TextSourcePreview content={"<script>alert(1)</script>\r\nplain"} selection={{ start: 200, end: 202 }} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("The referenced lines are outside the loaded text.")).toBeTruthy();
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });
});
