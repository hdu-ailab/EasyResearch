const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Resolves a Markdown `href`/`src` to an absolute project path when it points
 * at a local resource, or `null` for external URLs, fragment anchors, and
 * empty references. Relative targets resolve against the document's directory;
 * `..` segments normalize (and clamp) above the filesystem root.
 */
export function resolveLocalPreviewPath(documentPath: string, href: string): string | null {
  if (!href) return null;
  const target = href.trim();
  if (!target || target.startsWith("#") || target.startsWith("//") || SCHEME_RE.test(target)) return null;
  const baseDir = documentPath.includes("/") ? documentPath.slice(0, documentPath.lastIndexOf("/")) : "";
  const joined = target.startsWith("/") ? target : `${baseDir}/${target}`;
  const parts: string[] = [];
  for (const segment of joined.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}
