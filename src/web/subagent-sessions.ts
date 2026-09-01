import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readAgentAliases } from "../subagent/agent-alias";
import { readSubagentJournal } from "../subagent/job-journal";
import { AGENT_STATUS_TYPE } from "../subagent/notifications";
import type { RecoverySessionStore } from "../subagent/recovery";
import { readSubagentSessionLinks } from "../subagent/session-links";
import {
  addApiUsageTotals,
  applyApiUsageRecord,
  emptyApiUsageTotals,
  projectSessionUsage,
  trackedApiUsageRecordIds,
} from "./api-usage";
import type {
  ApiUsageSessionSummaryDto,
  ApiUsageStatisticsDto,
  ApiUsageRecordDto,
  ApiUsageTotalsDto,
  ChildSessionSnapshotDto,
  SubagentSessionSummaryDto,
} from "./contracts";
import { projectSessionTimeline } from "./session-timeline";

interface ReadonlySubagentSession {
  getEntries(): unknown[];
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getCwd(): string;
  getSessionName(): string | undefined;
  getBranch(): Array<{ type: string; id?: string; message?: AgentMessage }>;
}

interface RecoverySessionManager extends ReadonlySubagentSession {
  appendCustomMessageEntry(
    customType: string,
    content: string,
    display: boolean,
    details?: unknown,
  ): string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function persistedBatch(
  path: string,
  expected: { customType: string; content: string; display: false; details: { batchId: string } },
): "missing" | "matching" | "conflict" {
  const text = readFileSync(path, "utf8");
  let found = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry: unknown = JSON.parse(line);
    if (!isObject(entry) || entry.type !== "custom_message" || !isObject(entry.details)) continue;
    if (entry.details.batchId !== expected.details.batchId) continue;
    found = true;
    if (
      entry.customType === expected.customType
      && entry.content === expected.content
      && entry.display === false
    ) return "matching";
  }
  return found ? "conflict" : "missing";
}

export function createSubagentRecoverySessionStore(input: {
  rootSession: RecoverySessionManager;
  open(path: string): RecoverySessionManager;
}): RecoverySessionStore {
  const inspectedIdentities = new Map<string, { sessionId: string; cwd: string }>();
  const rootPath = input.rootSession.getSessionFile();
  if (rootPath) {
    inspectedIdentities.set(rootPath, {
      sessionId: input.rootSession.getSessionId(),
      cwd: input.rootSession.getCwd(),
    });
  }
  const openExact = (path: string): RecoverySessionManager => {
    readFileSync(path);
    const manager = input.open(path);
    if (manager.getSessionFile() !== path) {
      throw new Error("SessionManager did not open the exact journaled path.");
    }
    return manager;
  };

  return {
    async inspect(path) {
      try {
        const manager = openExact(path);
        const latest = latestAssistantText(branchMessages(manager));
        inspectedIdentities.set(path, {
          sessionId: manager.getSessionId(),
          cwd: manager.getCwd(),
        });
        return {
          readable: true,
          sessionId: manager.getSessionId(),
          cwd: manager.getCwd(),
          ...(latest === undefined ? {} : { latestAssistantText: latest }),
        };
      } catch {
        return { readable: false };
      }
    },
    async appendHiddenMessage(path, message) {
      const expected = inspectedIdentities.get(path);
      if (!expected) throw new Error("Recovery owner path was not inspected before insertion.");
      const physical = openExact(path);
      if (physical.getSessionId() !== expected.sessionId || physical.getCwd() !== expected.cwd) {
        throw new Error("Recovery owner session UUID or cwd changed after inspection.");
      }
      const manager = rootPath === path ? input.rootSession : physical;
      if (
        manager.getSessionFile() !== path
        || manager.getSessionId() !== expected.sessionId
        || manager.getCwd() !== expected.cwd
      ) throw new Error("Recovery root session identity changed after physical validation.");
      const existing = persistedBatch(path, message);
      if (existing === "matching") return;
      if (existing === "conflict") {
        throw new Error(`Recovery batch ${message.details.batchId} has conflicting persisted content.`);
      }
      manager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      if (persistedBatch(path, message) !== "matching") {
        throw new Error(`Recovery batch ${message.details.batchId} was not readable after insertion.`);
      }
    },
  };
}

