import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductMark, Topbar, TopbarIconButton } from "./Topbar";

describe("Topbar", () => {
  it("keeps text-only Home navigation and labelled compact actions", async () => {
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
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute("title", "Files");
    expect(home).toHaveAccessibleName("Back to home");
    expect(home).toHaveAttribute("aria-current", "page");
    expect(home).toHaveTextContent("EasyResearch");
    expect(within(home).queryByRole("img", { hidden: true })).not.toBeInTheDocument();

    await userEvent.setup().click(home);
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("does not mark a non-Home route as current", () => {
    render(<Topbar home={{ active: false, onClick: () => {} }} />);
    expect(screen.getByRole("button", { name: "Back to home" })).not.toHaveAttribute("aria-current");
  });

  it("renders only the application name in the page wordmark", () => {
    const { container } = render(<ProductMark />);
    expect(container).toHaveTextContent("EasyResearch");
    expect(container).not.toHaveTextContent(/studio/i);
    expect(container.querySelector("img, svg")).toBeNull();
  });
});
