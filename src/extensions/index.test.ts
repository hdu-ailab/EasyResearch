import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeBinding } from "../runtime/agent-runtime-binding";
import type { LiveConfiguration } from "../runtime/live-configuration";
import type {
  AgentSessionNetworkRouter,
  AppliedSearchRoute,
  SearchProxyConfiguration,
} from "../runtime/network-routing";
import type { SubagentCoordinator } from "../subagent/coordinator";
import type { SubagentSupervisor } from "../subagent/supervisor";
import { ManualCompactionController } from "../web/manual-compaction";
import { SessionStatsNotifier } from "../web/session-stats";
import { createResearchAssistantExtensions, type ResearchAssistantExtensionRuntime } from "./index";

const platformFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = platformFetch;
});

function binding(tools: string[]): AgentRuntimeBinding {
  return {
    current: () => ({ tools }),
    skillPaths: () => [],
    ensureCurrent: vi.fn(async () => {}),
  } as unknown as AgentRuntimeBinding;
}

function runtime(label: string, tools = ["read"]): ResearchAssistantExtensionRuntime {
  return {
    binding: binding(tools),
    liveConfiguration: {} as LiveConfiguration,
    coordinator: { label } as unknown as SubagentCoordinator,
    supervisor: { label } as unknown as SubagentSupervisor,
    compaction: new ManualCompactionController(),
    stats: new SessionStatsNotifier(),
    publishTimelineEntry: vi.fn(),
  };
}

function networkRouter(
  appliedSearchRoute: AppliedSearchRoute,
  scopes: string[] = [],
): AgentSessionNetworkRouter {
  return {
    appliedSearchRoute,
    decorateModelRuntime: (candidate) => candidate,
    withScope(scope, operation) {
      scopes.push(scope);
      return operation();
    },
  };
}

