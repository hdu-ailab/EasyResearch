import { describe, expect, it } from "vitest";
import { applyApiUsageRecord, projectSessionUsage } from "./api-usage";

const cost = (total: number) => ({
  input: total / 4,
  output: total / 4,
  cacheRead: total / 4,
  cacheWrite: total / 4,
  total,
});

describe("projectSessionUsage", () => {
  it("aggregates every Pi-tracked source without double-counting subset fields", () => {
    const entries = [
      {
        type: "message",
        id: "assistant-entry",
        parentId: null,
        timestamp: "2026-08-25T00:00:01.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "requested-model",
          responseModel: "served-model",
          usage: {
            input: 10,
            output: 4,
            cacheRead: 3,
            cacheWrite: 2,
            cacheWrite1h: 1,
            reasoning: 2,
            totalTokens: 19,
            cost: cost(10),
          },
        },
      },
      {
        type: "message",
        id: "tool-entry",
        parentId: "assistant-entry",
        timestamp: "2026-08-25T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          usage: {
            input: 2,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: cost(2),
          },
        },
      },
      {
        type: "compaction",
        id: "compaction-entry",
        parentId: "tool-entry",
        timestamp: "2026-08-25T00:00:03.000Z",
        usage: {
          input: 4,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          totalTokens: 7,
          cost: cost(4),
        },
      },
      {
        type: "branch_summary",
        id: "branch-entry",
        parentId: "compaction-entry",
        timestamp: "2026-08-25T00:00:04.000Z",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 1,
          cacheWrite: 1,
          totalTokens: 4,
          cost: cost(1),
        },
      },
    ];

    expect(projectSessionUsage("session-1", entries, entries)).toEqual({
      direct: {
        records: 4,
        input: 17,
        output: 8,
        cacheRead: 5,
        cacheWrite: 3,
        cacheWrite1h: 1,
        reasoning: 2,
        totalTokens: 33,
        cacheHitRate: 0.2,
        cost: {
          input: 4.25,
          output: 4.25,
          cacheRead: 4.25,
          cacheWrite: 4.25,
          total: 17,
        },
      },
      models: [
        {
          key: "openai/served-model",
          provider: "openai",
          model: "served-model",
          kind: "model",
          totals: {
            records: 1,
            input: 10,
            output: 4,
            cacheRead: 3,
            cacheWrite: 2,
            cacheWrite1h: 1,
            reasoning: 2,
            totalTokens: 19,
            cacheHitRate: 0.2,
            cost: cost(10),
          },
        },
        {
          key: "internal",
          kind: "internal",
          totals: {
            records: 3,
            input: 7,
            output: 4,
            cacheRead: 2,
            cacheWrite: 1,
            cacheWrite1h: 0,
            reasoning: 0,
            totalTokens: 14,
            cacheHitRate: 0.2,
            cost: cost(7),
          },
        },
      ],
      inlineUsage: [
        expect.objectContaining({
          id: "assistant-entry",
          source: "assistant",
          provider: "openai",
          model: "served-model",
          anchor: { kind: "message", messageEntryId: "assistant-entry" },
        }),
        expect.objectContaining({
          id: "tool-entry",
          source: "tool",
          anchor: { kind: "tool", toolCallId: "tool-1" },
        }),
        expect.objectContaining({
          id: "compaction-entry",
          source: "compaction",
          anchor: { kind: "standalone", afterEntryId: "tool-entry" },
        }),
        expect.objectContaining({
          id: "branch-entry",
          source: "branch-summary",
          anchor: { kind: "standalone", afterEntryId: "compaction-entry" },
        }),
      ],
    });
  });

  it("updates direct, ancestor subtree, root total, and model grouping as one immutable replacement", () => {
    const empty = {
      records: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      totalTokens: 0,
      cacheHitRate: null,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const statistics = {
      rootSessionId: "root",
      total: { ...empty, cost: { ...empty.cost } },
      sessions: [
        {
          sessionId: "root",
          direct: { ...empty, cost: { ...empty.cost } },
          subtree: { ...empty, cost: { ...empty.cost } },
          models: [],
        },
        {
          sessionId: "child",
          parentSessionId: "root",
          direct: { ...empty, cost: { ...empty.cost } },
          subtree: { ...empty, cost: { ...empty.cost } },
          models: [],
        },
      ],
      partial: false,
      warnings: [],
    };
    const record = {
      id: "entry-child",
      sessionId: "child",
      source: "assistant" as const,
      timestamp: "2026-08-25T00:00:00.000Z",
      anchor: { kind: "message" as const, messageEntryId: "entry-child" },
      provider: "openai",
      model: "served-model",
      usage: {
        input: 5,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 8,
        cacheHitRate: 1 / 6,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
      },
    };

    const next = applyApiUsageRecord(statistics, record);

    expect(next).toMatchObject({
      total: { records: 1, input: 5, output: 2, cacheRead: 1, totalTokens: 8, cacheHitRate: 1 / 6 },
      sessions: [
        { sessionId: "root", direct: { records: 0, cacheHitRate: null }, subtree: { records: 1, totalTokens: 8, cacheHitRate: 1 / 6 } },
        {
          sessionId: "child",
          direct: { records: 1, totalTokens: 8, cacheHitRate: 1 / 6 },
          subtree: { records: 1, totalTokens: 8, cacheHitRate: 1 / 6 },
          models: [{ key: "openai/served-model", totals: { records: 1, totalTokens: 8, cacheHitRate: 1 / 6 } }],
        },
      ],
    });
    expect(statistics.total.records).toBe(0);
    expect(applyApiUsageRecord(statistics, { ...record, sessionId: "missing" })).toBeUndefined();
  });
});
