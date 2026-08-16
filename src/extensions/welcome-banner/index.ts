import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { mountWelcomeBanner } from "../../tui/welcome-banner";

/**
 * ADR-063: atomic extension mounting the TUI welcome banner (ADR-023).
 * `mountWelcomeBanner` guards on `ctx.mode === "tui" && ctx.hasUI`, so the
 * banner is inert in headless Web sessions.
 */
export function createWelcomeBannerExtension(): InlineExtension {
  return async (pi) => {
    mountWelcomeBanner(pi);
  };
}

export default createWelcomeBannerExtension();
