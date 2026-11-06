import { describe, expect, it } from "vitest";
import {
  closeSessionTab,
  isSessionTabs,
  parseSessionTabs,
  reorderSessionTabs,
  SESSION_TAB_NAME_MAX_LENGTH,
  SESSION_TABS_MAX_BYTES,
  SESSION_TABS_MAX_COUNT,
  type SessionTab,
  snapshotSessionTabs,
  updateSessionTab,
  upsertSessionTab,
} from "./session-tabs";

const tabs: readonly SessionTab[] = Object.freeze([
  Object.freeze({ id: "a", cwd: "/workspace/a", name: "Alpha" }),
  Object.freeze({ id: "b", cwd: "C:\\Workspace B", name: "Beta" }),
  Object.freeze({ id: "c", cwd: "\\\\server\\share\\C", name: "Gamma" }),
]);
const ids = (value: readonly SessionTab[]) => value.map((tab) => tab.id);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("document-local session catalog", () => {
  it("upserts by id in place, preserving a known name until explicitly overwritten", () => {
    const updated = upsertSessionTab(tabs, { id: "b", cwd: "/moved B" });
    expect(ids(updated)).toEqual(ids(tabs));
    expect(updated[1]).toEqual({ ...tabs[1], cwd: "/moved B" });
    expect(updated[0]).toBe(tabs[0]);
    expect(upsertSessionTab(updated, { id: "b", cwd: "/moved B", name: undefined })[1]).not.toHaveProperty("name");
    expect(upsertSessionTab(updated, { id: "b", cwd: "/moved B", name: "" })[1]?.name).toBe("");
    expect(upsertSessionTab([...tabs, tabs[1]!], { id: "b", cwd: "/new", name: "New" })).toHaveLength(tabs.length);
    expect(upsertSessionTab(tabs, { id: "d", cwd: "/workspace/a" }).at(-1)?.id).toBe("d");
    expect(tabs[1]?.cwd).toBe("C:\\Workspace B");
  });

  it("updates metadata without reordering or reopening an absent id", () => {
    const updated = updateSessionTab(tabs, "b", { name: "Renamed" });
    expect(ids(updated)).toEqual(ids(tabs));
    expect(updated[1]).toEqual({ ...tabs[1], name: "Renamed" });
    expect(updateSessionTab(updated, "a", { cwd: "/exact/../a/" })[0]?.cwd).toBe("/exact/../a/");
    expect(updateSessionTab(tabs, "missing", { name: "Late response" })).toEqual(tabs);
  });

  it("closes active tabs right, then left, then Home; background close preserves selection", () => {
    expect(closeSessionTab(tabs, "b", "b")).toEqual({ tabs: [tabs[0], tabs[2]], selectedId: "c" });
    expect(closeSessionTab(tabs, "c", "c").selectedId).toBe("b");
    expect(closeSessionTab([tabs[0]!], "a", "a")).toEqual({ tabs: [], selectedId: null });
    expect(closeSessionTab(tabs, "b", "a").selectedId).toBe("a");
    expect(closeSessionTab(tabs, "b", null).selectedId).toBeNull();
    expect(closeSessionTab(tabs, "missing", "missing")).toEqual({ tabs, selectedId: "missing" });
  });

  it("reorders only the named tab and ignores obsolete drag identities", () => {
    expect(ids(reorderSessionTabs(tabs, "a", "c"))).toEqual(["b", "c", "a"]);
    expect(ids(reorderSessionTabs(tabs, "c", "a"))).toEqual(["c", "a", "b"]);
    expect(reorderSessionTabs(tabs, "b", "missing")).toEqual(tabs);
    expect(reorderSessionTabs(tabs, "b", "b")).toEqual(tabs);
  });
});

