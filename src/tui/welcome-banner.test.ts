import { describe, expect, it, vi } from "vitest";
import { BANNER_LINES, BANNER_TAGLINE, welcomeBannerLines, mountWelcomeBanner } from "./welcome-banner";
import { visibleWidth } from "@earendil-works/pi-tui";

function fakeTheme() {
  return { fg: (color: string, text: string) => `${color}:${text}` };
}

describe("welcomeBannerLines", () => {
  it("renders the two stacked word blocks plus the tagline", () => {
    const lines = welcomeBannerLines(fakeTheme(), 200);
    expect(lines).toHaveLength(BANNER_LINES.length + 1);
    const isArt = (l: string) => l.startsWith("accent:") && /^[█╚]/.test(l.slice("accent:".length));
    expect(lines.slice(0, 6).every(isArt)).toBe(true);
    expect(lines.slice(6, 12).every(isArt)).toBe(true);
    expect(lines.at(-1)).toBe(`dim:${BANNER_TAGLINE}`);
  });

  it("never emits a line wider than the requested width", () => {
    for (const width of [40, 75, 80, 200]) {
      for (const line of welcomeBannerLines(fakeTheme(), width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps the wordmark intact when the terminal is wide enough", () => {
    const lines = welcomeBannerLines(fakeTheme(), 200);
    expect(lines.slice(0, 6).map((l) => l.slice("accent:".length))).toEqual(
      BANNER_LINES.slice(0, 6),
    );
    expect(lines.slice(6, 12).map((l) => l.slice("accent:".length))).toEqual(
      BANNER_LINES.slice(6, 12),
    );
  });
});

describe("mountWelcomeBanner (ADR-023)", () => {
  function fakeCtx(overrides: { mode?: string; hasUI?: boolean } = {}) {
    const ui = { setHeader: vi.fn() };
    return { ctx: { mode: overrides.mode ?? "tui", hasUI: overrides.hasUI ?? true, ui }, ui };
  }

  function mount() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      }),
    };
    mountWelcomeBanner(pi as never);
    return { handlers };
  }

  it("registers a session_start handler", () => {
    const { handlers } = mount();
    expect(handlers.has("session_start")).toBe(true);
  });

  it("replaces the built-in header with the banner on session start in the TUI", async () => {
    const { handlers } = mount();
    const { ctx, ui } = fakeCtx();
    await handlers.get("session_start")!({}, ctx);
    expect(ui.setHeader).toHaveBeenCalledWith(expect.any(Function));
  });

  it("renders themed banner lines from the header factory", async () => {
    const { handlers } = mount();
    const { ctx } = fakeCtx();
    await handlers.get("session_start")!({}, ctx);
    const factory = (ctx.ui as { setHeader: ReturnType<typeof vi.fn> }).setHeader.mock.calls[0]![0];
    const component = factory({}, fakeTheme());
    const lines = component.render(200);
    expect(lines).toHaveLength(BANNER_LINES.length + 1);
    expect(lines[0]).toContain("█");
    expect(lines.at(-1)).toContain(BANNER_TAGLINE);
  });

  it("does nothing outside the native TUI (e.g. headless Web sessions)", async () => {
    const { handlers } = mount();
    for (const mode of ["rpc", "json", "print"]) {
      const { ctx, ui } = fakeCtx({ mode, hasUI: true });
      await handlers.get("session_start")!({}, ctx);
      expect(ui.setHeader).not.toHaveBeenCalled();
    }
  });
});
