import type {
  ApiUsageDto,
  ApiUsageModelSummaryDto,
  ApiUsageRecordDto,
  ApiUsageStatisticsDto,
  ApiUsageTotalsDto,
} from "./contracts";

interface SessionUsageProjection {
  direct: ApiUsageTotalsDto;
  models: ApiUsageModelSummaryDto[];
  inlineUsage: ApiUsageRecordDto[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || finiteNumber(value);
}

function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): number | null {
  const promptTokens = input + cacheRead + cacheWrite;
  return promptTokens > 0 ? cacheRead / promptTokens : null;
}

function readUsage(value: unknown): ApiUsageDto | undefined {
  if (!isRecord(value) || !isRecord(value.cost)) return undefined;
  if (
    !finiteNumber(value.input)
    || !finiteNumber(value.output)
    || !finiteNumber(value.cacheRead)
    || !finiteNumber(value.cacheWrite)
    || !optionalFiniteNumber(value.cacheWrite1h)
    || !optionalFiniteNumber(value.reasoning)
    || !finiteNumber(value.totalTokens)
    || !finiteNumber(value.cost.input)
    || !finiteNumber(value.cost.output)
    || !finiteNumber(value.cost.cacheRead)
    || !finiteNumber(value.cost.cacheWrite)
    || !finiteNumber(value.cost.total)
  ) return undefined;
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    ...(value.cacheWrite1h === undefined ? {} : { cacheWrite1h: value.cacheWrite1h }),
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
    totalTokens: value.totalTokens,
    cacheHitRate: cacheHitRate(value.input, value.cacheRead, value.cacheWrite),
    cost: {
      input: value.cost.input,
      output: value.cost.output,
      cacheRead: value.cost.cacheRead,
      cacheWrite: value.cost.cacheWrite,
      total: value.cost.total,
    },
  };
}

export function trackedApiUsageRecordIds(sessionId: string, entries: readonly unknown[]): string[] {
  return recordsFromEntries(sessionId, entries).map((record) => `${sessionId}:${record.id}`);
}

