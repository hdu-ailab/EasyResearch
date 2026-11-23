/** Shared preview/MIME vocabulary. Media decoding still follows the browser's codec support. */
export type FilePreviewKind = "image" | "svg" | "audio" | "video" | "pdf" | "html" | "markdown"
  | "mermaid" | "table" | "font" | "docx" | "spreadsheet" | "presentation" | "text";

interface FileFormat { readonly kind: FilePreviewKind; readonly mimeType: string }

// Extension coverage verified against the current V2 artifact catalog; no renderer dependency belongs here.
const formats: Readonly<Record<string, FileFormat>> = {
  png: { kind: "image", mimeType: "image/png" },
  jpg: { kind: "image", mimeType: "image/jpeg" },
  jpeg: { kind: "image", mimeType: "image/jpeg" },
  gif: { kind: "image", mimeType: "image/gif" },
  webp: { kind: "image", mimeType: "image/webp" },
  avif: { kind: "image", mimeType: "image/avif" },
  bmp: { kind: "image", mimeType: "image/bmp" },
  ico: { kind: "image", mimeType: "image/x-icon" },
  tif: { kind: "image", mimeType: "image/tiff" },
  tiff: { kind: "image", mimeType: "image/tiff" },
  heic: { kind: "image", mimeType: "image/heic" },
  svg: { kind: "svg", mimeType: "image/svg+xml" },
  mp3: { kind: "audio", mimeType: "audio/mpeg" },
  wav: { kind: "audio", mimeType: "audio/wav" },
  ogg: { kind: "audio", mimeType: "audio/ogg" },
  oga: { kind: "audio", mimeType: "audio/ogg" },
  m4a: { kind: "audio", mimeType: "audio/mp4" },
  aac: { kind: "audio", mimeType: "audio/aac" },
  flac: { kind: "audio", mimeType: "audio/flac" },
  opus: { kind: "audio", mimeType: "audio/ogg" },
  weba: { kind: "audio", mimeType: "audio/webm" },
  mp4: { kind: "video", mimeType: "video/mp4" },
  m4v: { kind: "video", mimeType: "video/mp4" },
  webm: { kind: "video", mimeType: "video/webm" },
  mov: { kind: "video", mimeType: "video/quicktime" },
  ogv: { kind: "video", mimeType: "video/ogg" },
  mkv: { kind: "video", mimeType: "video/x-matroska" },
  pdf: { kind: "pdf", mimeType: "application/pdf" },
  html: { kind: "html", mimeType: "text/html; charset=utf-8" },
  htm: { kind: "html", mimeType: "text/html; charset=utf-8" },
  md: { kind: "markdown", mimeType: "text/markdown; charset=utf-8" },
  markdown: { kind: "markdown", mimeType: "text/markdown; charset=utf-8" },
  mdx: { kind: "markdown", mimeType: "text/markdown; charset=utf-8" },
  mmd: { kind: "mermaid", mimeType: "text/vnd.mermaid; charset=utf-8" },
  mermaid: { kind: "mermaid", mimeType: "text/vnd.mermaid; charset=utf-8" },
  csv: { kind: "table", mimeType: "text/csv; charset=utf-8" },
  tsv: { kind: "table", mimeType: "text/tab-separated-values; charset=utf-8" },
  ttf: { kind: "font", mimeType: "font/ttf" },
  otf: { kind: "font", mimeType: "font/otf" },
  woff: { kind: "font", mimeType: "font/woff" },
  woff2: { kind: "font", mimeType: "font/woff2" },
  docx: { kind: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { kind: "spreadsheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { kind: "presentation", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};

export function fileFormatFor(path: string): FileFormat | undefined {
  const name = path.split(/[\\/]/u).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return Object.hasOwn(formats, extension) ? formats[extension] : undefined;
}
