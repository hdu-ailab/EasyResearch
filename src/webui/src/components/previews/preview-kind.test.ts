import { describe, expect, it } from "vitest";
import { previewKind } from "./preview-kind";

describe("previewKind", () => {
  it.each(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"])(
    "classifies .%s as a native image independently of case or host path syntax",
    (extension) => {
      for (const path of [`/p/报告.${extension}`, `C:\\papers\\报告.${extension.toUpperCase()}`]) {
        expect(previewKind(path)).toBe("image");
      }
      expect(previewKind(`/p/figure.${extension}.txt`)).toBe("text");
    },
  );

  it.each([
    ["report.HTML", "html"],
    ["report.HtM", "html"],
    ["clip.MP4", "video"],
    ["paper.PDF", "pdf"],
    ["paper.DoCx", "docx"],
    ["paper.MD", "markdown"],
    ["paper.Markdown", "markdown"],
    ["paper.doc", "text"],
    ["clip.mp4.txt", "text"],
    ["report.html/data.json", "text"],
    ["README", "text"],
  ] as const)("classifies %s as %s", (path, expected) => {
    expect(previewKind(path)).toBe(expected);
  });
});
