/** Dependency-free policy shared by the renderer and the Desktop preference boundary. */
export const TIMELINE_CATEGORIES = ["shell", "edit", "thinking", "subagents", "notices", "tools"] as const;

export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];
export type TimelinePlacement = "hidden" | "grouped" | "separate";
export type TimelineExpansion = "collapsed" | "expanded";
export type TimelineDetail = Record<TimelineCategory, { placement: TimelinePlacement; details: TimelineExpansion }>;

function uniformDetail(placement: TimelinePlacement, details: TimelineExpansion): TimelineDetail {
  return Object.fromEntries(
    TIMELINE_CATEGORIES.map((category) => [category, { placement, details }]),
  ) as TimelineDetail;
}

export const TIMELINE_PRESETS = [
  { id: "everything", value: uniformDetail("separate", "expanded") },
  {
    id: "detailed",
    value: {
      ...uniformDetail("grouped", "collapsed"),
      shell: { placement: "separate", details: "expanded" },
      edit: { placement: "separate", details: "expanded" },
      subagents: { placement: "separate", details: "collapsed" },
    },
  },
  { id: "compact", value: uniformDetail("grouped", "collapsed") },
  {
    id: "quiet",
    value: {
      ...uniformDetail("hidden", "collapsed"),
      edit: { placement: "grouped", details: "collapsed" },
      subagents: { placement: "grouped", details: "collapsed" },
    },
  },
  { id: "text-only", value: uniformDetail("hidden", "collapsed") },
] as const satisfies readonly {
  id: "everything" | "detailed" | "compact" | "quiet" | "text-only";
  value: TimelineDetail;
}[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Complete, known categories and exact fields only; safe for the narrow Desktop bridge. */
export function isTimelineDetail(value: unknown): value is TimelineDetail {
  if (!isRecord(value) || Object.keys(value).length !== TIMELINE_CATEGORIES.length) return false;
  return TIMELINE_CATEGORIES.every((category) => {
    if (!Object.hasOwn(value, category)) return false;
    const row = value[category];
    return (
      isRecord(row) &&
      Object.keys(row).length === 2 &&
      Object.hasOwn(row, "placement") &&
      Object.hasOwn(row, "details") &&
      (row.placement === "hidden" || row.placement === "grouped" || row.placement === "separate") &&
      (row.details === "collapsed" || row.details === "expanded")
    );
  });
}

export function cloneTimelineDetail(value: TimelineDetail): TimelineDetail {
  return Object.fromEntries(
    TIMELINE_CATEGORIES.map((category) => [category, { ...value[category] }]),
  ) as TimelineDetail;
}

export function parseTimelineDetail(value: unknown): TimelineDetail | undefined {
  return isTimelineDetail(value) ? cloneTimelineDetail(value) : undefined;
}

/** Hidden disclosure defaults do not change the visible preset, matching the V2 control. */
export function getTimelinePreset(value: TimelineDetail) {
  return TIMELINE_PRESETS.find((preset) =>
    TIMELINE_CATEGORIES.every(
      (category) =>
        value[category].placement === preset.value[category].placement &&
        (value[category].placement === "hidden" || value[category].details === preset.value[category].details),
    ),
  );
}

export function getTimelineDetail(preferences: {
  timelineDetail?: TimelineDetail;
  autoExpandThinking?: boolean;
  autoExpandTools?: boolean;
  expandSubagentOutput?: boolean;
}): TimelineDetail {
  // An explicit new policy is authoritative; malformed new data must not resurrect old choices.
  if (preferences.timelineDetail !== undefined) {
    return isTimelineDetail(preferences.timelineDetail)
      ? preferences.timelineDetail
      : uniformDetail("grouped", "collapsed");
  }
  const value = uniformDetail("grouped", "collapsed");
  if (preferences.autoExpandThinking === true) value.thinking = { placement: "separate", details: "expanded" };
  if (preferences.autoExpandTools === true) {
    for (const category of ["shell", "edit", "tools"] as const) {
      value[category] = { placement: "separate", details: "expanded" };
    }
  }
  if (preferences.expandSubagentOutput === true) value.subagents = { placement: "separate", details: "expanded" };
  return value;
}
