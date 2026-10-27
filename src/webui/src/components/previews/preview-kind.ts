export type PreviewKind = "pdf" | "docx" | "markdown" | "text" | "image" | "video" | "html";

/** Selects the preview and fetch strategy from a case-insensitive file extension. */
export function previewKind(path: string): PreviewKind {
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.docx$/i.test(path)) return "docx";
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(path)) return "image";
  if (/\.mp4$/i.test(path)) return "video";
  if (/\.html?$/i.test(path)) return "html";
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  return "text";
}
