import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createAuthGateway } from "./auth-gateway";
import { createAuthFlowStore } from "./auth-flow-store";
import {
  createAcceptedModelRuntime,
  createDaemonAuthRuntime,
  readModelsJsonProviderIds,
  resolveAuthFlowTimeout,
} from "./auth-runtime";
import { ConfigFileService } from "./config-files";

const anthropicProvider = {
  id: "anthropic",
  name: "Anthropic",
  auth: { apiKey: { name: "Anthropic API key", login: vi.fn() } },
};

function transactionRuntime(
  name: string,
  options: {
    models?: Array<{ provider: string; id: string; reasoning: boolean }>;
    providers?: Array<{ id: string; name: string; auth?: Record<string, unknown> }>;
    refresh?: { aborted: boolean; errors: ReadonlyMap<string, Error> };
    semanticError?: string;
  } = {},
) {
  const models = options.models ?? [{ provider: "provider", id: name, reasoning: false }];
  const providers = options.providers ?? [];
  return {
    name,
    dispose: vi.fn(),
    refresh: vi.fn(async () => options.refresh ?? { aborted: false, errors: new Map() }),
    getError: vi.fn(() => options.semanticError),
    getAvailableSnapshot: vi.fn(() => models),
    getProviders: vi.fn(() => providers),
    getProvider: vi.fn((providerId: string) => providers.find((provider) => provider.id === providerId)),
    getProviderAuthStatus: vi.fn(() => ({ configured: false })),
    checkAuth: vi.fn(async () => undefined),
    login: vi.fn(async () => ({ type: "api_key" as const, key: "secret" })),
    logout: vi.fn(async () => {}),
  };
}

describe("createAcceptedModelRuntime", () => {
  it("publishes fresh locally refreshed candidates only at synchronous commit", async () => {
    const first = transactionRuntime("v1");
    const discarded = transactionRuntime("discarded");
    const second = transactionRuntime("v2");
    const runtimes = [first, discarded, second];
    const accepted = createAcceptedModelRuntime(async () => runtimes.shift()!);

    const preparedFirst = await accepted.prepareModelCatalog();
    expect(first.refresh).toHaveBeenCalledWith({ allowNetwork: false });
    expect(preparedFirst.models).toEqual([{ provider: "provider", id: "v1" }]);
    expect(Object.isFrozen(preparedFirst.models)).toBe(true);
    expect(Object.isFrozen(preparedFirst.models[0])).toBe(true);
    expect(() => accepted.runtime.getAvailableSnapshot()).toThrow(/active/i);

    expect(preparedFirst.commit()).toBeUndefined();
    expect(accepted.runtime.getAvailableSnapshot()).toEqual([
      { provider: "provider", id: "v1", reasoning: false },
    ]);

    const rejected = await accepted.prepareModelCatalog();
    expect(accepted.runtime.getAvailableSnapshot()[0]?.id).toBe("v1");
    await rejected.rollback();
    expect(discarded.dispose).toHaveBeenCalledTimes(1);
    expect(accepted.runtime.getAvailableSnapshot()[0]?.id).toBe("v1");

    const preparedSecond = await accepted.prepareModelCatalog();
    expect(accepted.runtime.getAvailableSnapshot()[0]?.id).toBe("v1");
    preparedSecond.commit();
    expect(accepted.runtime.getAvailableSnapshot()[0]?.id).toBe("v2");

    await accepted.dispose();
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "provider refresh errors",
      runtime: () => transactionRuntime("bad-errors", {
        refresh: { aborted: false, errors: new Map([["provider", new Error("private path")]]) },
      }),
    },
    {
      name: "an aborted refresh",
      runtime: () => transactionRuntime("bad-abort", {
        refresh: { aborted: true, errors: new Map() },
      }),
    },
    {
      name: "Pi's semantic error channel",
      runtime: () => transactionRuntime("bad-semantic", { semanticError: "private models.json detail" }),
    },
  ])("keeps the accepted runtime unchanged after $name", async ({ runtime }) => {
    const first = transactionRuntime("accepted");
    const rejected = runtime();
    const runtimes = [first, rejected];
    const accepted = createAcceptedModelRuntime(async () => runtimes.shift()!);
    (await accepted.prepareModelCatalog()).commit();

    await expect(accepted.prepareModelCatalog()).rejects.toThrow(/model catalog/i);

    expect(accepted.runtime.getAvailableSnapshot()[0]?.id).toBe("accepted");
    expect(rejected.getAvailableSnapshot).not.toHaveBeenCalled();
    expect(rejected.dispose).toHaveBeenCalledTimes(1);
    await accepted.dispose();
  });

  it("lets AuthGateway consume the stable accepted proxy without refreshing uncommitted state", async () => {
    const first = transactionRuntime("v1");
    const second = transactionRuntime("v2");
    const runtimes = [first, second];
    const accepted = createAcceptedModelRuntime(async () => runtimes.shift()!);
    (await accepted.prepareModelCatalog()).commit();
    const synchronizeCatalog = vi.fn(async () => {});
    const gateway = createAuthGateway(accepted.runtime, createAuthFlowStore(), {
      timeoutMs: 600_000,
      synchronizeCatalog,
    });

    expect(await gateway.listModels()).toMatchObject([{ provider: "provider", id: "v1" }]);
    const pending = await accepted.prepareModelCatalog();
    expect(await gateway.listModels()).toMatchObject([{ provider: "provider", id: "v1" }]);
    pending.commit();
    expect(await gateway.listModels()).toMatchObject([{ provider: "provider", id: "v2" }]);

    expect(synchronizeCatalog).toHaveBeenCalledTimes(3);
    expect(first.refresh).toHaveBeenCalledTimes(1);
    expect(second.refresh).toHaveBeenCalledTimes(1);
    await accepted.dispose();
  });

  it("commits models.json provider pinning atomically with the matching runtime candidate", async () => {
    const first = transactionRuntime("v1");
    const discarded = transactionRuntime("discarded");
    const second = transactionRuntime("v2");
    const runtimes = [first, discarded, second];
    let providerIds: ReadonlySet<string> = new Set(["provider-v1"]);
    const accepted = createAcceptedModelRuntime(
      async () => runtimes.shift()!,
      async () => providerIds,
    );

    (await accepted.prepareModelCatalog()).commit();
    expect([...accepted.getModelsJsonProviderIds()]).toEqual(["provider-v1"]);

    providerIds = new Set(["discarded-provider"]);
    const rejected = await accepted.prepareModelCatalog();
    expect([...accepted.getModelsJsonProviderIds()]).toEqual(["provider-v1"]);
    await rejected.rollback();
    expect([...accepted.getModelsJsonProviderIds()]).toEqual(["provider-v1"]);

    providerIds = new Set(["provider-v2"]);
    const prepared = await accepted.prepareModelCatalog();
    expect([...accepted.getModelsJsonProviderIds()]).toEqual(["provider-v1"]);
    prepared.commit();
    expect(accepted.runtime.getAvailableSnapshot()[0]?.id).toBe("v2");
    expect([...accepted.getModelsJsonProviderIds()]).toEqual(["provider-v2"]);

    await accepted.dispose();
  });
});