describe("startup bookmark policy", () => {
  it("prioritizes the active and latest tabs while retaining order without imposing a live catalog cap", () => {
    const live = Array.from({ length: SESSION_TABS_MAX_COUNT + 20 }, (_, i) => ({
      id: String(i),
      cwd: `/project/${i}`,
    }));
    const saved = snapshotSessionTabs(live, live[0]!.id);
    expect(saved).toHaveLength(SESSION_TABS_MAX_COUNT);
    expect(saved[0]).toEqual(live[0]);
    expect(saved.slice(1)).toEqual(live.slice(-(SESSION_TABS_MAX_COUNT - 1)));
    expect(isSessionTabs(saved)).toBe(true);
    expect(live.length).toBeGreaterThan(saved.length);
    expect(snapshotSessionTabs(saved)).toEqual(saved);
  });

  it("uses serialized UTF-8 bytes including brackets, commas and escaping at the exact boundary", () => {
    const base = { id: "unicode-会话", cwd: "/" };
    const remaining = SESSION_TABS_MAX_BYTES - bytes([base]);
    const exact = { ...base, cwd: `/${"研".repeat(Math.floor(remaining / 3))}${"x".repeat(remaining % 3)}` };
    expect(bytes([exact])).toBe(SESSION_TABS_MAX_BYTES);
    expect(isSessionTabs([exact])).toBe(true);
    expect(snapshotSessionTabs([exact])).toEqual([exact]);
    const oversized = { ...exact, cwd: `${exact.cwd}x` };
    expect(isSessionTabs([oversized])).toBe(false);
    expect(snapshotSessionTabs([tabs[0]!, oversized], oversized.id)).toEqual([tabs[0]]);
    expect(snapshotSessionTabs([exact, tabs[0]!], exact.id)).toEqual([exact]);
    expect(snapshotSessionTabs([exact, tabs[0]!])).toEqual([tabs[0]]);
  });

  it("bounds cached names while preserving every id/cwd byte and excludes runtime fields", () => {
    const exact = { id: "  exact-id  ", cwd: "C:\\研究 空间\\..\\项目\\", name: `A${"🐬".repeat(600)}` };
    const saved = snapshotSessionTabs([{ ...exact, status: "running", loading: true, draft: "private" } as SessionTab]);
    expect(saved[0]?.id).toBe(exact.id);
    expect(saved[0]?.cwd).toBe(exact.cwd);
    expect(saved[0]?.name?.length).toBeLessThanOrEqual(SESSION_TAB_NAME_MAX_LENGTH);
    expect(saved[0]?.name).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(Object.keys(saved[0]!)).toEqual(["id", "cwd", "name"]);
    expect(isSessionTabs(saved)).toBe(true);
    expect(exact.name.length).toBeGreaterThan(SESSION_TAB_NAME_MAX_LENGTH);
  });

  it.each([
    null,
    {},
    "tabs",
    [null],
    [{ ...tabs[0], id: "" }],
    [{ ...tabs[0], id: " \n " }],
    [{ ...tabs[0], id: "a\0b" }],
    [{ ...tabs[0], cwd: "/a\0b" }],
    [{ ...tabs[0], name: "a\0b" }],
    [{ ...tabs[0], cwd: "relative/path" }],
    [{ ...tabs[0], cwd: "C:relative" }],
    [{ ...tabs[0], cwd: "\\\\server" }],
    [{ ...tabs[0], cwd: "~/workspace" }],
    [{ ...tabs[0], name: null }],
    [{ ...tabs[0], name: undefined }],
    [{ ...tabs[0], name: [] }],
    [{ ...tabs[0], name: "x".repeat(SESSION_TAB_NAME_MAX_LENGTH + 1) }],
    [{ ...tabs[0], status: "running" }],
    [{ ...tabs[0], history: [] }],
    [tabs[0], tabs[0]],
    Array.from({ length: SESSION_TABS_MAX_COUNT + 1 }, (_, i) => ({ id: String(i), cwd: "/" })),
  ])("rejects malformed or over-bound host data %j", (value) => {
    expect(isSessionTabs(value)).toBe(false);
  });

  it("recovers valid browser entries and latest duplicate metadata independently of malformed siblings", () => {
    const recovered = parseSessionTabs([tabs[0], null, { id: "no-cwd" }, tabs[1], { ...tabs[0], name: "Latest" }]);
    expect(recovered).toEqual([{ ...tabs[0], name: "Latest" }, tabs[1]]);
    expect(parseSessionTabs(undefined)).toEqual([]);
    expect(parseSessionTabs({ tabs })).toEqual([]);
    expect(isSessionTabs(parseSessionTabs([{ ...tabs[0], name: "x".repeat(2000) }]))).toBe(true);
    expect(parseSessionTabs(tabs)).toEqual(tabs);
  });
});
