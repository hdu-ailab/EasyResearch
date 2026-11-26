import type { Element, Root, RootContent } from "hast";

const excluded = new Set(["pre", "code", "math", "svg", "script", "style"]);

/** Decorate prose leaves only. Code, KaTeX and escaped HTML retain their original
 * semantic trees. Offsets are presentation-local UTF-16 indices, not source spans. */
export function prepareTextNodes(tree: Root): { tree: Root; prose: string } {
  let prose = "";
  const visit = (node: RootContent): RootContent => {
    if (node.type === "text") {
      if (node.data && "transcriptRawHtml" in node.data) return node;
      const start = prose.length;
      prose += node.value;
      if (!/\S/u.test(node.value)) return node;
      return {
        type: "element",
        tagName: "span",
        properties: { dataMarkdownText: start },
        children: [node],
      };
    }
    if (node.type !== "element") return node;
    if (
      excluded.has(node.tagName) ||
      (Array.isArray(node.properties.className) &&
        node.properties.className.some((name) => /^katex(?:-|$)/u.test(String(name))))
    )
      return node;
    return { ...node, children: node.children.map(visit) } as Element;
  };
  return { tree: { ...tree, children: tree.children.map(visit) }, prose };
}

/** The synchronous renderer uses the same decoration after its existing parser.
 * This synthetic span is a React-only boundary; it never wraps block DOM in a span. */
export function rehypeTextMotion() {
  return (tree: Root) => {
    const prepared = prepareTextNodes(tree);
    tree.children = [
      {
        type: "element",
        tagName: "span",
        properties: { dataMarkdownProse: prepared.prose },
        children: prepared.tree.children as Element["children"],
      },
    ];
  };
}
