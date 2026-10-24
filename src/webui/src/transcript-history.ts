import type { TranscriptPageDto } from "../../web/contracts";
import { fromSnapshot, type SessionViewState } from "./session-reducer";

/** New rows can still be estimated when the visible range index changes. The
 * header inset is part of the reading fold, like OpenCode V2's scrollMargin. */
export function shouldAdjustTranscriptRow(input: {
  introduced: boolean;
  index: number;
  end: number;
  firstVisible?: number;
  offset: number;
  adjustments: number;
  header: number;
}): boolean {
  return input.introduced
    ? input.end <= input.offset + input.adjustments + input.header
    : input.firstVisible !== undefined && input.index < input.firstVisible;
}

/** Publish old immutable entries without replaying or replacing live deltas. */
export function prependTranscriptPage(
  state: SessionViewState,
  page: TranscriptPageDto,
  sessionId: string,
): SessionViewState {
  const older = fromSnapshot({
    session: { id: sessionId, cwd: "", isStreaming: false, status: "ready", sessionName: state.sessionName },
    runtimeConfigurationGeneration: state.runtimeConfigurationGeneration,
    subagents: state.subagentSummaries ?? [],
    ...page,
  });
  const currentRows = [...state.messages, ...state.tools, ...state.summaries, ...state.completions];
  const offset = Math.min(0, ...currentRows.map((row) => row.order)) - older.nextOrder;
  const messageIds = new Set(state.messages.map((row) => row.entryId ?? row.key));
  const summaryIds = new Set(state.summaries.map((row) => row.entryId));
  const completionIds = new Set(state.completions.map((row) => row.key));
  const tools = new Map(state.tools.map((tool) => [tool.toolCallId ?? tool.key, tool]));
  for (const old of older.tools) {
    const id = old.toolCallId ?? old.key;
    const current = tools.get(id);
    tools.set(
      id,
      current
        ? {
            ...old,
            ...current,
            args: current.args ?? old.args,
            agentName: current.agentName ?? old.agentName,
            skillName: current.skillName ?? old.skillName,
            callEntryId: current.callEntryId ?? old.callEntryId,
            resultEntryId: current.resultEntryId ?? old.resultEntryId,
            apiUsage: current.apiUsage ?? old.apiUsage,
            order: current.callEntryId ? current.order : old.order + offset,
          }
        : { ...old, order: old.order + offset },
    );
  }
  const usageIds = new Set((state.inlineUsage ?? []).map((record) => record.id));
  return {
    ...state,
    messages: [
      ...older.messages
        .filter((row) => !messageIds.has(row.entryId ?? row.key))
        .map((row) => ({ ...row, order: row.order + offset })),
      ...state.messages,
    ],
    tools: [...tools.values()].sort((a, b) => a.order - b.order),
    summaries: [
      ...older.summaries
        .filter((row) => !summaryIds.has(row.entryId))
        .map((row) => ({ ...row, order: row.order + offset })),
      ...state.summaries,
    ],
    completions: [
      ...older.completions
        .filter((row) => !completionIds.has(row.key))
        .map((row) => ({ ...row, order: row.order + offset })),
      ...state.completions,
    ],
    inlineUsage: [
      ...(older.inlineUsage ?? []).filter((record) => !usageIds.has(record.id)),
      ...(state.inlineUsage ?? []),
    ],
    deferredEntries: { ...older.deferredEntries, ...state.deferredEntries },
    historyCursor: page.history?.cursor,
    messageStructureRevision: state.messageStructureRevision + 1,
  };
}
