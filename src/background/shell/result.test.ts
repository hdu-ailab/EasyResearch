import { describe, expect, it } from "vitest";
import { backgroundResult, resultContent, resultNotice, shellNotification } from "./result";
import type { ShellResult } from "./types";

function completed(values: Partial<ShellResult> = {}): ShellResult {
  return { output: "captured output", status: "completed", exitCode: 0, truncated: false, wallTimeSeconds: 42, ...values };
}

describe("shell result notices", () => {
  it.each([
    [{ exitCode: 0 }, undefined],
    [{ exitCode: 7 }, "Exit code: 7"],
    [{ exitCode: null, signal: "SIGTERM" }, "Exit code: 143 (SIGTERM)"],
    [{ exitCode: null, signal: "SIGKILL" }, "Exit code: 137 (SIGKILL)"],
    [{ exitCode: 23, signal: "SIGTERM" }, "Exit code: 23"],
    [{ exitCode: null, signal: "UNRECOGNIZED" }, "Exit code: unknown"],
  ] satisfies [Partial<ShellResult>, string | undefined][])("formats the reported exit without inventing structured metadata: %j", (fields, notice) => {
    const result = Object.freeze(completed(fields));
    expect(resultNotice(result)).toBe(notice);
    expect(result.exitCode).toBe(fields.exitCode);
  });

  it.each([undefined, 1250])("includes timeout recovery advice with only a known duration (%s)", (timeoutMs) => {
    const result = completed({ exitCode: null, signal: "SIGTERM", timeout: true, ...(timeoutMs ? { timeoutMs } : {}) });
    const duration = timeoutMs ? " after 1.25 seconds" : "";
    expect(resultNotice(result)).toBe(`Command timed out${duration}. If it needs longer and isn't waiting for input, rerun with a larger timeout.\nExit code: 143 (SIGTERM)`);
    expect(resultContent(result)).toContain("captured output\n\nCommand timed out");
    expect(result.exitCode).toBeNull();
    expect(resultNotice(result)).not.toContain("42 seconds");
  });

  it("keeps an actual custody failure ahead of generic timeout/exit advice", () => {
    expect(resultNotice(completed({ killed: "Worker custody was lost.", timeout: true, exitCode: null }))).toBe("Worker custody was lost.");
  });

  it("identifies an interrupted foreground command and its complete captured output", () => {
    const result = completed({ status: "cancelled", exitCode: null, signal: "SIGTERM", shellID: "shell_stop", outputPath: "/owned/output", output: "first\nlast\n" });
    expect(resultContent(result)).toBe("first\nlast\n\n[full output saved to /owned/output]\n\nCommand interrupted by the user (shell ID: shell_stop).");
    expect(result.exitCode).toBeNull();
  });

  it("reports a silent interruption once, with the retained output file", () => {
    expect(resultContent(completed({ status: "cancelled", exitCode: null, shellID: "shell_silent", outputPath: "/owned/empty", output: "(no output)" })))
      .toBe("[no output; output file: /owned/empty]\n\nCommand interrupted by the user (shell ID: shell_silent).");
  });

  it.each([true, false])("preserves incomplete capture without claiming cleanup finished (stopping: %s)", (stopping) => {
    const output = "partial tail\n\n[Output capture is incomplete: inherited writer remains. Captured output: /owned/partial]";
    const result = completed({ status: "cancelled", exitCode: null, shellID: "shell_partial", outputPath: "/owned/partial", output, truncated: true, incomplete: true, stopping });
    expect(resultContent(result)).toBe(`${output}\n\nCommand interrupted by the user (shell ID: shell_partial)${stopping ? "; it is still being stopped" : ""}.`);
    expect(resultContent(result)).not.toContain("full output saved");
  });

  it("carries timeout advice into the durable notification while background promotion still forbids duplicate launch", () => {
    const result = completed({ timeout: true, exitCode: null, signal: "SIGTERM" });
    const notification = shellNotification({ id: "shell_bg", notificationID: "notice", sessionID: "root", command: "work" }, result);
    expect(notification.content).toContain("rerun with a larger timeout");
    expect(notification.result.exitCode).toBeNull();
    const running = resultContent(backgroundResult({ id: "shell_bg", file: "/owned/out", started: Date.now() }, 100));
    expect(running).toContain("Do not start another copy while it is running.");
    expect(running).toContain("DO NOT poll for completion");
    expect(running).not.toContain("rerun with a larger timeout");
  });
});
