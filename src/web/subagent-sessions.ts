import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readAgentAliases } from "../subagent/agent-alias";
import type { RecoverySessionStore } from "../subagent/recovery";
import { readSubagentSessionLinks } from "../subagent/session-links";
import type { ChildSessionSnapshotDto, SubagentSessionSummaryDto } from "./contracts";

interface ReadonlySubagentSession {
  getEntries(): unknown[];
  getSessionId(): string;
  getCwd(): string;
  getSessionName(): string | undefined;
  getBranch(): Array<{ type: string; message?: AgentMessage }>;
}

interface RecoverySessionManager extends ReadonlySubagentSession {
  getSessionFile(): string | undefined;
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
    const manager = rootPath === path ? input.rootSession : input.open(path);
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
      const manager = openExact(path);
      if (manager.getSessionId() !== expected.sessionId || manager.getCwd() !== expected.cwd) {
        throw new Error("Recovery owner session UUID or cwd changed after inspection.");
      }
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
    let resolved: Awaited<ReturnType<SubagentSessionService["parent"]>>;
    try {
      resolved = await this.parent(parentSessionId);
    } catch (error) {
      if (error instanceof SubagentSessionNotFoundError) return [];
      throw error;
    }
    const { parent, sessions } = resolved;
    const summaries: SubagentSessionSummaryDto[] = [];
    const idBySession = new Map<string, string>();
    for (const alias of readAgentAliases(parent.manager.getEntries())) {
      idBySession.set(alias.sessionId, alias.id);
    }

    for (const link of readSubagentSessionLinks(parent.manager.getEntries())) {
      try {
        const child = this.child(sessions, link.childSessionId, parent.cwd);
        const messages = branchMessages(child);
        const latestMessage = latestAssistantText(messages);
        const id = idBySession.get(link.childSessionId);
        summaries.push({
          ...link,
          ...(id !== undefined ? { id } : {}),
          ...(latestMessage !== undefined ? { latestMessage } : {}),
        });
      } catch (error) {
        if (!(error instanceof SubagentSessionNotFoundError)) throw error;
        const id = idBySession.get(link.childSessionId);
        summaries.push(id !== undefined ? { ...link, id } : link);
      }
    }

    return summaries;
  }

  async snapshot(parentSessionId: string, childSessionId: string): Promise<ChildSessionSnapshotDto> {
    const { parent, sessions } = await this.parent(parentSessionId);
    const mapped = readSubagentSessionLinks(parent.manager.getEntries())
      .some((link) => link.childSessionId === childSessionId);
    if (!mapped) throw notFound(childSessionId);

    const child = this.child(sessions, childSessionId, parent.cwd);
    const sessionName = child.getSessionName();
    return {
      session: {
        id: child.getSessionId(),
        cwd: child.getCwd(),
        ...(sessionName === undefined ? {} : { sessionName }),
      },
      messages: branchMessages(child),
    };
  }

  private async parent(parentSessionId: string): Promise<{
    parent: { cwd: string; manager: ReadonlySubagentSession };
    sessions: Array<{ id: string; path: string; cwd: string }>;
  }> {
    const sessions = await this.store.listAll();
    const info = sessions.find((session) => session.id === parentSessionId);
    if (!info) throw notFound(parentSessionId);

    const manager = this.open(info.path, parentSessionId, info.cwd);
    return { parent: { cwd: info.cwd, manager }, sessions };
  }

  private child(
    sessions: Array<{ id: string; path: string; cwd: string }>,
    childSessionId: string,
    parentCwd: string,
  ): ReadonlySubagentSession {
    const info = sessions.find((session) => session.id === childSessionId);
    if (!info || info.cwd !== parentCwd) throw notFound(childSessionId);
    return this.open(info.path, childSessionId, parentCwd);
  }

  private open(path: string, expectedId: string, expectedCwd: string): ReadonlySubagentSession {
    try {
      const manager = this.store.open(path);
      if (manager.getSessionId() !== expectedId || manager.getCwd() !== expectedCwd) {
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
        entry.type === "message" && isAgentMessage(entry.message))
      .map((entry) => entry.message);
  } catch {
    throw notFound(session.getSessionId());
  }
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
