import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductMark, Topbar, TopbarIconButton } from "./Topbar";

describe("Topbar", () => {
  it("uses the product logo as the Home control and marks it as the current page", async () => {
    const onHome = vi.fn();
    render(
      <Topbar
        home={{ active: true, onClick: onHome }}
        actions={
          <TopbarIconButton label="Files" title="Files" onClick={() => {}}>
            <span />
          </TopbarIconButton>
        }
      />,
    );

    const home = screen.getAllByRole("button")[0]!;
    expect(screen.getByRole("banner")).toHaveClass("min-h-[52px]", "px-[12px]");
    expect(home).toHaveClass("size-[36px]");
    expect(screen.getByRole("button", { name: "Files" })).toHaveClass("size-[36px]");
    expect(home).toHaveAccessibleName("Back to home");
    expect(home).toHaveAttribute("aria-current", "page");
    expect(within(home).getByTestId("product-logo")).toHaveClass(
      "group-hover:opacity-0",
      "group-focus-visible:opacity-0",
    );
    expect(within(home).getByTestId("product-home-icon")).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
      "group-focus-visible:opacity-100",
    );
    expect(
      home.compareDocumentPosition(screen.getByText("EasyResearch")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await userEvent.setup().click(home);
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("does not mark a non-Home route as current", () => {
    render(<Topbar home={{ active: false, onClick: () => {} }} />);
    expect(screen.getByRole("button", { name: "Back to home" })).not.toHaveAttribute("aria-current");
  });

  it("uses the shared favicon artwork as the product mark", () => {
    render(<ProductMark />);
    const brand = screen.getByText("EasyResearch");
    const icon = brand.previousElementSibling as HTMLImageElement;
    expect(brand).toHaveClass("text-[24px]", "font-bold");
    expect(brand).toHaveStyle({ color: "#304c90" });
    expect(icon.tagName).toBe("IMG");
    expect(icon).toHaveAttribute("src", "/favicon.svg");
    expect(icon).toHaveAttribute("width", "30");
    expect(icon).toHaveAttribute("height", "30");
  });
});
