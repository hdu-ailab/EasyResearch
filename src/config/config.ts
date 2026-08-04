export interface LazyResearchConfig {
  /** Default model for the orchestrator, e.g. "anthropic/claude-opus-4-5" */
  model?: string;
  /** Thinking level for the orchestrator */
  thinkingLevel?: string;
  /** Experiment execution mode: "local" or "remote" (default: local) */
  experimentMode?: "local" | "remote";
  /** Behavior flags */
  flags?: {
    /** Ask for quality checkpoints between pipeline stages */
    confirmCheckpoints?: boolean;
    /** Auto-continue without asking (batch) */
    auto?: boolean;
  };
}

export const DEFAULT_CONFIG: LazyResearchConfig = {
  experimentMode: "local",
  flags: {
    confirmCheckpoints: true,
    auto: false,
  },
};

export function sanitizeConfig(raw: unknown): LazyResearchConfig {
  const cfg = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== "object") return cfg;
  const r = raw as Record<string, unknown>;
  if (typeof r.model === "string" && r.model.trim()) cfg.model = r.model.trim();
  if (typeof r.thinkingLevel === "string" && r.thinkingLevel.trim()) cfg.thinkingLevel = r.thinkingLevel.trim();
  if (r.experimentMode === "remote") cfg.experimentMode = "remote";
  if (r.flags && typeof r.flags === "object") {
    const f = r.flags as Record<string, unknown>;
    if (typeof f.confirmCheckpoints === "boolean") cfg.flags!.confirmCheckpoints = f.confirmCheckpoints;
    if (typeof f.auto === "boolean") cfg.flags!.auto = f.auto;
  }
  return cfg;
}
