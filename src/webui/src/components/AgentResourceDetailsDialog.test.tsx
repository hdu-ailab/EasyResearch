import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { PreferencesProvider } from "../preferences/PreferencesProvider";
import { AgentResourceDetailsDialog } from "./AgentResourceDetailsDialog";

describe("AgentResourceDetailsDialog", () => {
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
