import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { importPi } from "../runtime/pi-import";
import { createSessionMaterializationBarrier } from "./materialization";

function assistantMessage(text = "done"): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function assistantMessageEnd(text = "done"): JsonAgentSessionEvent {
  return { type: "message_end", message: assistantMessage(text) } as JsonAgentSessionEvent;
}

function userMessageEnd(): JsonAgentSessionEvent {
  return {
    type: "message_end",
    message: { role: "user", content: "continue", timestamp: 1 },
  } as JsonAgentSessionEvent;
}

describe("createSessionMaterializationBarrier", () => {
  it("checks a fresh path only after the first assistant message callback returns", async () => {
    let readable = false;
    let checks = 0;
    const deferred: Array<() => void> = [];
    const barrier = createSessionMaterializationBarrier({
      sessionPath: "/sessions/child.jsonl",
      continuation: false,
      assertReadable: async (path) => {
        checks += 1;
        expect(path).toBe("/sessions/child.jsonl");
        if (!readable) throw new Error("missing");
      },
      defer: (run) => deferred.push(run),
    });

    barrier.observe(assistantMessageEnd());
    expect(checks).toBe(0);
    readable = true;
    deferred.splice(0).forEach((run) => run());

    await expect(barrier.materialized).resolves.toBeUndefined();
    expect(checks).toBe(1);
  });

  it("rejects a continuation before SessionManager.open when its mapped path is unreadable", async () => {
    const barrier = createSessionMaterializationBarrier({
      sessionPath: "/deleted.jsonl",
      continuation: true,
      assertReadable: async (path) => {
        expect(path).toBe("/deleted.jsonl");
        throw new Error("not readable");
      },
    });

    await expect(barrier.materialized).rejects.toThrow("not readable");
  });

  it("ignores non-assistant messages and rejects when the prompt settles without materializing", async () => {
    let checks = 0;
    const barrier = createSessionMaterializationBarrier({
      sessionPath: "/sessions/missing.jsonl",
      continuation: false,
      assertReadable: async () => {
        checks += 1;
        throw new Error("still missing");
      },
    });

    barrier.observe(userMessageEnd());
    expect(checks).toBe(0);
    barrier.settlePrompt();

    await expect(barrier.materialized).rejects.toThrow("still missing");
    expect(checks).toBe(1);
  });

  it("uses prompt failure when its final readability check also fails", async () => {
    const barrier = createSessionMaterializationBarrier({
      sessionPath: "/sessions/missing.jsonl",
      continuation: false,
      assertReadable: async () => {
        throw new Error("still missing");
      },
    });

    barrier.settlePrompt(new Error("prompt failed before output"));

    await expect(barrier.materialized).rejects.toThrow("prompt failed before output");
  });

  it("allows prompt settlement to make one final check after the observed check failed", async () => {
    let checks = 0;
    const deferred: Array<() => void> = [];
    const barrier = createSessionMaterializationBarrier({
      sessionPath: "/sessions/child.jsonl",
      continuation: false,
      assertReadable: async () => {
        checks += 1;
        if (checks === 1) throw new Error("not persisted yet");
      },
      defer: (run) => deferred.push(run),
    });

    barrier.observe(assistantMessageEnd());
    deferred.splice(0).forEach((run) => run());
    await Promise.resolve();
    barrier.settlePrompt();

    await expect(barrier.materialized).resolves.toBeUndefined();
    expect(checks).toBe(2);
  });

  it("rejects pending materialization on disposal and ignores deferred work", async () => {
    let checks = 0;
    const deferred: Array<() => void> = [];
    const barrier = createSessionMaterializationBarrier({
      sessionPath: "/sessions/child.jsonl",
      continuation: false,
      assertReadable: async () => {
        checks += 1;
      },
      defer: (run) => deferred.push(run),
    });
    const rejected = expect(barrier.materialized).rejects.toThrow(/disposed/i);

    barrier.observe(assistantMessageEnd());
    barrier.dispose();
    deferred.splice(0).forEach((run) => run());

    await rejected;
    expect(checks).toBe(0);
  });

  it("performs only one successful readability check", async () => {
    let checks = 0;
    const deferred: Array<() => void> = [];
    const barrier = createSessionMaterializationBarrier({
      sessionPath: "/sessions/child.jsonl",
      continuation: false,
      assertReadable: async () => {
        checks += 1;
      },
      defer: (run) => deferred.push(run),
    });

    barrier.observe(assistantMessageEnd("first"));
    barrier.observe(assistantMessageEnd("second"));
    deferred.splice(0).forEach((run) => run());
    await barrier.materialized;
    barrier.settlePrompt();
    barrier.observe(assistantMessageEnd("third"));
    deferred.splice(0).forEach((run) => run());

    expect(checks).toBe(1);
  });
});

describe("pinned Pi session persistence", () => {
  it("keeps a fresh JSONL absent until the first assistant message", async () => {
    const root = await mkdtemp(join(tmpdir(), "easyresearch-materialization-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const previousHome = process.env.HOME;
    const previousAgentDir = process.env.EASYRESEARCH_CODING_AGENT_DIR;
    process.env.HOME = root;
    process.env.EASYRESEARCH_CODING_AGENT_DIR = agentDir;

    try {
      const { SessionManager } = await importPi();
      const manager = SessionManager.create(cwd);
      const sessionPath = manager.getSessionFile();
      expect(sessionPath).toBeTypeOf("string");

      manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
      manager.appendCustomEntry("test:state", { ready: true });
      await expect(access(sessionPath!)).rejects.toThrow();

      manager.appendMessage(assistantMessage());

      await expect(readFile(sessionPath!, "utf8")).resolves.toContain('"role":"assistant"');
      expect((await stat(sessionPath!)).isFile()).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousAgentDir === undefined) delete process.env.EASYRESEARCH_CODING_AGENT_DIR;
      else process.env.EASYRESEARCH_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
});
