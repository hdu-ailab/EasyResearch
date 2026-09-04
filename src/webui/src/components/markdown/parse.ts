import type { Root } from "hast";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { removePosition } from "unist-util-remove-position";
import type { MarkdownWorkerBlock } from "./protocol";

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkRehype).use(rehypeKatex);

function hexadecimal(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function signature(tree: Root): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(tree));
  return hexadecimal(await crypto.subtle.digest("SHA-256", bytes));
}

export async function parseMarkdownBlocks(source: string): Promise<MarkdownWorkerBlock[]> {
  if (!source) return [];
  const parsed = processor.parse(source);
  const rendered = (await processor.run(parsed)) as Root;
  removePosition(rendered, { force: true });
  return Promise.all(
    rendered.children.map(async (child) => {
      const tree: Root = { type: "root", children: [child] };
      return { signature: await signature(tree), tree };
    }),
  );
}
