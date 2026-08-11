import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { importPi } from "../runtime/pi-import";
import { SUBAGENT_SESSION_LINK_ENTRY } from "../subagent/session-links";
import type { SessionSnapshotDto, SubagentSessionSummaryDto } from "./contracts";
import { SubagentSessionNotFoundError, SubagentSessionService } from "./subagent-sessions";

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

it("requires parent snapshots to include subagent summaries", () => {
  expectTypeOf<SessionSnapshotDto["subagents"]>().toEqualTypeOf<SubagentSessionSummaryDto[]>();
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

  it("returns no summaries while a newly active parent is not yet in the persistent session listing", async () => {
    await expect(service(async () => []).summaries("new-parent-uuid")).resolves.toEqual([]);
  });

  it("returns mapped child summaries and complete branch snapshots by exact UUID", async () => {
    const parent = createSession();
    const child = createSession();
    appendParentMessage(parent);
    child.appendSessionInfo("lazyresearch:search");
    child.appendMessage(user("find papers"));
    child.appendMessage(assistant("final child reply"));
    link(parent, child);

    expect(await service().summaries(parent.getSessionId())).toEqual([{
      toolCallId: "tool-1",
      childSessionId: child.getSessionId(),
      agent: "search",
      latestMessage: "final child reply",
    }]);
    expect(await service().snapshot(parent.getSessionId(), child.getSessionId())).toMatchObject({
      session: {
        id: child.getSessionId(),
        cwd,
        sessionName: "lazyresearch:search",
      },
      messages: [{ role: "user" }, { role: "assistant" }],
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
      toolCallId: "tool-1",
      childSessionId: child.getSessionId(),
      agent: "search",
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
        toolCallId: "tool-1",
        childSessionId: child.getSessionId(),
        agent: "search",
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
      toolCallId: "tool-1",
      childSessionId: child.getSessionId(),
      agent: "search",
    }]);
    await expect(service(staleList).snapshot(parent.getSessionId(), child.getSessionId()))
      .rejects.toBeInstanceOf(SubagentSessionNotFoundError);
  });

  it("keeps messages before a compaction checkpoint in branch order", async () => {
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
    expect(snapshot.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(snapshot.messages[0]).toMatchObject({ content: "before compaction" });
  });
});
