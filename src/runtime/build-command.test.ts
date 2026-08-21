import { describe, expect, it } from "vitest";
import { compileCommand, TARGETS } from "../../scripts/build";

describe("compiled release command", () => {
  it("reuses the selected Bun executable without a PATH lookup", () => {
    const target = TARGETS.find((candidate) => candidate.name === "windows-x64");
    expect(target).toBeDefined();

    const command = compileCommand(target!, "D:\\release\\easyresearch.exe", "D:\\tools\\bun.exe");
    expect(command[0]).toBe("D:\\tools\\bun.exe");
    expect(command).toEqual(expect.arrayContaining([
      "build",
      "--compile",
      "--target",
      target!.target,
      "--outfile",
      "D:\\release\\easyresearch.exe",
    ]));
    expect(command).not.toContain("bun");
  });
});
