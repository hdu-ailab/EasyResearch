import type { FileWatcherEvent } from "../../web/contracts";

export type { FileWatcherEvent } from "../../web/contracts";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}

function normalizeAbsolutePath(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function normalizeRoot(root: string): string | null {
  const normalized = normalizeAbsolutePath(root);
  if (!normalized) return null;
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function isInRoot(root: string, file: string): boolean {
  return root === "/" ? file.startsWith("/") : file === root || file.startsWith(`${root}/`);
}

function isGitPath(root: string, file: string): boolean {
  const git = root === "/" ? "/.git" : `${root}/.git`;
  return file === git || file.startsWith(`${git}/`);
}

export function parseFileWatcherEvent(value: unknown, root: string): FileWatcherEvent | null {
  const source = record(value);
  const properties = record(source?.properties);
  const normalizedRoot = normalizeRoot(root);
  const file = typeof properties?.file === "string" ? normalizeAbsolutePath(properties.file) : null;
  const event = properties?.event;
  if (
    source?.type !== "file.watcher.updated" ||
    !properties ||
    !normalizedRoot ||
    !file ||
    (event !== "add" && event !== "change" && event !== "unlink") ||
    !isInRoot(normalizedRoot, file) ||
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
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "/" : path.slice(0, separator);
}
