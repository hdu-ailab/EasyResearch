import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import type { WebTreeEntryDto } from "./contracts";

function messageText(message: AgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Flatten a pi session tree into DTO entries, depth-first, keeping EVERY
 * entry so parent chains stay intact (ADR-066).
 *
 * Role mapping mirrors how the Web transcript treats each entry:
 * - `user`/`assistant` messages appear as bubbles in the transcript.
 * - `toolResult`/`bashExecution`/`system`/`compaction`/`branch_summary`/
 *   `custom_message`/`custom`/`thinking_level_change`/`model_change`/`label`/
 *   `session_info` map to `other`: they never zip onto transcript bubbles,
 *   but their nodes must remain so the leaf-path walk and version groups work.
 * - `compaction` carries `firstKeptEntryId` so the frontend can mirror pi's
 *   `buildContextEntries` (summarized entries are omitted from the context).
 */
export function flattenMessageTree(nodes: SessionTreeNode[]): WebTreeEntryDto[] {
  const out: WebTreeEntryDto[] = [];
  const visit = (node: SessionTreeNode): void => {
    const entry = node.entry;
    const nodeMeta = {
      ...(node.label !== undefined ? { label: node.label } : {}),
      ...(node.labelTimestamp !== undefined ? { labelTimestamp: node.labelTimestamp } : {}),
    };
    if (entry.type === "message") {
      const role = entry.message.role;
      if (role === "user" || role === "assistant") {
        const message = entry.message as AgentMessage & { stopReason?: string; errorMessage?: string };
        out.push({
          id: entry.id,
          parentId: entry.parentId,
          role,
          kind: role,
          text: messageText(entry.message),
          ...nodeMeta,
          ...(message.stopReason !== undefined ? { stopReason: message.stopReason } : {}),
          ...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
        });
      } else if (role === "toolResult") {
        out.push({
          id: entry.id,
          parentId: entry.parentId,
          role: "other",
          kind: "tool",
          text: messageText(entry.message),
          ...nodeMeta,
        });
      } else if (role === "bashExecution") {
        const command = "command" in entry.message && typeof entry.message.command === "string"
          ? entry.message.command
          : "";
        out.push({ id: entry.id, parentId: entry.parentId, role: "other", kind: "bash", text: command, ...nodeMeta });
      } else {
        out.push({
          id: entry.id,
          parentId: entry.parentId,
          role: "other",
          kind: "message",
          text: messageText(entry.message),
          ...nodeMeta,
        });
      }
    } else if (entry.type === "compaction") {
      out.push({
        id: entry.id,
        parentId: entry.parentId,
        role: "other",
        kind: "compaction",
        text: entry.summary,
        firstKeptEntryId: entry.firstKeptEntryId,
        tokensBefore: entry.tokensBefore,
        ...nodeMeta,
      });
    } else if (entry.type === "branch_summary") {
      out.push({
        id: entry.id,
        parentId: entry.parentId,
        role: "other",
        kind: "branch-summary",
        text: entry.summary,
        ...nodeMeta,
      });
    } else if (entry.type === "custom_message") {
      const content = typeof entry.content === "string"
        ? entry.content
        : messageText({ role: "custom", content: entry.content } as AgentMessage);
      out.push({
        id: entry.id,
        parentId: entry.parentId,
        role: "other",
        kind: "custom-message",
        text: content,
        ...nodeMeta,
      });
    } else if (entry.type === "model_change") {
      out.push({ id: entry.id, parentId: entry.parentId, role: "other", kind: "model-change", text: entry.modelId, ...nodeMeta });
    } else if (entry.type === "thinking_level_change") {
      out.push({
        id: entry.id,
        parentId: entry.parentId,
        role: "other",
        kind: "thinking-change",
        text: entry.thinkingLevel,
        ...nodeMeta,
      });
    } else if (entry.type === "session_info") {
      out.push({ id: entry.id, parentId: entry.parentId, role: "other", kind: "session-info", text: entry.name ?? "", ...nodeMeta });
    } else if (entry.type === "custom") {
      out.push({ id: entry.id, parentId: entry.parentId, role: "other", kind: "custom", text: entry.customType, ...nodeMeta });
    } else if (entry.type === "label") {
      out.push({ id: entry.id, parentId: entry.parentId, role: "other", kind: "label", text: entry.label ?? "", ...nodeMeta });
    }
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}