export interface SubagentSessionStore {
  open(path: string): ReadonlySubagentSession;
  listAll(): Promise<Array<{ id: string; path: string; cwd: string }>>;
}

export class SubagentSessionNotFoundError extends Error {}

export class SubagentSessionService {
  private readonly usageCache = new Map<string, {
    statistics: ApiUsageStatisticsDto;
    recordIds: Set<string>;
  }>();

  constructor(private readonly store: SubagentSessionStore) {}

  async summaries(parentSessionId: string): Promise<SubagentSessionSummaryDto[]> {
    let parent: Awaited<ReturnType<SubagentSessionService["parent"]>>;
    try {
      parent = await this.parent(parentSessionId);
    } catch (error) {
      if (error instanceof SubagentSessionNotFoundError) return [];
      throw error;
    }
    return this.fold(parent).summaries;
  }

  async snapshot(parentSessionId: string, childSessionId: string): Promise<ChildSessionSnapshotDto> {
    const parent = await this.parent(parentSessionId);
    const folded = this.fold(parent);
    const paths = folded.pathsBySession.get(childSessionId);
    if (!paths || paths.size !== 1) throw notFound(childSessionId);
    const child = this.open([...paths][0]!, childSessionId, parent.cwd);
    const sessionName = child.getSessionName();
    const branch = child.getBranch();
    return {
      session: {
        id: child.getSessionId(),
        cwd: child.getCwd(),
        ...(sessionName === undefined ? {} : { sessionName }),
      },
      timeline: projectSessionTimeline(branch),
      inlineUsage: projectSessionUsage(childSessionId, child.getEntries(), branch).inlineUsage,
      subagents: folded.summaries.filter((summary) => summary.ownerSessionId === childSessionId),
    };
  }

  async statistics(parentSessionId: string): Promise<ApiUsageStatisticsDto> {
    let parent: Awaited<ReturnType<SubagentSessionService["parent"]>>;
    try {
      parent = await this.parent(parentSessionId);
    } catch (error) {
      if (error instanceof SubagentSessionNotFoundError) {
        const statistics = emptyStatistics(parentSessionId);
        this.usageCache.set(parentSessionId, { statistics, recordIds: new Set() });
        return statistics;
      }
      throw error;
    }
    const folded = this.fold(parent);
    const rootEntries = parent.manager.getEntries();
    const recordIds = new Set(trackedApiUsageRecordIds(parent.id, rootEntries));
    const rootProjection = projectSessionUsage(
      parent.id,
      rootEntries,
      parent.manager.getBranch(),
    );
    const rootSession: ApiUsageSessionSummaryDto = {
      sessionId: parent.id,
      direct: rootProjection.direct,
      subtree: copyTotals(rootProjection.direct),
      models: rootProjection.models,
    };
    const sessions: ApiUsageSessionSummaryDto[] = [rootSession];
    const bySessionId = new Map<string, ApiUsageSessionSummaryDto>([[parent.id, rootSession]]);
    const summaryBySessionId = new Map<string, SubagentSessionSummaryDto>();
    for (const summary of folded.summaries) {
      if (!summaryBySessionId.has(summary.childSessionId)) summaryBySessionId.set(summary.childSessionId, summary);
    }
    const warnings: ApiUsageStatisticsDto["warnings"] = [];

    for (const [childSessionId, summary] of summaryBySessionId) {
      if (childSessionId === parent.id || bySessionId.has(childSessionId)) continue;
      const paths = folded.pathsBySession.get(childSessionId);
      if (!paths || paths.size !== 1) {
        warnings.push(usageWarning(summary));
        continue;
      }
      try {
        const child = this.open([...paths][0]!, childSessionId, parent.cwd);
        const childEntries = child.getEntries();
        for (const recordId of trackedApiUsageRecordIds(childSessionId, childEntries)) recordIds.add(recordId);
        const projection = projectSessionUsage(childSessionId, childEntries, child.getBranch());
        const row: ApiUsageSessionSummaryDto = {
          sessionId: childSessionId,
          parentSessionId: summary.ownerSessionId,
          agent: summary.agent,
          ...(summary.agentId === undefined ? {} : { agentId: summary.agentId }),
          direct: projection.direct,
          subtree: copyTotals(projection.direct),
          models: projection.models,
        };
        sessions.push(row);
        bySessionId.set(childSessionId, row);
      } catch {
        warnings.push(usageWarning(summary));
      }
    }

    const childrenByOwner = new Map<string, string[]>();
    for (const session of sessions.slice(1)) {
      const owner = session.parentSessionId;
      if (!owner || !bySessionId.has(owner)) continue;
      const children = childrenByOwner.get(owner) ?? [];
      children.push(session.sessionId);
      childrenByOwner.set(owner, children);
    }
    const resolved = new Set<string>();
    const resolving = new Set<string>();
    const resolveSubtree = (sessionId: string): ApiUsageTotalsDto => {
      const row = bySessionId.get(sessionId);
      if (!row || resolved.has(sessionId)) return row?.subtree ?? emptyApiUsageTotals();
      if (resolving.has(sessionId)) return row.subtree;
      resolving.add(sessionId);
      const subtree = copyTotals(row.direct);
      for (const childId of childrenByOwner.get(sessionId) ?? []) {
        addApiUsageTotals(subtree, resolveSubtree(childId));
      }
      resolving.delete(sessionId);
      resolved.add(sessionId);
      row.subtree = subtree;
      return subtree;
    };
    const total = copyTotals(resolveSubtree(parent.id));
    const statistics = {
      rootSessionId: parent.id,
      total,
      sessions,
      partial: warnings.length > 0,
      warnings,
    };
    this.usageCache.set(parentSessionId, { statistics, recordIds });
    return statistics;
  }

