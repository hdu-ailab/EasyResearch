import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RpcEventListener, RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { RouteServices } from "./routes";
import { createRouteHandler } from "./routes";
import type { RpcSessionAdapter, RpcSessionFactory, StartRpcSessionOptions } from "./rpc-session";
import { ActiveSessionRegistry, UnknownSessionError } from "./active-sessions";
import { DirectoryService } from "./directories";
import { ConfigFileService } from "./config-files";
import type { SessionSummaryDto } from "./contracts";
import { AgentModelError } from "./agent-models";
import { WebuiSettingsError, readEffectiveWebuiSettings, updateWebuiSettings } from "./webui-settings";
import { discoverAgents } from "../subagent/agents";
import { agentToDto, isKnownAgentName, toUserSessionSummaries } from "./server";
import type { Logger } from "../runtime/logger";
import { SubagentSessionNotFoundError } from "./subagent-sessions";
import type { FileWatcherEvent, FileWatcherFactory } from "./file-watcher";

const [loggerMock, createLoggerMock] = vi.hoisted(() => {
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return [mockLogger, vi.fn(() => mockLogger)] as const;
});

vi.mock("../runtime/logger", () => ({
  createLogger: createLoggerMock,
}));

vi.mock("../runtime/extensions-guard", () => ({
  assertSafeExtensionSources: vi.fn(),
  ExtensionGuardError: class ExtensionGuardError extends Error {},
}));

const noopLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function fakeLogger(): Logger & { calls: Array<[level: string, msg: string, fields?: Record<string, unknown>]> } {
  const calls: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const make = (level: string) => (msg: string, fields?: Record<string, unknown>) => calls.push([level, msg, fields]);
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error"), calls };
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function assistant(text: string): AgentMessage {
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

class FakeAdapter implements RpcSessionAdapter {
  static all: FakeAdapter[] = [];
  static nextId = 0;
  events = new Set<RpcEventListener>();
  exitListeners = new Set<(error: Error) => void>();
  prompts: string[] = [];
  aborts = 0;
  stopped = 0;
  setModels: Array<{ provider: string; modelId: string }> = [];
  messages: AgentMessage[] = [];
  constructor(public options: StartRpcSessionOptions) {
    FakeAdapter.all.push(this);
  }
  async start() {}
  async stop() {
    this.stopped++;
  }
  async prompt(message: string) {
    this.prompts.push(message);
  }
  async abort() {
    this.aborts++;
  }
  async setModel(provider: string, modelId: string) {
    this.setModels.push({ provider, modelId });
  }
  async getState(): Promise<RpcSessionState> {
    return {
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionFile: this.options.sessionPath ?? "/agent/sessions/default.jsonl",
      sessionId: `sess-${++FakeAdapter.nextId}`,
      autoCompactionEnabled: false,
      messageCount: 0,
      pendingMessageCount: 0,
    };
  }
  async getMessages(): Promise<AgentMessage[]> {
    return this.messages;
  }
  onEvent(listener: RpcEventListener) {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  onExit(listener: (error: Error) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}

class FakeFactory implements RpcSessionFactory {
  created: FakeAdapter[] = [];
  create(options: StartRpcSessionOptions): RpcSessionAdapter {
    const adapter = new FakeAdapter(options);
    this.created.push(adapter);
    return adapter;
  }
}

class FakeWatcherFactory implements FileWatcherFactory {
  created: Array<{ cwd: string; onEvent: (event: FileWatcherEvent) => void }> = [];

  create({ cwd, onEvent }: { cwd: string; onEvent: (event: FileWatcherEvent) => void }) {
    const close = vi.fn(async () => {});
    this.created.push({ cwd, onEvent });
    return { close };
  }

  emit(event: FileWatcherEvent) {
    this.created.at(-1)?.onEvent(event);
  }
}

describe("web routes", () => {
  let webuiDist: string;
  let homeDir: string;
  let agentDir: string;
  let projectDir: string;
  let factory: FakeFactory;
  let watcherFactory: FakeWatcherFactory;
  let registry: ActiveSessionRegistry;
  let directoryService: DirectoryService;
  let configService: ConfigFileService;
  let historySessions: SessionSummaryDto[];
  let handler: (request: Request) => Promise<Response>;

  beforeEach(() => {
    webuiDist = mkdtempSync(join(tmpdir(), "lazy-webui-dist-"));
    homeDir = mkdtempSync(join(tmpdir(), "lazy-home-"));
    agentDir = mkdtempSync(join(tmpdir(), "lazy-agent-"));
    projectDir = mkdtempSync(join(tmpdir(), "lazy-project-"));
    writeFileSync(join(webuiDist, "index.html"), "<div id=\"root\"></div>", "utf-8");
    FakeAdapter.all = [];
    FakeAdapter.nextId = 0;
    factory = new FakeFactory();
    watcherFactory = new FakeWatcherFactory();
    registry = new ActiveSessionRegistry(factory, noopLogger, watcherFactory);
    directoryService = new DirectoryService(homeDir);
    configService = new ConfigFileService(agentDir);
    historySessions = [];
  });

  function setup(overrides: Partial<RouteServices> = {}): void {
    const services: RouteServices = {
      webuiDist,
      listAllSessions: async () => historySessions,
      listModels: async () => [],
      effectiveModels: async () => [],
      setAgentModel: async () => {},
      listConfigProjects: async () => ({ home: agentDir, projects: [] }),
      directories: directoryService,
      registry,
      config: configService,
      logger: noopLogger,
      listAgents: async () => [],
      getWebuiSettings: vi.fn(async () => ({ agentModels: {}, orchestratorModel: null, effectiveOrchestratorModel: null })),
      updateWebuiSettings: vi.fn(async (patch) => ({ agentModels: {}, orchestratorModel: null, effectiveOrchestratorModel: null, ...patch })),
      subagentSessions: {
        summaries: async () => [],
        snapshot: async (_parentSessionId: string, childSessionId: string) => {
          throw new SubagentSessionNotFoundError(`Subagent session not found: ${childSessionId}`);
        },
      },
      ...overrides,
    };
    handler = createRouteHandler(services);
  }

  it("returns status with history and active sessions", async () => {
    historySessions = [
      {
        id: "h1",
        path: "/agent/sessions/--p--/a.jsonl",
        cwd: "/p",
        created: "2026-08-01T00:00:00.000Z",
        modified: "2026-08-01T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "hello",
      },
    ];
    setup();
    const res = await handler(new Request("http://localhost/api/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentDir: string; homeDir: string; sessions: unknown[]; activeSessions: unknown[] };
    expect(body.agentDir).toBe(agentDir);
    expect(body.homeDir).toBe(homeDir);
    expect(body.sessions).toHaveLength(1);
    expect(body.activeSessions).toEqual([]);
  });

  it("lists directories for a given path", async () => {
    setup();
    const res = await handler(new Request(`http://localhost/api/directories?path=${encodeURIComponent(homeDir)}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; entries: unknown[] };
    expect(body.path).toBe(homeDir);
  });

  it("lists files and directories for the files panel", async () => {
    writeFileSync(join(homeDir, "note.txt"), "x", "utf-8");
    setup();
    const res = await handler(new Request(`http://localhost/api/entries?path=${encodeURIComponent(homeDir)}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ kind: string }> };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((e) => e.kind === "file" || e.kind === "directory")).toBe(true);
  });

  it("reads a file for preview", async () => {
    writeFileSync(join(homeDir, "note.txt"), "preview me", "utf-8");
    setup();
    const res = await handler(new Request(`http://localhost/api/file?path=${encodeURIComponent(join(homeDir, "note.txt"))}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; truncated: boolean };
    expect(body.content).toBe("preview me");
    expect(body.truncated).toBe(false);
  });

  it("rejects reading a missing file", async () => {
    setup();
    const res = await handler(new Request(`http://localhost/api/file?path=${encodeURIComponent(join(homeDir, "nope.txt"))}`));
    expect(res.status).toBe(404);
  });

  it("requires a path for file reads", async () => {
    setup();
    const res = await handler(new Request("http://localhost/api/file"));
    expect(res.status).toBe(400);
  });

  it("serves raw file bytes with MIME metadata for a full read", async () => {
    const pdf = join(homeDir, "raw.pdf");
    writeFileSync(pdf, Buffer.from([0, 1, 2, 3, 4]));
    setup();
    const res = await handler(new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(pdf)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0, 1, 2, 3, 4]);
  });

  it("serves a single ranged raw file response", async () => {
    const pdf = join(homeDir, "raw.pdf");
    writeFileSync(pdf, Buffer.from([0, 1, 2, 3, 4]));
    setup();
    const res = await handler(
      new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(pdf)}`, {
        headers: { Range: "bytes=1-3" },
      }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 1-3/5");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("rejects unsatisfiable ranges with 416 and a content-range hint", async () => {
    const pdf = join(homeDir, "raw.pdf");
    writeFileSync(pdf, Buffer.from([0, 1, 2, 3, 4]));
    setup();
    const res = await handler(
      new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(pdf)}`, {
        headers: { Range: "bytes=20-30" },
      }),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */5");
  });

  it("streams full and ranged raw bodies instead of buffering the file", async () => {
    const pdf = join(homeDir, "raw.pdf");
    writeFileSync(pdf, Buffer.from([0, 1, 2, 3, 4]));
    setup();

    const full = await handler(new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(pdf)}`));
    expect(full.status).toBe(200);
    expect(full.body).toBeInstanceOf(ReadableStream);
    const fullReader = full.body!.getReader();
    const fullChunks: number[] = [];
    for (;;) {
      const { done, value } = await fullReader.read();
      if (done) break;
      fullChunks.push(...value);
    }
    expect(fullChunks).toEqual([0, 1, 2, 3, 4]);

    const ranged = await handler(
      new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(pdf)}`, {
        headers: { Range: "bytes=1-3" },
      }),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.body).toBeInstanceOf(ReadableStream);
    const rangedReader = ranged.body!.getReader();
    const rangedChunks: number[] = [];
    for (;;) {
      const { done, value } = await rangedReader.read();
      if (done) break;
      rangedChunks.push(...value);
    }
    expect(rangedChunks).toEqual([1, 2, 3]);
  });

  it("serves a small range of a large raw file through the streaming body", async () => {
    const big = join(homeDir, "big.bin");
    const size = 8 * 1024 * 1024;
    const fd = openSync(big, "w");
    try {
      writeSync(fd, Buffer.alloc(size));
      writeSync(fd, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]), 0, 4, size - 4);
    } finally {
      closeSync(fd);
    }
    setup();
    const res = await handler(
      new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(big)}`, {
        headers: { Range: "bytes=-4" },
      }),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes ${size - 4}-${size - 1}/${size}`);
    expect(res.headers.get("content-length")).toBe("4");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it("rejects raw reads of a directory with the same typed error as text reads", async () => {
    mkdirSync(join(homeDir, "subdir"), { recursive: true });
    setup();
    const res = await handler(new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(join(homeDir, "subdir"))}`));
    expect(res.status).toBe(400);
  });

  it("rejects raw reads of a missing file with the same typed error as text reads", async () => {
    setup();
    const res = await handler(new Request(`http://localhost/api/file/raw?path=${encodeURIComponent(join(homeDir, "nope.pdf"))}`));
    expect(res.status).toBe(404);
  });

  it("requires a path for raw file reads", async () => {
    setup();
    const res = await handler(new Request("http://localhost/api/file/raw"));
    expect(res.status).toBe(400);
  });

  it("creates a session for an exact cwd", async () => {
    setup();
    const res = await handler(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectDir }),
      }),
    );
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { id: string; cwd: string; status: string };
    expect(dto.cwd).toBe(projectDir);
    expect(dto.id).toBe("sess-1");
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0]?.options.cwd).toBe(projectDir);
  });

  it("opens a historical session using its recorded cwd", async () => {
    const sessionPath = "/agent/sessions/--p--/a.jsonl";
    historySessions = [
      {
        id: "h1",
        path: sessionPath,
        cwd: projectDir,
        created: "2026-08-01T00:00:00.000Z",
        modified: "2026-08-01T00:00:00.000Z",
        messageCount: 1,
        firstMessage: "hello",
      },
    ];
    setup();
    const res = await handler(
      new Request("http://localhost/api/sessions/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sessionPath }),
      }),
    );
    expect(res.status).toBe(200);
    const dto = (await res.json()) as { id: string };
    expect(dto.id).toBe("sess-1");
    expect(factory.created[0]?.options.sessionPath).toBe(sessionPath);
    expect(factory.created[0]?.options.cwd).toBe(projectDir);
  });

  it("lists active sessions", async () => {
    setup();
    await handler(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectDir }),
      }),
    );
    const res = await handler(new Request("http://localhost/api/active-sessions"));
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(1);
  });

  it("returns a session snapshot", async () => {
    setup();
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };
    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/snapshot`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { id: string }; messages: unknown[] };
    expect(body.session.id).toBe(created.id);
    expect(body.messages).toEqual([]);
  });

  it("includes subagent summaries in a parent HTTP snapshot", async () => {
    const subagents = [{
      toolCallId: "tool-1",
      childSessionId: "child-1",
      agent: "search",
      latestMessage: "final child reply",
    }];
    setup({
      subagentSessions: {
        summaries: async () => subagents,
        snapshot: async () => { throw new Error("not used"); },
      },
    });
    const created = await registry.create({ cwd: projectDir });

    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/snapshot`));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ subagents });
  });

  it("returns a complete read-only child snapshot", async () => {
    const childSnapshot = {
      session: { id: "child-1", cwd: projectDir, sessionName: "lazyresearch:search" },
      messages: [userMessage("dispatch"), assistant("complete child reply")],
    };
    setup({
      subagentSessions: {
        summaries: async () => [],
        snapshot: async () => childSnapshot,
      },
    });

    const res = await handler(new Request("http://localhost/api/sessions/parent-1/subagents/child-1/snapshot"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(childSnapshot);
  });

  it("maps an unmapped child snapshot to JSON 404", async () => {
    setup();

    const res = await handler(new Request("http://localhost/api/sessions/parent-1/subagents/unmapped/snapshot"));

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Subagent session not found: unmapped" });
  });

  it("does not add a child snapshot to the active-session registry", async () => {
    setup({
      subagentSessions: {
        summaries: async () => [],
        snapshot: async () => ({
          session: { id: "child-1", cwd: projectDir },
          messages: [assistant("complete child reply")],
        }),
      },
    });
    const parent = await registry.create({ cwd: projectDir });
    const activeBefore = registry.list().length;

    const res = await handler(new Request(`http://localhost/api/sessions/${parent.id}/subagents/child-1/snapshot`));

    expect(res.status).toBe(200);
    expect(registry.list()).toHaveLength(activeBefore);
  });

  it("returns a child snapshot after the parent registry entry is stopped", async () => {
    setup({
      subagentSessions: {
        summaries: async () => [],
        snapshot: async () => ({
          session: { id: "child-1", cwd: projectDir },
          messages: [assistant("persisted child reply")],
        }),
      },
    });
    const parent = await registry.create({ cwd: projectDir });
    await registry.stop(parent.id);
    expect(registry.list()).toEqual([]);

    const res = await handler(new Request(`http://localhost/api/sessions/${parent.id}/subagents/child-1/snapshot`));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ messages: [{ role: "assistant" }] });
  });

  it("streams snapshot and forwarded RPC events over SSE", async () => {
    setup();
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };

    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"type":"snapshot"');

    const adapter = factory.created[0]!;
    adapter.events.forEach((listener) => listener({ type: "message_start" } as never));
    const second = await reader.read();
    expect(decoder.decode(second.value)).toContain('"type":"message_start"');
    reader.cancel();
  });

  it("streams file watcher events over the existing SSE connection", async () => {
    setup();
    const created = await registry.create({ cwd: projectDir });
    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      await reader.read();
      watcherFactory.emit({
        type: "file.watcher.updated",
        properties: { file: `${projectDir}/new.md`, event: "add" },
      });
      const next = await reader.read();
      expect(decoder.decode(next.value)).toContain(
        JSON.stringify({
          type: "file.watcher.updated",
          properties: { file: `${projectDir}/new.md`, event: "add" },
        }),
      );
    } finally {
      await reader.cancel();
    }
  });

  it("includes the same subagent summaries in the first SSE snapshot", async () => {
    const subagents = [{
      toolCallId: "tool-1",
      childSessionId: "child-1",
      agent: "search",
      latestMessage: "final child reply",
    }];
    setup({
      subagentSessions: {
        summaries: async () => subagents,
        snapshot: async () => { throw new Error("not used"); },
      },
    });
    const parent = await registry.create({ cwd: projectDir });

    const res = await handler(new Request(`http://localhost/api/sessions/${parent.id}/events`));
    const reader = res.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    const payload = new TextDecoder().decode(first.value);

    expect(payload).toContain(`"subagents":${JSON.stringify(subagents)}`);
  });

  it("logs SSE connect on subscribe and disconnect on cancel", async () => {
    const logger = fakeLogger();
    setup({ logger });
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };

    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    expect(res.status).toBe(200);
    expect(logger.calls).toContainEqual(["info", "sse connected", { sessionId: created.id }]);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"type":"snapshot"');
    await reader.cancel();
    await vi.waitFor(() =>
      expect(logger.calls).toContainEqual(["info", "sse disconnected", { sessionId: created.id }]),
    );
  });

  it("emits session_deactivated over SSE and then 404s", async () => {
    setup();
    const created = await registry.create({ cwd: "/test/proj" });
    const adapter = factory.created[0]!;
    const res = await handler(new Request(`http://localhost/api/sessions/${created.id}/events`));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"type":"snapshot"');
    let body = "";
    try {
      adapter.events.forEach((listener) => listener({ type: "agent_start" } as never));
      adapter.events.forEach((listener) => listener({ type: "agent_settled" } as never));
      while (!body.includes("session_deactivated")) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value);
      }
      expect(body).toContain(JSON.stringify({ type: "session_deactivated", sessionId: created.id }));
    } finally {
      await reader.cancel();
    }
    const snap = await handler(new Request(`http://localhost/api/sessions/${created.id}/snapshot`));
    expect(snap.status).toBe(404);
  });

  it("posts a prompt to the active session", async () => {
    setup();
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };
    const res = await handler(
      new Request(`http://localhost/api/sessions/${created.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Write a paper" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(factory.created[0]?.prompts).toEqual(["Write a paper"]);
  });

  it("aborts, stops, and 404s restarting a stopped session", async () => {
    setup();
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };

    expect((await handler(new Request(`http://localhost/api/sessions/${created.id}/abort`, { method: "POST" }))).status).toBe(200);
    expect(factory.created[0]?.aborts).toBe(1);

    expect((await handler(new Request(`http://localhost/api/sessions/${created.id}/stop`, { method: "POST" }))).status).toBe(200);
    expect(factory.created[0]?.stopped).toBe(1);

    const restarted = await handler(new Request(`http://localhost/api/sessions/${created.id}/restart`, { method: "POST" }));
    expect(restarted.status).toBe(404);
    expect(factory.created).toHaveLength(1);
  });

  it("restarts a live session in place", async () => {
    setup();
    const created = (await (
      await handler(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: projectDir }),
        }),
      )
    ).json()) as { id: string };

    const restarted = await handler(new Request(`http://localhost/api/sessions/${created.id}/restart`, { method: "POST" }));
    expect(restarted.status).toBe(200);
    expect(factory.created).toHaveLength(2);
    const dto = (await restarted.json()) as { id: string };
    expect(dto.id).not.toBe(created.id);
  });

  it("lists, reads, writes, and creates config entries", async () => {
    setup();
    const list = await handler(new Request(`http://localhost/api/config?scope=global`));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);

    const write = await handler(
      new Request("http://localhost/api/config/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "global", path: "settings.json", content: '{"defaultModel":"a"}' }),
      }),
    );
    expect(write.status).toBe(200);

    const read = await handler(new Request(`http://localhost/api/config/file?scope=global&path=settings.json`));
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("defaultModel");

    const dir = await handler(
      new Request("http://localhost/api/config/directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "global", path: "agents" }),
      }),
    );
    expect(dir.status).toBe(200);
    const after = (await (await handler(new Request(`http://localhost/api/config?scope=global`))).json()) as { name: string }[];
    expect(after.map((e) => e.name)).toEqual(["agents", "settings.json"]);
  });

  it("returns 400 for malformed JSON bodies", async () => {
    setup();
    const res = await handler(
      new Request("http://localhost/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown active session ids", async () => {
    setup();
    const res = await handler(new Request("http://localhost/api/sessions/nope/snapshot"));
    expect(res.status).toBe(404);
  });

  it("returns 403 for config path escapes", async () => {
    setup();
    const res = await handler(
      new Request("http://localhost/api/config/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "global", path: "../evil.json", content: "{}" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 when reading a missing config file", async () => {
    setup();
    const res = await handler(new Request(`http://localhost/api/config/file?scope=global&path=settings.json`));
    expect(res.status).toBe(404);
  });

  it("returns 500 without secret content on internal errors", async () => {
    setup({ listAllSessions: async () => Promise.reject(new Error("boom")) });
    const res = await handler(new Request("http://localhost/api/status"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("boom");
  });

  it("serves static assets and 404s unknown paths", async () => {
    setup();
    const index = await handler(new Request("http://localhost/"));
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<div id=\"root\">");
    expect((await handler(new Request("http://localhost/nope"))).status).toBe(404);
  });

  it("serves .mjs modules with a JavaScript MIME type so PDF workers can load", async () => {
    writeFileSync(join(webuiDist, "pdf.worker.min.mjs"), "self.streamSink", "utf-8");
    setup();
    const worker = await handler(new Request("http://localhost/pdf.worker.min.mjs"));
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toMatch(/text\/javascript/);
    expect(await worker.text()).toBe("self.streamSink");
  });

  it("lists the agent roster with tools/subagents/skills without leaking system prompts or model", async () => {
    setup({
      listAgents: async () => [
        { name: "orchestrator", description: "Runs the pipeline", tools: ["subagent"], skills: ["research-project-workflow"] },
        { name: "search", description: "Finds papers", subagents: [], skills: [] },
      ],
    });
    const res = await handler(new Request("http://localhost/api/agents"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      name: string;
      description: string;
      tools?: string[];
      subagents?: string[];
      skills?: string[];
      systemPrompt?: string;
      model?: string;
    }>;
    expect(body.map((a) => a.name)).toEqual(["orchestrator", "search"]);
    expect(body[0]?.tools).toEqual(["subagent"]);
    expect(body[0]?.skills).toEqual(["research-project-workflow"]);
    expect(body[1]?.skills).toEqual([]);
    expect(body[0]?.systemPrompt).toBeUndefined();
    expect(body[0]?.model).toBeUndefined();
  });

  it("maps a discovered AgentConfig into the roster DTO without private fields", () => {
    expect(
      agentToDto({
        name: "search",
        description: "Finds papers",
        tools: ["bash"],
        subagents: ["experiment"],
        skills: ["paper-search"],
        model: "deepseek/ds-v3",
        systemPrompt: "SECRET PROMPT",
        source: "global",
        filePath: "/agent/agents/search.md",
      }),
    ).toEqual({
      name: "search",
      description: "Finds papers",
      tools: ["bash"],
      subagents: ["experiment"],
      skills: ["paper-search"],
    });
  });

  it("recognizes registry-discovered agent names via isKnownAgentName", async () => {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "search.md"), "---\nname: search\ndescription: finds papers\n---\nbody", "utf-8");
    const { agents } = await discoverAgents({
      agentDir,
      registry: { search: { definition: "agents/search.md", tools: ["bash"] } },
    });
    expect(isKnownAgentName(agents, "search")).toBe(true);
    expect(isKnownAgentName(agents, "writing")).toBe(false);
  });

  it("lists available models", async () => {
    setup({
      listModels: async () => [
        { provider: "openai", id: "gpt-4o" },
        { provider: "deepseek", id: "ds-v3" },
      ],
    });
    const res = await handler(new Request("http://localhost/api/models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ provider: string; id: string }> };
    expect(body.models).toEqual([
      { provider: "openai", id: "gpt-4o" },
      { provider: "deepseek", id: "ds-v3" },
    ]);
  });

  it("GET /api/webui-settings returns the settings object", async () => {
    const res = await handler(new Request("http://localhost/api/webui-settings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agentModels: {} });
  });

  it("PUT /api/webui-settings forwards the partial patch and returns the updated object", async () => {
    const res = await handler(
      new Request("http://localhost/api/webui-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentModels: { search: "openai/gpt-4o" } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agentModels: { search: "openai/gpt-4o" } });
  });

  it("PUT /api/webui-settings maps WebuiSettingsError to its status", async () => {
    const updateWebuiSettings = vi.fn(async () => {
      throw new WebuiSettingsError(400, "agentModels must be an object");
    });
    setup({ updateWebuiSettings });
    const res = await handler(
      new Request("http://localhost/api/webui-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentModels: 42 }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("agentModels");
  });

  it("round-trips the orchestrator default model through the real settings store", async () => {
    const TEST_AVAILABLE = [{ provider: "oc", id: "deepseek-v4-flash-free" }];
    setup({
      getWebuiSettings: () => readEffectiveWebuiSettings(configService, TEST_AVAILABLE),
      updateWebuiSettings: async (patch) => {
        await updateWebuiSettings(configService, patch);
        return readEffectiveWebuiSettings(configService, TEST_AVAILABLE);
      },
    });
    const put = await handler(
      new Request("http://localhost/api/webui-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orchestratorModel: "openai/gpt-4o" }),
      }),
    );
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { orchestratorModel: string | null; effectiveOrchestratorModel: string | null };
    expect(putBody.orchestratorModel).toBe("openai/gpt-4o");
    expect(putBody.effectiveOrchestratorModel).toBe("openai/gpt-4o");

    const get = await handler(new Request("http://localhost/api/webui-settings"));
    expect((await get.json()).orchestratorModel).toBe("openai/gpt-4o");

    const clear = await handler(
      new Request("http://localhost/api/webui-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orchestratorModel: null }),
      }),
    );
    expect(clear.status).toBe(200);
    expect((await clear.json()).orchestratorModel).toBeNull();
  });

  it("GET reports the Pi fallback model when no orchestrator default is configured", async () => {
    setup({
      getWebuiSettings: () => readEffectiveWebuiSettings(configService, [{ provider: "oc", id: "deepseek-v4-flash-free" }]),
    });
    const res = await handler(new Request("http://localhost/api/webui-settings"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orchestratorModel).toBeNull();
    expect(body.effectiveOrchestratorModel).toBe("oc/deepseek-v4-flash-free");
  });

  it("forwards a null orchestratorModel patch to the settings store", async () => {
    const updateWebuiSettingsMock = vi.fn(async (patch) => ({
      agentModels: {},
      orchestratorModel: null,
      effectiveOrchestratorModel: null,
      ...patch,
    }));
    setup({ updateWebuiSettings: updateWebuiSettingsMock });
    const res = await handler(
      new Request("http://localhost/api/webui-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orchestratorModel: null }),
      }),
    );
    expect(res.status).toBe(200);
    expect(updateWebuiSettingsMock).toHaveBeenCalledWith({ orchestratorModel: null });
  });

  it("returns the effective models for a session", async () => {
    const effectiveModels = vi.fn(async () => [{ name: "search", model: "a/1", source: "override" as const }]);
    setup({ effectiveModels });
    const res = await handler(new Request("http://localhost/api/sessions/s1/agents/effective-models"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: "search", model: "a/1", source: "override" }]);
    expect(effectiveModels).toHaveBeenCalledWith("s1");
  });

  it("returns 404 for effective models of an unknown session", async () => {
    setup({
      effectiveModels: async () => {
        throw new UnknownSessionError("Unknown session: nope");
      },
    });
    const res = await handler(new Request("http://localhost/api/sessions/nope/agents/effective-models"));
    expect(res.status).toBe(404);
  });

  it("sets a stage agent model via PUT and returns ok", async () => {
    const setAgentModel = vi.fn(async () => {});
    setup({ setAgentModel });
    const res = await handler(
      new Request("http://localhost/api/sessions/s1/agents/search/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "x/y" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(setAgentModel).toHaveBeenCalledWith("s1", "search", "x/y");
  });

  it("sets a null model (reset) via PUT", async () => {
    const setAgentModel = vi.fn(async () => {});
    setup({ setAgentModel });
    const res = await handler(
      new Request("http://localhost/api/sessions/s1/agents/figures/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: null }),
      }),
    );
    expect(res.status).toBe(200);
    expect(setAgentModel).toHaveBeenCalledWith("s1", "figures", null);
  });

  it("rejects a non-string model body with 400", async () => {
    const setAgentModel = vi.fn(async () => {});
    setup({ setAgentModel });
    const res = await handler(
      new Request("http://localhost/api/sessions/s1/agents/search/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: 42 }),
      }),
    );
    expect(res.status).toBe(400);
    expect(setAgentModel).not.toHaveBeenCalled();
  });

  it("surfaces AgentModelError statuses from setAgentModel (409 reset without default)", async () => {
    setup({
      setAgentModel: async () => {
        throw new AgentModelError(409, "No default model configured");
      },
    });
    const res = await handler(
      new Request("http://localhost/api/sessions/s1/agents/orchestrator/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: null }),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("lists config projects from session cwds", async () => {
    setup({
      listConfigProjects: async () => ({ home: agentDir, projects: [{ cwd: projectDir }] }),
    });
    const res = await handler(new Request("http://localhost/api/config/projects"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ home: agentDir, projects: [{ cwd: projectDir }] });
  });
});

interface SessionInfoLike {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

function sessionInfo(patch: Partial<SessionInfoLike>): SessionInfoLike {
  return {
    id: "sess",
    path: "/agent/sessions/sess.jsonl",
    cwd: "/proj",
    created: new Date("2026-08-10T00:00:00.000Z"),
    modified: new Date("2026-08-10T00:00:00.000Z"),
    messageCount: 1,
    firstMessage: "write a paper",
    ...patch,
  };
}

describe("toUserSessionSummaries", () => {
  it("excludes internal lazyresearch child session lines from the user home list", () => {
    expect(toUserSessionSummaries([
      sessionInfo({ id: "main", name: undefined, firstMessage: "write a paper" }),
      sessionInfo({ id: "child", name: "lazyresearch:search", firstMessage: "Task: search" }),
    ])).toEqual([
      expect.objectContaining({ id: "main", firstMessage: "write a paper" }),
    ]);
  });

  it("uses literal startsWith filtering, including the exact internal prefix", () => {
    const results = toUserSessionSummaries([
      sessionInfo({ id: "s1", name: "lazyresearch:search", firstMessage: "child" }),
      sessionInfo({ id: "s2", name: "my lazyresearch:search notes", firstMessage: "user" }),
      sessionInfo({ id: "s3", name: "lazyresearch:", firstMessage: "user" }),
    ]);
    expect(results.map((session) => session.id)).toEqual(["s2"]);
  });
});
