import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
