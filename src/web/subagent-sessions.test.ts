import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { importPi } from "../runtime/pi-import";
import { AGENT_ALIAS_ENTRY } from "../subagent/agent-alias";
import { SUBAGENT_JOB_ENTRY, type SubagentJobJournalRecord } from "../subagent/job-journal";
import { SUBAGENT_SESSION_LINK_ENTRY } from "../subagent/session-links";
import type {
  ChildSessionSnapshotDto,
  SessionSnapshotDto,
  SubagentSessionSummaryDto,
} from "./contracts";
import {
  createSubagentRecoverySessionStore,
  SubagentSessionNotFoundError,
  SubagentSessionService,
} from "./subagent-sessions";

type Pi = Awaited<ReturnType<typeof importPi>>;
type SessionManagerInstance = ReturnType<Pi["SessionManager"]["create"]>;

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(...texts: string[]): Message {
  return {
    role: "assistant",
    content: texts.map((text) => ({ type: "text" as const, text })),
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function assistantUsage(input: number, output: number, totalCost: number, text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: totalCost, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

it("requires parent snapshots to include subagent summaries", () => {
  expectTypeOf<SessionSnapshotDto["subagents"]>().toEqualTypeOf<SubagentSessionSummaryDto[]>();
  expectTypeOf<ChildSessionSnapshotDto["subagents"]>().toEqualTypeOf<SubagentSessionSummaryDto[]>();
});

describe("SubagentSessionService", () => {
  let SessionManager: Pi["SessionManager"];
  let sessionDir: string;
  let cwd: string;

  beforeAll(async () => {
    ({ SessionManager } = await importPi());
  });

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "lazy-subagent-sessions-"));
    cwd = mkdtempSync(join(tmpdir(), "lazy-subagent-project-"));
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function createSession(sessionCwd = cwd): SessionManagerInstance {
    return SessionManager.create(sessionCwd, sessionDir);
  }

  function service(listAll = () => SessionManager.listAll(sessionDir)): SubagentSessionService {
    return new SubagentSessionService({
      open: (path) => SessionManager.open(path),
      listAll,
    });
  }

  function appendParentMessage(parent: SessionManagerInstance): void {
    parent.appendMessage(user("parent request"));
    parent.appendMessage(assistant("parent reply"));
  }

  function link(parent: SessionManagerInstance, child: SessionManagerInstance, data: Record<string, unknown> = {}): void {
    parent.appendCustomEntry(SUBAGENT_SESSION_LINK_ENTRY, {
      toolCallId: "tool-1",
      childSessionId: child.getSessionId(),
      agent: "search",
      ...data,
    });
  }

  function journal(parent: SessionManagerInstance, record: SubagentJobJournalRecord): void {
    parent.appendCustomEntry(SUBAGENT_JOB_ENTRY, record);
  }

  function journalJob(
    parent: SessionManagerInstance,
    child: SessionManagerInstance,
    input: {
      launchId: string;
      ownerSessionId: string;
      toolCallId: string;
      agent: string;
      agentId: string;
      status: "working" | "complete" | "error";
      latestAssistantText?: string;
      errorMessage?: string;
    },
  ): void {
    journal(parent, {
      kind: "reserved",
      launchId: input.launchId,
      ownerSessionId: input.ownerSessionId,
      toolCallId: input.toolCallId,
      agent: input.agent,
      agentId: input.agentId,
      continuation: false,
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    journal(parent, {
      kind: "created",
      launchId: input.launchId,
      childSessionId: child.getSessionId(),
      sessionPath: child.getSessionFile()!,
    });
    journal(parent, { kind: "materialized", launchId: input.launchId });
    parent.appendCustomEntry(SUBAGENT_SESSION_LINK_ENTRY, {
      toolCallId: input.toolCallId,
      childSessionId: child.getSessionId(),
      agent: input.agent,
      ownerSessionId: input.ownerSessionId,
      launchId: input.launchId,
      agentId: input.agentId,
    });
    parent.appendCustomEntry(AGENT_ALIAS_ENTRY, {
      id: input.agentId,
      agent: input.agent,
      sessionId: child.getSessionId(),
      sessionPath: child.getSessionFile(),
    });
    if (input.status === "working") return;
    journal(parent, {
      kind: "launch_acknowledged",
      launchId: input.launchId,
      acknowledgedAt: "2026-08-19T00:00:01.000Z",
    });
    journal(parent, {
      kind: "terminal",
      launchId: input.launchId,
      status: input.status,
      ...(input.latestAssistantText === undefined ? {} : { latestAssistantText: input.latestAssistantText }),
      ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
      finishedAt: "2026-08-19T00:00:02.000Z",
    });
  }

  it("returns no summaries while a newly active parent is not yet in the persistent session listing", async () => {
    await expect(service(async () => []).summaries("new-parent-uuid")).resolves.toEqual([]);
  });

  it("attaches the agent id from coordinator alias entries to summaries (ADR-084)", async () => {
    const parent = createSession();
    const child = createSession();
    appendParentMessage(parent);
    child.appendSessionInfo("easyresearch:search");
    child.appendMessage(user("find papers"));
    child.appendMessage(assistant("final child reply"));
    link(parent, child);
    parent.appendCustomEntry(AGENT_ALIAS_ENTRY, {
      id: "search_0",
      agent: "search",
      sessionId: child.getSessionId(),
      sessionPath: child.getSessionFile(),
    });

    expect(await service().summaries(parent.getSessionId())).toEqual([{
      ownerSessionId: parent.getSessionId(),
      toolCallId: "tool-1",
      childSessionId: child.getSessionId(),
      agent: "search",
      agentId: "search_0",
      status: "complete",
      latestMessage: "final child reply",
    }]);
  });

  it("returns mapped child summaries and complete branch snapshots by exact UUID", async () => {
    const parent = createSession();
    const child = createSession();
    appendParentMessage(parent);
    child.appendSessionInfo("easyresearch:search");
    child.appendMessage(user("find papers"));
    child.appendMessage(assistant("final child reply"));
    link(parent, child);

    expect(await service().summaries(parent.getSessionId())).toEqual([{
      ownerSessionId: parent.getSessionId(),
      toolCallId: "tool-1",
      childSessionId: child.getSessionId(),
      agent: "search",
      status: "complete",
      latestMessage: "final child reply",
    }]);
    expect(await service().snapshot(parent.getSessionId(), child.getSessionId())).toMatchObject({
      session: {
        id: child.getSessionId(),
        cwd,
        sessionName: "easyresearch:search",
      },
      timeline: [
        {
          kind: "message",
          entryId: expect.any(String),
          message: { role: "user" },
        },
        {
          kind: "message",
          entryId: expect.any(String),
          message: { role: "assistant" },
        },
      ],
      inlineUsage: [
        {
          id: expect.any(String),
          sessionId: child.getSessionId(),
          source: "assistant",
          anchor: { kind: "message", messageEntryId: expect.any(String) },
          provider: "openai",
          model: "test-model",
          usage,
          timestamp: expect.any(String),
        },
      ],
      subagents: [],
    });
  });

  it("folds every materialized descendant into path-free root summaries and scopes retained-child jobs", async () => {
    const parent = createSession();
    const owner = createSession();
    const working = createSession();
    const nestedError = createSession();
    appendParentMessage(parent);
    owner.appendSessionInfo("easyresearch:experiment");
    owner.appendMessage(user("run experiment"));
    owner.appendMessage(assistant("owner complete"));
    owner.appendCustomMessageEntry(
      "easyresearch:agent_status",
      `<agent_status>Error subagent:{"session_path":"${nestedError.getSessionFile()}"}</agent_status>\n<agent_handoff>hidden</agent_handoff>`,
      false,
    );
    working.appendSessionInfo("easyresearch:search");
    working.appendMessage(user("keep searching"));
    working.appendMessage(assistant("working full latest message"));
    nestedError.appendSessionInfo("easyresearch:figures");
    nestedError.appendMessage(user("draw figure"));
    nestedError.appendMessage(assistant("nested partial result"));

    journalJob(parent, owner, {
      launchId: "launch-owner",
      ownerSessionId: parent.getSessionId(),
      toolCallId: "tool-owner",
      agent: "experiment",
      agentId: "experiment_0",
      status: "complete",
      latestAssistantText: "owner complete",
    });
    journalJob(parent, working, {
      launchId: "launch-working",
      ownerSessionId: parent.getSessionId(),
      toolCallId: "tool-working",
      agent: "search",
      agentId: "search_0",
      status: "working",
    });
    journalJob(parent, nestedError, {
      launchId: "launch-nested",
      ownerSessionId: owner.getSessionId(),
      toolCallId: "tool-nested",
      agent: "figures",
      agentId: "figures_0",
      status: "error",
      latestAssistantText: "nested partial result",
      errorMessage: `failed at ${nestedError.getSessionFile()}`,
    });

    const summaries = await service().summaries(parent.getSessionId());
    expect(summaries).toEqual([
      {
        launchId: "launch-owner",
        ownerSessionId: parent.getSessionId(),
        toolCallId: "tool-owner",
        agent: "experiment",
        agentId: "experiment_0",
        childSessionId: owner.getSessionId(),
        status: "complete",
        latestMessage: "owner complete",
      },
      {
        launchId: "launch-working",
        ownerSessionId: parent.getSessionId(),
        toolCallId: "tool-working",
        agent: "search",
        agentId: "search_0",
        childSessionId: working.getSessionId(),
        status: "working",
        latestMessage: "working full latest message",
      },
      {
        launchId: "launch-nested",
        ownerSessionId: owner.getSessionId(),
        toolCallId: "tool-nested",
        agent: "figures",
        agentId: "figures_0",
        childSessionId: nestedError.getSessionId(),
        status: "error",
        latestMessage: "nested partial result",
      },
    ]);
    const retained = await service().snapshot(parent.getSessionId(), owner.getSessionId());
    expect(retained.timeline.map((entry) => entry.kind === "message" ? entry.message.role : entry.kind))
      .toEqual(["user", "assistant"]);
    expect(retained.subagents).toEqual([summaries[2]]);

    const serialized = JSON.stringify({ summaries, retained });
    expect(serialized).not.toContain("sessionPath");
    expect(serialized).not.toContain("session_path");
    expect(serialized).not.toContain(nestedError.getSessionFile()!);
    expect(serialized).not.toContain("<agent_handoff>");
  });

  it("rebuilds recursive old-session statistics without recounting a continued child or writing migration data", async () => {
    const parent = createSession();
    const owner = createSession();
    const nested = createSession();
    parent.appendMessage(user("parent request"));
    parent.appendMessage(assistantUsage(10, 2, 0.1, "parent reply"));
    owner.appendMessage(user("run experiment"));
    owner.appendMessage(assistantUsage(5, 1, 0.05, "owner reply"));
    nested.appendMessage(user("find evidence"));
    nested.appendMessage(assistantUsage(3, 1, 0.03, "nested reply"));

    journalJob(parent, owner, {
      launchId: "launch-owner",
      ownerSessionId: parent.getSessionId(),
      toolCallId: "tool-owner",
      agent: "experiment",
      agentId: "experiment_0",
      status: "complete",
    });
    journalJob(parent, nested, {
      launchId: "launch-nested",
      ownerSessionId: owner.getSessionId(),
      toolCallId: "tool-nested",
      agent: "search",
      agentId: "search_0",
      status: "complete",
    });
    journalJob(parent, owner, {
      launchId: "launch-owner-continuation",
      ownerSessionId: parent.getSessionId(),
      toolCallId: "tool-owner-continuation",
      agent: "experiment",
      agentId: "experiment_0",
      status: "complete",
    });

    const files = [parent, owner, nested].map((session) => session.getSessionFile()!);
    const before = files.map((path) => readFileSync(path, "utf8"));
    const statistics = await service().statistics(parent.getSessionId());

    expect(statistics.partial).toBe(false);
    expect(statistics.warnings).toEqual([]);
    expect(statistics.sessions).toHaveLength(3);
    expect(statistics.total).toMatchObject({ records: 3, input: 18, output: 4, totalTokens: 22 });
    expect(statistics.sessions.map((session) => session.sessionId)).toEqual([
      parent.getSessionId(),
      owner.getSessionId(),
      nested.getSessionId(),
    ]);
    expect(statistics.sessions[1]).toMatchObject({
      parentSessionId: parent.getSessionId(),
      agent: "experiment",
      agentId: "experiment_0",
      direct: { records: 1, totalTokens: 6 },
      subtree: { records: 2, totalTokens: 10 },
    });
    expect(statistics.sessions[2]).toMatchObject({
      parentSessionId: owner.getSessionId(),
      direct: { records: 1, totalTokens: 4 },
      subtree: { records: 1, totalTokens: 4 },
    });
    expect(files.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  it("refreshes an earlier empty statistics projection from newly persisted usage", async () => {
    const parent = createSession();
    parent.appendMessage(user("start live session"));
    const sessions = service();

    await expect(sessions.statistics(parent.getSessionId())).resolves.toMatchObject({
      total: { records: 0, totalTokens: 0 },
    });

    parent.appendMessage(assistantUsage(11, 3, 0.2, "live reply"));

    await expect(sessions.statistics(parent.getSessionId())).resolves.toMatchObject({
      total: { records: 1, input: 11, output: 3, totalTokens: 14 },
    });
  });

  it("uses the exact root-journal path mapping instead of authorizing a same-cwd UUID from the global listing", async () => {
    const parent = createSession();
    const requested = createSession();
    const replacement = createSession();
    appendParentMessage(parent);
    requested.appendMessage(user("requested"));
    requested.appendMessage(assistant("requested reply"));
    replacement.appendMessage(user("replacement"));
    replacement.appendMessage(assistant("replacement reply"));
    journal(parent, {
      kind: "reserved",
      launchId: "launch-tampered",
      ownerSessionId: parent.getSessionId(),
      toolCallId: "tool-tampered",
      agent: "search",
      agentId: "search_0",
      continuation: false,
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    journal(parent, {
      kind: "created",
      launchId: "launch-tampered",
      childSessionId: requested.getSessionId(),
      sessionPath: replacement.getSessionFile()!,
    });
    journal(parent, { kind: "materialized", launchId: "launch-tampered" });

    await expect(service().snapshot(parent.getSessionId(), requested.getSessionId()))
      .rejects.toBeInstanceOf(SubagentSessionNotFoundError);
  });

  it("does not resurrect a suppressed journal launch through its persisted session link", async () => {
    const parent = createSession();
    const child = createSession();
    appendParentMessage(parent);
    child.appendMessage(user("stopped task"));
    child.appendMessage(assistant("partial before stop"));
    journalJob(parent, child, {
      launchId: "launch-suppressed",
      ownerSessionId: parent.getSessionId(),
      toolCallId: "tool-suppressed",
      agent: "search",
      agentId: "search_0",
      status: "working",
    });
    journal(parent, {
      kind: "launch_suppressed",
      launchId: "launch-suppressed",
      suppressedAt: "2026-08-19T00:00:03.000Z",
    });

    await expect(service().summaries(parent.getSessionId())).resolves.toEqual([]);
    await expect(service().snapshot(parent.getSessionId(), child.getSessionId()))
      .rejects.toBeInstanceOf(SubagentSessionNotFoundError);
  });

  it("preserves a legacy direct link as a terminal summary and opens it only through its persisted alias path", async () => {
    const parent = createSession();
    const child = createSession();
    appendParentMessage(parent);
    child.appendMessage(user("legacy task"));
    child.appendMessage(assistant("legacy final reply"));
    link(parent, child, { toolCallId: "legacy-tool", step: 2 });
    parent.appendCustomEntry(AGENT_ALIAS_ENTRY, {
      id: "search_7",
      agent: "search",
      sessionId: child.getSessionId(),
      sessionPath: child.getSessionFile(),
    });

    expect(await service().summaries(parent.getSessionId())).toEqual([{
      ownerSessionId: parent.getSessionId(),
      toolCallId: "legacy-tool",
      agent: "search",
      agentId: "search_7",
      childSessionId: child.getSessionId(),
      status: "complete",
      latestMessage: "legacy final reply",
      step: 2,
    }]);
    await expect(service().snapshot(parent.getSessionId(), child.getSessionId())).resolves.toMatchObject({
      session: { id: child.getSessionId(), cwd },
      subagents: [],
    });
  });

  it("uses the latest assistant message with non-whitespace text blocks", async () => {
    const parent = createSession();
    const child = createSession();
    appendParentMessage(parent);
    child.appendMessage(user("find papers"));
    child.appendMessage(assistant("first section", "second section"));
    child.appendMessage(assistant("  ", "\n"));
    link(parent, child);

    expect(await service().summaries(parent.getSessionId())).toMatchObject([{
      latestMessage: "first section\n\nsecond section",
    }]);
  });

  it("rejects an unmapped child UUID", async () => {
    const parent = createSession();
    const child = createSession();
    appendParentMessage(parent);
    child.appendMessage(user("find papers"));
    child.appendMessage(assistant("reply"));

    await expect(service().snapshot(parent.getSessionId(), child.getSessionId()))
      .rejects.toBeInstanceOf(SubagentSessionNotFoundError);
  });

  it("ignores malformed parent links and does not authorize their child UUID", async () => {
    const parent = createSession();
    const child = createSession();
    appendParentMessage(parent);
    child.appendMessage(user("find papers"));
    child.appendMessage(assistant("reply"));
    parent.appendCustomEntry(SUBAGENT_SESSION_LINK_ENTRY, {
      toolCallId: "tool-1",
      childSessionId: child.getSessionId(),
    });

    expect(await service().summaries(parent.getSessionId())).toEqual([]);
    await expect(service().snapshot(parent.getSessionId(), child.getSessionId()))
      .rejects.toBeInstanceOf(SubagentSessionNotFoundError);
  });

  it("preserves a deleted mapped child in summaries and rejects its snapshot", async () => {
    const parent = createSession();
    const child = createSession();
    appendParentMessage(parent);
    child.appendMessage(user("find papers"));
    child.appendMessage(assistant("reply"));
    link(parent, child);
    unlinkSync(child.getSessionFile()!);

    expect(await service().summaries(parent.getSessionId())).toEqual([{
      ownerSessionId: parent.getSessionId(),
      toolCallId: "tool-1",
      childSessionId: child.getSessionId(),
      agent: "search",
      status: "complete",
    }]);
    await expect(service().snapshot(parent.getSessionId(), child.getSessionId()))
      .rejects.toBeInstanceOf(SubagentSessionNotFoundError);
  });

  it("does not authorize a mapped UUID whose listed child belongs to another cwd", async () => {
    const otherCwd = mkdtempSync(join(tmpdir(), "lazy-subagent-other-project-"));
    try {
      const parent = createSession();
      const child = createSession(otherCwd);
      appendParentMessage(parent);
      child.appendMessage(user("find papers"));
      child.appendMessage(assistant("reply"));
      link(parent, child);

      expect(await service().summaries(parent.getSessionId())).toEqual([{
        ownerSessionId: parent.getSessionId(),
        toolCallId: "tool-1",
        childSessionId: child.getSessionId(),
        agent: "search",
        status: "complete",
      }]);
      await expect(service().snapshot(parent.getSessionId(), child.getSessionId()))
        .rejects.toBeInstanceOf(SubagentSessionNotFoundError);
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it("rejects a mapped child whose session file becomes malformed", async () => {
    const parent = createSession();
    const child = createSession();
    appendParentMessage(parent);
    child.appendMessage(user("find papers"));
    child.appendMessage(assistant("reply"));
    link(parent, child);
    const listed = await SessionManager.listAll(sessionDir);
    writeFileSync(child.getSessionFile()!, "not-json\n", "utf8");
    const staleList = async () => listed;

    expect(await service(staleList).summaries(parent.getSessionId())).toEqual([{
      ownerSessionId: parent.getSessionId(),
      toolCallId: "tool-1",
      childSessionId: child.getSessionId(),
      agent: "search",
      status: "complete",
    }]);
    await expect(service(staleList).snapshot(parent.getSessionId(), child.getSessionId()))
      .rejects.toBeInstanceOf(SubagentSessionNotFoundError);
  });

  it("keeps messages and the compaction disclosure in complete branch order", async () => {
    const parent = createSession();
    const child = createSession();
    appendParentMessage(parent);
    child.appendMessage(user("before compaction"));
    const earlierAssistantId = child.appendMessage(assistant("earlier reply"));
    child.appendCompaction("summary", earlierAssistantId, 1_000);
    child.appendMessage(user("after compaction"));
    child.appendMessage(assistant("later reply"));
    link(parent, child);

    const snapshot = await service().snapshot(parent.getSessionId(), child.getSessionId());
    expect((snapshot as unknown as { timeline?: unknown[] }).timeline).toEqual([
      expect.objectContaining({ kind: "message", message: expect.objectContaining({ content: "before compaction" }) }),
      expect.objectContaining({ kind: "message", message: expect.objectContaining({ role: "assistant" }) }),
      expect.objectContaining({ kind: "compaction", summary: "summary" }),
      expect.objectContaining({ kind: "message", message: expect.objectContaining({ content: "after compaction" }) }),
      expect.objectContaining({ kind: "message", message: expect.objectContaining({ role: "assistant" }) }),
    ]);
  });

  it("inspects only an exact readable Pi path and returns its UUID, cwd, and latest assistant text", async () => {
    const rootSession = createSession();
    appendParentMessage(rootSession);
    const child = createSession();
    child.appendMessage(user("nested task"));
    child.appendMessage(assistant("recoverable partial"));
    const store = createSubagentRecoverySessionStore({
      rootSession,
      open: (path) => SessionManager.open(path),
    });

    await expect(store.inspect(child.getSessionFile()!)).resolves.toEqual({
      readable: true,
      sessionId: child.getSessionId(),
      cwd,
      latestAssistantText: "recoverable partial",
    });
    await expect(store.inspect(join(sessionDir, "missing.jsonl"))).resolves.toEqual({ readable: false });
  });

  it("persists one exact hidden recovery batch and treats an already-readable insertion as acknowledged", async () => {
    const rootSession = createSession();
    appendParentMessage(rootSession);
    const path = rootSession.getSessionFile()!;
    const store = createSubagentRecoverySessionStore({
      rootSession,
      open: (candidate) => SessionManager.open(candidate),
    });
    const message = {
      customType: "easyresearch:agent_status",
      content: "hidden recovery handoff",
      display: false as const,
      details: { batchId: "recovery-batch" },
    };

    await store.appendHiddenMessage(path, message);
    await store.appendHiddenMessage(path, message);

    const reopened = SessionManager.open(path);
    expect(reopened.getEntries().filter((entry) =>
      entry.type === "custom_message"
      && entry.customType === message.customType
      && (entry.details as { batchId?: unknown } | undefined)?.batchId === message.details.batchId)).toHaveLength(1);
  });

  it("rejects a nested owner path whose UUID changes after recovery inspection", async () => {
    const rootSession = createSession();
    appendParentMessage(rootSession);
    const owner = createSession();
    owner.appendMessage(user("nested owner"));
    owner.appendMessage(assistant("owner reply"));
    const ownerPath = owner.getSessionFile()!;
    const store = createSubagentRecoverySessionStore({
      rootSession,
      open: (path) => SessionManager.open(path),
    });
    await expect(store.inspect(ownerPath)).resolves.toMatchObject({
      readable: true,
      sessionId: owner.getSessionId(),
      cwd,
    });
    writeFileSync(ownerPath, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "replacement-owner",
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
    })}\n`, "utf8");

    await expect(store.appendHiddenMessage(ownerPath, {
      customType: "easyresearch:agent_status",
      content: "must not enter replacement",
      display: false,
      details: { batchId: "replacement-batch" },
    })).rejects.toThrow(/UUID|identity|changed/i);
    expect(SessionManager.open(ownerPath).getEntries()).toEqual([]);
  });

  it("rejects a root owner whose physical UUID changes after recovery inspection", async () => {
    const rootSession = createSession();
    appendParentMessage(rootSession);
    const rootPath = rootSession.getSessionFile()!;
    const store = createSubagentRecoverySessionStore({
      rootSession,
      open: (path) => SessionManager.open(path),
    });
    await expect(store.inspect(rootPath)).resolves.toMatchObject({
      readable: true,
      sessionId: rootSession.getSessionId(),
      cwd,
    });
    writeFileSync(rootPath, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "replacement-root",
      timestamp: "2026-08-19T00:00:00.000Z",
      cwd,
    })}\n`, "utf8");

    await expect(store.appendHiddenMessage(rootPath, {
      customType: "easyresearch:agent_status",
      content: "must not enter replacement root",
      display: false,
      details: { batchId: "replacement-root-batch" },
    })).rejects.toThrow(/UUID|identity|changed/i);

    const replacement = SessionManager.open(rootPath);
    expect(replacement.getSessionId()).toBe("replacement-root");
    expect(replacement.getEntries()).toEqual([]);
  });
});
