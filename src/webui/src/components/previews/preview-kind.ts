import { type FilePreviewKind, fileFormatFor } from "../../../../web/file-formats";

export type PreviewKind = FilePreviewKind;

/** Selects the preview and fetch strategy from a case-insensitive file extension. */
export function previewKind(path: string): PreviewKind {
  return fileFormatFor(path)?.kind ?? "text";
}
