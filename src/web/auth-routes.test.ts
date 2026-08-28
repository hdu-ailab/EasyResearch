import { describe, it, expect, vi } from "vitest";
import { createRouteHandler, type RouteServices } from "./routes";
import { AuthGatewayError, createAuthGateway, type AuthGateway } from "./auth-gateway";
import { createAuthFlowStore, type AuthFlowStore, type AuthFlowRecord } from "./auth-flow-store";
import type {
  AuthFlowEventDto,
  AuthProviderInfoDto,
} from "./contracts";

function noopLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
}

function flowRecordStub(): AuthFlowRecord {
  return {
    flowId: "f1",
    bufferedNotifies: [],
    pendingPrompt: null,
    terminalEvent: null,
    resolveRespond: null,
    rejectRespond: null,
    abortController: new AbortController(),
    terminated: false,
    subscribers: new Set(),
  };
}

function makeServices(auth: AuthGateway | undefined): RouteServices {
  return {
    webuiDist: "/dev/null",
    listAllSessions: async () => [],
    listAgents: async () => [],
    listModels: async () => [],
    listConfigProjects: async () => ({ home: "", projects: [] }),
    directories: { homeDir: "/", list: async () => [], read: async () => ({}) } as any,
    registry: { listActive: () => [], subscribe: () => () => {}, snapshot: async () => ({ session: {} as any, messages: [] }) } as any,
    config: {} as any,
    subagentSessions: { summaries: async () => [], snapshot: async () => ({ session: {} as any, messages: [] }) } as any,
    logger: noopLogger(),
    auth,
  } as unknown as RouteServices;
}

function fakeStore(records: Record<string, Partial<AuthFlowRecord>> = {}): AuthFlowStore {
  return {
    create: vi.fn((flowId: string) => ({ ...flowRecordStub(), flowId, ...records[flowId] })) as any,
    get: vi.fn((id: string) => (records[id] ? ({ ...flowRecordStub(), ...records[id], flowId: id } as AuthFlowRecord) : undefined)),
    emit: vi.fn(),
    emitPrompt: vi.fn(),
    awaitRespond: vi.fn(async () => ""),
    resolveRespond: vi.fn(() => false),
    rejectRespond: vi.fn(),
    cancel: vi.fn(),
    terminate: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
    pendingKind: vi.fn(() => null),
    list: vi.fn(() => Object.keys(records)),
    ...records,
  } as unknown as AuthFlowStore;
}