describe("bundled extension runtime builder", () => {
  it("returns named in-process factories without the legacy agent-status extension", () => {
    const extensions = createResearchAssistantExtensions(runtime("root-a"));

    expect(extensions.length).toBeGreaterThan(0);
    expect(extensions.map(({ name }) => name)).not.toContain("agent-status");
    expect(extensions.map(({ name }) => name)).toContain("ssh-bash");
    expect(extensions.map(({ name }) => name)).toContain("session-stats");
    for (const extension of extensions) {
      expect(extension.name.length).toBeGreaterThan(0);
      expect(typeof extension.factory).toBe("function");
    }
  });

  it("builds fresh runtime-bound dispatch factories for separate roots", () => {
    const first = createResearchAssistantExtensions(runtime("root-a"));
    const second = createResearchAssistantExtensions(runtime("root-b"));

    expect(first).not.toBe(second);
    expect(first.find(({ name }) => name === "subagent-dispatch")?.factory)
      .not.toBe(second.find(({ name }) => name === "subagent-dispatch")?.factory);
  });

  it("loads web-search through one async named factory", async () => {
    const extensions = createResearchAssistantExtensions(runtime("root-a"));
    const entries = extensions.filter(({ name }) => name === "web-search");
    const registerTool = vi.fn();

    expect(entries).toHaveLength(1);
    const loading = entries[0]!.factory({ registerTool } as never);
    expect(loading).toBeInstanceOf(Promise);
    await loading;
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[0].name).toBe("web-search");
  });

  it("registers a safe root web-search tool when the applied Search route is invalid", async () => {
    const invalid = Object.assign(new Error("invalid Search route"), {
      code: "NETWORK_PROXY_INVALID" as const,
    });
    const invalidError = vi.fn(() => invalid);
    const appliedSearchRoute: AppliedSearchRoute = Object.freeze({
      policyFingerprint: "invalid:search",
      applyProxyConfiguration: vi.fn(() => {
        throw invalid;
      }),
      invalidError,
      sanitizeError: (error: unknown) => error instanceof Error ? error.message : String(error),
    });
    const owner = {
      ...runtime("root-routed"),
      networkRouter: networkRouter(appliedSearchRoute),
    } as ResearchAssistantExtensionRuntime;
    const extension = createResearchAssistantExtensions(owner)
      .find(({ name }) => name === "web-search")!;
    const registerTool = vi.fn();

    await expect(extension.factory({ registerTool } as never)).resolves.toBeUndefined();

    expect(invalidError).toHaveBeenCalledOnce();
    expect(registerTool).toHaveBeenCalledOnce();
    const tool = registerTool.mock.calls[0]![0];
    const result = await tool.execute("search-call", {
      query: "routing test",
      engines: ["duckduckgo"],
    }, undefined, undefined, {} as never);
    expect(result.details.error).toContain("NETWORK_PROXY_INVALID");
  });

  it("runs the root webfetch request through the bound Search scope", async () => {
    const scopes: string[] = [];
    const appliedSearchRoute: AppliedSearchRoute = Object.freeze({
      policyFingerprint: "direct",
      applyProxyConfiguration: (target: SearchProxyConfiguration) => {
        target.useProxy = false;
      },
      invalidError: () => undefined,
      sanitizeError: (error: unknown) => error instanceof Error ? error.message : String(error),
    });
    const owner = {
      ...runtime("root-routed"),
      networkRouter: networkRouter(appliedSearchRoute, scopes),
    } as ResearchAssistantExtensionRuntime;
    const extension = createResearchAssistantExtensions(owner)
      .find(({ name }) => name === "webfetch")!;
    const registerTool = vi.fn();
    globalThis.fetch = Object.assign(
      async () => new Response("root fetch", {
        headers: { "content-type": "text/plain" },
      }),
      { preconnect: platformFetch.preconnect },
    );

    await extension.factory({ registerTool } as never);
    const result = await registerTool.mock.calls[0]![0].execute("fetch-call", {
      url: "https://root-search.example/",
      format: "text",
    }, undefined, undefined, {} as never);

    expect(result.content).toEqual([{ type: "text", text: "root fetch" }]);
    expect(scopes).toEqual(["search"]);
  });

  it("forwards exact persisted summary entries without appending plugin state", async () => {
    const owner = runtime("root-a") as ResearchAssistantExtensionRuntime & {
      publishTimelineEntry: ReturnType<typeof vi.fn>;
    };
    const extension = createResearchAssistantExtensions(owner)
      .find((entry) => entry.name === "session-timeline");

    expect(extension).toBeDefined();
    if (!extension) return;

    const handlers = new Map<string, (event: any) => void>();
    const appendEntry = vi.fn();
    await extension.factory({
      on: vi.fn((event: string, handler: (value: any) => void) => handlers.set(event, handler)),
      appendEntry,
    } as never);
    const compactionEntry = {
      type: "compaction",
      id: "compact-1",
      parentId: "assistant-2",
      timestamp: "2026-09-01T00:00:00.000Z",
      summary: "Compressed context",
      firstKeptEntryId: "user-2",
      tokensBefore: 100,
    };
    const branchSummaryEntry = {
      type: "branch_summary",
      id: "branch-1",
      parentId: "user-3",
      timestamp: "2026-09-01T00:01:00.000Z",
      fromId: "assistant-side",
      summary: "Abandoned branch",
    };

    handlers.get("session_compact")?.({ type: "session_compact", compactionEntry });
    handlers.get("session_tree")?.({ type: "session_tree", summaryEntry: branchSummaryEntry });
    handlers.get("session_tree")?.({ type: "session_tree" });

    expect(owner.publishTimelineEntry.mock.calls).toEqual([
      [compactionEntry],
      [branchSummaryEntry],
    ]);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("applies the binding supplied to that registry instance", async () => {
    const extensions = createResearchAssistantExtensions(runtime("root-a", ["read", "subagent"]));
    const definition = extensions.find((entry) => entry.name === "research-assistant");
    const handlers = new Map<string, (...args: any[]) => any>();
    const setActiveTools = vi.fn();
    const api = {
      getAllTools: vi.fn(() => ["read", "bash", "subagent"].map((name) => ({ name }))),
      on: vi.fn((event: string, handler: (...args: any[]) => any) => handlers.set(event, handler)),
      setActiveTools,
    };
    await (definition!.factory as ExtensionFactory)(api as never);

    await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/paper" });

    expect(setActiveTools).toHaveBeenCalledWith(["read", "subagent"]);
  });
});
