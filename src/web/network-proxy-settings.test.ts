import * as fs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureInheritedProxyEnvironment,
  parseNetworkProxySettings,
  resolveNetworkPolicy,
} from "../runtime/network-policy";
import { type AuthoritativeConfigChange, ConfigFileService } from "./config-files";
import { NetworkProxySettingsService } from "./network-proxy-settings";

const { existsSyncMock, renameSyncMock, realFs } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<typeof fs.existsSync>(),
  renameSyncMock: vi.fn<typeof fs.renameSync>(),
  realFs: {
    existsSync: null as unknown as typeof fs.existsSync,
    renameSync: null as unknown as typeof fs.renameSync,
    writeFileSync: null as unknown as typeof fs.writeFileSync,
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  realFs.existsSync = original.existsSync;
  realFs.renameSync = original.renameSync;
  realFs.writeFileSync = original.writeFileSync;
  existsSyncMock.mockImplementation(original.existsSync);
  renameSyncMock.mockImplementation(original.renameSync);
  return {
    ...original,
    existsSync: existsSyncMock,
    renameSync: renameSyncMock,
  };
});

function startupPolicy(
  settings: unknown = {},
  inherited: Record<string, string | undefined> = {},
) {
  return resolveNetworkPolicy(
    parseNetworkProxySettings(settings),
    captureInheritedProxyEnvironment(inherited),
  );
}

const invalidError = (field: "settings" | "all" | "llm" | "search") => ({
  code: "NETWORK_PROXY_INVALID" as const,
  field,
});

