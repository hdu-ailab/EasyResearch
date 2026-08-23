import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as apiModule from "./api";
import {
  ApiError,
  abortSession,
  checkForUpdate,
  connectConfigurationEvents,
  connectSessionEvents,
  createConfigDirectory,
  createSession,
  getSessionCommands,
  getSessionTree,
  getSnapshot,
  listAgents,
  listConfig,
  listConfigProjects,
  listDirectories,
  listModels,
  listStatus,
  navigateSessionTree,
  openSession,
  patchAgent,
  readConfigFile,
  replaceFileWatchDirectories,
  restartSession,
  sendPrompt,
  stopSession,
  touchSession,
  writeConfigFile,
} from "./api";

type RawByteReader = (path: string, options: { maxBytes: number; signal?: AbortSignal }) => Promise<ArrayBuffer>;
type CompactSession = (id: string, customInstructions?: string) => Promise<{ state: "queued" | "running" }>;

function rawByteReader(): RawByteReader {
  const reader = (apiModule as typeof apiModule & { readRawFileBytes?: RawByteReader }).readRawFileBytes;
  if (!reader) throw new Error("readRawFileBytes is not implemented");
  return reader;
}

function compactSession(): CompactSession {
  const compact = (apiModule as typeof apiModule & { compactSession?: CompactSession }).compactSession;
  if (!compact) throw new Error("compactSession is not implemented");
  return compact;
}