export function emptyApiUsageTotals(): ApiUsageTotalsDto {
  return {
    records: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    totalTokens: 0,
    cacheHitRate: null,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addApiUsageTotals(target: ApiUsageTotalsDto, usage: ApiUsageDto | ApiUsageTotalsDto): void {
  target.records += "records" in usage ? usage.records : 1;
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cacheWrite1h += usage.cacheWrite1h ?? 0;
  target.reasoning += usage.reasoning ?? 0;
  target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
  target.cacheHitRate = cacheHitRate(target.input, target.cacheRead, target.cacheWrite);
  target.cost.input += usage.cost.input;
  target.cost.output += usage.cost.output;
  target.cost.cacheRead += usage.cost.cacheRead;
  target.cost.cacheWrite += usage.cost.cacheWrite;
  target.cost.total += usage.cost.total;
}

function usageRecord(sessionId: string, entry: unknown, afterEntryId?: string): ApiUsageRecordDto | undefined {
  if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.timestamp !== "string") return undefined;
  if (entry.type === "message" && isRecord(entry.message)) {
    const usage = readUsage(entry.message.usage);
    if (!usage) return undefined;
    if (entry.message.role === "assistant") {
      const provider = typeof entry.message.provider === "string" ? entry.message.provider : undefined;
      const model = typeof entry.message.responseModel === "string"
        ? entry.message.responseModel
        : typeof entry.message.model === "string"
          ? entry.message.model
          : undefined;
      return {
        id: entry.id,
        sessionId,
        source: "assistant",
        timestamp: entry.timestamp,
        anchor: { kind: "message", messageEntryId: entry.id },
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        usage,
      };
    }
    if (entry.message.role === "toolResult") {
      const toolCallId = typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : undefined;
      return {
        id: entry.id,
        sessionId,
        source: "tool",
        timestamp: entry.timestamp,
        anchor: toolCallId
          ? { kind: "tool", toolCallId }
          : { kind: "standalone", ...(afterEntryId === undefined ? {} : { afterEntryId }) },
        usage,
      };
    }
    return undefined;
  }
  if (entry.type !== "compaction" && entry.type !== "branch_summary") return undefined;
  const usage = readUsage(entry.usage);
  if (!usage) return undefined;
  return {
    id: entry.id,
    sessionId,
    source: entry.type === "compaction" ? "compaction" : "branch-summary",
    timestamp: entry.timestamp,
    anchor: { kind: "standalone", ...(afterEntryId === undefined ? {} : { afterEntryId }) },
    usage,
  };
}

export function projectApiUsageRecord(sessionId: string, entry: unknown): ApiUsageRecordDto | undefined {
  const afterEntryId = isRecord(entry) && typeof entry.parentId === "string" ? entry.parentId : undefined;
  return usageRecord(sessionId, entry, afterEntryId);
}

function recordsFromEntries(sessionId: string, entries: readonly unknown[]): ApiUsageRecordDto[] {
  const records: ApiUsageRecordDto[] = [];
  let previousEntryId: string | undefined;
  for (const entry of entries) {
    const record = usageRecord(sessionId, entry, previousEntryId);
    if (record) records.push(record);
    if (isRecord(entry) && typeof entry.id === "string") previousEntryId = entry.id;
  }
  return records;
}

export function projectSessionUsage(
  sessionId: string,
  entries: readonly unknown[],
  branchEntries: readonly unknown[],
): SessionUsageProjection {
  const direct = emptyApiUsageTotals();
  const byModel = new Map<string, ApiUsageModelSummaryDto>();
  for (const record of recordsFromEntries(sessionId, entries)) {
    addApiUsageTotals(direct, record.usage);
    const key = record.source === "assistant" && record.provider && record.model
      ? `${record.provider}/${record.model}`
      : "internal";
    let summary = byModel.get(key);
    if (!summary) {
      summary = key === "internal"
        ? { key, kind: "internal", totals: emptyApiUsageTotals() }
        : {
            key,
            provider: record.provider,
            model: record.model,
            kind: "model",
            totals: emptyApiUsageTotals(),
          };
      byModel.set(key, summary);
    }
    addApiUsageTotals(summary.totals, record.usage);
  }
  return {
    direct,
    models: [...byModel.values()],
    inlineUsage: recordsFromEntries(sessionId, branchEntries),
  };
}

export function attachMessageEntryIds<T extends { role?: unknown; timestamp?: unknown }>(
  messages: readonly T[],
  branchEntries: readonly unknown[],
): T[] {
  const candidates = branchEntries.filter((entry): entry is { id: string; message: T } =>
    isRecord(entry)
    && entry.type === "message"
    && typeof entry.id === "string"
    && isRecord(entry.message));
  const used = new Set<number>();
  return messages.map((message) => {
    let index = candidates.findIndex((entry, candidateIndex) =>
      !used.has(candidateIndex) && entry.message === message);
    if (index < 0) {
      index = candidates.findIndex((entry, candidateIndex) =>
        !used.has(candidateIndex)
        && entry.message.role === message.role
        && entry.message.timestamp === message.timestamp);
    }
    if (index < 0) return message;
    used.add(index);
    const candidate = candidates[index];
    return candidate ? { ...message, id: candidate.id } : message;
  });
}

function copyTotals(source: ApiUsageTotalsDto): ApiUsageTotalsDto {
  return { ...source, cost: { ...source.cost } };
}

export function applyApiUsageRecord(
  statistics: ApiUsageStatisticsDto,
  record: ApiUsageRecordDto,
): ApiUsageStatisticsDto | undefined {
  if (!statistics.sessions.some((session) => session.sessionId === record.sessionId)) return undefined;
  const sessions = statistics.sessions.map((session) => ({
    ...session,
    direct: copyTotals(session.direct),
    subtree: copyTotals(session.subtree),
    models: session.models.map((model) => ({ ...model, totals: copyTotals(model.totals) })),
  }));
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const target = byId.get(record.sessionId);
  if (!target) return undefined;
  addApiUsageTotals(target.direct, record.usage);
  const modelKey = record.source === "assistant" && record.provider && record.model
    ? `${record.provider}/${record.model}`
    : "internal";
  let model = target.models.find((candidate) => candidate.key === modelKey);
  if (!model) {
    model = modelKey === "internal"
      ? { key: modelKey, kind: "internal", totals: emptyApiUsageTotals() }
      : {
          key: modelKey,
          provider: record.provider,
          model: record.model,
          kind: "model",
          totals: emptyApiUsageTotals(),
        };
    target.models.push(model);
  }
  addApiUsageTotals(model.totals, record.usage);

  const children = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentSessionId || !byId.has(session.parentSessionId)) continue;
    const childIds = children.get(session.parentSessionId) ?? [];
    childIds.push(session.sessionId);
    children.set(session.parentSessionId, childIds);
  }
  const resolved = new Set<string>();
  const resolving = new Set<string>();
  const subtree = (sessionId: string): ApiUsageTotalsDto => {
    const session = byId.get(sessionId);
    if (!session) return emptyApiUsageTotals();
    if (resolved.has(sessionId) || resolving.has(sessionId)) return session.subtree;
    resolving.add(sessionId);
    const total = copyTotals(session.direct);
    for (const childId of children.get(sessionId) ?? []) addApiUsageTotals(total, subtree(childId));
    resolving.delete(sessionId);
    resolved.add(sessionId);
    session.subtree = total;
    return total;
  };
  const total = copyTotals(subtree(statistics.rootSessionId));
  return {
    ...statistics,
    total,
    sessions,
    warnings: statistics.warnings.map((warning) => ({ ...warning })),
  };
}
