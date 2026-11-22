import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketSkillDto, SkillMarketCatalogDto } from "../../../../web/skill-marketplace-contracts";
import * as api from "../../api/skill-marketplace";
import { SkillMarketplacePanel } from "./SkillMarketplacePanel";

vi.mock("../../api/skill-marketplace", () => ({
  getSkillMarket: vi.fn(),
  getSkillMarketDetail: vi.fn(),
  installMarketSkill: vi.fn(),
}));
const skill: MarketSkillDto = {
  id: "example/repo/research",
  source: "example/repo",
  slug: "research",
  name: "Research",
  installs: 1234,
  supported: true,
};
const detail = {
  id: skill.id,
  name: "research",
  description: "Research materials",
  content: "# Research",
  commit: "a".repeat(40),
  directory: "skills/research/",
  files: ["SKILL.md", "references/guide.md"],
  state: "available" as const,
};

beforeEach(() => {
  vi.mocked(api.getSkillMarket)
    .mockReset()
    .mockResolvedValue({ skills: [skill] });
  vi.mocked(api.getSkillMarketDetail).mockReset().mockResolvedValue(detail);
  vi.mocked(api.installMarketSkill).mockReset().mockResolvedValue({ id: skill.id, name: "research" });
});

describe("Skill marketplace", () => {
  it("only fetches when visible, searches explicitly, and rejects obsolete results", async () => {
    const old = Promise.withResolvers<SkillMarketCatalogDto>();
    const view = render(<SkillMarketplacePanel active={false} skills={[]} onInstalled={() => {}} />);
    expect(api.getSkillMarket).not.toHaveBeenCalled();
    vi.mocked(api.getSkillMarket).mockReturnValueOnce(old.promise);
    view.rerender(<SkillMarketplacePanel active skills={[]} onInstalled={() => {}} />);
    const signal = vi.mocked(api.getSkillMarket).mock.calls[0]?.[2];
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "writing" } });
    expect(api.getSkillMarket).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.getSkillMarket).toHaveBeenCalledTimes(2));
    expect(signal?.aborted).toBe(true);
    await act(async () => old.resolve({ skills: [{ ...skill, id: "old/repo/old", name: "Obsolete" }] }));
    expect(screen.queryByText("Obsolete")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "View Research" })).toBeInTheDocument();
  });

  it("previews the complete file list and installs the exact shown commit only once", async () => {
    const user = userEvent.setup();
    const onInstalled = vi.fn();
    const pending = Promise.withResolvers<{ id: string; name: string }>();
    vi.mocked(api.installMarketSkill).mockReturnValue(pending.promise);
    render(<SkillMarketplacePanel active skills={[]} onInstalled={onInstalled} />);
    const trigger = (await screen.findAllByRole("button", { name: "Add Research" }))[0]!;
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Research" });
    expect(await within(dialog).findByText(detail.commit)).toBeInTheDocument();
    await user.click(within(dialog).getByText("Files (2)"));
    expect(within(dialog).getByText("references/guide.md")).toBeVisible();
    await user.dblClick(within(dialog).getByRole("button", { name: "Install globally" }));
    expect(api.installMarketSkill).toHaveBeenCalledExactlyOnceWith({ id: skill.id, commit: detail.commit });
    expect(within(dialog).getByRole("button", { name: "Installing…" })).toBeDisabled();
    await act(async () => pending.resolve({ id: skill.id, name: "research" }));
    expect(within(dialog).getByRole("button", { name: "Installed" })).toBeDisabled();
    expect(onInstalled).toHaveBeenCalledOnce();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("does not equate a same-name bundled skill with a marketplace installation", async () => {
    vi.mocked(api.getSkillMarketDetail).mockResolvedValue({ ...detail, state: "conflict" });
    render(
      <SkillMarketplacePanel
        active
        skills={[
          { name: "research", source: "bundled", path: "/bundled/research", skillPath: "/bundled/research/SKILL.md" },
        ]}
        onInstalled={() => {}}
      />,
    );
    fireEvent.click((await screen.findAllByRole("button", { name: "Add Research" }))[0]!);
    expect(await screen.findByText(/A skill with this name already exists/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install globally" })).toBeDisabled();
    expect(api.installMarketSkill).not.toHaveBeenCalled();
  });

  it("shows recoverable errors and keeps a failed installation retryable", async () => {
    vi.mocked(api.getSkillMarket).mockRejectedValueOnce(new Error("Source rate limited"));
    render(<SkillMarketplacePanel active skills={[]} onInstalled={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Source rate limited");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Add Research" }))[0]!);
    await screen.findByText(detail.commit);
    vi.mocked(api.installMarketSkill).mockRejectedValueOnce(new Error("Download incomplete"));
    fireEvent.click(screen.getByRole("button", { name: "Install globally" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Download incomplete");
    expect(screen.getByRole("button", { name: "Install globally" })).toBeEnabled();
  });
});