describe("api transport", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("listStatus GETs /api/status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ agentDir: "/a", homeDir: "/home/user", sessions: [], activeSessions: [] }), {
        status: 200,
      }),
    );
    const result = await listStatus();
    expect(fetchMock).toHaveBeenCalledWith("/api/status", expect.objectContaining({ method: "GET" }));
    expect(result.agentDir).toBe("/a");
  });

  it("checkForUpdate GETs the same-origin update endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ latestVersion: "0.0.62" }), { status: 200 }));

    await expect(checkForUpdate()).resolves.toEqual({ latestVersion: "0.0.62" });
    expect(fetchMock).toHaveBeenCalledWith("/api/update-check", expect.objectContaining({ method: "GET" }));
  });

  it("listModels GETs /api/models", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          models: [{ provider: "openai", id: "gpt-4o", reasoning: true, thinkingLevelMap: { xhigh: null, max: null } }],
        }),
        { status: 200 },
      ),
    );
    const models = await listModels();
    expect(fetchMock).toHaveBeenCalledWith("/api/models", expect.objectContaining({ method: "GET" }));
    expect(models[0]?.id).toBe("gpt-4o");
    expect(models[0]?.reasoning).toBe(true);
    expect(models[0]?.thinkingLevelMap).toEqual({ xhigh: null, max: null });
  });

  it("patchAgent PATCHes one encoded global Agent and returns the authoritative row", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: "reviewer/strict",
          description: "Reviews strictly",
          enabled: true,
          builtin: false,
          source: "global",
          filePath: "/agent/agents/reviewer-strict.md",
          model: "openai/gpt-4o",
          effectiveTools: [],
          effectiveSkills: [],
          missingSkills: [],
        }),
        { status: 200 },
      ),
    );
    const agent = await patchAgent("reviewer/strict", { model: "openai/gpt-4o", thinking: null });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/agents/reviewer%2Fstrict");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ model: "openai/gpt-4o", thinking: null });
    expect(agent).toMatchObject({ name: "reviewer/strict", source: "global", model: "openai/gpt-4o" });
  });

  it("listDirectories GETs /api/directories with path", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ entries: [] }), { status: 200 }));
    await listDirectories("/home/user");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(url).toBe("/api/directories?path=%2Fhome%2Fuser");
  });

  it("reads bounded raw file bytes through the same-origin API and forwards abort", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    fetchMock.mockResolvedValueOnce(
      new Response(bytes, { status: 200, headers: { "Content-Length": String(bytes.byteLength) } }),
    );
    const controller = new AbortController();

    const result = await rawByteReader()("/p/paper.docx", { maxBytes: 8, signal: controller.signal });

    expect(new Uint8Array(result)).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledWith("/api/file/raw?path=%2Fp%2Fpaper.docx", {
      method: "GET",
      signal: controller.signal,
    });
  });

  it("rejects an oversized declared response before buffering it", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Length": "3" },
    });
    const readBody = vi.spyOn(response, "arrayBuffer");
    const cancelBody = vi.spyOn(response.body!, "cancel");
    fetchMock.mockResolvedValueOnce(response);

    await expect(rawByteReader()("/p/large.docx", { maxBytes: 2 })).rejects.toMatchObject({
      name: "RawFileSizeError",
      maxBytes: 2,
      actualBytes: 3,
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it("rejects oversized bytes when Content-Length is absent or understated", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Length": "1" } }),
    );

    await expect(rawByteReader()("/p/understated.docx", { maxBytes: 2 })).rejects.toMatchObject({
      name: "RawFileSizeError",
      maxBytes: 2,
      actualBytes: 3,
    });
  });

  it("rejects a declared length beyond the safe-integer range before buffering", async () => {
    const response = new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "Content-Length": "9007199254740992" },
    });
    const readBody = vi.spyOn(response, "arrayBuffer");
    fetchMock.mockResolvedValueOnce(response);

    await expect(rawByteReader()("/p/impossible.docx", { maxBytes: 2 })).rejects.toMatchObject({
      name: "RawFileSizeError",
      maxBytes: 2,
    });
    expect(readBody).not.toHaveBeenCalled();
  });

  it("listAgents GETs /api/agents for the exact cwd and preserves missing skills", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            name: "search",
            description: "Finds papers",
            enabled: true,
            builtin: true,
            source: "global",
            filePath: "/agent/agents/search.md",
            tools: ["web-search"],
            effectiveTools: ["web-search"],
            subagents: [],
            skills: ["paper-search", "missing-skill"],
            effectiveSkills: ["paper-search"],
            missingSkills: ["missing-skill"],
          },
        ]),
        { status: 200 },
      ),
    );
    const agents = await listAgents("/exact/project");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents?cwd=%2Fexact%2Fproject",
      expect.objectContaining({ method: "GET" }),
    );
    expect(agents[0]?.skills).toEqual(["paper-search", "missing-skill"]);
    expect(agents[0]?.effectiveSkills).toEqual(["paper-search"]);
    expect(agents[0]?.missingSkills).toEqual(["missing-skill"]);
  });

  it.each([
    ["absent", undefined],
    ["not an array", "missing-skill"],
    ["contains non-strings", ["missing-skill", 42]],
  ])("rejects an agent payload when missingSkills is %s", async (_case, missingSkills) => {
    const agent: Record<string, unknown> = {
      name: "search",
      description: "Finds papers",
      enabled: true,
      builtin: true,
      source: "bundled",
      filePath: "search.md",
      effectiveTools: [],
      effectiveSkills: [],
    };
    if (missingSkills !== undefined) agent.missingSkills = missingSkills;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([agent]), { status: 200 }));

    await expect(listAgents()).rejects.toThrow();
  });

  it("createSession POSTs cwd only", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "s1", cwd: "/p", isStreaming: false, status: "ready" }), { status: 200 }),
    );
    await createSession("/p");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions");
    expect(JSON.parse(init.body as string)).toEqual({ cwd: "/p" });
  });

  it("openSession POSTs path only", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "s1", cwd: "/p", isStreaming: false, status: "ready" }), { status: 200 }),
    );
    await openSession("/agent/s/a.jsonl");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/open");
    expect(JSON.parse(init.body as string)).toEqual({ path: "/agent/s/a.jsonl" });
  });

  it("touchSession POSTs the encoded session endpoint", async () => {
    await touchSession("abc/123");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/abc%2F123/touch", { method: "POST" });
  });

  it("replaces one encoded file-watch lease with its complete directory set", async () => {
    await replaceFileWatchDirectories("session/1", "lease/1", 3, ["/p", "/p/src"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/session%2F1/file-watches/lease%2F1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ revision: 3, directories: ["/p", "/p/src"] });
  });

  it("getSnapshot GETs session snapshot", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          session: { id: "s1", cwd: "/p", isStreaming: false, status: "ready" },
          messages: [],
          subagents: [],
        }),
        { status: 200 },
      ),
    );
    await getSnapshot("s1");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/sessions/s1/snapshot");
  });

  it("sendPrompt POSTs message", async () => {
    await sendPrompt("s1", "hello");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/s1/messages");
    expect(JSON.parse(init.body as string)).toEqual({ message: "hello" });
  });

  it("getSessionCommands GETs the session commands endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          commands: [
            { name: "arxiv", description: "arXiv", source: "skill", requiresPrefix: true },
            { name: "name", source: "extension" },
          ],
        }),
        { status: 200 },
      ),
    );
    const commands = await getSessionCommands("s1");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/commands", expect.objectContaining({ method: "GET" }));
    expect(commands).toEqual([
      { name: "arxiv", description: "arXiv", source: "skill", requiresPrefix: true },
      { name: "name", source: "extension" },
    ]);
  });

  it("getSessionTree GETs the session tree endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          leafId: "m2",
          filterMode: "default",
          skipBranchSummaryPrompt: false,
          tree: [{ id: "m1", parentId: null, role: "user", kind: "user", text: "hi" }],
        }),
        { status: 200 },
      ),
    );
    const tree = await getSessionTree("s1");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/tree", expect.objectContaining({ method: "GET" }));
    expect(tree.leafId).toBe("m2");
    expect(tree.tree).toHaveLength(1);
  });

  it("navigateSessionTree POSTs summary options and parses Pi's editor text", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ cancelled: false, editorText: "original prompt", leafId: "entry-8" }), {
        status: 200,
      }),
    );
    const result = await (
      navigateSessionTree as unknown as (
        id: string,
        entryId: string,
        options: { summarize: boolean; customInstructions: string },
      ) => Promise<unknown>
    )("s1", "entry-9", { summarize: true, customInstructions: "focus on evidence" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/s1/tree/navigate");
    expect(JSON.parse(init.body as string)).toEqual({
      entryId: "entry-9",
      summarize: true,
      customInstructions: "focus on evidence",
    });
    expect(result).toEqual({ cancelled: false, editorText: "original prompt", leafId: "entry-8" });
  });

  it("compactSession POSTs optional instructions and parses the accepted state", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ state: "queued" }), { status: 200 }));

    const result = await compactSession()("s1", "Keep experiment decisions");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/s1/compact");
    expect(JSON.parse(init.body as string)).toEqual({ customInstructions: "Keep experiment decisions" });
    expect(result).toEqual({ state: "queued" });
  });

  it("abortSession, stopSession, restartSession hit their endpoints", async () => {
    await abortSession("s1");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/s1/abort");
    await stopSession("s1");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/sessions/s1/stop");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "s1", cwd: "/p", isStreaming: false, status: "ready" }), { status: 200 }),
    );
    await restartSession("s1");
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/sessions/s1/restart");
  });

  it("accepts an empty 204 response for void commands", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await abortSession("s1");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/abort", { method: "POST" });
  });

  it("listConfig sends scope, cwd, and path", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    await listConfig("project", "/p", "agents");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/config?scope=project&cwd=%2Fp&path=agents");
  });

  it("listConfigProjects GETs /api/config/projects", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ home: "/h", projects: [{ cwd: "/p" }] }), { status: 200 }),
    );
    const dto = await listConfigProjects();
    expect(fetchMock).toHaveBeenCalledWith("/api/config/projects", expect.objectContaining({ method: "GET" }));
    expect(dto.home).toBe("/h");
  });

  it("readConfigFile GETs /api/config/file", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ path: "settings.json", content: "{}" }), { status: 200 }),
    );
    await readConfigFile("global", "/p", "settings.json");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/config/file?scope=global&cwd=%2Fp&path=settings.json");
  });

  it("writeConfigFile PUTs content", async () => {
    await writeConfigFile("project", "/p", "settings.json", '{"a":1}');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/config/file");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      scope: "project",
      cwd: "/p",
      path: "settings.json",
      content: '{"a":1}',
    });
  });

  it("createConfigDirectory POSTs /api/config/directory", async () => {
    await createConfigDirectory("project", "/p", "agents");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/config/directory");
    expect(JSON.parse(init.body as string)).toEqual({ scope: "project", cwd: "/p", path: "agents" });
  });

  it("throws ApiError with status and body details on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "nope", options: [1] }), { status: 409 }));
    const error = await listStatus().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).details).toEqual({ error: "nope", options: [1] });
  });

  it("ApiError message never includes request content", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 400 }));
    const error = (await writeConfigFile("global", "/p", "secrets.json", "SECRET-PAYLOAD").catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(error.message).not.toContain("SECRET-PAYLOAD");
    expect(error.message).toContain("boom");
  });
});

