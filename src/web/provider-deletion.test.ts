import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigFileService } from "./config-files";
import { createProviderDeletionService, ProviderDeletionError } from "./provider-deletion";

const roots: string[] = [];

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
  it("removes one explicit provider, returns the accepted repair outcome, and cleans only its stored state", async () => {
    const root = fixture();
    const outcome = { status: "repaired", generation: 4, availabilityEpoch: 2, error: null };
    const onAuthoritativeWrite = vi.fn(async () => outcome);
    const service = createProviderDeletionService(new ConfigFileService(root, { onAuthoritativeWrite }));

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
    const service = createProviderDeletionService(new ConfigFileService(root));

    const error = await service.delete("missing").catch((cause) => cause);

    expect(error).toBeInstanceOf(ProviderDeletionError);
    expect(error.status).toBe(404);
    expect(readFileSync(join(root, "models.json"))).toEqual(before);
  });
});
