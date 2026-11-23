import { describe, expect, it } from "vitest";
import { SubagentCoordinator } from "./coordinator";
import { formatBackgroundResult } from "./background-periods";

function fixture() {
  const entries: unknown[] = [];
  const coordinator = new SubagentCoordinator({
    getSessionId: () => "root", getSessionFile: () => "/root.jsonl", getEntries: () => entries,
    appendCustomEntry(customType, data) { entries.push({ type: "custom", customType, data }); return String(entries.length); },
  });
  const agent = { name: "search", enabled: true } as any;
  const catalog = { all: [agent], available: [agent] };
  const reserve = (ownerSessionId = "root", sessionID?: string) => coordinator.reserveDispatch({
    ownerSessionId, toolCallId: String(entries.length), requested: "search", catalog, sessionID, description: "Find primary sources",
  });
  return { coordinator, reserve, entries };
}

describe("background subagent periods", () => {
  it("uses a failure body for an error period without text", () => {
    const report = formatBackgroundResult({ sessionID: "native-child", description: "Check sources", state: "error", outstanding: [] });
    expect(report).toContain('state="error"');
    expect(report).toContain("Subagent failed");
    expect(report).not.toContain("completed");
  });

  it("continues only an immediate child and joins its active period", () => {
    const { coordinator, reserve } = fixture();
    const first = reserve();
    coordinator.recordMaterialized(first, { childSessionId: "native-child", sessionPath: "/child.jsonl" });
    const followup = reserve("root", "native-child");
    expect(followup.launchId).toBe(first.launchId);
    expect(followup.childSessionId).toBe("native-child");
    expect(() => reserve("sibling", "native-child")).toThrow(/immediate|child of/);
  });

  it("commits report and claim release together and never revives a cancelled period", () => {
    const { coordinator, reserve, entries } = fixture();
    const reservation = reserve();
    coordinator.recordMaterialized(reservation, { childSessionId: "native-child", sessionPath: "/child.jsonl" });
    coordinator.recordBackgroundAdmission(reservation.launchId, { cwd: "/project", callerAgent: "research-assistant", description: "Find primary sources" });
    const before = entries.length;
    coordinator.commitBackgroundReport(reservation.launchId, { state: "cancelled", text: "Subagent cancelled", outstanding: [] });
    expect(entries).toHaveLength(before + 1);
    expect(coordinator.journal().pendingBatches).toHaveLength(1);
    expect(coordinator.journal().jobs.get(reservation.launchId)?.terminalStatus).toBe("error");
    expect(coordinator.claimBackgroundRestart(reservation.launchId)).toBe(false);
  });

  it("charges at most ten durable restart attempts per period", () => {
    const { coordinator, reserve } = fixture();
    const reservation = reserve();
    coordinator.recordMaterialized(reservation, { childSessionId: "native-child", sessionPath: "/child.jsonl" });
    coordinator.recordBackgroundAdmission(reservation.launchId, { cwd: "/project", callerAgent: "research-assistant", description: "Find primary sources" });
    for (let i = 0; i < 10; i++) expect(coordinator.claimBackgroundRestart(reservation.launchId)).toBe(true);
    expect(coordinator.claimBackgroundRestart(reservation.launchId)).toBe(false);
  });

  it("reports remaining work without conflating idle and subtree completion", () => {
    const text = formatBackgroundResult({ sessionID: "native-child", description: 'Check "sources"', state: "completed", text: "Current period only", outstanding: [{ id: "shell-1", kind: "shell", sessionID: "native-child", description: "Training", status: "running", blocking: false }] });
    expect(text).toContain('state="running"');
    expect(text).toContain("&quot;sources&quot;");
    expect(text).toContain("shell-1");
    expect(text).toContain("Current period only");
  });
});
