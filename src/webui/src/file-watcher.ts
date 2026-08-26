import type { FileWatcherEvent } from "../../web/contracts";
import {
  isSameOrDescendantPath,
  joinFilesystemPath,
  normalizeAbsoluteFilesystemPath,
  parentFilesystemPath,
} from "./filesystem-path";

export type { FileWatcherEvent } from "../../web/contracts";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}

function isGitPath(root: string, file: string): boolean {
  return isSameOrDescendantPath(joinFilesystemPath(root, ".git"), file);
}

export function parseFileWatcherEvent(value: unknown, root: string): FileWatcherEvent | null {
  const source = record(value);
  const properties = record(source?.properties);
  const normalizedRoot = normalizeAbsoluteFilesystemPath(root);
  const file = typeof properties?.file === "string" ? normalizeAbsoluteFilesystemPath(properties.file) : null;
  const event = properties?.event;
  if (
    source?.type !== "file.watcher.updated" ||
    !properties ||
    !normalizedRoot ||
    !file ||
    (event !== "add" && event !== "change" && event !== "unlink") ||
    !isSameOrDescendantPath(normalizedRoot, file) ||
    isGitPath(normalizedRoot, file)
  ) {
    return null;
  }
  return {
    type: "file.watcher.updated",
    properties: { file, event },
  };
}

export function parentPath(path: string): string {
  return parentFilesystemPath(path);
}
