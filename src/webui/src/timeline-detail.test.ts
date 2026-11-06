import { describe, expect, it } from "vitest";
import {
  cloneTimelineDetail,
  getTimelineDetail,
  getTimelinePreset,
  isTimelineDetail,
  parseTimelineDetail,
  TIMELINE_CATEGORIES,
  TIMELINE_PRESETS,
  type TimelineDetail,
} from "./timeline-detail";

describe("timeline detail policy", () => {
  it("starts compact and gives independent defaults to callers and categories", () => {
    const first = getTimelineDetail({});
    const second = getTimelineDetail({});
    expect(getTimelinePreset(first)?.id).toBe("compact");
    first.shell.details = "expanded";
    expect(first.edit.details).toBe("collapsed");
    expect(second.shell.details).toBe("collapsed");
    expect(getTimelinePreset(getTimelineDetail({}))?.id).toBe("compact");
  });

  it.each(
    [false, true].flatMap((autoExpandThinking) =>
      [false, true].flatMap((autoExpandTools) =>
        [false, true].map((expandSubagentOutput) => ({ autoExpandThinking, autoExpandTools, expandSubagentOutput })),
      ),
    ),
  )("migrates independent legacy choices: %j", (legacy) => {
    const value = getTimelineDetail(legacy);
    for (const category of TIMELINE_CATEGORIES) {
      const expanded =
        category === "thinking"
          ? legacy.autoExpandThinking
          : category === "subagents"
            ? legacy.expandSubagentOutput
            : category === "notices"
              ? false
              : legacy.autoExpandTools;
      expect(value[category]).toEqual({
        placement: expanded ? "separate" : "grouped",
        details: expanded ? "expanded" : "collapsed",
      });
    }
  });

  it("uses the complete new policy ahead of old flags", () => {
    const value = cloneTimelineDetail(TIMELINE_PRESETS[4].value);
    expect(
      getTimelineDetail({
        timelineDetail: value,
        autoExpandThinking: true,
        autoExpandTools: true,
        expandSubagentOutput: true,
      }),
    ).toEqual(value);
  });

  it("does not resurrect legacy expansion when an explicit new policy is corrupt", () => {
    expect(getTimelineDetail({ timelineDetail: null as unknown as TimelineDetail, autoExpandThinking: true })).toEqual(
      getTimelineDetail({}),
    );
  });

  it.each(TIMELINE_PRESETS)("round-trips the $id preset without sharing mutable rows", ({ id, value }) => {
    const parsed = parseTimelineDetail(JSON.parse(JSON.stringify(value)))!;
    expect(parsed).toEqual(value);
    expect(getTimelinePreset(parsed)?.id).toBe(id);
    for (const category of TIMELINE_CATEGORIES) expect(parsed[category]).not.toBe(value[category]);
  });

  it("matches hidden categories regardless of their dormant disclosure default", () => {
    const value = cloneTimelineDetail(TIMELINE_PRESETS[4].value);
    value.thinking.details = "expanded";
    expect(getTimelinePreset(value)?.id).toBe("text-only");
    value.thinking.placement = "separate";
    expect(getTimelinePreset(value)).toBeUndefined();
  });

  it.each([
    null,
    [],
    false,
    "compact",
    {},
    { ...getTimelineDetail({}), tools: undefined },
    { ...getTimelineDetail({}), future: { placement: "grouped", details: "collapsed" } },
    { ...getTimelineDetail({}), shell: { placement: "grouped" } },
    { ...getTimelineDetail({}), shell: { placement: "grouped", details: "collapsed", token: "unsupported" } },
    { ...getTimelineDetail({}), shell: { placement: "future", details: "collapsed" } },
    { ...getTimelineDetail({}), shell: { placement: "grouped", details: true } },
    { ...getTimelineDetail({}), shell: null },
    { ...getTimelineDetail({}), shell: [] },
  ])("rejects incomplete or unsupported policy data: %j", (candidate) => {
    expect(isTimelineDetail(candidate)).toBe(false);
    expect(parseTimelineDetail(candidate)).toBeUndefined();
  });

  it("requires own category fields, even for non-JSON callers", () => {
    const inherited = Object.create(getTimelineDetail({}));
    expect(isTimelineDetail(inherited)).toBe(false);
  });
});
