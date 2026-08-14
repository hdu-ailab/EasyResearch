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

/** Flatten a pi session tree into message-only DTO entries, depth-first. */
export function flattenMessageTree(nodes: SessionTreeNode[]): WebTreeEntryDto[] {
  const out: WebTreeEntryDto[] = [];
  const visit = (node: SessionTreeNode): void => {
    const entry = node.entry;
    if (entry.type === "message") {
      out.push({
        id: entry.id,
        parentId: entry.parentId,
        role: entry.message.role === "user" ? "user" : "assistant",
        text: messageText(entry.message),
      });
    }
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}
