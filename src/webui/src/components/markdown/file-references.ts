import type { Element, Root, RootContent } from "hast";
import type { FileLineRange } from "../../../../web/file-reference-contracts";
import { isAbsoluteFilesystemPath, joinFilesystemPath, normalizeAbsoluteFilesystemPath } from "../../filesystem-path";
import { inlineCodeKind } from "./inline-code-kind";

const extensionless =
  /^(?:CHANGELOG|CODEOWNERS|Containerfile|Dockerfile|Gemfile|Justfile|LICENSE|Makefile|Procfile|README|Rakefile|Vagrantfile)$/u;

export interface ParsedFileReference {
  path: string;
  selection?: FileLineRange;
}

// Locator syntax and extensionless candidates follow the MIT-licensed V2 reference:
// anomalyco/opencode ee5fe34e136488a1839ac73bcca8321c51a31b75,
// packages/util/src/path.ts and session-ui/src/components/markdown-inline-code-kind.ts.
// Parsing is deliberately view/filesystem-free for Worker and synchronous parity.
export function parseFileReference(input: string, explicit = false): ParsedFileReference | null {
  const url = /^file:/iu.test(input);
  const encoded = explicit || url;
  let value = input;
  let selection: FileLineRange | undefined;
  const locator =
    /^(.*?)#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/iu.exec(value) ??
    /^(.*?):(\d+)(?::\d+)?(?:-(\d+)(?::\d+)?)?:?$/u.exec(value);
  if (locator && !/^[a-z]:?$/iu.test(locator[1] ?? "")) {
    const first = Number(locator[2]);
    const last = Number(locator[3] ?? locator[2]);
    value = locator[1] ?? "";
    if (first >= 1 && last >= 1 && first <= 1_000_000 && last <= 1_000_000) {
      selection = { start: Math.min(first, last), end: Math.max(first, last) };
    }
    // Do not reinterpret tel:123 (or arbitrary schemes) as a filename.
    if (
      /^[a-z][a-z\d+.-]*:/iu.test(input) &&
      !/^[a-z]:[\\/]/iu.test(input) &&
      !/^file:/iu.test(input) &&
      !/[.\\/]/u.test(value) &&
      !extensionless.test(value)
    )
      return null;
  }
  if (encoded) {
    if (/^[#?]/u.test(value) || value.startsWith("//")) return null;
    value = value.split(/[?#]/u)[0] ?? "";
    if (/^file:/iu.test(value)) {
      const match = /^file:\/\/(?:localhost)?(\/.*)$/iu.exec(value);
      if (!match) return null;
      value = (match[1] ?? "").replace(/^\/([a-z]:\/)/iu, "$1");
    }
    if (!fileReference(value.replace(/%5c/giu, "\\").replace(/%2f/giu, "/"), true)) return null;
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  const path = fileReference(value, explicit || url, true, encoded);
  return path ? { path, selection } : null;
}

export const isNetworkFileReference = (path: string) => /^[\\/]{2}/u.test(path);

function fileReference(path: string, explicit = false, grouped = false, literal = false): string | null {
  if (
    !path ||
    path !== path.trim() ||
    /[\p{Cc}<>|*]/u.test(path) ||
    /^[~$]/u.test(path) ||
    (!literal && path.startsWith("#")) ||
    path.startsWith("//") ||
    (!explicit && /[?[\]{}]/u.test(path)) ||
    /^\\(?!\\)/u.test(path) ||
    (!explicit && path.includes("@")) ||
    (!literal && /^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path))
  )
    return null;
  if (!path || /[\\/]$/u.test(path) || path === "." || path === "..") return null;
  if (explicit) return path;
  const filename = path.split(/[\\/]/u).at(-1) ?? "";
  if (extensionless.test(filename) && (grouped || !/\s/u.test(path))) return path;
  // Syntax only: numeric/Unicode/long extensions and dotted identifiers all go
  // through the same existence check instead of a format/extension allowlist.
  const hasFilename = /\p{L}/u.test(filename) && /^(?:\.[^.]+|.+\.[^.]+)$/u.test(filename);
  if (hasFilename && (grouped || !/\s/u.test(path))) return path;
  if (/^(?:\.{1,2}[\\/]|[a-z]:[\\/]|\\\\)/iu.test(path)) return path;
  if (/^\/[^/]+\//u.test(path)) return path;
  if (grouped && /^[^\s\\/]+[\\/].+/u.test(path) && !path.startsWith("/")) return path;
  return null;
}

export function resolveTranscriptFilePath(cwd: string, reference: string, literal = false): string | null {
  const path = fileReference(reference, true, false, literal);
  if (!path || !normalizeAbsoluteFilesystemPath(cwd)) return null;
  return normalizeAbsoluteFilesystemPath(isAbsoluteFilesystemPath(path) ? path : joinFilesystemPath(cwd, path));
}

function referenceNode(label: string, reference: ParsedFileReference): Element {
  return {
    type: "element",
    tagName: "a",
    properties: {
      dataFilePath: reference.path,
      dataFileAutomatic: "true",
      dataFileLineStart: reference.selection?.start,
      dataFileLineEnd: reference.selection?.end,
    },
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
    const reference = parseFileReference(label);
    if (!reference || !fileReference(reference.path, false, quoted !== undefined)) continue;
    const start = match.index + (quoted === undefined ? prefix : 1);
    if (start > offset) nodes.push({ type: "text", value: value.slice(offset, start) });
    nodes.push(referenceNode(label, reference));
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
            const reference = parseFileReference(href, true);
            if (reference) {
              node.properties.dataFilePath = reference.path;
              node.properties.dataFileLineStart = reference.selection?.start;
              node.properties.dataFileLineEnd = reference.selection?.end;
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
          const kind = inlineCodeKind(label);
          if (kind) {
            node.properties.dataInlineKind = kind;
            return;
          }
          if (/[{}=;|]/u.test(label) || /^[\w.$]+\s*\(/u.test(label) || /^(["'])[\s\S]*\1$/u.test(label)) return;
          const reference = parseFileReference(label);
          if (reference) {
            node.children = [referenceNode(label, reference)];
          }
          return;
        }
      }
      let rawDepth = 0;
      node.children = node.children.flatMap((child) => {
        const raw =
          "value" in child &&
          (child.type === "raw" || (child.type === "text" && child.data && "transcriptRawHtml" in child.data));
        if (raw && "value" in child) {
          // ReactMarkdown retains raw nodes; the Worker marks its inert text equivalent.
          // Neither the tag bytes nor Markdown nested between authored HTML tags are file candidates.
          for (const tag of child.value.matchAll(/<(\/?)([a-z][a-z\d-]*)\b[^>]*?(\/?)>/giu)) {
            if (tag[1]) rawDepth = Math.max(0, rawDepth - 1);
            else if (
              !tag[3] &&
              !/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/iu.test(tag[2] ?? "")
            )
              rawDepth++;
          }
          return [child];
        }
        if (rawDepth > 0) return [child];
        if (child.type === "text" && !(child.data && "transcriptRawHtml" in child.data)) return linkText(child.value);
        if (child.type === "element") visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}
