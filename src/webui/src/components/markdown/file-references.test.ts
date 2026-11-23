import type { Root } from "hast";
import { describe, expect, it } from "vitest";
import { parseFileReference, resolveTranscriptFilePath } from "./file-references";
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
  it("distinguishes authored fragments from encoded leading hash filename bytes", async () => {
    expect(await references("[Open](%23report.txt) [literal](%2523report.txt) [fragment](#report.txt)")).toEqual([
      "#report.txt",
      "%23report.txt",
    ]);
    expect(resolveTranscriptFilePath("/p", "#report.txt", true)).toBe("/p/#report.txt");
  });
  it.each([
    ["src/main.ts:24:8", false, "src/main.ts", { start: 24, end: 24 }],
    ["README:30-12", false, "README", { start: 12, end: 30 }],
    ["src/main.ts#L42C8-L45C2", false, "src/main.ts", { start: 42, end: 45 }],
    ["file:///tmp/a%2520b%23L12#L3", true, "/tmp/a%20b#L12", { start: 3, end: 3 }],
    ["file://localhost/C:/Research%20Data/a.txt:9", true, "C:/Research Data/a.txt", { start: 9, end: 9 }],
    ["file:///tmp/%E6%8A%A5%E5%91%8A.txt#L2", false, "/tmp/报告.txt", { start: 2, end: 2 }],
    ["data%3A12%23L4", true, "data:12#L4", undefined],
    ["a.txt:1000001", false, "a.txt", undefined],
    ["a.txt:0", false, "a.txt", undefined],
  ])("parses bounded locators before explicit URL decoding: %s", (input, explicit, path, selection) => {
    expect(parseFileReference(input as string, explicit as boolean)).toEqual({ path, selection });
  });
  it("recognizes extensionless names and every local extension without a preview allowlist", async () => {
    expect(
      await references("`README` `LICENSE` `Dockerfile` `Makefile` `.env` `model.unusual` [unknown](opaque)"),
    ).toEqual(["README", "LICENSE", "Dockerfile", "Makefile", ".env", "model.unusual", "opaque"]);
  });
  it("never recognizes glob expressions or references inside inline raw HTML", async () => {
    expect(await references("`src/?.ts` `src/[ab].ts` `src/{a,b}.ts` <span>README `src/main.ts`</span>")).toEqual([]);
  });
  it("admits numeric, Unicode and long extensions as existence candidates", async () => {
    expect(await references("`archive.7z` `报告.数据` `model.verylongcustomextension` `object.value` `v1.2`")).toEqual([
      "archive.7z",
      "报告.数据",
      "model.verylongcustomextension",
      "object.value",
      "v1.2",
    ]);
  });
  it("keeps complete commands and Skill invocations distinct from file actions", async () => {
    const source = [
      "`python experiments/train.py`",
      "`npm run check:web`",
      "`bun scripts/build.ts`",
      "`git diff src/main.ts`",
      "`cat report.md`",
      "`/usr/bin/python report.py`",
      "`./run.sh --input data.csv`",
      "`/skill:paper-search papers/topic.md`",
      "`/compact summarize results/report.md`",
      "`value = results/table.csv`",
      "`pdflatex manuscript/main.tex`",
      "`latexmk manuscript/main.tex`",
      "`tar xf results.tar`",
      '`pd.read_csv("results/table.csv")`',
      "`custom-runner experiments/train.py`",
    ].join("\n\n");
    expect(await references(source)).toEqual([]);
    expect(
      await references(
        "`results/my report.md` [script](scripts/run.sh) `./src/main.ts` `/Research Papers/paper.md` `results/R&D.md`",
      ),
    ).toEqual([
      "results/my report.md",
      "scripts/run.sh",
      "./src/main.ts",
      "/Research Papers/paper.md",
      "results/R&D.md",
    ]);
  });

  it("preserves quotes within standalone filenames without turning quoted commands into paths", async () => {
    expect(
      await references(
        '`./results/author\'s report.md` `results/a"b.md` `cat "results/report.md"` `pd.read_csv("results/table.csv")`',
      ),
    ).toEqual(["./results/author's report.md", 'results/a"b.md']);
  });

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
      "https://example.com/paper.pdf /compact ~/notes.md $HOME/notes.md user@example.com",
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