describe("connectSessionEvents", () => {
  let FakeEventSource: {
    instances: {
      url: string;
      onmessage: ((e: MessageEvent) => void) | null;
      onerror: (() => void) | null;
      close: () => void;
    }[];
  };

  beforeEach(() => {
    FakeEventSource = {
      instances: [],
    } as typeof FakeEventSource;
    class ES {
      static instances: typeof FakeEventSource.instances = FakeEventSource.instances;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        ES.instances.push(this as unknown as (typeof FakeEventSource.instances)[number]);
      }
      close() {}
    }
    vi.stubGlobal("EventSource", ES);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates an EventSource at the session endpoint and returns close", () => {
    const handlers = { onEvent: vi.fn(), onError: vi.fn() };
    const unsubscribe = connectSessionEvents("abc/123", handlers);
    const instance = FakeEventSource.instances[0]!;
    expect(instance.url).toBe("/api/sessions/abc%2F123/events");
    instance.onmessage?.({ data: '{"type":"agent_settled"}' } as MessageEvent);
    expect(handlers.onEvent).toHaveBeenCalledWith({ type: "agent_settled" });
    instance.onerror?.();
    expect(handlers.onError).toHaveBeenCalled();
    const closed = vi.spyOn(instance, "close");
    unsubscribe();
    expect(closed).toHaveBeenCalled();
  });

  it("calls onError on malformed payload", () => {
    const handlers = { onEvent: vi.fn(), onError: vi.fn() };
    connectSessionEvents("s1", handlers);
    const instance = FakeEventSource.instances[0]!;
    instance.onmessage?.({ data: "{not json" } as MessageEvent);
    expect(handlers.onEvent).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalled();
  });
});

