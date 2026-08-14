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
    if (entry.type === "message") {
      const role = entry.message.role;
      if (role === "user" || role === "assistant") {
        out.push({ id: entry.id, parentId: entry.parentId, role, text: messageText(entry.message) });
      } else {
        out.push({ id: entry.id, parentId: entry.parentId, role: "other", text: "" });
      }
    } else if (entry.type === "compaction") {
      out.push({
        id: entry.id,
        parentId: entry.parentId,
        role: "other",
        text: entry.summary,
        firstKeptEntryId: entry.firstKeptEntryId,
      });
    } else if (entry.type === "branch_summary") {
      out.push({ id: entry.id, parentId: entry.parentId, role: "other", text: entry.summary });
    } else {
      out.push({ id: entry.id, parentId: entry.parentId, role: "other", text: "" });
    }
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}