describe("createDaemonAuthRuntime", () => {
  it("shares one accepted transaction between LiveConfiguration validation and AuthGateway", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "easyresearch-daemon-auth-"));
    const candidate = transactionRuntime("accepted");
    const createModelRuntime = vi.fn(async () => candidate);
    const synchronizeCatalog = vi.fn(async () => {});
    const onModelsChanged = vi.fn(async () => {});
    const daemon = await createDaemonAuthRuntime({
      config: new ConfigFileService(agentDir),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      createModelRuntime,
      synchronizeCatalog,
      onModelsChanged,
    });

    const prepared = await daemon.modelValidator.prepareModelCatalog();
    expect(createModelRuntime).toHaveBeenCalledTimes(1);
    prepared.commit();
    await expect(daemon.auth.listModels()).resolves.toMatchObject([
      { provider: "provider", id: "accepted" },
    ]);
    expect(synchronizeCatalog).toHaveBeenCalledTimes(1);

    await daemon.dispose();
    expect(candidate.dispose).toHaveBeenCalledTimes(1);
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("keeps provider rows and pinning on the accepted candidate while current models.json is rejected", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "easyresearch-daemon-auth-"));
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(modelsPath, '{"providers":{"accepted-provider":{}}}');
    const acceptedRuntime = transactionRuntime("accepted-model", {
      models: [{ provider: "accepted-provider", id: "accepted-model", reasoning: false }],
      providers: [{ id: "accepted-provider", name: "Accepted" }],
    });
    const recoveredRuntime = transactionRuntime("recovered-model", {
      models: [{ provider: "recovered-provider", id: "recovered-model", reasoning: false }],
      providers: [{ id: "recovered-provider", name: "Recovered" }],
    });
    const runtimes = [acceptedRuntime, recoveredRuntime];
    const daemon = await createDaemonAuthRuntime({
      config: new ConfigFileService(agentDir),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      createModelRuntime: async () => runtimes.shift()!,
      synchronizeCatalog: async () => {},
      onModelsChanged: async () => {},
    });

    (await daemon.modelValidator.prepareModelCatalog()).commit();
    writeFileSync(modelsPath, '{"providers":');

    await expect(daemon.auth.listModels()).resolves.toMatchObject([
      { provider: "accepted-provider", id: "accepted-model" },
    ]);
    await expect(daemon.auth.listProviders()).resolves.toMatchObject([
      { id: "accepted-provider", modelsJson: true },
    ]);
    expect(acceptedRuntime.refresh).toHaveBeenCalledTimes(1);

    writeFileSync(modelsPath, '{"providers":{"recovered-provider":{}}}');
    (await daemon.modelValidator.prepareModelCatalog()).commit();
    await expect(daemon.auth.listProviders()).resolves.toMatchObject([
      { id: "recovered-provider", modelsJson: true },
    ]);
    expect(recoveredRuntime.refresh).toHaveBeenCalledTimes(1);

    await daemon.dispose();
    rmSync(agentDir, { recursive: true, force: true });
  });
});

