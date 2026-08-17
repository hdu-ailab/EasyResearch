import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../runtime/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  COLLAPSED_LINE_MAX_CHARS,
  DDGR_INSTALL_HINT,
  buildDdgrArgs,
  compactLine,
  formatResults,
  parseDdgrJson,
  requestSearch,
  resolveDdgrCommand,
  serialize,
  textContent,
  truncateOutput,
  webSearchTool,
  type SearchResult,
  type SpawnFn,
} from "./index";

describe("search tool definition (ADR-031 as amended by ADR-038/079)", () => {
  it("is named web-search", () => {
    expect(webSearchTool.name).toBe("web-search");
  });

  it("declares query required and num/site/time optional", () => {
    const schema = webSearchTool.parameters as {
      type: string;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["query"]);
    const properties = schema.properties ?? {};
    expect(properties).toHaveProperty("query");
    expect(properties).toHaveProperty("num");
    expect(properties).toHaveProperty("site");
    expect(properties).toHaveProperty("time");
  });
});

describe("buildDdgrArgs", () => {
  it("uses --json with num and no --noua when masked", () => {
    expect(buildDdgrArgs({ query: "hello world", num: 5 }, true)).toEqual(["--json", "-n", "5", "hello world"]);
  });

  it("adds --noua for the unmasked run", () => {
    const argv = buildDdgrArgs({ query: "hi", num: 5 }, false);
    expect(argv).toContain("--noua");
    expect(argv).not.toContain("-w");
  });

  it("maps site and time filters, normalizing the site to a bare domain", () => {
    const argv = buildDdgrArgs(
      { query: "q", num: 3, site: "https://github.com/foo/bar", time: "m" },
      false,
    );
    expect(argv).toContain("-w");
    expect(argv).toContain("github.com");
    expect(argv).toContain("-t");
    expect(argv).toContain("m");
  });

  it("keeps the query intact when no filters are present", () => {
    expect(buildDdgrArgs({ query: "a b c", num: 10 }, true)).toEqual(["--json", "-n", "10", "a b c"]);
  });
});

describe("parseDdgrJson", () => {
  it("parses ddgr JSON results", () => {
    const expected: SearchResult[] = [{ title: "T", url: "https://u", abstract: "A" }];
    expect(parseDdgrJson(JSON.stringify(expected))).toEqual(expected);
  });

  it("returns an empty array for an empty result set", () => {
    expect(parseDdgrJson("[]")).toEqual([]);
  });

  it("returns undefined for unparseable or malformed output", () => {
    expect(parseDdgrJson("not json")).toBeUndefined();
    expect(parseDdgrJson('{"a":1}')).toBeUndefined();
    expect(parseDdgrJson('[{"title":1,"url":"u","abstract":"a"}]')).toBeUndefined();
  });
});

describe("resolveDdgrCommand", () => {
  it("prefers the venv binary on posix", () => {
    const exists = (path: string) => path === "/agent/venv/bin/ddgr";
    expect(resolveDdgrCommand("/agent", "linux", exists)).toBe("/agent/venv/bin/ddgr");
  });

  it("uses the Scripts layout on win32", () => {
    const exists = (path: string) => path.endsWith("ddgr.exe");
    expect(resolveDdgrCommand("C:\\agent", "win32", exists)!.replace(/\\/g, "/")).toBe(
      "C:/agent/venv/Scripts/ddgr.exe",
    );
  });

  it("returns undefined when the venv binary is missing", () => {
    expect(resolveDdgrCommand("/agent", "linux", () => false)).toBeUndefined();
  });
});

