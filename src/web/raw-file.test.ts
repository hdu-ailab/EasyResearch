import { describe, expect, it } from "vitest";
import { mimeTypeFor, parseByteRange, RawFileRangeError } from "./raw-file";

describe("parseByteRange", () => {
  it.each([
    ["bytes=1-3", { start: 1, end: 3 }],
    ["bytes=4-", { start: 4, end: 9 }],
    ["bytes=-3", { start: 7, end: 9 }],
  ])("parses %s", (header, expected) => {
    expect(parseByteRange(header, 10)).toEqual(expected);
  });

  it("returns null when no Range header is present", () => {
    expect(parseByteRange(null, 10)).toBeNull();
  });

  it("rejects malformed, multiple, and unsatisfiable ranges", () => {
    expect(() => parseByteRange("bytes=20-30", 10)).toThrow(RawFileRangeError);
    expect(() => parseByteRange("bytes=0-1,4-5", 10)).toThrow(RawFileRangeError);
    expect(() => parseByteRange("items=0-1", 10)).toThrow(RawFileRangeError);
    expect(() => parseByteRange("bytes=-0", 10)).toThrow(RawFileRangeError);
  });

  it("rejects any range on an empty file", () => {
    expect(() => parseByteRange("bytes=0-1", 0)).toThrow(RawFileRangeError);
  });
});

describe("mimeTypeFor", () => {
  it("maps document extensions to conservative MIME types", () => {
    expect(mimeTypeFor("paper.pdf")).toBe("application/pdf");
    expect(mimeTypeFor("paper.DOCX")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(mimeTypeFor("notes.md")).toBe("text/markdown; charset=utf-8");
    expect(mimeTypeFor("figure.png")).toBe("image/png");
    expect(mimeTypeFor("archive.bin")).toBe("application/octet-stream");
  });

  it("falls back to octet-stream for unknown or extensionless files", () => {
    expect(mimeTypeFor("unknown.xyz")).toBe("application/octet-stream");
    expect(mimeTypeFor("README")).toBe("application/octet-stream");
    expect(mimeTypeFor("trailing.")).toBe("application/octet-stream");
  });
});
