import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_TABS_MAX_BYTES, SESSION_TABS_MAX_COUNT, snapshotSessionTabs } from "../webui/src/session-tabs";
import { getTimelineDetail, TIMELINE_CATEGORIES, TIMELINE_PRESETS } from "../webui/src/timeline-detail";
import {
  desktopPreferencePath,
  readDesktopPreferenceBlob,
  writeDesktopPreferenceBlob,
} from "./preferences-store";

const valid = JSON.stringify({
  chatFontSize: 13,
  filesFontSize: 12,
  language: "en",
  autoExpandThinking: false,
  autoExpandTools: true,
  expandSubagentOutput: false,
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-desktop-prefs-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("desktop preference persistence", () => {
  it("mirrors bounded session bookmarks alongside chat categories and still accepts old blobs", () => {
    const sessionTabs = snapshotSessionTabs(Array.from({ length: 70 }, (_, i) => ({ id: String(i), cwd: `/研究/${i}` })), "0");
    const blob = JSON.stringify({ ...JSON.parse(valid), sessionTabs, timelineDetail: getTimelineDetail({}), studioTheme: "dark" });
    writeDesktopPreferenceBlob(root, blob);
    expect(readDesktopPreferenceBlob(root)).toBe(blob);
    writeDesktopPreferenceBlob(root, valid);
    expect(readDesktopPreferenceBlob(root)).toBe(valid);
  });

  it("strictly rejects malformed nested bookmarks without replacing the accepted mirror", () => {
    const tab = { id: "root", cwd: "/workspace", name: "Research" };
    const accepted = JSON.stringify({ ...JSON.parse(valid), sessionTabs: [tab] });
    writeDesktopPreferenceBlob(root, accepted);
    const candidates = [
      null, {}, "tabs", [null], [{ ...tab, id: 1 }], [{ ...tab, id: "" }], [{ ...tab, cwd: "relative" }],
      [{ ...tab, cwd: "C:relative" }], [{ ...tab, cwd: "\\\\server" }], [{ ...tab, cwd: "/bad\0path" }],
      [{ ...tab, name: {} }], [{ ...tab, name: null }], [{ ...tab, name: "x".repeat(513) }],
      [{ ...tab, status: "running" }], [{ ...tab, draft: "secret" }], [tab, tab],
      Array.from({ length: SESSION_TABS_MAX_COUNT + 1 }, (_, i) => ({ id: String(i), cwd: "/" })),
      [{ ...tab, cwd: `/${"研".repeat(SESSION_TABS_MAX_BYTES / 2)}` }],
    ];
    for (const sessionTabs of candidates) {
      expect(() => writeDesktopPreferenceBlob(root, JSON.stringify({ ...JSON.parse(valid), sessionTabs }))).toThrow(/preference/i);
      expect(readDesktopPreferenceBlob(root)).toBe(accepted);
    }
  });

  it("enforces the bookmark byte boundary before the unchanged 16 KiB envelope limit", () => {
    const base = { id: "exact", cwd: "/" };
    const sessionTabs = [{ ...base, cwd: `/${"x".repeat(SESSION_TABS_MAX_BYTES - Buffer.byteLength(JSON.stringify([base])))}` }];
    const blob = JSON.stringify({ ...JSON.parse(valid), sessionTabs });
    writeDesktopPreferenceBlob(root, blob);
    expect(readDesktopPreferenceBlob(root)).toBe(blob);
    const oversized = JSON.stringify({ ...JSON.parse(valid), sessionTabs: [{ ...sessionTabs[0], cwd: `${sessionTabs[0]!.cwd}x` }] });
    expect(Buffer.byteLength(oversized)).toBeLessThan(16 * 1024);
    expect(() => writeDesktopPreferenceBlob(root, oversized)).toThrow(/schema/);
    expect(readDesktopPreferenceBlob(root)).toBe(blob);
  });

  it.each(TIMELINE_PRESETS)("round-trips a complete $id timeline policy through the host mirror", ({ value }) => {
    const blob = JSON.stringify({ ...JSON.parse(valid), timelineDetail: value });
    writeDesktopPreferenceBlob(root, blob);
    expect(readDesktopPreferenceBlob(root)).toBe(blob);
  });

  it.each(TIMELINE_CATEGORIES)("validates exact nested fields for %s without replacing accepted preferences", (category) => {
    const accepted = JSON.stringify({ ...JSON.parse(valid), timelineDetail: getTimelineDetail({}) });
    writeDesktopPreferenceBlob(root, accepted);
    const missing = getTimelineDetail({}) as Partial<ReturnType<typeof getTimelineDetail>>;
    delete missing[category];
    const candidates = [
      missing,
      { ...getTimelineDetail({}), [category]: { placement: "grouped", details: "collapsed", extra: true } },
      { ...getTimelineDetail({}), [category]: { placement: "grouped" } },
      { ...getTimelineDetail({}), [category]: { placement: "future", details: "collapsed" } },
      { ...getTimelineDetail({}), [category]: { placement: "grouped", details: "future" } },
      { ...getTimelineDetail({}), [category]: [] },
      { ...getTimelineDetail({}), [category]: null },
    ];
    for (const timelineDetail of candidates) {
      expect(() => writeDesktopPreferenceBlob(root, JSON.stringify({ ...JSON.parse(valid), timelineDetail })))
        .toThrow(/preference/i);
      expect(readDesktopPreferenceBlob(root)).toBe(accepted);
    }
  });

  it.each([null, [], false, "compact", {}, { ...getTimelineDetail({}), extra: {} }])(
    "rejects an invalid timeline policy: %j",
    (timelineDetail) => {
      writeDesktopPreferenceBlob(root, valid);
      expect(() => writeDesktopPreferenceBlob(root, JSON.stringify({ ...JSON.parse(valid), timelineDetail })))
        .toThrow(/preference/i);
      expect(readDesktopPreferenceBlob(root)).toBe(valid);
    },
  );

  it.each(["light", "dark"])("restores a Studio %s preference blob through the host mirror", (studioTheme) => {
    const blob = JSON.stringify({ ...JSON.parse(valid), uiVersion: "studio", studioTheme });
    writeDesktopPreferenceBlob(root, blob);
    expect(readDesktopPreferenceBlob(root)).toBe(blob);
  });

  it("round-trips only the existing Web preference object", () => {
    writeDesktopPreferenceBlob(root, valid);
    expect(readDesktopPreferenceBlob(root)).toBe(valid);
    expect(JSON.parse(readFileSync(desktopPreferencePath(root), "utf8")))
      .toEqual(JSON.parse(valid));
  });

  it("removes the mirror when the browser preference is absent", () => {
    writeDesktopPreferenceBlob(root, valid);
    writeDesktopPreferenceBlob(root, null);
    expect(readDesktopPreferenceBlob(root)).toBeUndefined();
    expect(existsSync(desktopPreferencePath(root))).toBe(false);
  });

  it.each([
    "not-json",
    "[]",
    JSON.stringify({ auth: { token: "secret" } }),
    JSON.stringify({ chatFontSize: 99 }),
    ...["future", null, false, 1, {}].map((uiVersion) => JSON.stringify({ ...JSON.parse(valid), uiVersion })),
    ...["system", null, false, 1, {}].map((studioTheme) => JSON.stringify({ ...JSON.parse(valid), uiVersion: "studio", studioTheme })),
    JSON.stringify({ ...JSON.parse(valid), uiVersion: "classic", unknown: true }),
  ])("rejects an invalid preference blob without replacing the accepted value", (candidate) => {
    writeDesktopPreferenceBlob(root, valid);
    expect(() => writeDesktopPreferenceBlob(root, candidate)).toThrow(/preference/i);
    expect(readDesktopPreferenceBlob(root)).toBe(valid);
  });

  it("rejects blobs larger than 16 KiB", () => {
    expect(() => writeDesktopPreferenceBlob(root, JSON.stringify({
      chatFontSize: 13,
      filesFontSize: 12,
      language: "en",
      autoExpandThinking: false,
      autoExpandTools: false,
      expandSubagentOutput: false,
      padding: "x".repeat(17 * 1024),
    }))).toThrow(/16 KiB/);
  });
});
