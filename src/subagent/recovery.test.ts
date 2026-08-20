import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./agents";
import { SubagentCoordinator, type CoordinatorSessionManager, type ReservedDispatch } from "./coordinator";
import {
  recoverSubagentTree,
  type RecoverySessionStore,
  type SubagentRecoveryReport,
} from "./recovery";

const searchAgent: AgentConfig = {
  name: "search",
  description: "Search",
  enabled: true,
  builtin: true,
  source: "bundled",
  filePath: "/agents/search.md",
  systemPrompt: "Search carefully.",
  tools: ["read"],
  effectiveTools: ["read"],
  skills: ["paper-search"],
  effectiveSkills: ["paper-search"],
  missingSkills: [],
  subagents: [],
};

class MemoryCoordinatorSessionManager implements CoordinatorSessionManager {
  readonly entries: unknown[] = [];
  private sequence = 0;

  constructor(
    private readonly sessionId = "root",
    private readonly sessionFile = "/sessions/root.jsonl",
  ) {}

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string {
    return this.sessionFile;
  }

  getEntries(): unknown[] {
    return this.entries;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const id = `entry-${this.sequence++}`;
    this.entries.push({ type: "custom", id, customType, data });
    return id;
  }
}

interface Inspection {
  readable: boolean;
  sessionId?: string;
  cwd?: string;
  latestAssistantText?: string;
}

interface HiddenMessage {
  customType: string;
  content: string;
  display: false;
  details: { batchId: string };
}

class MemoryRecoveryStore implements RecoverySessionStore {
  readonly inspectCalls: string[] = [];
  readonly appendAttempts: Array<{ path: string; message: HiddenMessage }> = [];
  readonly hidden = new Map<string, HiddenMessage[]>();
  appendError?: Error;

  constructor(readonly inspected = new Map<string, Inspection>()) {}

  async inspect(path: string): Promise<Inspection> {
    this.inspectCalls.push(path);
    return this.inspected.get(path) ?? { readable: false };
  }

  async appendHiddenMessage(path: string, message: HiddenMessage): Promise<void> {
    this.appendAttempts.push({ path, message });
    if (this.appendError) throw this.appendError;
    const messages = this.hidden.get(path) ?? [];
    const existing = messages.find((candidate) => candidate.details.batchId === message.details.batchId);
    if (existing) {
      if (existing.content !== message.content) throw new Error("Persisted batch content mismatch");
      return;
    }
    messages.push(message);
    this.hidden.set(path, messages);
  }
}

function reserve(
  coordinator: SubagentCoordinator,
  input: { ownerSessionId?: string; toolCallId?: string } = {},
): ReservedDispatch {
  return coordinator.reserveDispatch({
    ownerSessionId: input.ownerSessionId ?? "root",
    toolCallId: input.toolCallId ?? "tool-0",
    requested: "search",
    catalog: { all: [searchAgent], available: [searchAgent] },
  });
}

function materialize(
  coordinator: SubagentCoordinator,
  reservation: ReservedDispatch,
  childSessionId: string,
  sessionPath: string,
  acknowledge = true,
): void {
  const child = { childSessionId, sessionPath };
  coordinator.recordChildCreated(reservation, child);
  coordinator.recordMaterialized(reservation, child);
  if (acknowledge) coordinator.recordLaunchAcknowledged(reservation.launchId);
}

async function recover(
  coordinator: SubagentCoordinator,
  store: MemoryRecoveryStore,
): Promise<SubagentRecoveryReport> {
  return recoverSubagentTree({
    coordinator,
    store,
    expectedCwd: "/paper",
    now: () => "2026-08-19T00:00:00.000Z",
  });
}

