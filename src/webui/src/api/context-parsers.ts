import type {
  ContextItemDto,
  ContextItemTextDto,
  ContextPreviewDto,
  ContextSegmentDto,
  ContextSnapshotDto,
} from "../../../web/context-contracts";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid context response");
  return value as ObjectValue;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid context text");
  return value;
}
function identity(value: unknown): string {
  const result = text(value);
  if (!result.trim()) throw new Error("Invalid context identity");
  return result;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid context number");
  return value;
}
function nullable(value: unknown): number | null {
  return value === null ? null : number(value);
}
function percent(value: unknown): number {
  const result = number(value);
  if (result > 100) throw new Error("Invalid context share");
  return result;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid context flag");
  return value;
}
function array<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid context collection");
  return value.map(parse);
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error("Invalid context type");
  return value as T;
}
function preview(value: unknown): string {
  const result = text(value);
  if (Array.from(result).length > 240) throw new Error("Oversized context preview");
  return result;
}
function segment(value: unknown): ContextSegmentDto {
  const s = object(value);
  return {
    id: identity(s.id),
    type: choice(s.type, ["system", "summary", "user", "assistant"]),
    preview: preview(s.preview),
    tokens: number(s.tokens),
    percent: percent(s.percent),
    itemIds: array(s.itemIds, identity),
    canFold: boolean(s.canFold),
    canDelete: boolean(s.canDelete),
  };
}
function item(value: unknown): ContextItemDto {
  const s = object(value);
  return {
    id: identity(s.id),
    segmentId: identity(s.segmentId),
    type: choice(s.type, ["system", "summary", "user", "thinking", "tool-call", "tool-result", "assistant"]),
    ...(s.toolName === undefined ? {} : { toolName: text(s.toolName) }),
    preview: preview(s.preview),
    tokens: number(s.tokens),
    percent: percent(s.percent),
    segmentPercent: percent(s.segmentPercent),
    canFold: boolean(s.canFold),
    canDelete: boolean(s.canDelete),
    relatedIds: array(s.relatedIds, identity),
    folded: boolean(s.folded),
  };
}
export function parseContextSnapshot(value: unknown): ContextSnapshotDto {
  const s = object(value);
  if (s.estimated !== true) throw new Error("Invalid context estimate");
  const segments = array(s.segments, segment);
  const items = array(s.items, item);
  const byItem = new Map(items.map((item) => [item.id, item]));
  const bySegment = new Map(segments.map((segment) => [segment.id, segment]));
  if (
    byItem.size !== items.length ||
    bySegment.size !== segments.length ||
    segments.some(
      (segment) =>
        new Set(segment.itemIds).size !== segment.itemIds.length ||
        segment.itemIds.some((id) => byItem.get(id)?.segmentId !== segment.id),
    ) ||
    items.some(
      (item) =>
        !bySegment.get(item.segmentId)?.itemIds.includes(item.id) || item.relatedIds.some((id) => !byItem.has(id)),
    )
  )
    throw new Error("Invalid context relationships");
  const model = s.model === undefined ? undefined : object(s.model);
  return {
    sessionId: identity(s.sessionId),
    revision: identity(s.revision),
    busy: boolean(s.busy),
    estimated: true,
    ...(model ? { model: { provider: identity(model.provider), id: identity(model.id), name: text(model.name) } } : {}),
    contextWindow: nullable(s.contextWindow),
    totalTokens: number(s.totalTokens),
    remainingTokens: nullable(s.remainingTokens),
    segments,
    items,
  };
}
export function parseContextPreview(value: unknown): ContextPreviewDto {
  const s = object(value),
    cache = object(s.cache);
  if (cache.basis !== "unchanged-prefix") throw new Error("Invalid cache basis");
  const hitRate = nullable(cache.hitRate);
  if (hitRate !== null && hitRate > 1) throw new Error("Invalid cache estimate");
  return {
    revision: identity(s.revision),
    beforeTokens: number(s.beforeTokens),
    afterTokens: number(s.afterTokens),
    removedTokens: number(s.removedTokens),
    remainingTokens: nullable(s.remainingTokens),
    cache: { basis: "unchanged-prefix", hitRate, reusableTokens: nullable(cache.reusableTokens) },
    changes: array(s.changes, (value) => {
      const change = object(value);
      return { itemId: identity(change.itemId), action: choice(change.action, ["fold", "delete"]) };
    }),
    segments: array(s.segments, (value) => {
      const segment = object(value);
      return { id: identity(segment.id), afterTokens: number(segment.afterTokens) };
    }),
  };
}
export function parseContextItemText(value: unknown): ContextItemTextDto {
  const s = object(value);
  const result: ContextItemTextDto = {
    revision: identity(s.revision),
    itemId: identity(s.itemId),
    view: choice(s.view, ["original", "current"]),
    text: text(s.text),
    offset: number(s.offset),
    totalChars: number(s.totalChars),
    nextOffset: nullable(s.nextOffset),
  };
  if (
    ![result.offset, result.totalChars, result.nextOffset ?? 0].every(Number.isSafeInteger) ||
    result.offset > result.totalChars ||
    (result.nextOffset !== null && (result.nextOffset <= result.offset || result.nextOffset > result.totalChars))
  )
    throw new Error("Invalid context page");
  return result;
}
