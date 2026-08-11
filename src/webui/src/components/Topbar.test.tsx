import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductMark, Topbar, TopbarIconButton } from "./Topbar";

describe("Topbar", () => {
  it("owns the first Home control and marks it as the current page", async () => {
    const onHome = vi.fn();
    render(
      <Topbar
        home={{ active: true, onClick: onHome }}
        leading={<ProductMark />}
        actions={
          <TopbarIconButton label="Files" title="Files" onClick={() => {}}>
            <span />
          </TopbarIconButton>
        }
      />,
    );

    const home = screen.getAllByRole("button")[0]!;
    expect(screen.getByRole("banner")).toHaveClass("h-[36px]", "px-[12px]");
    expect(home).toHaveClass("size-[28px]");
    expect(screen.getByRole("button", { name: "Files" })).toHaveClass("size-[28px]");
    expect(home).toHaveAccessibleName("Back to home");
    expect(home).toHaveAttribute("aria-current", "page");
    expect(home.querySelector(".lucide-house")).not.toBeNull();
    expect(
      home.compareDocumentPosition(screen.getByText("LazyResearch")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await userEvent.setup().click(home);
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("does not mark a non-Home route as current", () => {
    render(<Topbar home={{ active: false, onClick: () => {} }} leading={<ProductMark />} />);
    expect(screen.getByRole("button", { name: "Back to home" })).not.toHaveAttribute("aria-current");
  });

  it("keeps the product mark at a fixed 16px size", () => {
    render(<ProductMark />);
    expect(screen.getByText("LazyResearch").previousElementSibling).toHaveClass("size-[16px]");
  });
});
