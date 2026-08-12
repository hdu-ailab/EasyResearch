import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * EasyResearch TUI welcome banner (see .docs/tui.md, ADR-023).
 *
 * On session start in the native TUI, the "EASYRESEARCH" wordmark replaces
 * Pi's built-in startup header (logo line, keybinding hints, onboarding text)
 * via `ctx.ui.setHeader`. The banner is the persistent header for the session
 * and shows regardless of whether the global agent directory exists — the
 * extension is always mounted inline and reads no config. Web RPC children are
 * skipped via the `ctx.mode === "tui"` guard.
 */

/**
 * figlet -f ANSI Shadow, rendered per letter and stacked per word: the "EASY"
 * block (letters spaced out to roughly match the "RESEARCH" block width) sits
 * above the "RESEARCH" block. Trailing whitespace trimmed per line.
 */
export const BANNER_LINES: readonly string[] = [
  "███████╗            █████╗            ███████╗          ██╗   ██╗",
  "██╔════╝           ██╔══██╗           ██╔════╝          ╚██╗ ██╔╝",
  "███████╗           ███████║           ███████╗           ╚████╔╝",
  "╚════██║           ██╔══██║           ╚════██║            ╚██╔╝",
  "███████║           ██║  ██║           ███████║             ██║",
  "╚══════╝           ╚═╝  ╚═╝           ╚══════╝             ╚═╝",
  "██████╗ ███████╗███████╗███████╗ █████╗ ██████╗  ██████╗██╗  ██╗",
  "██╔══██╗██╔════╝██╔════╝██╔════╝██╔══██╗██╔══██╗██╔════╝██║  ██║",
  "██████╔╝█████╗  ███████╗█████╗  ███████║██████╔╝██║     ███████║",
  "██╔══██╗██╔══╝  ╚════██║██╔══╝  ██╔══██║██╔══██╗██║     ██╔══██║",
  "██║  ██║███████╗███████║███████╗██║  ██║██║  ██║╚██████╗██║  ██║",
  "╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝",
].map((line) => line.trimEnd());

export const BANNER_TAGLINE = "Automated academic paper writing — powered by the Pi agent harness";

/** Minimal structural view of Pi's Theme.fg needed by the banner. */
export interface WelcomeTheme {
  fg(color: "accent" | "dim", text: string): string;
}

/** Rendered banner lines (wordmark in accent, tagline in dim), each ≤ width. */
export function welcomeBannerLines(theme: WelcomeTheme, width: number): string[] {
  return [
    ...BANNER_LINES.map((line) => theme.fg("accent", line)),
    theme.fg("dim", BANNER_TAGLINE),
  ].map((line) => truncateToWidth(line, width, ""));
}

/**
 * Mount the welcome banner on the Paper Assistant extension.
 * TUI-only: `setHeader` component factories are terminal-only features, and the
 * same extension file runs in Web RPC children where they would be inert.
 */
export function mountWelcomeBanner(pi: ExtensionAPI): void {
  const tuiOnly = (_event: unknown, ctx: { mode?: string; hasUI?: boolean }): boolean =>
    ctx.mode === "tui" && ctx.hasUI === true;

  pi.on("session_start", (_event, ctx) => {
    if (!tuiOnly(_event, ctx)) return;
    ctx.ui.setHeader((_tui, theme) => ({
      render: (width: number) => welcomeBannerLines(theme, width),
      invalidate: () => {},
    }));
  });
}