describe("connectConfigurationEvents", () => {
  let instances: {
    url: string;
    onmessage: ((e: MessageEvent) => void) | null;
    onerror: (() => void) | null;
    close: () => void;
  }[];

  beforeEach(() => {
    instances = [];
    class ES {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        instances.push(this);
      }
      close() {}
    }
    vi.stubGlobal("EventSource", ES);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates configuration events and leaves native reconnect ownership open", () => {
    const handlers = { onEvent: vi.fn(), onError: vi.fn() };
    const disconnect = connectConfigurationEvents(handlers);
    const source = instances[0]!;
    expect(source.url).toBe("/api/config/events");

    source.onmessage?.({
      data: JSON.stringify({ type: "config.updated", generation: 2, agentsChanged: true, modelsChanged: false }),
    } as MessageEvent);
    expect(handlers.onEvent).toHaveBeenCalledWith({
      type: "config.updated",
      generation: 2,
      agentsChanged: true,
      modelsChanged: false,
    });

    source.onmessage?.({ data: JSON.stringify({ type: "config.updated", generation: "2" }) } as MessageEvent);
    expect(handlers.onEvent).toHaveBeenCalledTimes(1);
    expect(handlers.onError).toHaveBeenCalledTimes(1);

    source.onerror?.();
    expect(handlers.onError).toHaveBeenCalledTimes(2);
    const close = vi.spyOn(source, "close");
    disconnect();
    expect(close).toHaveBeenCalledOnce();
  });
});
