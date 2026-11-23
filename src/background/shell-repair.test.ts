import { describe, expect, it } from "vitest";
import { repairRecoveredShellCalls } from "./shell-repair";

const repair = { sessionID: "root", toolCallID: "call-a", result: { output: "running", exitCode: null, wallTimeSeconds: 1, status: "running" as const, truncated: false, shellID: "shell-a" } };
const call = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "shell", arguments: { command: "build" } }] } };

describe("recovered foreground shell calls", () => {
  it("repairs only an unpaired accepted shell and is idempotent on the native branch", () => {
    const entries: unknown[] = [call];
    const store = { getSessionId: () => "root", getBranch: () => entries,
      appendMessage(message: unknown) { entries.push({ type: "message", message }); return "result"; } };
    expect(repairRecoveredShellCalls(store, [repair])).toBe(1);
    expect(entries[1]).toMatchObject({ message: { role: "toolResult", toolCallId: "call-a", toolName: "shell", isError: false } });
    expect(repairRecoveredShellCalls(store, [repair])).toBe(0);
    expect(entries).toHaveLength(2);
  });

  it("never manufactures a call for another owner or for absent branch history", () => {
    const entries: unknown[] = [call];
    const store = { getSessionId: () => "root", getBranch: () => entries,
      appendMessage() { throw new Error("unexpected mutation"); } };
    expect(repairRecoveredShellCalls(store, [{ ...repair, sessionID: "child" }, { ...repair, toolCallID: "absent" }])).toBe(0);
  });

  it("uses native assistant identity when a provider reused a call id", () => {
    const entries: unknown[] = [
      { ...call, id: "old" },
      { type: "message", message: { role: "toolResult", toolCallId: "call-a", toolName: "shell" } },
      { ...call, id: "interrupted" },
    ];
    const store = { getSessionId: () => "root", getBranch: () => entries,
      appendMessage(message: unknown) { entries.push({ type: "message", message }); return "result"; } };
    expect(repairRecoveredShellCalls(store, [{ ...repair, assistantEntryId: "old" }])).toBe(0);
    expect(repairRecoveredShellCalls(store, [{ ...repair, assistantEntryId: "interrupted" }])).toBe(1);
  });

  it("ignores skipped calls from failed responses and unrelated duplicate ids", () => {
    const entries: unknown[] = [
      { ...call, id: "failed", message: { ...call.message, stopReason: "error" } },
      { type: "message", id: "other", message: { role: "assistant", content: [
        { type: "toolCall", id: "same", name: "read" }, { type: "toolCall", id: "same", name: "read" },
      ] } },
      { ...call, id: "actual" },
    ];
    const store = { getSessionId: () => "root", getBranch: () => entries,
      appendMessage(message: unknown) { entries.push({ type: "message", message }); return "result"; } };
    expect(repairRecoveredShellCalls(store, [{ ...repair, assistantEntryId: "actual" }])).toBe(1);
  });

  it("repairs an interrupted managed SSH call under its real registered tool name", () => {
    const entries: unknown[] = [{ type: "message", id: "remote", message: { role: "assistant", content: [
      { type: "toolCall", id: "call-a", name: "ssh-bash", arguments: { action: "run", command: "train" } },
    ] } }];
    const store = { getSessionId: () => "root", getBranch: () => entries,
      appendMessage(message: unknown) { entries.push({ type: "message", message }); return "result"; } };
    expect(repairRecoveredShellCalls(store, [repair])).toBe(0);
    expect(repairRecoveredShellCalls(store, [{ ...repair, assistantEntryId: "remote", toolName: "ssh-bash" }])).toBe(1);
    expect(entries[1]).toMatchObject({ message: { toolName: "ssh-bash", toolCallId: "call-a" } });
  });
});
