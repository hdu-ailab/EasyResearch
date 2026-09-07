import { relativeFilesystemPath } from "./filesystem-path";

export const FILE_PATH_DRAG_TYPE = "application/x-easyresearch-file-path";

export function readFilePathDrop(data: DataTransfer, root: string): string | null {
  try {
    const payload: unknown = JSON.parse(data.getData(FILE_PATH_DRAG_TYPE));
    if (!payload || typeof payload !== "object") return null;
    const { kind, path, root: sourceRoot } = payload as Record<string, unknown>;
    if (kind !== "file" || sourceRoot !== root || typeof path !== "string" || path.includes("\0")) return null;
    return relativeFilesystemPath(root, path) ? path : null;
  } catch {
    return null;
  }
}
