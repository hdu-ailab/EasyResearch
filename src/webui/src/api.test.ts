import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  abortSession,
  connectSessionEvents,
  createConfigDirectory,
  createSession,
  getEffectiveModels,
  getSnapshot,
  listAgents,
  listConfig,
  listConfigProjects,
  listDirectories,
  listModels,
  listStatus,
  openSession,
  readConfigFile,
  restartSession,
  sendPrompt,
  setAgentModel,
  stopSession,
  writeConfigFile,
} from "./api";

describe("api transport", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("listStatus GETs /api/status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ agentDir: "/a", sessions: [], activeSessions: [] }), { status: 200 }),
    );
    const result = await listStatus();
    expect(fetchMock).toHaveBeenCalledWith("/api/status", expect.objectContaining({ method: "GET" }));
    expect(result.agentDir).toBe("/a");
  });

  it("listModels GETs /api/models", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ provider: "openai", id: "gpt-4o" }] }), { status: 200 }),
    );
    const models = await listModels();
    expect(fetchMock).toHaveBeenCalledWith("/api/models", expect.objectContaining({ method: "GET" }));
    expect(models[0]?.id).toBe("gpt-4o");
  });

  it("getEffectiveModels GETs the session endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ name: "search", model: "a/1", source: "override" }]), { status: 200 }),
    );
    const list = await getEffectiveModels("s1");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1/agents/effective-models", expect.objectContaining({ method: "GET" }));
    expect(list[0]?.source).toBe("override");
  });

  it("setAgentModel PUTs the agent model", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await setAgentModel("s1", "search", "openai/gpt-4o");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/s1/agents/search/model");
    expect(init.method).toBe("PUT");
  });

  it("listDirectories GETs /api/directories with path", async () => {
    await listDirectories("/home/user");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(url).toBe("/api/directories?path=%2Fhome%2Fuser");
  });

  it("listAgents GETs /api/agents", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ name: "search", description: "Finds papers" }]), { status: 200 }),
    );
    const agents = await listAgents();
    expect(fetchMock).toHaveBeenCalledWith("/api/agents", expect.objectContaining({ method: "GET" }));
    expect(agents[0]?.name).toBe("search");
  });

  it("createSession POSTs cwd only", async () => {
    await createSession("/p");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions");
    expect(JSON.parse(init.body as string)).toEqual({ cwd: "/p" });
  });

  it("openSession POSTs path only", async () => {
    await openSession("/agent/s/a.jsonl");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sessions/open");
    expect(JSON.parse(init.body as string)).toEqual({ path: "/agent/s/a.jsonl" });
  });

  it("getSnapshot GETs session snapshot", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ session: { id: "s1" }, messages: [] }), { status: 200 }),
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

  it("abortSession, stopSession, restartSession hit their endpoints", async () => {
    await abortSession("s1");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/s1/abort");
    await stopSession("s1");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/sessions/s1/stop");
    await restartSession("s1");
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/sessions/s1/restart");
  });

  it("listConfig sends scope, cwd, and path", async () => {
    await listConfig("project", "/p", "agents");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/config?scope=project&cwd=%2Fp&path=agents");
  });

  it("listConfigProjects GETs /api/config/projects", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ home: "/h", projects: [{ cwd: "/p" }] }), { status: 200 }));
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
    expect(JSON.parse(init.body as string)).toEqual({ scope: "project", cwd: "/p", path: "settings.json", content: '{"a":1}' });
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
    const error = (await writeConfigFile("global", "/p", "secrets.json", "SECRET-PAYLOAD").catch((e: unknown) => e)) as ApiError;
    expect(error.message).not.toContain("SECRET-PAYLOAD");
    expect(error.message).toContain("boom");
  });
});

describe("connectSessionEvents", () => {
  let FakeEventSource: {
    instances: { url: string; onmessage: ((e: MessageEvent) => void) | null; onerror: (() => void) | null; close: () => void }[];
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
