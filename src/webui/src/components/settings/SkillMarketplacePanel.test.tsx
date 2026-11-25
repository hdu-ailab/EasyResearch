import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillResourceDto } from "../../../../web/contracts";
import type {
  MarketSkillDto,
  SkillMarketCatalogDto,
  SkillMarketDetailDto,
} from "../../../../web/skill-marketplace-contracts";
import * as api from "../../api/skill-marketplace";
import { SkillMarketplacePanel } from "./SkillMarketplacePanel";

vi.mock("../../api/skill-marketplace", () => ({
  getSkillMarketDescription: vi.fn(),
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
const detail: SkillMarketDetailDto = {
  id: skill.id,
  name: "research",
  description: "Research materials",
  content: "# Research",
  commit: "a".repeat(40),
  directory: "skills/research/",
  files: ["SKILL.md", "references/guide.md"],
  state: "available",
};
const resource: SkillResourceDto = {
  name: "research",
  source: "global",
  path: "/agent/skills/research",
  skillPath: "/agent/skills/research/SKILL.md",
  marketplaceId: skill.id,
};
const defaults = { active: true, skills: [], onInstalled: vi.fn(), resourcesRevision: 1 };

beforeEach(() => {
  vi.mocked(api.getSkillMarketDescription).mockReset().mockRejectedValue(new Error("Catalog description unavailable"));
  vi.mocked(api.getSkillMarket)
    .mockReset()
    .mockResolvedValue({ skills: [skill] });
  vi.mocked(api.getSkillMarketDetail).mockReset().mockResolvedValue(detail);
  vi.mocked(api.installMarketSkill).mockReset().mockResolvedValue({ id: skill.id, name: "research" });
  defaults.onInstalled.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("Skill marketplace", () => {
  it("never enriches cards on render, scroll, hover, focus, popular rotation or reentry", async () => {
    const user = userEvent.setup();
    const observer = vi.fn();
    vi.stubGlobal("IntersectionObserver", observer);
    const view = render(<SkillMarketplacePanel {...defaults} />);
    const titles = await screen.findAllByRole("button", { name: "View Research" });
    await user.hover(titles[0]!);
    titles[0]!.focus();
    fireEvent.scroll(window);
    await user.click(screen.getByRole("button", { name: "Show more popular skills" }));
    view.rerender(<SkillMarketplacePanel {...defaults} active={false} />);
    view.rerender(<SkillMarketplacePanel {...defaults} />);
    await waitFor(() => expect(api.getSkillMarket).toHaveBeenCalledTimes(2));
    expect(observer).not.toHaveBeenCalled();
    expect(api.getSkillMarketDetail).not.toHaveBeenCalled();
    expect(api.getSkillMarketDescription).not.toHaveBeenCalled();
    expect(api.installMarketSkill).not.toHaveBeenCalled();
    expect(screen.queryByText(detail.description)).not.toBeInTheDocument();
  });

  it("uses only catalog-provided descriptions and keeps source links independent", async () => {
    vi.mocked(api.getSkillMarket).mockResolvedValue({
      skills: [{ ...skill, description: "Catalog-provided summary" }],
    });
    render(<SkillMarketplacePanel {...defaults} />);
    expect(await screen.findAllByText("Catalog-provided summary")).toHaveLength(2);
    const author = screen.getAllByRole("link", { name: "example/repo" })[0]!;
    expect(author).toHaveAttribute("href", "https://skills.sh/example/repo");
    expect(author).toHaveAttribute("target", "_blank");
    fireEvent.click(author);
    expect(api.getSkillMarketDetail).not.toHaveBeenCalled();
    expect(api.getSkillMarketDescription).not.toHaveBeenCalled();
  });

  it("explicitly previews only the selected Skill, with explanation and actual source", async () => {
    vi.mocked(api.getSkillMarketDescription).mockResolvedValue({
      content: "# Public catalog guide",
      url: "https://skills.sh/example/repo/research",
    });
    const user = userEvent.setup();
    render(<SkillMarketplacePanel {...defaults} />);
    const trigger = (await screen.findAllByRole("button", { name: "View Research" }))[0]!;
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Research" });
    expect(await within(dialog).findByRole("heading", { name: "Public catalog guide" })).toBeVisible();
    expect(api.getSkillMarketDescription).toHaveBeenCalledExactlyOnceWith(skill.id, expect.any(AbortSignal));
    expect(api.getSkillMarketDetail).toHaveBeenCalledExactlyOnceWith(skill.id, expect.any(AbortSignal));
    await user.click(within(dialog).getByText("Files (2)"));
    expect(within(dialog).getByText("references/guide.md")).toBeVisible();
    await user.click(within(dialog).getByText("Full SKILL.md"));
    expect(within(dialog).getByRole("heading", { name: "Research", level: 1 })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(vi.mocked(api.getSkillMarketDetail).mock.calls[0]![1]?.aborted).toBe(true);
  });

  it("falls back to SKILL.md when the public explanation is unavailable", async () => {
    render(<SkillMarketplacePanel {...defaults} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "View Research" }))[0]!);
    expect(await screen.findByRole("heading", { name: "Research", level: 1 })).toBeInTheDocument();
  });

  it("direct plus resolves only the selected snapshot and installs once across duplicate cards", async () => {
    const snapshot = Promise.withResolvers<SkillMarketDetailDto>();
    const pending = Promise.withResolvers<{ id: string; name: string }>();
    vi.mocked(api.getSkillMarketDetail).mockReturnValue(snapshot.promise);
    vi.mocked(api.installMarketSkill).mockReturnValue(pending.promise);
    render(<SkillMarketplacePanel {...defaults} />);
    const add = await screen.findAllByRole("button", { name: "Add Research" });
    act(() => {
      fireEvent.click(add[0]!);
      fireEvent.click(add[1]!);
      fireEvent.click(add[0]!);
    });
    expect(api.getSkillMarketDetail).toHaveBeenCalledExactlyOnceWith(skill.id);
    expect(api.getSkillMarketDescription).not.toHaveBeenCalled();
    expect(api.installMarketSkill).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Installing…" }).every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    await act(async () => snapshot.resolve(detail));
    expect(api.installMarketSkill).toHaveBeenCalledExactlyOnceWith({ id: skill.id, commit: detail.commit });
    await act(async () => pending.resolve({ id: skill.id, name: "research" }));
    expect(screen.getAllByRole("button", { name: "View installed Research" })).toHaveLength(2);
    expect(defaults.onInstalled).toHaveBeenCalledOnce();
  });

  it("shares admission between a pending card install and the explicit detail action", async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<{ id: string; name: string }>();
    vi.mocked(api.installMarketSkill).mockReturnValue(pending.promise);
    render(<SkillMarketplacePanel {...defaults} />);
    await user.click((await screen.findAllByRole("button", { name: "Add Research" }))[0]!);
    await user.click(screen.getAllByRole("button", { name: "View Research" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "Research" });
    await within(dialog).findByText(detail.commit);
    expect(within(dialog).getByRole("button", { name: "Installing…" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Installing…" }));
    expect(api.installMarketSkill).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ id: skill.id, name: "research" }));
    expect(within(dialog).getByRole("button", { name: "Installed" })).toBeDisabled();
  });

  it("installs the displayed immutable preview snapshot without another source read", async () => {
    const user = userEvent.setup();
    render(<SkillMarketplacePanel {...defaults} />);
    await user.click((await screen.findAllByRole("button", { name: "View Research" }))[0]!);
    await screen.findByText(detail.commit);
    await user.dblClick(screen.getByRole("button", { name: "Install globally" }));
    expect(api.installMarketSkill).toHaveBeenCalledExactlyOnceWith({ id: skill.id, commit: detail.commit });
    expect(api.getSkillMarketDetail).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Installed" })).toBeDisabled();
  });

  it("preserves success across stale lists, then reconciles a fresh list and deletion", async () => {
    const view = render(<SkillMarketplacePanel {...defaults} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Add Research" }))[0]!);
    await screen.findAllByRole("button", { name: "View installed Research" });
    view.rerender(<SkillMarketplacePanel {...defaults} skills={[]} />);
    expect(screen.getAllByRole("button", { name: "View installed Research" })).toHaveLength(2);
    view.rerender(<SkillMarketplacePanel {...defaults} skills={[resource]} resourcesRevision={2} />);
    expect(screen.getAllByRole("button", { name: "View installed Research" })).toHaveLength(2);
    view.rerender(<SkillMarketplacePanel {...defaults} skills={[]} resourcesRevision={3} />);
    expect(screen.getAllByRole("button", { name: "Add Research" })).toHaveLength(2);
  });

  it("refreshes with the latest owner after a late install reply and accepts newer removal", async () => {
    const pending = Promise.withResolvers<{ id: string; name: string }>();
    const currentRefresh = vi.fn();
    vi.mocked(api.installMarketSkill).mockReturnValue(pending.promise);
    const view = render(<SkillMarketplacePanel {...defaults} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Add Research" }))[0]!);
    await waitFor(() => expect(api.installMarketSkill).toHaveBeenCalledOnce());
    view.rerender(<SkillMarketplacePanel {...defaults} resourcesRevision={8} onInstalled={currentRefresh} />);
    await act(async () => pending.resolve({ id: skill.id, name: "research" }));
    expect(defaults.onInstalled).not.toHaveBeenCalled();
    expect(currentRefresh).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("button", { name: "View installed Research" })).toHaveLength(2);
    view.rerender(<SkillMarketplacePanel {...defaults} resourcesRevision={9} />);
    expect(screen.getAllByRole("button", { name: "Add Research" })).toHaveLength(2);
  });

  it("clears only the deleted identity while a complete post-install list is still pending", async () => {
    const view = render(<SkillMarketplacePanel {...defaults} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Add Research" }))[0]!);
    await screen.findAllByRole("button", { name: "View installed Research" });
    view.rerender(<SkillMarketplacePanel {...defaults} deletion={{ id: "example/repo/other", revision: 2 }} />);
    expect(screen.getAllByRole("button", { name: "View installed Research" })).toHaveLength(2);
    view.rerender(<SkillMarketplacePanel {...defaults} deletion={{ id: skill.id, revision: 3 }} />);
    expect(screen.getAllByRole("button", { name: "Add Research" })).toHaveLength(2);
    expect(api.installMarketSkill).toHaveBeenCalledOnce();
  });

  it("does not equate same-name resources with exact marketplace provenance", async () => {
    vi.mocked(api.getSkillMarketDetail).mockResolvedValue({ ...detail, state: "conflict" });
    render(
      <SkillMarketplacePanel {...defaults} skills={[{ ...resource, marketplaceId: undefined, source: "bundled" }]} />,
    );
    fireEvent.click((await screen.findAllByRole("button", { name: "Add Research" }))[0]!);
    expect(await screen.findAllByText(/A skill with this name already exists/)).toHaveLength(2);
    expect(api.installMarketSkill).not.toHaveBeenCalled();
    expect(screen.getAllByRole("link", { name: "Manual download" })[0]).toHaveAttribute(
      "href",
      "https://skills.sh/example/repo/research",
    );
  });

  it("retains other cards on error and retries installation directly without explanation reads", async () => {
    const other = { ...skill, id: "example/repo/other", slug: "other", name: "Other" };
    vi.mocked(api.getSkillMarket).mockResolvedValue({ skills: [skill, other] });
    vi.mocked(api.installMarketSkill).mockRejectedValueOnce(new Error("Download incomplete"));
    render(<SkillMarketplacePanel {...defaults} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Add Research" }))[0]!);
    const errors = await screen.findAllByRole("alert");
    expect(errors[0]).toHaveTextContent("Download incomplete");
    expect(
      screen.getAllByRole("button", { name: "Add Other" }).every((button) => !button.hasAttribute("disabled")),
    ).toBe(true);
    fireEvent.click(within(errors[0]!).getByRole("button", { name: "Retry" }));
    await screen.findAllByRole("button", { name: "View installed Research" });
    expect(api.installMarketSkill).toHaveBeenCalledTimes(2);
    expect(api.getSkillMarketDescription).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows manual recovery for unsupported identities without silently ignoring plus", async () => {
    vi.mocked(api.getSkillMarket).mockResolvedValue({
      skills: [{ ...skill, supported: false, unsupportedReason: "identity" }],
    });
    render(<SkillMarketplacePanel {...defaults} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Research" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Manual skill installation");
    expect(screen.getByRole("link", { name: "Manual download" })).toBeVisible();
    expect(api.installMarketSkill).not.toHaveBeenCalled();
    expect(api.getSkillMarketDescription).not.toHaveBeenCalled();
  });

  it("keeps an available explanation when snapshot preview fails and offers copied recovery", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    vi.mocked(api.getSkillMarketDetail).mockRejectedValue(new Error("Download failed"));
    vi.mocked(api.getSkillMarketDescription).mockResolvedValue({
      content: "# Public guide",
      url: "https://skills.sh/example/repo/research",
    });
    render(<SkillMarketplacePanel {...defaults} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "View Research" }))[0]!);
    expect(await screen.findByRole("heading", { name: "Public guide" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Copy installation request" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]![0]).toContain(skill.id);
    expect(writeText.mock.calls[0]![0]).toContain("global Skills directory");
    expect(api.installMarketSkill).not.toHaveBeenCalled();
    expect(await screen.findByText(/Copied. Paste/)).toBeInTheDocument();
  });

  it("selects a readable recovery request when clipboard permission is denied", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    vi.mocked(api.getSkillMarketDetail).mockRejectedValue(new Error("Download failed"));
    render(<SkillMarketplacePanel {...defaults} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "View Research" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Copy installation request" }));
    const field = screen.getByRole("textbox", { name: "Request for the Research Assistant" }) as HTMLTextAreaElement;
    await waitFor(() => expect(field).toHaveFocus());
    expect(field.selectionEnd - field.selectionStart).toBe(field.value.length);
    expect(screen.getByText(/Copy failed/)).toBeInTheDocument();
  });

  it("only fetches a visible catalog, keeps drafts, and rejects obsolete results", async () => {
    const old = Promise.withResolvers<SkillMarketCatalogDto>();
    const view = render(<SkillMarketplacePanel {...defaults} active={false} />);
    expect(api.getSkillMarket).not.toHaveBeenCalled();
    vi.mocked(api.getSkillMarket).mockReturnValueOnce(old.promise);
    view.rerender(<SkillMarketplacePanel {...defaults} />);
    const signal = vi.mocked(api.getSkillMarket).mock.calls[0]?.[2];
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "writing" } });
    expect(api.getSkillMarket).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.getSkillMarket).toHaveBeenCalledTimes(2));
    expect(signal?.aborted).toBe(true);
    await act(async () => old.resolve({ skills: [{ ...skill, id: "old/repo/old", name: "Obsolete" }] }));
    expect(screen.queryByText("Obsolete")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "View Research" })).toBeInTheDocument();
    view.rerender(<SkillMarketplacePanel {...defaults} active={false} />);
    expect(vi.mocked(api.getSkillMarket).mock.calls[1]![2]?.aborted).toBe(true);
    view.rerender(<SkillMarketplacePanel {...defaults} />);
    expect(screen.getByRole("searchbox")).toHaveValue("writing");
    await waitFor(() =>
      expect(api.getSkillMarket).toHaveBeenLastCalledWith("writing", "all-time", expect.any(AbortSignal)),
    );
  });

  it("retries a catalog failure without losing the search", async () => {
    vi.mocked(api.getSkillMarket).mockRejectedValueOnce(new Error("Source rate limited"));
    render(<SkillMarketplacePanel {...defaults} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Source rate limited");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findAllByRole("button", { name: "Add Research" })).toHaveLength(2);
  });
});
