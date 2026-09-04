import { describe, expect, it } from "vitest";
import { summarizeWorkSamples } from "./probe";

describe("summarizeWorkSamples", () => {
  it("reports frame percentiles, long tasks, blanks, and bounded rows", () => {
    expect(
      summarizeWorkSamples({
        frameGaps: [10, 20, 30, 40],
        longTasks: [55, 70],
        blankSamples: 0,
        mountedRows: [18, 24, 22],
        stableRowReplacements: 0,
        stableMarkdownReplacements: 0,
      }),
    ).toEqual({
      rafP50Ms: 30,
      rafP95Ms: 40,
      rafP99Ms: 40,
      rafGapsOver33Ms: 1,
      rafGapsOver50Ms: 0,
      longTaskCount: 2,
      longTaskTimeMs: 125,
      blankSamples: 0,
      maxMountedRows: 24,
      stableRowReplacements: 0,
      stableMarkdownReplacements: 0,
    });
  });
});
