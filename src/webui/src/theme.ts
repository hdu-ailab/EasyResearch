import type { Theme } from "./preferences";

/** Apply the same theme before first paint and after local or cross-tab changes. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.uiTheme = theme;
  document.documentElement.style.colorScheme = theme;
}
