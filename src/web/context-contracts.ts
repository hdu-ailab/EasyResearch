/** Explicit root-session context inspection; never included in ordinary SSE/history. */
export type ContextItemType = "system" | "summary" | "user" | "thinking" | "tool-call" | "tool-result" | "assistant";
export type ContextSegmentType = "system" | "summary" | "user" | "assistant";

export interface ContextItemDto {
  id: string;
  segmentId: string;
  type: ContextItemType;
  toolName?: string;
  preview: string;
  tokens: number;
  percent: number;
  segmentPercent: number;
  canFold: boolean;
  canDelete: boolean;
  relatedIds: string[];
  folded: boolean;
}

export interface ContextSegmentDto {
  id: string;
  type: ContextSegmentType;
  preview: string;
  tokens: number;
  percent: number;
  itemIds: string[];
  canFold: boolean;
  canDelete: boolean;
}

export interface ContextSnapshotDto {
  sessionId: string;
  revision: string;
  busy: boolean;
  estimated: true;
  model?: { provider: string; id: string; name: string };
  contextWindow: number | null;
  totalTokens: number;
  remainingTokens: number | null;
  segments: ContextSegmentDto[];
  items: ContextItemDto[];
}

export interface ContextEditDto {
  target: "segment" | "item";
  id: string;
  /** reset discards pending changes for that scope, never rewrites history. */
  action: "fold" | "delete" | "reset";
}

export interface ContextEditRequestDto {
  revision: string;
  edits: ContextEditDto[];
}

export interface ContextPreviewDto {
  revision: string;
  beforeTokens: number;
  afterTokens: number;
  removedTokens: number;
  remainingTokens: number | null;
  cache: {
    basis: "unchanged-prefix";
    /** Fraction in [0,1], null when a useful prior-request baseline is absent. */
    hitRate: number | null;
    reusableTokens: number | null;
  };
  changes: Array<{ itemId: string; action: "fold" | "delete" }>;
  segments: Array<{ id: string; afterTokens: number }>;
}

export interface ContextItemTextDto {
  revision: string;
  itemId: string;
  view: "original" | "current";
  text: string;
  offset: number;
  totalChars: number;
  nextOffset: number | null;
}
