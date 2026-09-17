import type { Element, Root, RootContent } from "hast";
import { isAbsoluteFilesystemPath, joinFilesystemPath, normalizeAbsoluteFilesystemPath } from "../../filesystem-path";

function fileReference(path: string, explicit = false, grouped = false): string | null {
  if (
    !path ||
    path !== path.trim() ||
    /[\p{Cc}<>|*]/u.test(path) ||
    /^[~$#]/u.test(path) ||
    path.startsWith("//") ||
    /^\\(?!\\)/u.test(path) ||
    path.includes("@") ||
    (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path))
  )
    return null;
  if (!path || /[\\/]$/u.test(path) || path === "." || path === "..") return null;
  if (explicit) return path;
  const filename = path.split(/[\\/]/u).at(-1) ?? "";
  const hasFilename = /^(?:\.[\w-]+|.+\.[a-z][a-z\d_-]{0,15})$/iu.test(filename);
  if (hasFilename && (grouped || !/\s/u.test(path))) return path;
  if (/^(?:\.{1,2}[\\/]|[a-z]:[\\/]|\\\\)/iu.test(path)) return path;
  if (/^\/[^/]+\//u.test(path)) return path;
  if (grouped && /^[^\s\\/]+[\\/].+/u.test(path) && !path.startsWith("/")) return path;
  return null;
}

function stripFileLocator(value: string): string {
  const path = value.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/u, "");
  return fileReference(path, false, true) ? path : value;
}

export function resolveTranscriptFilePath(cwd: string, reference: string): string | null {
  const path = fileReference(reference, true);
  if (!path || !normalizeAbsoluteFilesystemPath(cwd)) return null;
  return normalizeAbsoluteFilesystemPath(isAbsoluteFilesystemPath(path) ? path : joinFilesystemPath(cwd, path));
}

function referenceNode(label: string, path: string): Element {
  return {
    type: "element",
    tagName: "a",
    properties: { dataFilePath: path },
    children: [{ type: "text", value: label }],
  };
}

function linkText(value: string): RootContent[] {
  const nodes: RootContent[] = [];
  let offset = 0;
  for (const match of value.matchAll(
    /"([^"\n]+)"|'([^'\n]+)'|[^\s"'<>\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\uFF08\uFF09\u3010\u3011]+/gu,
  )) {
    const quoted = match[1] ?? match[2];
    const raw = quoted ?? match[0];
    const prefix = quoted === undefined ? (raw.match(/^[([{]+/u)?.[0].length ?? 0) : 0;
    const label = quoted ?? raw.slice(prefix).replace(/[.,;:!?)\]}]+$/u, "");
    const path = fileReference(stripFileLocator(label), false, quoted !== undefined);
    if (!path) continue;
    const start = match.index + (quoted === undefined ? prefix : 1);
    if (start > offset) nodes.push({ type: "text", value: value.slice(offset, start) });
    nodes.push(referenceNode(label, path));
    offset = start + label.length;
  }
  if (offset < value.length) nodes.push({ type: "text", value: value.slice(offset) });
  return nodes;
}

// Shared by the Worker and ReactMarkdown fallback; contains no Work state or DOM access.
export function rehypeFileReferences() {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      if (node.type === "element") {
        if (node.tagName === "a") {
          const href = node.properties.href;
          if (typeof href === "string") {
            try {
              const path = fileReference(decodeURIComponent(stripFileLocator(href.split(/[?#]/u)[0] ?? "")), true);
              if (path) node.properties.dataFilePath = path;
            } catch {
              /* Malformed URL escapes remain inert. */
            }
          }
          return;
        }
        if (
          ["pre", "math", "svg", "script", "style"].includes(node.tagName) ||
          (Array.isArray(node.properties.className) &&
            node.properties.className.some((name) => name === "katex" || name === "katex-error"))
        )
          return;
        if (node.tagName === "code" && node.children.length === 1 && node.children[0]?.type === "text") {
          const label = node.children[0].value;
          const path = fileReference(stripFileLocator(label), false, true);
          if (path) {
            node.children = [referenceNode(label, path)];
            return;
          }
        }
      }
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && !(child.data && "transcriptRawHtml" in child.data)) return linkText(child.value);
        if (child.type === "element") visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}