describe("auth routes", () => {
  it("GET /api/auth/providers returns the AuthProvidersResponseDto", async () => {
    const providers: AuthProviderInfoDto[] = [
      { id: "anthropic", name: "Anthropic", authMethods: ["api_key"], connectable: true, authStatus: { configured: false }, modelsJson: false },
    ];
    const gw = { listProviders: vi.fn(async () => providers) } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(new Request("http://l/api/auth/providers"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: AuthProviderInfoDto[] };
    expect(body.providers).toEqual(providers);
  });

  it("DELETE /api/auth/providers/:id returns the accepted deletion result", async () => {
    const gw = { listProviders: vi.fn(async () => []) } as unknown as AuthGateway;
    const services = makeServices(gw);
    const result = {
      providerId: "custom-provider",
      configuration: { status: "repaired", generation: 4 },
      credentialsRemoved: true,
      cacheRemoved: true,
      warnings: [],
    };
    services.providerDeletion = { delete: vi.fn(async () => result) };
    const handler = createRouteHandler(services);

    const response = await handler(new Request("http://l/api/auth/providers/custom-provider", { method: "DELETE" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(result);
    expect(services.providerDeletion.delete).toHaveBeenCalledWith("custom-provider");
  });

  it("POST /api/auth/login with no active flow returns 202 with flowId", async () => {
    const gw = {
      activeFlow: () => null,
      preflight: vi.fn(),
      runFlow: vi.fn(async () => {}),
      store: () => fakeStore(),
    } as unknown as AuthGateway;
    const services = makeServices(gw);
    const handler = createRouteHandler(services);
    const res = await handler(
      new Request("http://l/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ providerId: "anthropic", type: "api_key" }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { flowId: string };
    expect(body.flowId).toBeTruthy();
    expect((gw.preflight as any)).toHaveBeenCalledWith({
      flowId: body.flowId,
      providerId: "anthropic",
      type: "api_key",
    });
  });

  it("POST /api/auth/login runs the flow fire-and-forget after preflight", async () => {
    const gw = {
      activeFlow: () => null,
      preflight: vi.fn(),
      runFlow: vi.fn(async () => {}),
      store: () => fakeStore(),
    } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(
      new Request("http://l/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ providerId: "anthropic", type: "api_key" }),
      }),
    );
    expect(res.status).toBe(202);
    await Promise.resolve();
    expect((gw.runFlow as any)).toHaveBeenCalled();
  });

  it("accepts only one concurrent login and exposes a registered flow before 202", async () => {
    const provider = {
      id: "anthropic",
      name: "Anthropic",
      auth: { apiKey: { name: "Anthropic API key", login: vi.fn() } },
    };
    let resolveRefresh!: (result: { aborted: boolean; errors: Map<string, Error> }) => void;
    const refresh = vi.fn(
      () => new Promise<{ aborted: boolean; errors: Map<string, Error> }>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const store = createAuthFlowStore();
    const gateway = createAuthGateway(
      {
        getProviders: () => [provider],
        getProvider: (id) => (id === provider.id ? provider : undefined),
        getModels: () => [],
        getAvailableSnapshot: () => [],
        getError: () => undefined,
        getProviderAuthStatus: () => ({ configured: false }),
        checkAuth: async () => undefined,
        login: async (_providerId, _type, interaction) => {
          await interaction.prompt({ type: "secret", message: "API key" });
          return { type: "api_key", key: "sk" };
        },
        logout: async () => {},
        refresh,
      },
      store,
      { timeoutMs: 600_000 },
    );
    const handler = createRouteHandler(makeServices(gateway));
    const login = () => handler(
      new Request("http://l/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ providerId: "anthropic", type: "api_key" }),
      }),
    );

    const requests = [login(), login()];
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    resolveRefresh({ aborted: false, errors: new Map() });
    const responses = await Promise.all(requests);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([202, 409]);

    const payloads = await Promise.all(responses.map((response) => response.json()));
    const accepted = payloads[responses.findIndex((response) => response.status === 202)] as { flowId: string };
    const rejected = payloads[responses.findIndex((response) => response.status === 409)] as { activeFlowId: string };
    expect(rejected.activeFlowId).toBe(accepted.flowId);
    expect(store.get(accepted.flowId)).toBeDefined();

    const events = await handler(new Request(`http://l/api/auth/flows/${accepted.flowId}/events`));
    expect(events.status).toBe(200);
    await events.body?.cancel();
    await vi.waitFor(() => expect(store.pendingKind(accepted.flowId)).toBe("secret"));
    store.cancel(accepted.flowId);
    await vi.waitFor(() => expect(gateway.activeFlow()).toBeNull());
  });

  it("POST /api/auth/login returns 409 with activeFlowId when a flow is active", async () => {
    const gw = {
      activeFlow: () => "f-active",
      preflight: async () => {
        throw new AuthGatewayError(409, "another auth flow is active");
      },
      runFlow: vi.fn(),
      store: () => fakeStore(),
    } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(
      new Request("http://l/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ providerId: "anthropic", type: "api_key" }),
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.activeFlowId).toBe("f-active");
  });

  it("POST /api/auth/login returns 404 for unknown provider via preflight AuthGatewayError", async () => {
    const gw = {
      activeFlow: () => null,
      preflight: async () => {
        throw new AuthGatewayError(404, "unknown provider: nope");
      },
      runFlow: vi.fn(),
      store: () => fakeStore(),
    } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(
      new Request("http://l/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ providerId: "nope", type: "api_key" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/auth/login returns 400 for a malformed body", async () => {
    const gw = { activeFlow: () => null, preflight: vi.fn() } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(
      new Request("http://l/api/auth/login", { method: "POST", body: JSON.stringify({ providerId: "x" }) }),
    );
    expect(res.status).toBe(400);
    expect((gw.preflight as any)).not.toHaveBeenCalled();
  });

  it("POST /api/auth/flows/:id/respond with no pending returns 409", async () => {
    const store = fakeStore({ f1: { pendingPrompt: null } });
    const gw = { store: () => store } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(
      new Request("http://l/api/auth/flows/f1/respond", {
        method: "POST",
        body: JSON.stringify({ value: "x" }),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("POST /api/auth/flows/:id/respond with a terminated flow returns 410", async () => {
    const store = fakeStore({ f1: { terminated: true } });
    const gw = { store: () => store } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(
      new Request("http://l/api/auth/flows/f1/respond", {
        method: "POST",
        body: JSON.stringify({ value: "x" }),
      }),
    );
    expect(res.status).toBe(410);
  });

  it("POST /api/auth/flows/:id/respond with a pending prompt resolves and returns 200", async () => {
    const store = fakeStore({ f1: { pendingPrompt: { type: "prompt", kind: "secret", message: "key" } as any } });
    (store.resolveRespond as any) = vi.fn(() => true);
    const gw = { store: () => store } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(
      new Request("http://l/api/auth/flows/f1/respond", {
        method: "POST",
        body: JSON.stringify({ value: "sk-abc" }),
      }),
    );
    expect(res.status).toBe(200);
    expect((store.resolveRespond as any)).toHaveBeenCalledWith("f1", "sk-abc");
  });

  it("POST /api/auth/flows/:id/cancel returns 200 and calls store.cancel", async () => {
    const store = fakeStore({ f1: {} });
    const gw = { store: () => store } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(new Request("http://l/api/auth/flows/f1/cancel", { method: "POST" }));
    expect(res.status).toBe(200);
    expect((store.cancel as any)).toHaveBeenCalledWith("f1");
  });

  it("POST /api/auth/flows/:id/cancel with unknown flow returns 404", async () => {
    const store = fakeStore();
    const gw = { store: () => store } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(new Request("http://l/api/auth/flows/ghost/cancel", { method: "POST" }));
    expect(res.status).toBe(404);
  });

  it("POST /api/auth/logout forwards to gateway and returns 200", async () => {
    const logout = vi.fn(async () => {});
    const gw = { logout } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(
      new Request("http://l/api/auth/logout", {
        method: "POST",
        body: JSON.stringify({ providerId: "anthropic" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(logout).toHaveBeenCalledWith("anthropic");
  });

  it("POST /api/auth/logout surfaces 404 from AuthGatewayError", async () => {
    const gw = {
      logout: () => {
        throw new AuthGatewayError(404, "unknown provider: nope");
      },
    } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(
      new Request("http://l/api/auth/logout", {
        method: "POST",
        body: JSON.stringify({ providerId: "nope" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/auth/logout reports a safe error after committed removal forces model synchronization", async () => {
    const provider = { id: "anthropic", name: "Anthropic", auth: { apiKey: {} } };
    const onModelsChanged = vi.fn(async () => {});
    const committedError = Object.assign(
      new Error("private synchronization detail at /home/private"),
      {
        name: "CredentialSynchronizationError",
        providerId: "anthropic",
        operation: "logout",
        credential: undefined,
      },
    );
    const gw = createAuthGateway(
      {
        getProviders: () => [provider],
        getProvider: () => provider,
        getModels: () => [],
        getAvailableSnapshot: () => [],
        getError: () => undefined,
        getProviderAuthStatus: () => ({ configured: true }),
        checkAuth: async () => undefined,
        login: async () => ({ type: "api_key", key: "unused" }),
        logout: async () => {
          throw committedError;
        },
        refresh: async () => ({ aborted: false, errors: new Map() }),
      },
      createAuthFlowStore(),
      { timeoutMs: 600_000, onModelsChanged },
    );
    const handler = createRouteHandler(makeServices(gw));

    const res = await handler(
      new Request("http://l/api/auth/logout", {
        method: "POST",
        body: JSON.stringify({ providerId: "anthropic" }),
      }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "Credential removal was saved, but local model state could not be synchronized.",
    });
    expect(onModelsChanged).toHaveBeenCalledTimes(1);
  });

  it("GET /api/auth/flows/:id/events returns 404 for unknown flow", async () => {
    const store = fakeStore();
    const gw = { store: () => store } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(new Request("http://l/api/auth/flows/ghost/events"));
    expect(res.status).toBe(404);
  });

  it("GET /api/auth/flows/:id/events opens an SSE stream and replays buffered notifies", async () => {
    const records: Record<string, Partial<AuthFlowRecord>> = {
      f1: {
        bufferedNotifies: [
          { type: "notify", event: { kind: "info", message: "hi" } } as AuthFlowEventDto,
        ],
        pendingPrompt: { type: "prompt", kind: "secret", message: "API key" } as AuthFlowEventDto,
        terminated: false,
      },
    };
    const store = fakeStore(records);
    (store.subscribe as any) = vi.fn((flowId: string, onEvent: (e: AuthFlowEventDto) => void) => {
      // Mimic replay by invoking onEvent for buffered + pending
      const rec = records[flowId];
      if (rec) {
        for (const e of rec.bufferedNotifies ?? []) onEvent(e);
        if (rec.pendingPrompt) onEvent(rec.pendingPrompt);
      }
      return () => {};
    });
    const gw = { store: () => store } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(new Request("http://l/api/auth/flows/f1/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    // Read the two replayed events (each emitted as `data: {...}\n\n`).
    for (let i = 0; i < 2; i++) {
      const { value } = await reader.read();
      received += decoder.decode(value);
    }
    expect(received).toContain('"type":"notify"');
    expect(received).toContain('"type":"prompt"');
    reader.cancel();
  });

  it("routes 404 when auth is not wired on the services", async () => {
    const handler = createRouteHandler(makeServices(undefined));
    const res = await handler(new Request("http://l/api/auth/providers"));
    expect(res.status).toBe(404);
  });

  it("GET /api/auth/flows/:id/events replays the terminal event for an already-terminated flow", async () => {
    const store = createAuthFlowStore();
    store.create("f1", new AbortController().signal);
    store.emit("f1", { type: "notify", event: { kind: "info", message: "hi" } } as AuthFlowEventDto);
    store.terminate("f1", { type: "done", credential: { type: "api_key" } } as AuthFlowEventDto);
    const gw = { store: () => store } as unknown as AuthGateway;
    const handler = createRouteHandler(makeServices(gw));
    const res = await handler(new Request("http://l/api/auth/flows/f1/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    for (let i = 0; i < 2; i++) {
      const { value } = await reader.read();
      received += decoder.decode(value);
    }
    expect(received).toContain('"type":"notify"');
    expect(received).toContain('"type":"done"');
    reader.cancel();
  });
});
