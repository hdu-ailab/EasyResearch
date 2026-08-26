import { isAbsoluteFilesystemPath, resolveFilesystemPath } from "../../filesystem-path";

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Resolves a Markdown `href`/`src` to an absolute project path when it points
 * at a local resource, or `null` for external URLs, fragment anchors, and
 * empty references. Query strings and URL fragments are stripped from the
 * resolved path (e.g. `other.md#sec` → `/p/docs/other.md`); percent-encoded
 * characters such as spaces are decoded. Relative targets resolve against the
 * document's directory; `..` segments normalize (and clamp) above the
 * filesystem root.
 */
export function resolveLocalPreviewPath(documentPath: string, href: string): string | null {
  if (!href) return null;
  const target = href.trim();
  if (
    !target ||
    target.startsWith("#") ||
    target.startsWith("//") ||
    (SCHEME_RE.test(target) && !isAbsoluteFilesystemPath(target))
  ) {
    return null;
  }
  const [pathOnly] = target.split(/[?#]/, 1);
  if (!pathOnly || pathOnly.startsWith("//")) return null;
  const decoded = pathOnly.split("/").map(decodeSegment).join("/");
  return resolveFilesystemPath(documentPath, decoded);
}
