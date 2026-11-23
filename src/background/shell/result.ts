import { constants } from "node:os";
import type { ShellNotification, ShellResult } from "./types";

// Tool prose adapted from the reviewed MIT shell tool reference (ee5fe34e).
export const BACKGROUND_INSTRUCTION = "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes.";

function displayedExitCode(result: ShellResult): number | string {
  if (result.exitCode !== null) return result.exitCode;
  const signal = result.signal === undefined ? undefined : constants.signals[result.signal as NodeJS.Signals];
  return signal === undefined ? "unknown" : `${128 + signal} (${result.signal})`;
}
export function resultNotice(result: ShellResult): string | undefined {
  if (result.killed !== undefined) return result.killed;
  if (result.timeout) {
    const duration = result.timeoutMs && Number.isSafeInteger(result.timeoutMs) && result.timeoutMs > 0 ? ` after ${result.timeoutMs / 1000} seconds` : "";
    return `Command timed out${duration}. If it needs longer and isn't waiting for input, rerun with a larger timeout.\nExit code: ${displayedExitCode(result)}`;
  }
  if (result.status === "cancelled") return "Cancelled";
  if (result.signal !== undefined || (result.exitCode !== null && result.exitCode !== 0)) return `Exit code: ${displayedExitCode(result)}`;
  return undefined;
}
export function resultContent(result: ShellResult): string {
  if (result.status === "cancelled" && result.shellID) {
    const stopped = `Command interrupted by the user (shell ID: ${result.shellID})${result.stopping ? "; it is still being stopped" : ""}.`;
    if (!result.outputPath || result.truncated || result.incomplete) return [result.output, stopped].filter(Boolean).join("\n\n");
    if (result.output === "(no output)") return `[no output; output file: ${result.outputPath}]\n\n${stopped}`;
    return `${result.output.replace(/\n$/, "")}\n\n[full output saved to ${result.outputPath}]\n\n${stopped}`;
  }
  return [result.output, result.status === "running" ? BACKGROUND_INSTRUCTION : resultNotice(result)].filter(Boolean).join("\n\n");
}
export function backgroundResult(record: { id: string; pid?: number; file: string; started: number }, timeout?: number): ShellResult {
  return {
    output: [
      `Command moved to the background (shell ID: ${record.id}).`,
      ...(record.pid ? [`PID: ${record.pid}`] : []),
      `Output is streaming to: ${record.file}`,
      ...(timeout === undefined ? [] : ["", `The command did not finish within its timeout of ${timeout / 1000} seconds and was moved to the background. Do not start another copy while it is running.`]),
    ].join("\n"),
    exitCode: null, status: "running", truncated: false, shellID: record.id,
    pid: record.pid, outputPath: record.file, wallTimeSeconds: (Date.now() - record.started) / 1000,
  };
}
export function shellNotification(record: { id: string; notificationID: string; sessionID: string; command: string; notificationWake?: boolean }, result: ShellResult): ShellNotification {
  const state = result.status === "running" ? "error" : result.status;
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return {
    id: record.notificationID, sessionID: record.sessionID, shellID: record.id, state, result,
    wake: record.notificationWake !== false, recovered: record.notificationWake === false,
    content: `<background-result kind="shell" id="${escape(record.id)}" state="${state}" command="${escape(record.command)}">\n${resultContent(result)}\n</background-result>`,
  };
}