  async trackUsage(parentSessionId: string, record: ApiUsageRecordDto): Promise<ApiUsageStatisticsDto> {
    const cached = this.usageCache.get(parentSessionId) ?? {
      statistics: await this.statistics(parentSessionId),
      recordIds: this.usageCache.get(parentSessionId)?.recordIds ?? new Set<string>(),
    };
    const recordKey = `${record.sessionId}:${record.id}`;
    if (cached.recordIds.has(recordKey)) return cached.statistics;
    const next = applyApiUsageRecord(cached.statistics, record);
    if (!next) {
      this.usageCache.delete(parentSessionId);
      return this.statistics(parentSessionId);
    }
    cached.recordIds.add(recordKey);
    cached.statistics = next;
    this.usageCache.set(parentSessionId, cached);
    return next;
  }

  private async parent(parentSessionId: string): Promise<{
    id: string;
    cwd: string;
    manager: ReadonlySubagentSession;
    sessions: Array<{ id: string; path: string; cwd: string }>;
  }> {
    const sessions = await this.store.listAll();
    const info = sessions.find((session) => session.id === parentSessionId);
    if (!info) throw notFound(parentSessionId);

    const manager = this.open(info.path, parentSessionId, info.cwd);
    return { id: parentSessionId, cwd: info.cwd, manager, sessions };
  }

