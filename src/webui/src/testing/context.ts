import type { ContextItemDto, ContextPreviewDto, ContextSnapshotDto } from "../../../web/context-contracts";

export function contextSnapshot(revision = "r1"): ContextSnapshotDto {
  const definitions = [
    ["system", "system", "system", "Private system instruction", 100],
    ["user", "user", "user", "Inspect the experiment", 100],
    ["thought", "first", "thinking", "Check evidence first", 100],
    ["call", "first", "tool-call", "read evidence.json", 100],
    ["result", "first", "tool-result", "Evidence output", 400],
    ["answer", "first", "assistant", "Evidence checked", 100],
    ["later", "second", "assistant", "Later assistant interval", 100],
  ] as const;
  const items: ContextItemDto[] = definitions.map(([id, segmentId, type, preview, tokens]) => ({
    id,
    segmentId,
    type,
    preview,
    tokens,
    percent: tokens / 10,
    segmentPercent: segmentId === "first" ? tokens / 7 : 100,
    canFold: type === "tool-result",
    canDelete: type !== "system" && type !== "user",
    folded: false,
    relatedIds: id === "call" ? ["result"] : id === "result" ? ["call"] : [],
    ...(type === "tool-call" || type === "tool-result" ? { toolName: "read" } : {}),
  }));
  return {
    sessionId: "s1",
    revision,
    busy: false,
    estimated: true,
    contextWindow: 10000,
    totalTokens: 1000,
    remainingTokens: 9000,
    segments: [
      {
        id: "system",
        type: "system",
        preview: "Private system instruction",
        tokens: 100,
        percent: 10,
        itemIds: ["system"],
        canFold: false,
        canDelete: false,
      },
      {
        id: "user",
        type: "user",
        preview: "Inspect the experiment",
        tokens: 100,
        percent: 10,
        itemIds: ["user"],
        canFold: false,
        canDelete: false,
      },
      {
        id: "first",
        type: "assistant",
        preview: "Evidence checked",
        tokens: 700,
        percent: 70,
        itemIds: ["thought", "call", "result", "answer"],
        canFold: true,
        canDelete: true,
      },
      {
        id: "second",
        type: "assistant",
        preview: "Later assistant interval",
        tokens: 100,
        percent: 10,
        itemIds: ["later"],
        canFold: false,
        canDelete: true,
      },
    ],
    items,
  };
}
export function contextPreview(
  changes: ContextPreviewDto["changes"] = [{ itemId: "result", action: "fold" }],
): ContextPreviewDto {
  return {
    revision: "r1",
    beforeTokens: 1000,
    afterTokens: 607,
    removedTokens: 393,
    remainingTokens: 9393,
    cache: { basis: "unchanged-prefix", hitRate: 0.321, reusableTokens: 195 },
    changes,
    segments: [{ id: "first", afterTokens: 307 }],
  };
}
