import { describe, expect, it } from "vitest";
import { parseDelimited, TABLE_LIMITS } from "./table-parser";

describe("delimited file parsing", () => {
  it("preserves quoted commas, doubled quotes, CRLF, BOM and trailing empty fields", () => {
    expect(parseDelimited('\uFEFFname,value,last\r\n"a,b","line 1\r\n""line 2""",\r\n', ",").rows).toEqual([
      ["name", "value", "last"],
      ["a,b", 'line 1\r\n"line 2"', ""],
    ]);
  });
  it("parses tabs, bare CR separators, blank rows and an empty quoted field", () => {
    expect(parseDelimited('a\tb\rc\t"d\te"\r\r""', "\t").rows).toEqual([["a", "b"], ["c", "d\te"], [""], [""]]);
    expect(parseDelimited("", ",").rows).toEqual([]);
    expect(parseDelimited(",", ",").rows).toEqual([["", ""]]);
  });
  it.each(['a,"unclosed', 'a,"closed"extra', 'a,un"quoted'])("labels malformed input %s", (content) => {
    expect(parseDelimited(content, ",").malformed).toBe(true);
  });
  it("retains wider body rows rather than dropping columns absent in the header", () => {
    const result = parseDelimited("a\nx,y,z", ",");
    expect(result.columns).toBe(3);
    expect(result.rows[1]).toEqual(["x", "y", "z"]);
  });
  it("bounds row, column, cell and input work with an explicit limit flag", () => {
    const rows = parseDelimited("x\n".repeat(TABLE_LIMITS.rows + 1), ",");
    expect(rows.rows).toHaveLength(TABLE_LIMITS.rows);
    expect(rows.limited).toBe(true);
    const wide = parseDelimited("x,".repeat(TABLE_LIMITS.columns + 1), ",");
    expect(wide.columns).toBeLessThanOrEqual(TABLE_LIMITS.columns);
    expect(wide.limited).toBe(true);
    const long = parseDelimited("x".repeat(TABLE_LIMITS.characters + 1), ",");
    expect(long.limited).toBe(true);
    expect(long.rows[0]?.[0]?.length ?? 0).toBeLessThanOrEqual(TABLE_LIMITS.cellCharacters);
    const cells = parseDelimited(`${"x,".repeat(199)}x\n`.repeat(1000), ",");
    expect(cells.rows.reduce((sum, row) => sum + row.length, 0)).toBeLessThanOrEqual(TABLE_LIMITS.cells);
    expect(cells.limited).toBe(true);
  });
});
