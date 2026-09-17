import type { Root } from "hast";
import { describe, expect, it } from "vitest";
import { resolveTranscriptFilePath } from "./file-references";
import { parseMarkdownBlocks } from "./parse";

async function references(source: string): Promise<string[]> {
  const paths: string[] = [];
  const visit = (node: Root | Root["children"][number]) => {
    if (node.type === "element" && typeof node.properties.dataFilePath === "string") {
      paths.push(node.properties.dataFilePath);
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  for (const block of await parseMarkdownBlocks(source)) visit(block.tree);
  return paths;
}

describe("transcript file references", () => {
  it("handles bare filename locators without treating them as URI schemes", async () => {
    expect(await references("README.md:12 `README.md:12:3` [read](README.md:12) [bad](javascript:123)")).toEqual([
      "README.md",
      "README.md",
      "README.md",
    ]);
  });

  it("never opens Markdown-unescaped single-backslash UNC text as a project-relative file", async () => {
    expect(await references(String.raw`Read \\server\share\paper.pdf and [file](<\\server\share\paper.pdf>)`)).toEqual(
      [],
    );
    expect(resolveTranscriptFilePath("C:\\Papers\\Project", "\\server\\share\\paper.pdf")).toBeNull();
  });

  it("preserves URL-encoded locator-shaped filename bytes", async () => {
    const paths = await references("[hash](results/report.md%23L12) [colon](results/report.md%3A12)");
    expect(paths).toEqual(["results/report.md#L12", "results/report.md:12"]);
    expect(paths.map((path) => resolveTranscriptFilePath("/papers", path))).toEqual([
      "/papers/results/report.md#L12",
      "/papers/results/report.md:12",
    ]);
  });

  it("keeps malformed formulas out of path recognition", async () => {
    expect(await references(String.raw`$\frac{results/table.csv}$ $results/table.csv}$`)).toEqual([]);
  });

  it("recognizes prose and inline paths without including surrounding punctuation or line locators", async () => {
    expect(await references("Read README.md, (results/table.csv), `./src/main.ts:42:3` and ../notes.txt.")).toEqual([
      "README.md",
      "results/table.csv",
      "./src/main.ts",
      "../notes.txt",
    ]);
  });

  it("preserves quoted spaces, Unicode, literal percent/hash bytes, and host-native absolute paths", async () => {
    expect(
      await references(
        '"results/my report.md" `/tmp/\u62a5\u544a.md` `C:\\Research Data\\paper.md` `\\\\server\\share\\paper.pdf` `results/a%20b#draft.md`',
      ),
    ).toEqual([
      "results/my report.md",
      "/tmp/\u62a5\u544a.md",
      "C:\\Research Data\\paper.md",
      "\\\\server\\share\\paper.pdf",
      "results/a%20b#draft.md",
    ]);
  });

  it("supports grouped filenames with spaces without interpreting prose ratios as paths", async () => {
    expect(
      await references(
        'Read "my report.md" or `draft final.md`; input/output and 1/2 stay text. `src/Makefile` is a path.',
      ),
    ).toEqual(["my report.md", "draft final.md", "src/Makefile"]);
  });

  it("resolves explicit Markdown destinations rather than their labels, decoding only destinations", async () => {
    expect(
      await references("[paper](results/my%20report.md#intro) [file](<C:\\Papers\\draft.md>) [license](LICENSE)"),
    ).toEqual(["results/my report.md", "C:\\Papers\\draft.md", "LICENSE"]);
  });

  it("does not turn URLs, commands, formulas, fenced code, or unsafe targets into file actions", async () => {
    const source = [
      "https://example.com/paper.pdf /compact ~/notes.md $HOME/notes.md user@example.com v1.2",
      "[web](https://example.com/a.md) [relative web](//example.com/a.md) [bad](javascript:alert) [fragment](#intro)",
      "$\\text{results/table.csv}$",
      "```text\nresults/table.csv\n```",
      "```mermaid\ngraph TD; A[results/table.csv]-->B\n```",
    ].join("\n\n");
    expect(await references(source)).toEqual([]);
  });

  it("recognizes multiple paths in table cells without nesting actions in explicit links", async () => {
    expect(
      await references(
        "| Files |\n| --- |\n| results/a.csv and `results/b.csv` |\n\n[results/label.csv](results/target.csv)",
      ),
    ).toEqual(["results/a.csv", "results/b.csv", "results/target.csv"]);
  });

  it.each([
    ["/papers/project", "results/./table.csv", "/papers/project/results/table.csv"],
    ["/papers/project", "../notes.txt", "/papers/notes.txt"],
    ["/papers/project", "/outside/report.md", "/outside/report.md"],
    ["/papers/project", "results/a%20b#draft.md", "/papers/project/results/a%20b#draft.md"],
    ["C:\\Papers\\Project", ".\\results/table.csv", "C:\\Papers\\Project\\results\\table.csv"],
    ["C:\\Papers\\Project", "D:\\Other\\report.md", "D:\\Other\\report.md"],
    ["\\\\server\\share\\project", "../draft.md", "\\\\server\\share\\draft.md"],
    ["/papers", "https://example.com/file.md", null],
    ["/papers", "//example.com/file.md", null],
    ["/papers", "~/file.md", null],
    ["/papers", "file.md\u0000", null],
  ])("resolves %s + %s against the session rather than the daemon cwd", (cwd, path, expected) => {
    expect(resolveTranscriptFilePath(cwd, path)).toBe(expected);
  });
});
