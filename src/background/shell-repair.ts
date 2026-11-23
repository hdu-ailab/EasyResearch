import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { resultContent, type ShellResult } from "./shell";

interface ShellRepairJournal {
  getSessionId(): string;
  getBranch(): readonly unknown[];
  appendMessage(message: AgentMessage): string;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Restore an accepted process result before the next native model request. */
export function repairRecoveredShellCalls(journal: ShellRepairJournal, repairs: readonly {
  sessionID: string; toolCallID: string; assistantEntryId?: string; toolName?: "shell" | "ssh-bash"; result: ShellResult;
}[]): number {
  const pending = new Map<string, Array<{ entryId?: string; name: string }>>();
  for (const entry of journal.getBranch()) {
    if (!object(entry) || entry.type !== "message" || !object(entry.message)) continue;
    const message = entry.message;
    if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!object(part) || part.type !== "toolCall" || typeof part.id !== "string" || (part.name !== "shell" && part.name !== "ssh-bash")) continue;
        const candidates = pending.get(part.id) ?? [];
        candidates.push({ entryId: typeof entry.id === "string" ? entry.id : undefined, name: part.name });
        pending.set(part.id, candidates);
      }
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const candidates = pending.get(message.toolCallId);
      const index = candidates?.findLastIndex((candidate) => candidate.name === message.toolName) ?? -1;
      if (index >= 0) candidates!.splice(index, 1);
    }
  }
  let repaired = 0;
  for (const repair of repairs) {
    if (repair.sessionID !== journal.getSessionId()) continue;
    const candidates = pending.get(repair.toolCallID) ?? [];
    const toolName = repair.toolName ?? "shell";
    const matching = candidates.filter((candidate) => candidate.name === toolName
      && (repair.assistantEntryId === undefined || candidate.entryId === repair.assistantEntryId));
    if (!matching.length) continue;
    if (matching.length !== 1) throw new Error("Ambiguous interrupted shell tool-call identity.");
    journal.appendMessage({
      role: "toolResult", toolCallId: repair.toolCallID, toolName,
      content: [{ type: "text", text: resultContent(repair.result) }], details: { ...repair.result },
      isError: repair.result.status === "error" || repair.result.status === "cancelled", timestamp: Date.now(),
    });
    candidates.splice(candidates.indexOf(matching[0]!), 1);
    repaired += 1;
  }
  return repaired;
}