describe("resolveAuthFlowTimeout", () => {
  it("defaults to 10 minutes", () => {
    expect(resolveAuthFlowTimeout(undefined)).toBe(600_000);
    expect(resolveAuthFlowTimeout({})).toBe(600_000);
    expect(resolveAuthFlowTimeout({ easyresearch: {} })).toBe(600_000);
  });

  it("respects positive, 0, and -1 values", () => {
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: 30_000 } } })).toBe(30_000);
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: 0 } } })).toBe(0);
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: -1 } } })).toBe(-1);
  });

  it("falls back for non-integer or non-positive values", () => {
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: -5 } } })).toBe(600_000);
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: "1000" } } })).toBe(600_000);
    expect(resolveAuthFlowTimeout({ easyresearch: { web: { authFlowTimeoutMs: 1.5 } } })).toBe(600_000);
  });
});

describe("readModelsJsonProviderIds", () => {
  it("reads provider ids from Pi-compatible commented JSON with trailing commas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-models-json-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(
      modelsPath,
      `{
        // Pi accepts line comments and trailing commas.
        "providers": {
          "commented-provider": { "models": [], },
        },
      }`,
    );

    try {
      expect([...await readModelsJsonProviderIds(modelsPath)]).toEqual(["commented-provider"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed models.json instead of silently clearing pinning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-models-json-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, '{ "providers": {');

    try {
      await expect(readModelsJsonProviderIds(modelsPath)).rejects.toThrow("Unable to parse models.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a semantically invalid providers value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-models-json-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(modelsPath, '{ "providers": [] }');

    try {
      await expect(readModelsJsonProviderIds(modelsPath)).rejects.toThrow("Invalid models.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a models.json read failure instead of silently clearing pinning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "easyresearch-models-json-"));
    const modelsPath = join(dir, "models.json");
    mkdirSync(modelsPath);

    try {
      await expect(readModelsJsonProviderIds(modelsPath)).rejects.toThrow("Unable to read models.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("auth gateway shutdown aborts active flows", () => {
  it("aborts pending prompt after shutdown() so the flow terminates", async () => {
    const loginImpl = vi.fn(async (_id: string, _type: string, interaction: any) => {
      try {
        await interaction.prompt({ type: "secret", message: "API key" });
      } catch (e) {
        throw e;
      }
      return { type: "api_key", key: "sk" };
    });
    const store = createAuthFlowStore();
    const gw = createAuthGateway(
      {
        getProviders: () => [anthropicProvider],
        getProvider: (id: string) => (id === "anthropic" ? anthropicProvider : undefined),
        getAvailableSnapshot: () => [],
        getError: () => undefined,
        getProviderAuthStatus: () => ({ configured: false } as any),
        checkAuth: async () => undefined,
        login: loginImpl as any,
        logout: async () => {},
        refresh: async () => ({ aborted: false, errors: new Map() }),
      } as any,
      store,
      { timeoutMs: 600_000 },
    );
    await gw.preflight({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    const flow = gw.runFlow({ flowId: "f1", providerId: "anthropic", type: "api_key" });
    await vi.waitFor(() => expect(store.pendingKind("f1")).toBe("secret"));
    gw.shutdown();
    await expect(flow).resolves.toBeUndefined();
    expect(store.get("f1")?.terminated).toBe(true);
  });
});
