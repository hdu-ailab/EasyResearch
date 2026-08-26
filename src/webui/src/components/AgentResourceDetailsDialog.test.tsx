import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { AgentResourceDetailsDialog } from "./AgentResourceDetailsDialog";

describe("AgentResourceDetailsDialog", () => {
  it("uses the full mobile viewport with a scrolling body and keeps its desktop bounds at 820px", () => {
    render(
      <PreferencesProvider>
        <I18nProvider>
          <AgentResourceDetailsDialog
            agentName="Search"
            tools={["read"]}
            skills={["paper-search"]}
            onClose={() => {}}
          />
        </I18nProvider>
      </PreferencesProvider>,
    );

    const dialog = screen.getByRole("dialog", { name: "Search resources" });
    expect(dialog.parentElement).toHaveClass("p-0", "min-[820px]:p-4");
    expect(dialog).toHaveClass(
      "flex",
      "h-full",
      "w-full",
      "overflow-hidden",
      "min-[820px]:h-auto",
      "min-[820px]:max-w-[520px]",
      "min-[820px]:rounded-[10px]",
    );
    expect(dialog).not.toHaveClass("max-w-[520px]", "rounded-[10px]");
    expect(dialog.querySelector("header")?.nextElementSibling).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
  });

  it("shows the concrete effective tools and skills and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PreferencesProvider>
        <I18nProvider>
          <AgentResourceDetailsDialog
            agentName="Search"
            tools={["read", "web-search"]}
            skills={["paper-search", "arxiv"]}
            onClose={onClose}
          />
        </I18nProvider>
      </PreferencesProvider>,
    );

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Search resources")).toBeTruthy();
    expect(screen.getByText("web-search")).toBeTruthy();
    expect(screen.getByText("paper-search")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
