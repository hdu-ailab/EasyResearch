import { describe, expect, it } from "vitest";
import { attachmentDisposition, mimeTypeFor, parseByteRange, rawFileHeaders, RawFileRangeError } from "./raw-file";

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
    expect(mimeTypeFor("movie.MP4")).toBe("video/mp4");
    expect(mimeTypeFor("figure.AVIF")).toBe("image/avif");
    expect(mimeTypeFor("archive.bin")).toBe("application/octet-stream");
  });

  it("falls back to octet-stream for unknown or extensionless files", () => {
    expect(mimeTypeFor("unknown.xyz")).toBe("application/octet-stream");
    expect(mimeTypeFor("README")).toBe("application/octet-stream");
    expect(mimeTypeFor("trailing.")).toBe("application/octet-stream");
  });
});

describe("attachmentDisposition", () => {
  it("round trips Unicode names while keeping the quoted fallback ASCII-safe", () => {
    const name = "研究 🐬 % \"'().mp4";
    const disposition = attachmentDisposition(name);
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x21\x23-\x5b\x5d-\x7e]+"; filename\*=UTF-8''/);
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1]!)).toBe(name);
    expect(attachmentDisposition("bad\r\nHeader: injected")).not.toMatch(/[\r\n]/);
  });
});

describe("raw document response policy", () => {
  it.each(["text/html; charset=utf-8", "application/xhtml+xml"])("makes %s an isolated attachment by MIME", (mime) => {
    const headers = new Headers(rawFileHeaders(mime, "alias.bin"));
    expect(headers.get("content-type")).toBe(mime);
    expect(headers.get("content-disposition")).toBe(attachmentDisposition("alias.bin"));
    expect(headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(headers.get("content-security-policy")).not.toContain("allow-scripts");
    expect(headers.get("content-security-policy")).not.toContain("allow-same-origin");
  });

  it.each(["image/svg+xml", "application/xml; charset=utf-8", "text/xml"])("keeps %s viewable but script-disabled", (mime) => {
    const headers = new Headers(rawFileHeaders(mime, "figure.svg"));
    expect(headers.get("content-disposition")).toBeNull();
    expect(headers.get("content-security-policy")).toContain("style-src 'unsafe-inline'");
    expect(headers.get("content-security-policy")).toContain("img-src data: blob:");
    expect(headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("keeps passive MIME, download selection and cache invalidation independent", () => {
    for (const name of ["figure.png", "paper.pdf", "paper.docx", "clip.mp4", "style.css", "data.json"]) {
      const mime = mimeTypeFor(name);
      const inline = new Headers(rawFileHeaders(mime, name));
      const download = new Headers(rawFileHeaders(mime, name, true));
      expect(inline.get("content-type")).toBe(mime);
      expect(inline.get("content-security-policy")).toBeNull();
      expect(inline.get("content-disposition")).toBeNull();
      expect(download.get("content-disposition")).toBe(attachmentDisposition(name));
      for (const headers of [inline, download]) {
        expect(headers.get("cache-control")).toBe("no-store");
        expect(headers.get("x-content-type-options")).toBe("nosniff");
        expect(headers.has("access-control-allow-origin")).toBe(false);
      }
    }
  });
});
