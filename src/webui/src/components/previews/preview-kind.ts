export type PreviewKind = "pdf" | "docx" | "markdown" | "text";

/** Selects the preview and fetch strategy from a case-insensitive file extension. */
export function previewKind(path: string): PreviewKind {
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.docx$/i.test(path)) return "docx";
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  return "text";
}
