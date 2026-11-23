import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resultContent, type ManagedShellService } from "../../background/shell";
import { backgroundProgressDescription } from "./progress";

export const shellInputSchema = Type.Object({
  command: Type.String({ description: "Shell command string to execute" }),
  workdir: Type.Optional(Type.String({ description: "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead." })),
  timeout: Type.Optional(Type.Integer({ minimum: 0, description: "Timeout in milliseconds. Foreground omitted/zero waits 120000 ms then backgrounds the same command. For explicit background execution, a positive timeout stops the command; omitted/zero is unlimited." })),
  background: Type.Optional(Type.Boolean({ description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." })),
});

export interface ManagedShellExtensionOptions {
  manager: ManagedShellService;
  /** Read current native identity at invocation, including after idle reload. */
  owner: () => { sessionID: string; cwd: string };
}

export function createManagedShellTool(options: ManagedShellExtensionOptions) {
  const os = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  return defineTool({
    name: "shell", label: "Shell",
    description: [
      "Execute a shell command and return its output.",
      `Commands run on ${os} using ${process.platform === "win32" ? "PowerShell" : "a compatible local shell (bash by default)"}.`,
      "Quote file paths containing spaces or special characters.",
      "Prefer dedicated tools over shell commands when possible.",
      "When output is large, the full result is saved to a file and a truncated preview is returned.",
      "Rely on automatic truncation unless filtering the output is more useful.",
      "Foreground commands still running after their wait timeout move to the background.",
      "Background commands return immediately, and you will be notified when they complete.",
      backgroundProgressDescription,
      "The current session ID is available in the EASYRESEARCH_SESSION_ID environment variable.",
    ].join(" "),
    parameters: shellInputSchema,
    async execute(toolCallID, input, signal, _onUpdate, context) {
      // Earlier tool results in this batch may already have advanced the leaf.
      // Bind the actual assistant row, not a reused provider ID or the latest row.
      const branch = context.sessionManager.getBranch();
      let assistantEntryId: string | undefined;
      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index]!;
        if (entry.type !== "message" || entry.message.role !== "assistant"
          || entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
        if (entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallID && part.name === "shell")) {
          assistantEntryId = entry.id;
          break;
        }
      }
      const result = await options.manager.execute(options.owner().sessionID, input, signal, { toolCallID, ...(assistantEntryId ? { assistantEntryId } : {}) });
      return { content: [{ type: "text", text: resultContent(result) }], details: result,
        isError: result.status === "error" || result.status === "cancelled" };
    },
  });
}

/** Lifetime belongs to the root manager, not an extension reload or view. */
export function createManagedShellExtension(options: ManagedShellExtensionOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => { pi.registerTool(createManagedShellTool(options)); };
}
