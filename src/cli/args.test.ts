import { describe, expect, it } from "vitest";
import { parseArgs } from "./args";

describe("parseArgs", () => {
  it("returns help for empty argv", () => {
    expect(parseArgs([])).toEqual({ command: "help", positionals: [], flags: {} });
  });

  it("parses `new <topic>`", () => {
    expect(parseArgs(["new", "diffusion models"])).toEqual({
      command: "new",
      positionals: ["diffusion models"],
      flags: {},
    });
  });

  it("parses `run --auto`", () => {
    expect(parseArgs(["run", "--auto"])).toEqual({ command: "run", positionals: [], flags: { auto: true } });
  });

  it("parses flags with values", () => {
    expect(parseArgs(["web", "--port=8080"])).toEqual({
      command: "web",
      positionals: [],
      flags: { port: "8080" },
    });
  });

  it("parses space-separated values for known value flags", () => {
    expect(parseArgs(["web", "--port", "8080"])).toEqual({
      command: "web",
      positionals: [],
      flags: { port: "8080" },
    });
    expect(parseArgs(["run", "--model", "gpt-4o", "topic"])).toEqual({
      command: "run",
      positionals: ["topic"],
      flags: { model: "gpt-4o" },
    });
  });

  it("parses short flags", () => {
    expect(parseArgs(["run", "-c"])).toEqual({ command: "run", positionals: [], flags: { c: true } });
  });

  it("treats unknown first token as help", () => {
    expect(parseArgs(["frobnicate"])).toEqual({ command: "help", positionals: ["frobnicate"], flags: {} });
  });
});
