import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readSubagentSessionLinks } from "../subagent/session-links";
import type { ChildSessionSnapshotDto, SubagentSessionSummaryDto } from "./contracts";

interface ReadonlySubagentSession {
  getEntries(): unknown[];
  getSessionId(): string;
  getCwd(): string;
  getSessionName(): string | undefined;
  getBranch(): Array<{ type: string; message?: AgentMessage }>;
}

export interface SubagentSessionStore {
  open(path: string): ReadonlySubagentSession;
  listAll(): Promise<Array<{ id: string; path: string; cwd: string }>>;
}

export class SubagentSessionNotFoundError extends Error {}

export class SubagentSessionService {
  constructor(private readonly store: SubagentSessionStore) {}

  async summaries(parentSessionId: string): Promise<SubagentSessionSummaryDto[]> {
    const { parent, sessions } = await this.parent(parentSessionId);
    const summaries: SubagentSessionSummaryDto[] = [];

    for (const link of readSubagentSessionLinks(parent.manager.getEntries())) {
      try {
        const child = this.child(sessions, link.childSessionId, parent.cwd);
        const messages = branchMessages(child);
        const latestMessage = latestAssistantText(messages);
        summaries.push(latestMessage ? { ...link, latestMessage } : link);
      } catch (error) {
        if (!(error instanceof SubagentSessionNotFoundError)) throw error;
        summaries.push(link);
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
