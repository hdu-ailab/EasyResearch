import { describe, expect, it } from "vitest";
import { FOLLOW_GLOBAL_ENTRY, readFollowGlobalFlag } from "./agent-follow-global";

describe("readFollowGlobalFlag", () => {
  const entry = (follow?: boolean): { type: string; customType?: string; data?: unknown } => ({
    type: "custom",
    customType: FOLLOW_GLOBAL_ENTRY,
    data: follow === undefined ? {} : { follow },
  });

  it("is false without any flag entry", () => {
    expect(readFollowGlobalFlag([])).toBe(false);
    expect(readFollowGlobalFlag([{ type: "custom", customType: "easyresearch:agent_model", data: {} }])).toBe(false);
  });

  it("is true when a flag entry exists (defaults to true for legacy shape)", () => {
    expect(readFollowGlobalFlag([entry()])).toBe(true);
    expect(readFollowGlobalFlag([entry(true)])).toBe(true);
  });

  it("follows the latest entry and clears when follow:false is appended", () => {
    expect(readFollowGlobalFlag([entry(true), entry(false)])).toBe(false);
    expect(readFollowGlobalFlag([entry(false), entry(true)])).toBe(true);
  });
});
