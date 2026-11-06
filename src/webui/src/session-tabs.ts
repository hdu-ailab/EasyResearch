import { normalizeAbsoluteFilesystemPath } from "./filesystem-path";

/** Startup bookmarks only. Live views and runtime activity belong to App. */
export interface SessionTab {
  id: string;
  cwd: string;
  name?: string;
}

export interface SessionTabItem extends SessionTab {
  status?: string;
  loading?: boolean;
  error?: boolean;
}

export const SESSION_TABS_MAX_COUNT = 32;
export const SESSION_TABS_MAX_BYTES = 8 * 1024;
export const SESSION_TAB_NAME_MAX_LENGTH = 512;

/** App supplies one instance prefix to pair the strip with its lazy view panels. */
export function sessionTabDomId(prefix: string, id: string): string {
  return `${encodeURIComponent(prefix)}-session-tab-${encodeURIComponent(id)}`;
}

export function sessionPanelDomId(prefix: string, id: string): string {
  return `${encodeURIComponent(prefix)}-session-panel-${encodeURIComponent(id)}`;
}

const owns = (value: object, key: string) => Object.hasOwn(value, key);
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function isDescriptor(value: unknown, boundedName: boolean): value is SessionTab {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tab = value as Record<string, unknown>;
  return (
    Object.keys(tab).every((key) => key === "id" || key === "cwd" || key === "name") &&
    owns(tab, "id") &&
    typeof tab.id === "string" &&
    tab.id.trim().length > 0 &&
    !tab.id.includes("\0") &&
    owns(tab, "cwd") &&
    typeof tab.cwd === "string" &&
    !tab.cwd.includes("\0") &&
    normalizeAbsoluteFilesystemPath(tab.cwd) !== null &&
    (!owns(tab, "name") ||
      (typeof tab.name === "string" &&
        !tab.name.includes("\0") &&
        (!boundedName || tab.name.length <= SESSION_TAB_NAME_MAX_LENGTH)))
  );
}

/** Strict host policy; no DOM, storage or runtime imports. */
export function isSessionTabs(value: unknown): value is SessionTab[] {
  if (!Array.isArray(value) || value.length > SESSION_TABS_MAX_COUNT) return false;
  const ids = new Set<string>();
  for (const tab of value) {
    if (!isDescriptor(tab, true) || ids.has(tab.id)) return false;
    ids.add(tab.id);
  }
  return byteLength(value) <= SESSION_TABS_MAX_BYTES;
}

/** Browser recovery is field-local: keep valid descriptors and normalize bounds. */
export function parseSessionTabs(value: unknown): SessionTab[] {
  return Array.isArray(value) ? snapshotSessionTabs(value.filter((tab) => isDescriptor(tab, false))) : [];
}

function mergeTab(tab: SessionTab, patch: Partial<Pick<SessionTab, "cwd" | "name">>): SessionTab {
  const next = { ...tab, cwd: patch.cwd ?? tab.cwd };
  if (owns(patch, "name")) {
    if (patch.name === undefined) delete next.name;
    else next.name = patch.name;
  }
  return next;
}

export function upsertSessionTab(tabs: readonly SessionTab[], tab: SessionTab): SessionTab[] {
  let found = false;
  const next = tabs.flatMap((current) => {
    if (current.id !== tab.id) return [current];
    if (found) return [];
    found = true;
    return [mergeTab(current, tab)];
  });
  if (!found) next.push(mergeTab({ id: tab.id, cwd: tab.cwd }, tab));
  return next;
}

export function updateSessionTab(
  tabs: readonly SessionTab[],
  id: string,
  patch: Partial<Pick<SessionTab, "cwd" | "name">>,
): SessionTab[] {
  return tabs.map((tab) => (tab.id === id ? mergeTab(tab, patch) : tab));
}

export function closeSessionTab(
  tabs: readonly SessionTab[],
  id: string,
  selectedId: string | null,
): { tabs: SessionTab[]; selectedId: string | null } {
  const index = tabs.findIndex((tab) => tab.id === id);
  return {
    tabs: tabs.filter((tab) => tab.id !== id),
    selectedId: index !== -1 && selectedId === id ? (tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null) : selectedId,
  };
}

/** Move to the target's original index; selection remains the caller's route. */
export function reorderSessionTabs(tabs: readonly SessionTab[], fromId: string, toId: string): SessionTab[] {
  const next = [...tabs];
  const from = next.findIndex((tab) => tab.id === fromId);
  const to = next.findIndex((tab) => tab.id === toId);
  if (from < 0 || to < 0 || from === to) return next;
  const [tab] = next.splice(from, 1);
  if (tab) next.splice(to, 0, tab);
  return next;
}

/** Prefer the active descriptor, then the latest entries; keep their relative order. */
export function snapshotSessionTabs(tabs: readonly SessionTab[], preferredId?: string | null): SessionTab[] {
  const unique = new Map<string, SessionTab>();
  for (const tab of tabs) {
    const descriptor: SessionTab = { id: tab.id, cwd: tab.cwd };
    if (tab.name !== undefined) {
      // Avoid leaving half a surrogate pair at the cache boundary.
      const name = tab.name.slice(0, SESSION_TAB_NAME_MAX_LENGTH);
      descriptor.name = /[\uD800-\uDBFF]$/u.test(name) ? name.slice(0, -1) : name;
    }
    if (isDescriptor(descriptor, true)) unique.set(tab.id, descriptor);
  }
  const candidates = [...unique.values()];
  const priority = [...candidates].reverse();
  const preferred = unique.get(preferredId ?? "");
  if (preferred) priority.unshift(preferred);
  const selected = new Set<string>();
  let bytes = 2; // JSON array brackets.
  for (const tab of priority) {
    if (selected.has(tab.id)) continue;
    if (selected.size === SESSION_TABS_MAX_COUNT) break;
    const addition = byteLength(tab) + (selected.size ? 1 : 0);
    if (bytes + addition > SESSION_TABS_MAX_BYTES) continue;
    bytes += addition;
    selected.add(tab.id);
  }
  return candidates.filter((tab) => selected.has(tab.id));
}