describe("recoverSubagentTree", () => {
  it("recovers a readable nonterminal launch as a no-trigger Error with available final text", async () => {
    const manager = new MemoryCoordinatorSessionManager();
    const coordinator = new SubagentCoordinator(manager);
    const job = reserve(coordinator);
    materialize(coordinator, job, "child", "/sessions/child.jsonl");
    const store = new MemoryRecoveryStore(new Map([
      ["/sessions/child.jsonl", {
        readable: true,
        sessionId: "child",
        cwd: "/paper",
        latestAssistantText: "partial work",
      }],
      ["/sessions/root.jsonl", { readable: true, sessionId: "root", cwd: "/paper" }],
    ]));

    const report = await recover(coordinator, store);

    expect(report.interruptedLaunchIds).toEqual([job.launchId]);
    expect(report.unmaterializedLaunchIds).toEqual([]);
    expect(report.notifications).toEqual([expect.objectContaining({
      ownerSessionId: "root",
      triggerTurn: false,
    })]);
    expect(report.notifications[0]?.content).toContain(
      'Error subagent:{"name":"search_0","session_path":"/sessions/child.jsonl"}',
    );
    expect(report.notifications[0]?.content).toContain("Agent: search_0\nResult: partial work");
    expect(coordinator.journal().jobs.get(job.launchId)).toMatchObject({
      status: "error",
      terminalStatus: "error",
      latestAssistantText: "partial work",
    });
    expect(report.acknowledgedBatchIds).toHaveLength(1);
    expect(coordinator.journal().pendingBatches).toEqual([]);
  });

  it("finalizes an unmaterialized reservation without inspecting or fabricating a path notification", async () => {
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const job = reserve(coordinator);
    const store = new MemoryRecoveryStore();

    const report = await recover(coordinator, store);

    expect(report.unmaterializedLaunchIds).toEqual([job.launchId]);
    expect(report.interruptedLaunchIds).toEqual([]);
    expect(report.notifications).toEqual([]);
    expect(store.inspectCalls).toEqual([]);
    expect(store.appendAttempts).toEqual([]);
    expect(coordinator.journal().jobs.get(job.launchId)?.status).toBe("pre_materialization_failed");
  });

  it.each([
    ["wrong UUID", { readable: true, sessionId: "other-child", cwd: "/paper" }],
    ["wrong cwd", { readable: true, sessionId: "child", cwd: "/other-paper" }],
    ["unreadable path", { readable: false }],
  ] as const)("finalizes a materialized reservation with %s without a path notification", async (_label, inspected) => {
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const job = reserve(coordinator);
    materialize(coordinator, job, "child", "/sessions/exact-child.jsonl");
    const store = new MemoryRecoveryStore(new Map([["/sessions/exact-child.jsonl", inspected]]));

    const report = await recover(coordinator, store);

    expect(report.unmaterializedLaunchIds).toEqual([job.launchId]);
    expect(report.interruptedLaunchIds).toEqual([]);
    expect(report.notifications).toEqual([]);
    expect(store.inspectCalls).toEqual(["/sessions/exact-child.jsonl"]);
    expect(store.appendAttempts).toEqual([]);
    expect(coordinator.journal().jobs.get(job.launchId)?.status).toBe("pre_materialization_failed");
  });

  it("leaves an acknowledged terminal launch untouched and does not inspect its path", async () => {
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const job = reserve(coordinator);
    materialize(coordinator, job, "child", "/sessions/child.jsonl");
    coordinator.recordTerminal({ launchId: job.launchId, status: "complete", latestAssistantText: "done" });
    coordinator.recordNotificationBatch({
      batchId: "acknowledged-batch",
      ownerSessionId: "root",
      launchIds: [job.launchId],
      content: "already delivered",
      triggerTurn: true,
    });
    coordinator.acknowledgeNotification("acknowledged-batch");
    const store = new MemoryRecoveryStore();

    await expect(recover(coordinator, store)).resolves.toEqual({
      interruptedLaunchIds: [],
      unmaterializedLaunchIds: [],
      acknowledgedBatchIds: [],
      notifications: [],
    });
    expect(store.inspectCalls).toEqual([]);
    expect(store.appendAttempts).toEqual([]);
  });

  it("promotes a persisted Complete recorded before launch acknowledgement without interruption reclassification", async () => {
    const manager = new MemoryCoordinatorSessionManager();
    const coordinator = new SubagentCoordinator(manager);
    const job = reserve(coordinator);
    materialize(coordinator, job, "child", "/sessions/child.jsonl", false);
    coordinator.recordTerminal({
      launchId: job.launchId,
      status: "complete",
      latestAssistantText: "completed before acknowledgement",
    });
    const store = new MemoryRecoveryStore(new Map([
      ["/sessions/root.jsonl", { readable: true, sessionId: "root", cwd: "/paper" }],
    ]));

    const first = await recover(coordinator, store);
    const entriesAfterFirst = manager.entries.length;
    const appendAttemptsAfterFirst = store.appendAttempts.length;
    const second = await recover(coordinator, store);

    expect(first.interruptedLaunchIds).toEqual([]);
    expect(first.unmaterializedLaunchIds).toEqual([]);
    expect(first.notifications).toEqual([expect.objectContaining({
      ownerSessionId: "root",
      triggerTurn: false,
      content: expect.stringContaining("Complete subagent:search_0"),
    })]);
    expect(first.notifications[0]?.content).toContain(
      "Agent: search_0\nResult: completed before acknowledgement",
    );
    expect(store.inspectCalls).toEqual(["/sessions/root.jsonl"]);
    expect(coordinator.journal().jobs.get(job.launchId)).toMatchObject({
      status: "complete",
      terminalStatus: "complete",
      terminalRecovered: true,
      launchAcknowledged: false,
    });
    expect(manager.entries).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({
        kind: "terminal",
        launchId: job.launchId,
        status: "complete",
        recovered: true,
      }),
    }));
    expect(second).toEqual({
      interruptedLaunchIds: [],
      unmaterializedLaunchIds: [],
      acknowledgedBatchIds: [],
      notifications: [],
    });
    expect(manager.entries).toHaveLength(entriesAfterFirst);
    expect(store.appendAttempts).toHaveLength(appendAttemptsAfterFirst);
  });

  it("promotes a persisted Error recorded before launch acknowledgement without replacing its failure", async () => {
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const job = reserve(coordinator);
    materialize(coordinator, job, "child", "/sessions/child.jsonl", false);
    coordinator.recordTerminal({
      launchId: job.launchId,
      status: "error",
      latestAssistantText: "partial evidence",
      errorMessage: "provider failed",
    });
    const store = new MemoryRecoveryStore(new Map([
      ["/sessions/root.jsonl", { readable: true, sessionId: "root", cwd: "/paper" }],
    ]));

    const report = await recover(coordinator, store);

    expect(report.interruptedLaunchIds).toEqual([]);
    expect(report.unmaterializedLaunchIds).toEqual([]);
    expect(report.notifications).toEqual([expect.objectContaining({
      triggerTurn: false,
      content: expect.stringContaining(
        'Error subagent:{"name":"search_0","session_path":"/sessions/child.jsonl"}',
      ),
    })]);
    expect(store.inspectCalls).toEqual(["/sessions/root.jsonl"]);
    expect(coordinator.journal().jobs.get(job.launchId)).toMatchObject({
      status: "error",
      terminalStatus: "error",
      terminalRecovered: true,
      launchAcknowledged: false,
      latestAssistantText: "partial evidence",
      errorMessage: "provider failed",
    });
  });

  it("delivers an already terminal but unnotified outcome without duplicating its terminal record", async () => {
    const manager = new MemoryCoordinatorSessionManager();
    const coordinator = new SubagentCoordinator(manager);
    const job = reserve(coordinator);
    materialize(coordinator, job, "child", "/sessions/child.jsonl");
    coordinator.recordTerminal({ launchId: job.launchId, status: "complete", latestAssistantText: "done" });
    const terminalCount = manager.entries.filter((entry) =>
      typeof entry === "object"
      && entry !== null
      && "data" in entry
      && typeof entry.data === "object"
      && entry.data !== null
      && "kind" in entry.data
      && entry.data.kind === "terminal").length;
    const store = new MemoryRecoveryStore(new Map([
      ["/sessions/root.jsonl", { readable: true, sessionId: "root", cwd: "/paper" }],
    ]));

    const report = await recover(coordinator, store);

    expect(report.interruptedLaunchIds).toEqual([]);
    expect(report.notifications).toEqual([expect.objectContaining({
      ownerSessionId: "root",
      triggerTurn: false,
      content: expect.stringContaining("Complete subagent:search_0"),
    })]);
    expect(manager.entries.filter((entry) =>
      typeof entry === "object"
      && entry !== null
      && "data" in entry
      && typeof entry.data === "object"
      && entry.data !== null
      && "kind" in entry.data
      && entry.data.kind === "terminal")).toHaveLength(terminalCount);
  });

  it("does not replay a superseded batch and replaces its still-unnotified outcome once", async () => {
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const job = reserve(coordinator);
    materialize(coordinator, job, "child", "/sessions/child.jsonl");
    coordinator.recordTerminal({ launchId: job.launchId, status: "complete", latestAssistantText: "done" });
    coordinator.recordNotificationBatch({
      batchId: "superseded-batch",
      ownerSessionId: "root",
      launchIds: [job.launchId],
      content: "obsolete trigger-turn batch",
      triggerTurn: true,
    });
    coordinator.supersedeNotification("superseded-batch");
    const store = new MemoryRecoveryStore(new Map([
      ["/sessions/root.jsonl", { readable: true, sessionId: "root", cwd: "/paper" }],
    ]));

    const report = await recover(coordinator, store);

    expect(report.acknowledgedBatchIds).toHaveLength(1);
    expect(report.acknowledgedBatchIds).not.toContain("superseded-batch");
    expect(report.notifications[0]?.content).toContain("Complete subagent:search_0");
    expect(report.notifications[0]?.content).not.toContain("obsolete trigger-turn batch");
    expect(coordinator.journal().supersededBatchIds).toContain("superseded-batch");
    expect(store.hidden.get("/sessions/root.jsonl")).toHaveLength(1);
  });

  it("acknowledges an inserted persisted batch without appending a duplicate", async () => {
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const job = reserve(coordinator);
    materialize(coordinator, job, "child", "/sessions/child.jsonl");
    coordinator.recordTerminal({ launchId: job.launchId, status: "complete", latestAssistantText: "done" });
    coordinator.recordNotificationBatch({
      batchId: "persisted-batch",
      ownerSessionId: "root",
      launchIds: [job.launchId],
      content: "persisted hidden handoff",
      triggerTurn: true,
    });
    const store = new MemoryRecoveryStore(new Map([
      ["/sessions/root.jsonl", { readable: true, sessionId: "root", cwd: "/paper" }],
    ]));
    store.hidden.set("/sessions/root.jsonl", [{
      customType: "easyresearch:agent_status",
      content: "persisted hidden handoff",
      display: false,
      details: { batchId: "persisted-batch" },
    }]);

    const report = await recover(coordinator, store);

    expect(report.acknowledgedBatchIds).toEqual(["persisted-batch"]);
    expect(store.hidden.get("/sessions/root.jsonl")).toHaveLength(1);
    expect(coordinator.journal().pendingBatches).toEqual([]);
  });

  it("leaves a failed recovery delivery pending with a durable no-trigger mode", async () => {
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const job = reserve(coordinator);
    materialize(coordinator, job, "child", "/sessions/child.jsonl");
    coordinator.recordTerminal({ launchId: job.launchId, status: "complete", latestAssistantText: "done" });
    const store = new MemoryRecoveryStore(new Map([
      ["/sessions/root.jsonl", { readable: true, sessionId: "root", cwd: "/paper" }],
    ]));
    store.appendError = new Error("owner unavailable during reopen");

    await expect(recover(coordinator, store)).rejects.toThrow("owner unavailable during reopen");

    expect(coordinator.journal().pendingBatches).toEqual([
      expect.objectContaining({
        ownerSessionId: "root",
        launchIds: [job.launchId],
        triggerTurn: false,
      }),
    ]);
  });

  it("writes a nested recovery handoff only to the exact immediate-owner session", async () => {
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const writing = reserve(coordinator, { toolCallId: "writing-tool" });
    materialize(coordinator, writing, "writing-child", "/sessions/writing.jsonl");
    coordinator.recordTerminal({ launchId: writing.launchId, status: "complete", latestAssistantText: "writing done" });
    const nested = reserve(coordinator, { ownerSessionId: "writing-child", toolCallId: "figures-tool" });
    materialize(coordinator, nested, "figures-child", "/sessions/figures.jsonl");
    const store = new MemoryRecoveryStore(new Map([
      ["/sessions/figures.jsonl", {
        readable: true,
        sessionId: "figures-child",
        cwd: "/paper",
        latestAssistantText: "editable figure recovered",
      }],
      ["/sessions/writing.jsonl", { readable: true, sessionId: "writing-child", cwd: "/paper" }],
    ]));

    const report = await recover(coordinator, store);

    expect(report.notifications).toEqual([expect.objectContaining({
      ownerSessionId: "writing-child",
      triggerTurn: false,
    })]);
    expect(store.hidden.get("/sessions/writing.jsonl")).toHaveLength(1);
    expect(store.hidden.has("/sessions/root.jsonl")).toBe(false);
    expect(store.appendAttempts.map(({ path }) => path)).toEqual(["/sessions/writing.jsonl"]);
  });

  it("is idempotent after the interrupted Error and hidden batch are durably acknowledged", async () => {
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const job = reserve(coordinator);
    materialize(coordinator, job, "child", "/sessions/child.jsonl");
    const store = new MemoryRecoveryStore(new Map([
      ["/sessions/child.jsonl", { readable: true, sessionId: "child", cwd: "/paper" }],
      ["/sessions/root.jsonl", { readable: true, sessionId: "root", cwd: "/paper" }],
    ]));

    const first = await recover(coordinator, store);
    const appendCount = store.appendAttempts.length;
    const second = await recover(coordinator, store);

    expect(first.interruptedLaunchIds).toEqual([job.launchId]);
    expect(second).toEqual({
      interruptedLaunchIds: [],
      unmaterializedLaunchIds: [],
      acknowledgedBatchIds: [],
      notifications: [],
    });
    expect(store.appendAttempts).toHaveLength(appendCount);
  });

  it("does not release a terminal outcome durably suppressed by Stop before launch acknowledgement", async () => {
    const coordinator = new SubagentCoordinator(new MemoryCoordinatorSessionManager());
    const job = reserve(coordinator);
    materialize(coordinator, job, "child", "/sessions/child.jsonl", false);
    coordinator.recordTerminal({ launchId: job.launchId, status: "error", latestAssistantText: "stopped partial" });
    coordinator.recordLaunchSuppressed(job.launchId);
    const store = new MemoryRecoveryStore(new Map([
      ["/sessions/child.jsonl", { readable: true, sessionId: "child", cwd: "/paper" }],
    ]));

    const report = await recover(coordinator, store);

    expect(report).toEqual({
      interruptedLaunchIds: [],
      unmaterializedLaunchIds: [],
      acknowledgedBatchIds: [],
      notifications: [],
    });
    expect(store.inspectCalls).toEqual([]);
    expect(coordinator.journal().jobs.get(job.launchId)).toMatchObject({
      launchAcknowledged: false,
      terminalStatus: "error",
      terminalSuppressed: true,
    });
  });
});
