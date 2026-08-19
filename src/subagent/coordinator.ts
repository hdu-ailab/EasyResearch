import { randomUUID } from "node:crypto";
import {
  AGENT_ALIAS_ENTRY,
  formatAgentId,
  readAgentAliases,
  resolveAgentAlias,
} from "./agent-alias";
import type { AgentConfig } from "./agents";
import type {
  SubagentJobIdentity,
  SubagentJobSummary,
  SubagentSupervisorEvent,
} from "./contracts";
import {
  SUBAGENT_JOB_ENTRY,
  readSubagentJournal,
  type SubagentJobJournalRecord,
  type SubagentJournalState,
} from "./job-journal";
import { SUBAGENT_SESSION_LINK_ENTRY } from "./session-links";

export interface CoordinatorSessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getEntries(): unknown[];
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface AgentCatalog {
  all: readonly AgentConfig[];
  available: readonly AgentConfig[];
}

export interface ReservedDispatch {
  launchId: string;
  ownerSessionId: string;
  toolCallId: string;
  agent: string;
  agentId: string;
  continuation: boolean;
  childSessionId?: string;
  sessionPath?: string;
}

const RUNNING_STATUSES = new Set(["reserved", "created", "working"]);

function now(): string {
  return new Date().toISOString();
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Unknown pre-materialization failure";
}

export class SubagentCoordinator {
  private state: SubagentJournalState;
  private readonly listeners = new Set<(event: SubagentSupervisorEvent) => void>();
  private paperAssistantState?: { model(): string | undefined; thinking(): string | undefined };
  private closing = false;

  constructor(private readonly rootSessionManager: CoordinatorSessionManager) {
    this.state = readSubagentJournal(rootSessionManager.getEntries());
  }

  reserveDispatch(input: { ownerSessionId: string; toolCallId: string; requested: string; catalog: AgentCatalog }): ReservedDispatch {
    if (this.closing) throw new Error("Cannot reserve a subagent while the coordinator is closing.");
    if (!input.ownerSessionId.trim() || !input.toolCallId.trim() || !input.requested.trim()) {
      throw new Error("Owner session id, tool call id, and Agent name are required.");
    }

    this.refresh();
    const aliases = readAgentAliases(this.rootSessionManager.getEntries());
    const alias = resolveAgentAlias(aliases, input.requested);
    const exactAgent = input.catalog.all.find((candidate) => candidate.name === input.requested);
    if (alias && exactAgent) {
      throw new Error(`Ambiguous subagent target "${input.requested}": it is both an Agent name and a saved agent id.`);
    }

    let reservation: ReservedDispatch;
    if (alias) {
      if (!input.catalog.available.some((candidate) => candidate.name === alias.agent)) {
        throw new Error(`Agent "${alias.agent}" for saved id "${alias.id}" is disabled or no longer available.`);
      }
      if (this.isRunning(alias.id)) {
        throw new Error(`Agent id "${alias.id}" is still running and cannot be continued.`);
      }
      reservation = {
        launchId: this.nextLaunchId(),
        ownerSessionId: input.ownerSessionId,
        toolCallId: input.toolCallId,
        agent: alias.agent,
        agentId: alias.id,
        continuation: true,
        childSessionId: alias.sessionId,
        sessionPath: alias.sessionPath,
      };
    } else {
      if (!exactAgent) throw new Error(`Unknown Agent "${input.requested}".`);
      if (!input.catalog.available.some((candidate) => candidate.name === exactAgent.name)) {
        throw new Error(`Agent "${exactAgent.name}" is disabled or unavailable.`);
      }

      const consumedIds = new Set([
        ...aliases.map((candidate) => candidate.id),
        ...[...this.state.jobs.values()].map((job) => job.agentId),
      ]);
      const actualNames = new Set(input.catalog.all.map((candidate) => candidate.name));
      let sequence = 0;
      let agentId = formatAgentId(exactAgent.name, sequence);
      while (consumedIds.has(agentId) || actualNames.has(agentId)) {
        sequence += 1;
        agentId = formatAgentId(exactAgent.name, sequence);
      }
      reservation = {
        launchId: this.nextLaunchId(),
        ownerSessionId: input.ownerSessionId,
        toolCallId: input.toolCallId,
        agent: exactAgent.name,
        agentId,
        continuation: false,
      };
    }

    this.append({
      kind: "reserved",
      launchId: reservation.launchId,
      ownerSessionId: reservation.ownerSessionId,
      toolCallId: reservation.toolCallId,
      agent: reservation.agent,
      agentId: reservation.agentId,
      continuation: reservation.continuation,
      createdAt: now(),
    });
    return reservation;
  }

  recordChildCreated(reservation: ReservedDispatch, child: { childSessionId: string; sessionPath: string }): void {
    this.append({
      kind: "created",
      launchId: reservation.launchId,
      childSessionId: child.childSessionId,
      sessionPath: child.sessionPath,
    });
  }

