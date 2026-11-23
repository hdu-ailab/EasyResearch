import { describe, expect, it } from "vitest";
import { previewKind } from "../webui/src/components/previews/preview-kind";
import { mimeTypeFor } from "./raw-file";

describe("file format routing and raw media delivery", () => {
  it.each([
    ["chart.TIFF", "image", "image/tiff"], ["photo.heic", "image", "image/heic"],
    ["drawing.svg", "svg", "image/svg+xml"], ["speech.MP3", "audio", "audio/mpeg"],
    ["recording.opus", "audio", "audio/ogg"], ["audio.weba", "audio", "audio/webm"],
    ["clip.webm", "video", "video/webm"], ["clip.mov", "video", "video/quicktime"],
    ["clip.mkv", "video", "video/x-matroska"], ["notebook.mdx", "markdown", "text/markdown"],
    ["flow.mmd", "mermaid", "text/vnd.mermaid"], ["flow.mermaid", "mermaid", "text/vnd.mermaid"],
    ["data.csv", "table", "text/csv"], ["data.tsv", "table", "text/tab-separated-values"],
    ["face.otf", "font", "font/otf"], ["face.woff2", "font", "font/woff2"],
    ["book.xlsx", "spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["deck.pptx", "presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ])("routes %s to a matching viewer and MIME", (name, kind, mime) => {
    expect(previewKind(`/project/${name}`)).toBe(kind);
    expect(mimeTypeFor(`/project/${name}`).split(";", 1)[0]).toBe(mime);
  });
  it("does not interpret a dotted parent directory or extensionless file as media", () => {
    expect(previewKind("/project.csv/README")).toBe("text");
    expect(mimeTypeFor("/project.csv/README")).toBe("application/octet-stream");
  });
  it.each(["constructor", "__proto__"])("keeps .%s as an unknown file extension", (extension) => {
    expect(previewKind(`/project/file.${extension}`)).toBe("text");
    expect(mimeTypeFor(`/project/file.${extension}`)).toBe("application/octet-stream");
  });
});