  private fold(parent: {
    id: string;
    cwd: string;
    manager: ReadonlySubagentSession;
    sessions: Array<{ id: string; path: string; cwd: string }>;
  }): {
    summaries: SubagentSessionSummaryDto[];
    pathsBySession: Map<string, Set<string>>;
  } {
    const entries = parent.manager.getEntries();
    const state = readSubagentJournal(entries);
    const aliases = readAgentAliases(entries);
    const links = readSubagentSessionLinks(entries);
    const summaries: SubagentSessionSummaryDto[] = [];
    const pathsBySession = new Map<string, Set<string>>();
    const journalLaunchIds = new Set(state.jobs.keys());

    const rememberPath = (childSessionId: string, sessionPath: string): void => {
      const paths = pathsBySession.get(childSessionId) ?? new Set<string>();
      paths.add(sessionPath);
      pathsBySession.set(childSessionId, paths);
    };
    const latestAt = (childSessionId: string, sessionPath: string): string | undefined => {
      try {
        return latestAssistantText(branchMessages(this.open(sessionPath, childSessionId, parent.cwd)));
      } catch (error) {
        if (error instanceof SubagentSessionNotFoundError) return undefined;
        throw error;
      }
    };

    for (const job of state.jobs.values()) {
      if (
        job.terminalSuppressed
        || !job.childSessionId
        || !job.sessionPath
        || (job.status !== "working" && job.status !== "complete" && job.status !== "error")
      ) continue;
      rememberPath(job.childSessionId, job.sessionPath);
      const latestMessage = job.latestAssistantText?.trim()
        ? job.latestAssistantText
        : latestAt(job.childSessionId, job.sessionPath);
      summaries.push({
        launchId: job.launchId,
        ownerSessionId: job.ownerSessionId,
        toolCallId: job.toolCallId,
        agent: job.agent,
        agentId: job.agentId,
        childSessionId: job.childSessionId,
        status: job.status,
        ...(latestMessage === undefined ? {} : { latestMessage }),
      });
    }

    for (const link of links) {
      if (link.launchId !== undefined && journalLaunchIds.has(link.launchId)) continue;
      const alias = [...aliases].reverse().find((candidate) =>
        candidate.sessionId === link.childSessionId && candidate.agent === link.agent);
      const legacyInfo = parent.sessions.find((candidate) =>
        candidate.id === link.childSessionId && candidate.cwd === parent.cwd);
      const sessionPath = alias?.sessionPath ?? legacyInfo?.path;
      if (sessionPath) rememberPath(link.childSessionId, sessionPath);
      const latestMessage = sessionPath
        ? latestAt(link.childSessionId, sessionPath)
        : undefined;
      summaries.push({
        ownerSessionId: link.ownerSessionId ?? parent.id,
        toolCallId: link.toolCallId,
        agent: link.agent,
        childSessionId: link.childSessionId,
        status: "complete",
        ...(link.launchId === undefined ? {} : { launchId: link.launchId }),
        ...((link.agentId ?? alias?.id) === undefined ? {} : { agentId: link.agentId ?? alias?.id }),
        ...(latestMessage === undefined ? {} : { latestMessage }),
        ...(link.step === undefined ? {} : { step: link.step }),
      });
    }

    return { summaries, pathsBySession };
  }

  private open(path: string, expectedId: string, expectedCwd: string): ReadonlySubagentSession {
    try {
      const manager = this.store.open(path);
      if (
        manager.getSessionFile() !== path
        || manager.getSessionId() !== expectedId
        || manager.getCwd() !== expectedCwd
      ) {
        throw notFound(expectedId);
      }
      return manager;
    } catch {
      throw notFound(expectedId);
    }
  }
}

function copyTotals(source: ApiUsageTotalsDto): ApiUsageTotalsDto {
  const copy = emptyApiUsageTotals();
  addApiUsageTotals(copy, source);
  return copy;
}

function emptyStatistics(rootSessionId: string): ApiUsageStatisticsDto {
  const direct = emptyApiUsageTotals();
  return {
    rootSessionId,
    total: copyTotals(direct),
    sessions: [{
      sessionId: rootSessionId,
      direct,
      subtree: copyTotals(direct),
      models: [],
    }],
    partial: false,
    warnings: [],
  };
}

function usageWarning(summary: SubagentSessionSummaryDto): ApiUsageStatisticsDto["warnings"][number] {
  return {
    sessionId: summary.childSessionId,
    ...(summary.agentId === undefined ? {} : { agentId: summary.agentId }),
    reason: "unreadable-descendant",
  };
}

function branchMessages(session: ReadonlySubagentSession): AgentMessage[] {
  try {
    return branchMessagesFromEntries(session.getBranch());
  } catch {
    throw notFound(session.getSessionId());
  }
}

function branchMessagesFromEntries(entries: Array<{ type: string; id?: string; message?: AgentMessage }>): AgentMessage[] {
  return entries
    .filter((entry): entry is { type: "message"; id?: string; message: AgentMessage } =>
      entry.type === "message"
      && isAgentMessage(entry.message)
      && !isHiddenStatusMessage(entry.message))
    .map((entry) => ({
      ...entry.message,
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
    }) as AgentMessage);
}

function isHiddenStatusMessage(message: unknown): boolean {
  return isObject(message)
    && message.role === "custom"
    && message.customType === AGENT_STATUS_TYPE;
}

function isAgentMessage(message: unknown): message is AgentMessage {
  if (message === null || typeof message !== "object" || !("role" in message)) return false;
  return typeof message.role === "string" && message.role.length > 0;
}

function latestAssistantText(messages: readonly AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0)
      .map((block) => block.text)
      .join("\n\n");
    if (text) return text;
  }
  return undefined;
}

function notFound(sessionId: string): SubagentSessionNotFoundError {
  return new SubagentSessionNotFoundError(`Subagent session not found: ${sessionId}`);
}
