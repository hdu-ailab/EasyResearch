import { createContext, useContext } from "react";
import type { UiVersion } from "./preferences";

/**
 * The interface version in effect.
 *
 * A dedicated context rather than a slice of the preferences context: shared
 * presentation components read only this value, and it carries the production
 * default so such a component can still render outside the preferences
 * provider (isolated tests) without changing what the app does.
 */
export const UiVersionContext = createContext<UiVersion>("current");

/**
 * The pre-refresh favicon was an inline bulb data URI in `index.html`; the
 * refreshed UI ships a dolphin SVG at `/favicon.svg`. A page has exactly one
 * icon link, so the classic option restores the original inline icon.
 */
export const CLASSIC_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%231D5C8F' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5'/%3E%3Cpath d='M9 18h6'/%3E%3Cpath d='M10 22h4'/%3E%3C/svg%3E";
export const CURRENT_FAVICON = "/favicon.svg";

/**
 * Point the document icon at the selected version's favicon.
 *
 * The icon link lives in `<head>`, outside the React tree, so this is a
 * document-level side effect rather than a rendered prop. It is idempotent and
 * safe to run on every preference change.
 */
export function applyUiVersion(version: UiVersion): void {
  // The classic palette and typography are a scoped theme-token override keyed
  // off this attribute, so it must be applied before anything reads colors.
  document.documentElement.dataset.uiVersion = version;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  link.href = version === "classic" ? CLASSIC_FAVICON : CURRENT_FAVICON;
}

/** Whether the classic interface version is selected. Re-renders on change. */
export function useClassicUi(): boolean {
  return useContext(UiVersionContext) === "classic";
}