describe("NetworkProxySettingsService", () => {
  let agentDir: string;
  let settingsPath: string;
  let notify: ReturnType<typeof vi.fn<(change: AuthoritativeConfigChange) => void>>;
  let config: ConfigFileService;

  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockImplementation(realFs.existsSync);
    renameSyncMock.mockReset();
    renameSyncMock.mockImplementation(realFs.renameSync);
    agentDir = mkdtempSync(join(tmpdir(), "easyresearch-network-settings-"));
    settingsPath = join(agentDir, "settings.json");
    notify = vi.fn<(change: AuthoritativeConfigChange) => void>();
    config = new ConfigFileService(agentDir, { onAuthoritativeWrite: notify });
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("reads missing settings without creating a file or exposing an inherited URL", async () => {
    const inheritedUrl = "http://private-user:private-secret@inherited.example:8080";
    const service = new NetworkProxySettingsService(
      config,
      startupPolicy({}, { HTTPS_PROXY: inheritedUrl }),
    );

    const dto = await service.get();

    expect(dto).toEqual({
      configured: {},
      appliedConfigured: {},
      sources: { all: "environment", llm: "environment", search: "environment" },
      errors: [],
      restartRequired: false,
    });
    expect(JSON.stringify(dto)).not.toContain(inheritedUrl);
    expect(JSON.stringify(dto)).not.toContain("private-secret");
    expect(existsSync(settingsPath)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("compares normalized current and startup-applied configured fingerprints", async () => {
    const applied = startupPolicy({
      httpProxy: "http://proxy.example",
      easyresearch: { network: { llmProxy: "https://llm.example" } },
    });
    const service = new NetworkProxySettingsService(config, applied);
    writeFileSync(settingsPath, JSON.stringify({
      unrelated: { keep: true },
      httpProxy: "  HTTP://PROXY.EXAMPLE:80/ ",
      easyresearch: { network: { llmProxy: "HTTPS://LLM.EXAMPLE:443/" } },
    }));

    const equivalent = await service.get();

    expect(equivalent.configured).toEqual({
      all: "http://proxy.example",
      llm: "https://llm.example",
    });
    expect(equivalent.appliedConfigured).toEqual(applied.configured);
    expect(equivalent.sources).toEqual({ all: "configured", llm: "configured", search: "all" });
    expect(equivalent.restartRequired).toBe(false);

    writeFileSync(settingsPath, JSON.stringify({
      httpProxy: "http://proxy.example",
      easyresearch: {
        network: {
          llmProxy: "https://llm.example",
          searchProxy: "https://search.example",
        },
      },
    }));

    expect((await service.get()).restartRequired).toBe(true);
  });

  it("reads BOM-prefixed settings accepted by Pi without changing their bytes", async () => {
    const bytes = `\uFEFF${JSON.stringify({
      httpProxy: "http://all.example:8000",
      easyresearch: { network: { searchProxy: "http://search.example:8002" } },
    })}`;
    writeFileSync(settingsPath, bytes, "utf8");
    const service = new NetworkProxySettingsService(config, startupPolicy());

    const dto = await service.get();

    expect(dto.configured).toEqual({
      all: "http://all.example:8000",
      search: "http://search.example:8002",
    });
    expect(dto.errors).toEqual([]);
    expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
    expect(renameSyncMock).not.toHaveBeenCalled();
  });

  it("returns every current validation error in stable order without changing bytes", async () => {
    const bytes = JSON.stringify({
      httpProxy: "ftp://all.example",
      easyresearch: {
        network: {
          llmProxy: 42,
          searchProxy: "https://search.example/path",
        },
      },
    });
    writeFileSync(settingsPath, bytes);
    const service = new NetworkProxySettingsService(config, startupPolicy());

    const dto = await service.get();

    expect(dto.configured).toEqual({});
    expect(dto.errors).toEqual([
      invalidError("all"),
      invalidError("llm"),
      invalidError("search"),
    ]);
    expect(dto.restartRequired).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
    expect(renameSyncMock).not.toHaveBeenCalled();
  });

  it("patches all provided fields with one atomic write while preserving every sibling", async () => {
    const applied = startupPolicy({
      httpProxy: "http://old-all.example",
      easyresearch: {
        network: {
          llmProxy: "http://old-llm.example",
          searchProxy: "http://old-search.example",
        },
      },
    });
    writeFileSync(settingsPath, JSON.stringify({
      theme: "dark",
      httpProxy: "http://old-all.example",
      easyresearch: {
        keep: { nested: true },
        network: {
          llmProxy: "http://old-llm.example",
          searchProxy: "http://old-search.example",
          futureRoute: { keep: true },
        },
      },
    }));
    const service = new NetworkProxySettingsService(config, applied);

    const dto = await service.patch({
      all: "  HTTP://NEW-ALL.EXAMPLE:80/ ",
      llm: " HTTPS://NEW-LLM.EXAMPLE:443/ ",
      search: null,
    });

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      theme: "dark",
      httpProxy: "http://new-all.example",
      easyresearch: {
        keep: { nested: true },
        network: {
          llmProxy: "https://new-llm.example",
          futureRoute: { keep: true },
        },
      },
    });
    expect(dto).toEqual({
      configured: {
        all: "http://new-all.example",
        llm: "https://new-llm.example",
      },
      appliedConfigured: {
        all: "http://old-all.example",
        llm: "http://old-llm.example",
        search: "http://old-search.example",
      },
      sources: { all: "configured", llm: "configured", search: "configured" },
      errors: [],
      restartRequired: true,
    });
    expect(renameSyncMock).toHaveBeenCalledTimes(1);
    expect(readdirSync(agentDir).filter((name) => name.startsWith("."))).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("prunes cleared fields and an empty network object", async () => {
    writeFileSync(settingsPath, JSON.stringify({
      httpProxy: "http://old-all.example",
      easyresearch: {
        keep: true,
        network: {
          llmProxy: "http://old-llm.example",
          searchProxy: "http://old-search.example",
        },
      },
    }));
    const service = new NetworkProxySettingsService(config, startupPolicy({
      httpProxy: "http://old-all.example",
      easyresearch: { network: { llmProxy: "http://old-llm.example" } },
    }));

    const dto = await service.patch({ all: null, llm: "  ", search: null });

    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      easyresearch: { keep: true },
    });
    expect(dto.configured).toEqual({});
    expect(dto.errors).toEqual([]);
    expect(dto.restartRequired).toBe(true);
  });

  it("repairs multiple invalid leaf values together", async () => {
    writeFileSync(settingsPath, JSON.stringify({
      httpProxy: "socks5://all.example",
      easyresearch: {
        network: {
          llmProxy: false,
          searchProxy: "https://search.example/path",
          keep: "sibling",
        },
      },
    }));
    const service = new NetworkProxySettingsService(config, startupPolicy());

    const dto = await service.patch({
      all: null,
      llm: "https://llm.example:8443",
      search: null,
    });

    expect(dto.configured).toEqual({ llm: "https://llm.example:8443" });
    expect(dto.errors).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      easyresearch: {
        network: {
          llmProxy: "https://llm.example:8443",
          keep: "sibling",
        },
      },
    });
  });

  it.each([
    null,
    [],
    { extra: null },
    { all: 42 },
    { llm: undefined },
    { all: "http://valid.example", search: "ftp://invalid.example" },
    { all: "http://user:secret@invalid.example" },
  ])("rejects malformed or invalid candidate patch %# without writing", async (patch) => {
    const bytes = '{"theme":"dark","future":{"keep":true}}\n ';
    writeFileSync(settingsPath, bytes);
    const service = new NetworkProxySettingsService(config, startupPolicy());

    await expect(service.patch(patch)).rejects.toMatchObject({ status: 400 });

    expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
    expect(renameSyncMock).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("accepts an empty patch as a non-writing read of current state", async () => {
    const bytes = '{"httpProxy":"http://current.example","keep":true}';
    writeFileSync(settingsPath, bytes);
    const service = new NetworkProxySettingsService(config, startupPolicy());

    const dto = await service.patch({});

    expect(dto.configured).toEqual({ all: "http://current.example" });
    expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
    expect(renameSyncMock).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    "{malformed",
    "[]",
    '{"easyresearch":"invalid"}',
    '{"easyresearch":{"network":[]}}',
  ])("rejects malformed existing ancestors without replacing bytes: %s", async (bytes) => {
    writeFileSync(settingsPath, bytes);
    const service = new NetworkProxySettingsService(config, startupPolicy());

    await expect(service.patch({ all: "http://valid.example" })).rejects.toMatchObject({
      status: 409,
      code: "CONFIG_INVALID",
    });

    expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
    expect(renameSyncMock).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("returns the committed DTO rather than rereading an external overwrite after commit", async () => {
    writeFileSync(settingsPath, '{"httpProxy":"http://old.example"}');
    const service = new NetworkProxySettingsService(
      config,
      startupPolicy({ httpProxy: "http://old.example" }),
    );
    renameSyncMock.mockImplementation((source, target) => {
      realFs.renameSync(source, target);
      realFs.writeFileSync(settingsPath, '{"httpProxy":"http://external-after.example"}');
    });

    const dto = await service.patch({ all: "http://committed.example" });

    expect(dto.configured).toEqual({ all: "http://committed.example" });
    expect(dto.restartRequired).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      httpProxy: "http://external-after.example",
    });
  });

  it("retries a CAS conflict and returns the normalized outcome from the successful attempt", async () => {
    writeFileSync(settingsPath, JSON.stringify({
      theme: "dark",
      easyresearch: { network: { llmProxy: "http://old-llm.example" } },
    }));
    const service = new NetworkProxySettingsService(config, startupPolicy());
    let settingsExistenceChecks = 0;
    existsSyncMock.mockImplementation((path) => {
      const exists = realFs.existsSync(path);
      if (path === settingsPath) {
        settingsExistenceChecks += 1;
        if (settingsExistenceChecks === 2) {
          realFs.writeFileSync(settingsPath, JSON.stringify({
            theme: "light",
            httpProxy: "http://external-all.example",
            external: { keep: true },
            easyresearch: { network: { llmProxy: "http://external-llm.example" } },
          }));
        }
      }
      return exists;
    });

    const dto = await service.patch({ llm: "https://new-llm.example:8443" });

    expect(settingsExistenceChecks).toBe(4);
    expect(renameSyncMock).toHaveBeenCalledTimes(1);
    expect(dto.configured).toEqual({
      all: "http://external-all.example",
      llm: "https://new-llm.example:8443",
    });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      theme: "light",
      httpProxy: "http://external-all.example",
      external: { keep: true },
      easyresearch: { network: { llmProxy: "https://new-llm.example:8443" } },
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
