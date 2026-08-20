import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readAgentAliases } from "../subagent/agent-alias";
import { readSubagentJournal } from "../subagent/job-journal";
import { AGENT_STATUS_TYPE } from "../subagent/notifications";
import type { RecoverySessionStore } from "../subagent/recovery";
import { readSubagentSessionLinks } from "../subagent/session-links";
import type { ChildSessionSnapshotDto, SubagentSessionSummaryDto } from "./contracts";

interface ReadonlySubagentSession {
  getEntries(): unknown[];
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getCwd(): string;
  getSessionName(): string | undefined;
  getBranch(): Array<{ type: string; message?: AgentMessage }>;
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
    return {
      session: {
        id: child.getSessionId(),
        cwd: child.getCwd(),
        ...(sessionName === undefined ? {} : { sessionName }),
      },
      messages: branchMessages(child),
      subagents: folded.summaries.filter((summary) => summary.ownerSessionId === childSessionId),
    };
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

function branchMessages(session: ReadonlySubagentSession): AgentMessage[] {
  try {
    return session.getBranch()
      .filter((entry): entry is { type: "message"; message: AgentMessage } =>
        entry.type === "message"
        && isAgentMessage(entry.message)
        && !isHiddenStatusMessage(entry.message))
      .map((entry) => entry.message);
  } catch {
    throw notFound(session.getSessionId());
  }
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
