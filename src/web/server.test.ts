import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RpcEventListener, RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { RouteServices } from "./routes";
import { createRouteHandler } from "./routes";
import type { RpcSessionAdapter, RpcSessionFactory, StartRpcSessionOptions } from "./rpc-session";
import { ActiveSessionRegistry } from "./active-sessions";
import { DirectoryService } from "./directories";
import { ConfigFileService } from "./config-files";
import type { SessionSummaryDto } from "./contracts";

vi.mock("../runtime/extensions-guard", () => ({
  assertNoUserExtensions: vi.fn(),
  ExtensionGuardError: class ExtensionGuardError extends Error {},
}));

class FakeAdapter implements RpcSessionAdapter {
  static all: FakeAdapter[] = [];
  static nextId = 0;
  events = new Set<RpcEventListener>();
  exitListeners = new Set<(error: Error) => void>();
  prompts: string[] = [];
  aborts = 0;
  stopped = 0;
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

describe("web routes", () => {
  let webuiDist: string;
  let homeDir: string;
  let agentDir: string;
  let projectDir: string;
  let factory: FakeFactory;
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
    registry = new ActiveSessionRegistry(factory);
    directoryService = new DirectoryService(homeDir);
    configService = new ConfigFileService(agentDir);
    historySessions = [];
  });

  function setup(overrides: Partial<RouteServices> = {}): void {
    const services: RouteServices = {
      webuiDist,
      listAllSessions: async () => historySessions,
      directories: directoryService,
      registry,
      config: configService,
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

  it("aborts, stops, and restarts an active session", async () => {
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
    expect(restarted.status).toBe(200);
    expect(factory.created).toHaveLength(2);
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
});
