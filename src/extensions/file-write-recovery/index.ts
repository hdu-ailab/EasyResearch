import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

const PREFIX = "Write recovery:";
const SMALL_WRITES = "Supply complete valid path and content arguments. Inspect the target and preserve confirmed content first. For long content, write one smaller section per call to separate temporary fragments, confirm each result, then assemble the verified fragments locally in explicit order. Retry only missing or incomplete sections. The write tool overwrites; repeated write calls to the same path do not append. Do not resend the entire document or publish an incomplete draft.";

/** Guidance supplements evidence; it never declares a failed write successful. */
function recoveryContent(content: (TextContent | ImageContent)[]): (TextContent | ImageContent)[] | undefined {
  const text = content.filter((block): block is TextContent => block.type === "text").map((block) => block.text).join("\n");
  if (content.some(block => block.type === "text" && block.text.startsWith(PREFIX))) return;
  // Validation errors include the attempted document. Classify the diagnostic,
  // not arbitrary prose inside the rejected arguments.
  const diagnostic = text.split("\nReceived arguments:", 1)[0]!;
  let advice: string;
  if (/\b(EACCES|EPERM|EROFS)\b|permission denied|read-only file system/i.test(diagnostic)) {
    advice = "Check target permissions and whether the filesystem is read-only. Use an authorized writable location or report the access blocker; smaller writes do not fix permissions. Preserve existing files.";
  } else if (/\b(ENOSPC|EDQUOT)\b|no space left|disk quota/i.test(diagnostic)) {
    advice = "Check available disk space or quota and report the storage blocker. Preserve existing files; smaller writes do not resolve exhausted storage.";
  } else if (/\b(ENOENT|ENOTDIR|EISDIR|EEXIST|ENAMETOOLONG)\b/i.test(diagnostic)) {
    advice = "Inspect the target path and parent directories. Correct the file/directory conflict or invalid path without overwriting existing work, then retry the intended section.";
  } else if (/abort|cancel/i.test(diagnostic)) {
    advice = "The operation was cancelled. Do not automatically restart it. If the task is later resumed, inspect the file before retrying because a write may already have completed.";
  } else if (/truncat|output token limit|validation failed|invalid.*argument|timed? out|timeout|stream ended|connection.*closed/i.test(diagnostic)) {
    advice = SMALL_WRITES;
  } else {
    advice = "Inspect the original error and target file before retrying. Preserve confirmed content and correct the reported cause; do not assume that a missing final result means no bytes were written. The write tool replaces a file, not appends.";
  }
  return [...content, { type: "text", text: `${PREFIX} ${advice}` }];
}

export function createFileWriteRecoveryExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", (event) => {
      if (event.toolName !== "write" || !event.isError) return;
      const content = recoveryContent(event.content);
      return content ? { content } : undefined;
    });
    // Pi's argument-validation and output-length errors may precede tool
    // execution and bypass tool_result. Enrich the context copy only; never
    // invent a tool result for an aborted provider response.
    pi.on("context", (event) => {
      let changed = false;
      const messages = event.messages.map((message) => {
        if (message.role !== "toolResult" || message.toolName !== "write" || !message.isError) return message;
        const content = recoveryContent(message.content);
        if (!content) return message;
        changed = true;
        return { ...message, content };
      });
      return changed ? { messages } : undefined;
    });
  };
}