  recordMaterialized(reservation: ReservedDispatch, child: { childSessionId: string; sessionPath: string }): SubagentJobIdentity {
    const current = this.journal().jobs.get(reservation.launchId);
    if (!current || current.childSessionId !== child.childSessionId || current.sessionPath !== child.sessionPath) {
      this.recordChildCreated(reservation, child);
    }
    this.append({ kind: "materialized", launchId: reservation.launchId });
    this.rootSessionManager.appendCustomEntry(AGENT_ALIAS_ENTRY, {
      id: reservation.agentId,
      agent: reservation.agent,
      sessionId: child.childSessionId,
      sessionPath: child.sessionPath,
    });
    this.rootSessionManager.appendCustomEntry(SUBAGENT_SESSION_LINK_ENTRY, {
      toolCallId: reservation.toolCallId,
      childSessionId: child.childSessionId,
      agent: reservation.agent,
      ownerSessionId: reservation.ownerSessionId,
      launchId: reservation.launchId,
      agentId: reservation.agentId,
    });

    return {
      launchId: reservation.launchId,
      ownerSessionId: reservation.ownerSessionId,
      toolCallId: reservation.toolCallId,
      agent: reservation.agent,
      agentId: reservation.agentId,
      childSessionId: child.childSessionId,
    };
  }

  recordLaunchAcknowledged(launchId: string): void {
    this.append({ kind: "launch_acknowledged", launchId, acknowledgedAt: now() });
  }

  recordPreMaterializationFailure(reservation: ReservedDispatch, error: unknown): void {
    this.append({
      kind: "pre_materialization_failed",
      launchId: reservation.launchId,
      reason: describeError(error),
      failedAt: now(),
    });
  }

  recordTerminal(input: { launchId: string; status: "complete" | "error"; latestAssistantText?: string; errorMessage?: string }): void {
    this.append({
      kind: "terminal",
      launchId: input.launchId,
      status: input.status,
      ...(input.latestAssistantText === undefined ? {} : { latestAssistantText: input.latestAssistantText }),
      ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
      finishedAt: now(),
    });
  }

  recordNotificationBatch(input: { batchId: string; ownerSessionId: string; launchIds: string[]; content: string }): void {
    this.append({
      kind: "notification_batch",
      batchId: input.batchId,
      ownerSessionId: input.ownerSessionId,
      launchIds: [...input.launchIds],
      content: input.content,
      createdAt: now(),
    });
  }

  acknowledgeNotification(batchId: string): void {
    this.append({ kind: "notification_ack", batchId, acknowledgedAt: now() });
  }

  supersedeNotification(batchId: string): void {
    this.append({ kind: "notification_superseded", batchId, supersededAt: now() });
  }

  journal(): SubagentJournalState {
    this.refresh();
    return this.state;
  }

  isRunning(agentId: string): boolean {
    this.refresh();
    return [...this.state.jobs.values()].some((job) => job.agentId === agentId && RUNNING_STATUSES.has(job.status));
  }

  summaries(): SubagentJobSummary[] {
    this.refresh();
    const summaries: SubagentJobSummary[] = [];
    for (const job of this.state.jobs.values()) {
      if (!job.childSessionId || (job.status !== "working" && job.status !== "complete" && job.status !== "error")) continue;
      summaries.push({
        launchId: job.launchId,
        ownerSessionId: job.ownerSessionId,
        toolCallId: job.toolCallId,
        agent: job.agent,
        agentId: job.agentId,
        childSessionId: job.childSessionId,
        status: job.status,
        ...(job.latestAssistantText === undefined ? {} : { latestMessage: job.latestAssistantText }),
      });
    }
    return summaries;
  }

  publish(event: SubagentSupervisorEvent): void {
    const publicEvent: SubagentSupervisorEvent = {
      type: "subagent_supervisor",
      launchId: event.launchId,
      ownerSessionId: event.ownerSessionId,
      toolCallId: event.toolCallId,
      agent: event.agent,
      agentId: event.agentId,
      childSessionId: event.childSessionId,
      status: event.status,
      ...(event.latestMessage === undefined ? {} : { latestMessage: event.latestMessage }),
      ...(event.event === undefined ? {} : { event: event.event }),
    };
    for (const listener of this.listeners) {
      try {
        listener(publicEvent);
      } catch {
        // Supervisor listeners observe state; they never control job ownership.
      }
    }
  }

  subscribe(listener: (event: SubagentSupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginClosing(): void {
    this.closing = true;
  }

  getRootSessionManager(): CoordinatorSessionManager {
    return this.rootSessionManager;
  }

  getPaperAssistantModel(): string | undefined {
    return this.paperAssistantState?.model();
  }

  getPaperAssistantThinking(): string | undefined {
    return this.paperAssistantState?.thinking();
  }

  bindPaperAssistantState(read: { model(): string | undefined; thinking(): string | undefined }): void {
    this.paperAssistantState = read;
  }

  private append(record: SubagentJobJournalRecord): void {
    this.rootSessionManager.appendCustomEntry(SUBAGENT_JOB_ENTRY, record);
    this.refresh();
  }

  private refresh(): void {
    this.state = readSubagentJournal(this.rootSessionManager.getEntries());
  }

  private nextLaunchId(): string {
    let launchId = randomUUID();
    while (this.state.jobs.has(launchId)) launchId = randomUUID();
    return launchId;
  }
}
