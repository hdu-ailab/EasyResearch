import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigFileService } from "./config-files";
import { createProviderDeletionService, ProviderDeletionError } from "./provider-deletion";
import type { AuthGateway } from "./auth-gateway";

const roots: string[] = [];
const noAuthOperations: Pick<AuthGateway, "withProviderDeletion"> = {
  withProviderDeletion: (_providerId, operation) => operation(),
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-provider-delete-"));
  roots.push(root);
  writeFileSync(join(root, "models.json"), JSON.stringify({
    providers: {
      removable: { baseUrl: "http://localhost:9000/v1", api: "openai-completions", models: [{ id: "m" }] },
      retained: { baseUrl: "http://localhost:9001/v1", api: "openai-completions", models: [{ id: "r" }] },
    },
  }));
  writeFileSync(join(root, "auth.json"), JSON.stringify({
    removable: { type: "api_key", key: "secret" },
    retained: { type: "api_key", key: "keep" },
  }));
  writeFileSync(join(root, "models-store.json"), JSON.stringify({
    removable: { models: [{ id: "cached" }] },
    retained: { models: [{ id: "keep" }] },
  }));
  return root;
}

describe("provider deletion", () => {
  it("waits for Pi AuthStorage.modify before deleting credentials and preserves its sibling update", async () => {
    const root = fixture();
    const { importPi } = await import("../runtime/pi-import");
    await importPi();
    const { AuthStorage } = await import("../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js");
    const storage = AuthStorage.create(join(root, "auth.json"));
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const modelDeleted = Promise.withResolvers<void>();
    const writing = storage.modify("retained", async (current) => {
      held.resolve();
      await release.promise;
      return { ...current, type: "api_key", key: "renewed-sibling" };
    });
    await held.promise;
    const config = new ConfigFileService(root, {
      onAuthoritativeWrite: async (change) => {
        if (change.modelsChanged) modelDeleted.resolve();
      },
    });
    const deleting = createProviderDeletionService(config, noAuthOperations).delete("removable");
    try {
      await modelDeleted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(JSON.parse(readFileSync(join(root, "auth.json"), "utf8"))).toHaveProperty("removable");
      release.resolve();
      await writing;
      await expect(deleting).resolves.toMatchObject({ credentialsRemoved: true, warnings: [] });
      expect(JSON.parse(readFileSync(join(root, "auth.json"), "utf8"))).toEqual({
        retained: { type: "api_key", key: "renewed-sibling" },
      });
    } finally {
      release.resolve();
      await Promise.allSettled([writing, deleting]);
    }
  });

  it("does not restore another concurrently deleted provider in models, credentials, or cache", async () => {
    const root = fixture();
    const originals = new Map(["models.json", "auth.json", "models-store.json"].map((path) => {
      const value = JSON.parse(readFileSync(join(root, path), "utf8"));
      const entries = path === "models.json" ? value.providers : value;
      entries.other = { ...entries.removable };
      writeFileSync(join(root, path), JSON.stringify(value));
      return [path, value];
    }));
    const config = new ConfigFileService(root);
    const results = await Promise.all([
      createProviderDeletionService(config, noAuthOperations).delete("removable"),
      createProviderDeletionService(config, noAuthOperations).delete("other"),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ providerId: "removable", credentialsRemoved: true, cacheRemoved: true, warnings: [] }),
      expect.objectContaining({ providerId: "other", credentialsRemoved: true, cacheRemoved: true, warnings: [] }),
    ]);
    for (const [path, original] of originals) {
      const value = JSON.parse(readFileSync(join(root, path), "utf8"));
      expect(path === "models.json" ? value.providers : value).toEqual({
        retained: (path === "models.json" ? original.providers : original).retained,
      });
    }
  });

  it("repairs settings before cleanup and preserves sibling writes during acceptance", async () => {
    const root = fixture();
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      easyresearch: { agentDefaults: { search: { model: "removable/m", thinking: "high" } } },
    }));
    const { repairDanglingAgentDefaults } = await import("../runtime/agent-default-repair");
    const config = new ConfigFileService(root, {
      onAuthoritativeWrite: async (change) => {
        if (!change.modelsChanged) return;
        expect(JSON.parse(readFileSync(join(root, "auth.json"), "utf8"))).toHaveProperty("removable");
        await repairDanglingAgentDefaults(config, [{ agentName: "search", danglingModel: "removable/m" }]);
        for (const path of ["auth.json", "models-store.json"]) {
          const content = JSON.parse(readFileSync(join(root, path), "utf8"));
          await config.write({ scope: "global", path, content: JSON.stringify({ ...content, external: { keep: true } }) });
        }
      },
    });

    await expect(createProviderDeletionService(config, noAuthOperations).delete("removable")).resolves.toMatchObject({ warnings: [] });
    expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))).toEqual({
      easyresearch: { agentDefaults: { search: { thinking: "high" } } },
    });
    for (const path of ["auth.json", "models-store.json"]) {
      const content = JSON.parse(readFileSync(join(root, path), "utf8"));
      expect(content).not.toHaveProperty("removable");
      expect(content.external).toEqual({ keep: true });
    }
  });

  it("removes one explicit provider, returns the accepted repair outcome, and cleans only its stored state", async () => {
    const root = fixture();
    const outcome = { status: "repaired", generation: 4, availabilityEpoch: 2, error: null };
    const onAuthoritativeWrite = vi.fn(async () => outcome);
    const service = createProviderDeletionService(new ConfigFileService(root, { onAuthoritativeWrite }), noAuthOperations);

    await expect(service.delete("removable")).resolves.toEqual({
      providerId: "removable",
      configuration: outcome,
      credentialsRemoved: true,
      cacheRemoved: true,
      warnings: [],
    });

    expect(JSON.parse(readFileSync(join(root, "models.json"), "utf8"))).toEqual({
      providers: {
        retained: { baseUrl: "http://localhost:9001/v1", api: "openai-completions", models: [{ id: "r" }] },
      },
    });
    expect(JSON.parse(readFileSync(join(root, "auth.json"), "utf8"))).toEqual({
      retained: { type: "api_key", key: "keep" },
    });
    expect(JSON.parse(readFileSync(join(root, "models-store.json"), "utf8"))).toEqual({
      retained: { models: [{ id: "keep" }] },
    });
    expect(onAuthoritativeWrite).toHaveBeenCalledTimes(3);
    expect(onAuthoritativeWrite.mock.calls).toEqual([
      [{ modelsChanged: true }],
      [{ availabilityChanged: true }],
      [{ availabilityChanged: true }],
    ]);
  });

  it("rejects an unknown provider without changing files", async () => {
    const root = fixture();
    const before = readFileSync(join(root, "models.json"));
    const service = createProviderDeletionService(new ConfigFileService(root), noAuthOperations);

    const error = await service.delete("missing").catch((cause) => cause);

    expect(error).toBeInstanceOf(ProviderDeletionError);
    expect(error.status).toBe(404);
    expect(readFileSync(join(root, "models.json"))).toEqual(before);
  });

  it("rejects a duplicate concurrent deletion instead of acknowledging it twice", async () => {
    const root = fixture();
    const service = createProviderDeletionService(new ConfigFileService(root), noAuthOperations);
    const results = await Promise.allSettled([service.delete("removable"), service.delete("removable")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 404 } });
  });

  it("retains malformed cleanup bytes and releases mutation ownership for the next deletion", async () => {
    const root = fixture();
    writeFileSync(join(root, "auth.json"), "{malformed");
    const service = createProviderDeletionService(new ConfigFileService(root), noAuthOperations);

    await expect(service.delete("removable")).resolves.toMatchObject({
      credentialsRemoved: false, cacheRemoved: true, warnings: ["auth.json could not be cleaned."],
    });
    await expect(service.delete("retained")).resolves.toMatchObject({
      credentialsRemoved: false, cacheRemoved: true, warnings: ["auth.json could not be cleaned."],
    });
    expect(readFileSync(join(root, "auth.json"), "utf8")).toBe("{malformed");
    expect(JSON.parse(readFileSync(join(root, "models.json"), "utf8"))).toEqual({ providers: {} });
    expect(JSON.parse(readFileSync(join(root, "models-store.json"), "utf8"))).toEqual({});
  });
});
