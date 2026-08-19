import { describe, expect, it } from "vitest";
import { readAgentAliases } from "./agent-alias";
import {
  SUBAGENT_JOB_ENTRY,
  readSubagentJournal,
  type SubagentJobJournalRecord,
} from "./job-journal";

const entry = (data: SubagentJobJournalRecord) => ({
  type: "custom",
  customType: SUBAGENT_JOB_ENTRY,
  data,
});

describe("subagent job journal", () => {
  it("reduces reservation through acknowledged terminal notification", () => {
    const state = readSubagentJournal([
      entry({ kind: "reserved", launchId: "l0", ownerSessionId: "root", toolCallId: "t0", agent: "search", agentId: "search_0", continuation: false, createdAt: "t" }),
      entry({ kind: "created", launchId: "l0", childSessionId: "child", sessionPath: "/sessions/child.jsonl" }),
      entry({ kind: "materialized", launchId: "l0" }),
      entry({ kind: "launch_acknowledged", launchId: "l0", acknowledgedAt: "t1" }),
      entry({ kind: "terminal", launchId: "l0", status: "complete", latestAssistantText: "status: complete", finishedAt: "t2" }),
      entry({ kind: "notification_batch", batchId: "b0", ownerSessionId: "root", launchIds: ["l0"], content: "<agent_status>...</agent_status>", createdAt: "t3" }),
      entry({ kind: "notification_ack", batchId: "b0", acknowledgedAt: "t4" }),
    ]);

    expect(state.jobs.get("l0")).toMatchObject({
      agentId: "search_0",
      childSessionId: "child",
      sessionPath: "/sessions/child.jsonl",
      status: "complete",
      launchAcknowledged: true,
      latestAssistantText: "status: complete",
    });
    expect(state.pendingBatches).toEqual([]);
    expect([...state.acknowledgedBatchIds]).toEqual(["b0"]);
  });

  it("ignores malformed, foreign, and out-of-order records", () => {
    const valid = entry({
      kind: "reserved",
      launchId: "kept",
      ownerSessionId: "root",
      toolCallId: "tool",
      agent: "search",
      agentId: "search_0",
      continuation: false,
      createdAt: "t0",
    });
    const state = readSubagentJournal([
      null,
      { type: "custom", customType: "other", data: valid.data },
      { ...valid, data: { ...valid.data, launchId: "" } },
      { ...valid, data: { ...valid.data, continuation: "false" } },
      entry({ kind: "created", launchId: "missing", childSessionId: "child", sessionPath: "/sessions/child.jsonl" }),
      { type: "custom", customType: SUBAGENT_JOB_ENTRY, data: { kind: "terminal", launchId: "kept", status: "partial", finishedAt: "t1" } },
      { type: "custom", customType: SUBAGENT_JOB_ENTRY, data: { kind: "notification_batch", batchId: "b0", ownerSessionId: "root", launchIds: ["kept", 3], content: "status", createdAt: "t2" } },
      valid,
    ]);

    expect([...state.jobs]).toEqual([
      ["kept", {
        launchId: "kept",
        ownerSessionId: "root",
        toolCallId: "tool",
        agent: "search",
        agentId: "search_0",
        continuation: false,
        createdAt: "t0",
        status: "reserved",
        launchAcknowledged: false,
      }],
    ]);
    expect(state.pendingBatches).toEqual([]);
  });

  it("uses the latest valid created and terminal records for a launch", () => {
    const state = readSubagentJournal([
      entry({ kind: "reserved", launchId: "l0", ownerSessionId: "root", toolCallId: "t0", agent: "search", agentId: "search_0", continuation: false, createdAt: "t0" }),
      entry({ kind: "created", launchId: "l0", childSessionId: "child-old", sessionPath: "/sessions/old.jsonl" }),
      entry({ kind: "created", launchId: "l0", childSessionId: "child-new", sessionPath: "/sessions/new.jsonl" }),
      entry({ kind: "materialized", launchId: "l0" }),
      entry({ kind: "terminal", launchId: "l0", status: "complete", latestAssistantText: "first", finishedAt: "t1" }),
      entry({ kind: "terminal", launchId: "l0", status: "error", latestAssistantText: "last", errorMessage: "failed", finishedAt: "t2" }),
    ]);

    expect(state.jobs.get("l0")).toMatchObject({
      childSessionId: "child-new",
      sessionPath: "/sessions/new.jsonl",
      status: "error",
      latestAssistantText: "last",
      errorMessage: "failed",
    });
  });

  it("removes superseded batches from pending delivery", () => {
    const state = readSubagentJournal([
      entry({ kind: "notification_batch", batchId: "b0", ownerSessionId: "root", launchIds: ["l0"], content: "first", createdAt: "t0" }),
      entry({ kind: "notification_batch", batchId: "b1", ownerSessionId: "root", launchIds: ["l1"], content: "second", createdAt: "t1" }),
      entry({ kind: "notification_superseded", batchId: "b0", supersededAt: "t2" }),
    ]);

    expect(state.pendingBatches).toEqual([
      { batchId: "b1", ownerSessionId: "root", launchIds: ["l1"], content: "second", createdAt: "t1" },
    ]);
    expect([...state.supersededBatchIds]).toEqual(["b0"]);
  });

  it("keeps pre-materialization failures consumed but not resumable", () => {
    const entries = [
      entry({ kind: "reserved", launchId: "l0", ownerSessionId: "root", toolCallId: "t0", agent: "search", agentId: "search_0", continuation: false, createdAt: "t0" }),
      entry({ kind: "pre_materialization_failed", launchId: "l0", reason: "model unavailable", failedAt: "t1" }),
    ];
    const state = readSubagentJournal(entries);

    expect(state.jobs.get("l0")).toMatchObject({ agentId: "search_0", status: "pre_materialization_failed" });
    expect(readAgentAliases(entries)).toEqual([]);
  });
});
