import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrustService, type TrustDeps } from "./trust";

interface StoreEntry {
  path: string;
  decision: boolean | null;
}

function makeDeps(overrides: Partial<TrustDeps> = {}): TrustDeps & { store: Map<string, boolean | null> } {
  const store = new Map<string, boolean | null>();
  return {
    hasTrustRequiringProjectResources: vi.fn(() => true),
    trustStore: {
      get: vi.fn((cwd: string) => {
        let dir = cwd;
        while (true) {
          if (store.has(dir)) return store.get(dir) ?? null;
          const parent = dir.slice(0, dir.lastIndexOf("/"));
          if (parent === dir) return null;
          dir = parent;
        }
      }),
      setMany: vi.fn((updates: StoreEntry[]) => {
        for (const u of updates) store.set(u.path, u.decision);
      }),
    },
    getProjectTrustOptions: vi.fn((target: string) => [
      { label: "Trust", trusted: true, updates: [{ path: target, decision: true }], savedPath: target },
      { label: "Trust (this session only)", trusted: true, updates: [], savedPath: undefined },
      { label: "Do not trust", trusted: false, updates: [{ path: target, decision: false }], savedPath: target },
    ]),
    defaultProjectTrust: "ask",
    ...overrides,
  } as TrustDeps & { store: Map<string, boolean | null> };
}

let cwd: string;

beforeEach(() => {
  const root = join(tmpdir(), `lazyresearch-trust-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "settings.json"), "{}");
  cwd = root;
});

describe("TrustService.inspect", () => {
  it("returns not required and trusted when no resources exist", () => {
    const deps = makeDeps({ hasTrustRequiringProjectResources: vi.fn(() => false) });
    const service = new TrustService(deps);
    expect(service.inspect(cwd)).toEqual({ required: false, trusted: true, options: [] });
  });

  it("uses a saved decision without prompting", () => {
    const deps = makeDeps();
    deps.trustStore.setMany([{ path: cwd, decision: true }]);
    const service = new TrustService(deps);
    expect(service.inspect(cwd)).toEqual({ required: true, trusted: true, options: [] });
    expect(deps.getProjectTrustOptions).not.toHaveBeenCalled();
  });

  it("resolves defaultProjectTrust always without prompting", () => {
    const deps = makeDeps({ defaultProjectTrust: "always" });
    const service = new TrustService(deps);
    expect(service.inspect(cwd)).toEqual({ required: true, trusted: true, options: [] });
  });

  it("resolves defaultProjectTrust never without prompting", () => {
    const deps = makeDeps({ defaultProjectTrust: "never" });
    const service = new TrustService(deps);
    expect(service.inspect(cwd)).toEqual({ required: true, trusted: false, options: [] });
  });

  it("returns native option labels in native order only for ask", () => {
    const deps = makeDeps({ defaultProjectTrust: "ask" });
    const service = new TrustService(deps);
    const inspection = service.inspect(cwd);
    expect(inspection.required).toBe(true);
    expect(inspection.options.map((o) => o.label)).toEqual([
      "Trust",
      "Trust (this session only)",
      "Do not trust",
    ]);
    expect(inspection.options[1]).toEqual({
      label: "Trust (this session only)",
      trusted: true,
      savesDecision: false,
    });
  });
});

describe("TrustService.apply", () => {
  it("applies setMany(option.updates) and returns option.trusted as the RPC override", () => {
    const deps = makeDeps();
    const service = new TrustService(deps);
    const result = service.apply(cwd, 0);
    expect(result).toEqual({ trusted: true, projectTrustOverride: true });
    expect(deps.trustStore.setMany).toHaveBeenCalledWith([{ path: cwd, decision: true }]);
  });

  it("does not persist session-only options but still returns the override", () => {
    const deps = makeDeps();
    const service = new TrustService(deps);
    const result = service.apply(cwd, 1);
    expect(result).toEqual({ trusted: true, projectTrustOverride: true });
    expect(deps.trustStore.setMany).not.toHaveBeenCalled();
  });

  it("returns the untrusted option unchanged", () => {
    const deps = makeDeps();
    const service = new TrustService(deps);
    const result = service.apply(cwd, 2);
    expect(result).toEqual({ trusted: false, projectTrustOverride: false });
  });

  it("throws for an out-of-range option index", () => {
    const deps = makeDeps();
    const service = new TrustService(deps);
    expect(() => service.apply(cwd, 99)).toThrow(/option/);
  });
});

describe("createTrustService production wiring", () => {
  it("inspects an undecided trust-requiring directory with native options", async () => {
    const agentDir = join(tmpdir(), `lazyresearch-trust-agent-${Math.random().toString(36).slice(2)}`);
    mkdirSync(agentDir, { recursive: true });
    const originalHome = process.env.HOME;
    const originalAgentDir = process.env.LAZYRESEARCH_CODING_AGENT_DIR;
    process.env.HOME = join(tmpdir(), `lazyresearch-trust-home-${Math.random().toString(36).slice(2)}`);
    process.env.LAZYRESEARCH_CODING_AGENT_DIR = agentDir;
    mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
    try {
      const { createTrustService } = await import("./trust");
      const service = await createTrustService(agentDir);
      const inspection = service.inspect(cwd);
      expect(inspection.required).toBe(true);
      expect(inspection.trusted).toBeUndefined();
      const labels = inspection.options.map((o) => o.label);
      expect(labels).toContain("Trust");
      expect(labels).toContain("Trust (this session only)");
      expect(labels).toContain("Do not trust");
      const applied = service.apply(cwd, 1);
      expect(applied.trusted).toBe(true);
    } finally {
      process.env.HOME = originalHome;
      process.env.LAZYRESEARCH_CODING_AGENT_DIR = originalAgentDir;
    }
  });
});