describe("requestSearch", () => {
  function jsonResults(results: SearchResult[]): string {
    return JSON.stringify(results);
  }

  it("returns results from the first unmasked run", async () => {
    const calls: Array<{ args: string[]; command: string }> = [];
    const spawnFn: SpawnFn = async (command, args) => {
      calls.push({ command, args });
      return {
        status: 0,
        stdout: jsonResults([{ title: "T", url: "https://u", abstract: "A" }]),
        stderr: "",
      };
    };
    const results = await requestSearch("ddgr", { query: "q", num: 5 }, undefined, undefined, spawnFn);
    expect(results).toEqual([{ title: "T", url: "https://u", abstract: "A" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("--noua");
  });

  it("falls back to the masked browser-UA run when the plain run fails", async () => {
    const calls: string[][] = [];
    const spawnFn: SpawnFn = async (_command, args) => {
      calls.push(args);
      if (calls.length === 1) return { status: 1, stdout: "", stderr: "DuckDuckGo is blocking us" };
      return { status: 0, stdout: jsonResults([{ title: "T", url: "https://u", abstract: "A" }]), stderr: "" };
    };
    const results = await requestSearch("ddgr", { query: "q", num: 5 }, undefined, undefined, spawnFn);
    expect(results).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--noua");
    expect(calls[1]).not.toContain("--noua");
  });

  it("treats an empty JSON result set as no results after one run", async () => {
    const spawnFn: SpawnFn = async () => ({ status: 0, stdout: "[]", stderr: "" });
    const results = await requestSearch("ddgr", { query: "q", num: 5 }, undefined, undefined, spawnFn);
    expect(results).toBeNull();
  });

  it("counts one failure per attempt when both UA modes fail and throws after three attempts", async () => {
    const calls: string[][] = [];
    const spawnFn: SpawnFn = async (_command, args) => {
      calls.push(args);
      return { status: 1, stdout: "", stderr: "blocked" };
    };
    await expect(
      requestSearch("ddgr", { query: "q", num: 5 }, undefined, undefined, spawnFn, [0, 0, 0]),
    ).rejects.toThrow(/3 serial attempts failed/);
    expect(calls).toHaveLength(6);
    expect(calls.filter((args) => args.includes("--noua"))).toHaveLength(3);
    expect(calls.filter((args) => !args.includes("--noua"))).toHaveLength(3);
  });

  it("retries the masked run when the plain run produces unparseable output", async () => {
    const calls: string[][] = [];
    const spawnFn: SpawnFn = async (_command, args) => {
      calls.push(args);
      if (calls.length === 1) return { status: 0, stdout: "garbage", stderr: "" };
      return { status: 0, stdout: jsonResults([{ title: "T", url: "https://u", abstract: "A" }]), stderr: "" };
    };
    const results = await requestSearch("ddgr", { query: "q", num: 5 }, undefined, undefined, spawnFn);
    expect(results).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("bails out with an install hint when ddgr is missing (ENOENT)", async () => {
    const spawnFn: SpawnFn = async () => {
      const error = new Error("spawn ddgr ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };
    await expect(requestSearch("ddgr", { query: "q", num: 5 }, undefined, undefined, spawnFn)).rejects.toThrow(
      DDGR_INSTALL_HINT,
    );
  });
});

describe("compactLine", () => {
  it("keeps short lines unchanged", () => {
    expect(compactLine("  hello   world ")).toBe("hello world");
  });

  it("truncates long lines with an ellipsis", () => {
    const long = "x".repeat(COLLAPSED_LINE_MAX_CHARS + 50);
    const compact = compactLine(long);
    expect(compact).toHaveLength(COLLAPSED_LINE_MAX_CHARS);
    expect(compact.endsWith("…")).toBe(true);
  });
});

describe("textContent", () => {
  it("joins only text items", () => {
    const result = {
      content: [
        { type: "text", text: "a" },
        { type: "tool_use", text: "ignored" },
        { type: "text", text: "b" },
        { type: "text" },
      ],
    };
    expect(textContent(result)).toBe("a\nb");
  });
});

describe("serialize", () => {
  it("runs concurrent operations one at a time", async () => {
    const order: string[] = [];
    const first = serialize(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("first");
      return 1;
    });
    const second = serialize(async () => {
      order.push("second");
      return 2;
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("formatResults", () => {
  it("formats results with numbering and fields", () => {
    const output = formatResults([
      { title: "T1", url: "https://u1", abstract: "A1" },
      { title: "T2", url: "https://u2", abstract: "A2" },
    ]);
    expect(output).toContain("Result 1\nTitle: T1\nURL: https://u1\nAbstract: A1");
    expect(output).toContain("Result 2");
  });
});

describe("truncateOutput", () => {
  it("keeps short output untouched", async () => {
    const result = await truncateOutput("short output");
    expect(result.text).toBe("short output");
    expect(result.fullOutputPath).toBeUndefined();
  });

  it("writes a temp file and appends a notice when truncated", async () => {
    const big = Array.from({ length: 10_000 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n");
    const result = await truncateOutput(big);
    expect(result.fullOutputPath).toBeDefined();
    expect(result.text).toContain("[Output truncated:");
    expect(result.text).toContain("Full output saved to:");
    const written = readFileSync(result.fullOutputPath!, "utf8");
    expect(written).toBe(big);
  });
});