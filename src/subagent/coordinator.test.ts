import { describe, expect, it, vi } from "vitest";
import { readAgentAliases } from "./agent-alias";
import type { AgentConfig } from "./agents";
import type {
  SubagentJobIdentity,
  SubagentJobSummary,
  SubagentLaunchDetails,
  SubagentSupervisorEvent,
} from "./contracts";
import { SubagentCoordinator, type AgentCatalog, type CoordinatorSessionManager } from "./coordinator";
import { readSubagentSessionLinks } from "./session-links";

function agent(name: string): AgentConfig {
  return {
    name,
    description: name,
    enabled: true,
    builtin: false,
    effectiveTools: [],
    effectiveSkills: [],
    missingSkills: [],
    systemPrompt: "",
    source: "project",
    filePath: `/${name}.md`,
  };
}

function catalogOf(...names: string[]): AgentCatalog {
  const all = names.map(agent);
  return { all, available: all };
}

function catalogWithAvailable(allNames: string[], availableNames: string[]): AgentCatalog {
  const all = allNames.map(agent);
  const available = all.filter((candidate) => availableNames.includes(candidate.name));
  return { all, available };
}

function harness(initialEntries: unknown[] = []) {
  const entries = [...initialEntries];
  const manager: CoordinatorSessionManager = {
    getSessionId: () => "root",
    getSessionFile: () => "/sessions/root.jsonl",
    getEntries: () => entries,
    appendCustomEntry: (customType, data) => {
      const id = `entry-${entries.length}`;
      entries.push({ type: "custom", id, customType, data });
      return id;
    },
  };
  return { coordinator: new SubagentCoordinator(manager), entries, manager };
}

function materialize(
  coordinator: SubagentCoordinator,
  reservation: ReturnType<SubagentCoordinator["reserveDispatch"]>,
  childSessionId = "child",
  sessionPath = "/sessions/child.jsonl",
) {
  const child = { childSessionId, sessionPath };
  coordinator.recordChildCreated(reservation, child);
  return coordinator.recordMaterialized(reservation, child);
}

describe("SubagentCoordinator", () => {
  it("reserves distinct same-role ids before either launch starts", () => {
    const { coordinator } = harness();
    const catalog = catalogOf("search");
    const first = coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t0", requested: "search", catalog });
    const second = coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t1", requested: "search", catalog });
    expect([first.agentId, second.agentId]).toEqual(["search_0", "search_1"]);
  });

  it.each(["审稿人", "review.agent", "review agent", "review-agent", "review_agent", "review2"])(
    "treats %s as an exact Agent name rather than parsing an id shape",
    (name) => {
      const reserved = harness().coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t", requested: name, catalog: catalogOf(name) });
      expect(reserved).toMatchObject({ agent: name, agentId: `${name}_0`, continuation: false });
    },
  );

  it("rejects a value that is both an exact alias and an exact Agent name", () => {
    const { coordinator } = harness();
    const first = coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t0", requested: "review", catalog: catalogOf("review") });
    materialize(coordinator, first, "review-child", "/sessions/review.jsonl");
    coordinator.recordTerminal({ launchId: first.launchId, status: "complete" });

    expect(() => coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t1", requested: "review_0", catalog: catalogOf("review", "review_0") }))
      .toThrow(/ambiguous/i);
  });

  it("skips a fresh id that is an actual Agent name", () => {
    const reserved = harness().coordinator.reserveDispatch({
      ownerSessionId: "root",
      toolCallId: "t0",
      requested: "search",
      catalog: catalogOf("search", "search_0"),
    });
    expect(reserved.agentId).toBe("search_1");
  });

  it("keeps a pre-materialization failure consumed without creating an alias", () => {
    const { coordinator, entries } = harness();
    const catalog = catalogOf("search");
    const failed = coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t0", requested: "search", catalog });
    coordinator.recordPreMaterializationFailure(failed, new Error("model unavailable"));
    const next = coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t1", requested: "search", catalog });

    expect([failed.agentId, next.agentId]).toEqual(["search_0", "search_1"]);
    expect(readAgentAliases(entries)).toEqual([]);
    expect(coordinator.journal().jobs.get(failed.launchId)?.status).toBe("pre_materialization_failed");
  });

  it("uses one root-scoped sequence for nested owners", () => {
    const { coordinator } = harness();
    const catalog = catalogOf("search");
    const root = coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t0", requested: "search", catalog });
    const nested = coordinator.reserveDispatch({ ownerSessionId: "experiment-child", toolCallId: "t1", requested: "search", catalog });

    expect([root.agentId, nested.agentId]).toEqual(["search_0", "search_1"]);
    expect([root.ownerSessionId, nested.ownerSessionId]).toEqual(["root", "experiment-child"]);
  });

  it("rejects continuation while the mapped child is running", () => {
    const { coordinator } = harness();
    const catalog = catalogOf("search");
    const running = coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t0", requested: "search", catalog });
    materialize(coordinator, running);

    expect(() => coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t1", requested: running.agentId, catalog }))
      .toThrow(/running/i);
  });

  it("continues a completed exact alias with its persisted child", () => {
    const { coordinator } = harness();
    const catalog = catalogOf("search");
    const completed = coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t0", requested: "search", catalog });
    materialize(coordinator, completed, "child-search", "/sessions/search.jsonl");
    coordinator.recordTerminal({ launchId: completed.launchId, status: "complete", latestAssistantText: "done" });

    const continuation = coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t1", requested: completed.agentId, catalog });
    expect(continuation).toMatchObject({
      ownerSessionId: "root",
      toolCallId: "t1",
      agent: "search",
      agentId: "search_0",
      continuation: true,
      childSessionId: "child-search",
      sessionPath: "/sessions/search.jsonl",
    });
    expect(coordinator.isRunning("search_0")).toBe(true);
  });

  it("rejects continuation when the aliased Agent is no longer available", () => {
    const { coordinator } = harness();
    const catalog = catalogOf("search");
    const completed = coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t0", requested: "search", catalog });
    materialize(coordinator, completed);
    coordinator.recordTerminal({ launchId: completed.launchId, status: "complete" });

    expect(() => coordinator.reserveDispatch({
      ownerSessionId: "root",
      toolCallId: "t1",
      requested: completed.agentId,
      catalog: catalogWithAvailable(["search"], []),
    })).toThrow(/available|disabled/i);
  });

  it("persists ownership metadata only after materialization and returns path-free public state", () => {
    const pathFreeContracts: [
      "sessionPath" extends keyof SubagentJobIdentity ? false : true,
      "sessionPath" extends keyof SubagentJobSummary ? false : true,
      "sessionPath" extends keyof SubagentSupervisorEvent ? false : true,
      "sessionPath" extends keyof SubagentLaunchDetails ? false : true,
    ] = [true, true, true, true];
    const { coordinator, entries } = harness();
    const reserved = coordinator.reserveDispatch({ ownerSessionId: "experiment-child", toolCallId: "t0", requested: "search", catalog: catalogOf("search") });
    coordinator.recordChildCreated(reserved, { childSessionId: "child", sessionPath: "/sessions/child.jsonl" });
    expect(readAgentAliases(entries)).toEqual([]);
    expect(readSubagentSessionLinks(entries)).toEqual([]);

    const identity = coordinator.recordMaterialized(reserved, { childSessionId: "child", sessionPath: "/sessions/child.jsonl" });
    expect(identity).toEqual({
      launchId: reserved.launchId,
      ownerSessionId: "experiment-child",
      toolCallId: "t0",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child",
    });
    expect(readAgentAliases(entries)).toEqual([
      { id: "search_0", agent: "search", sessionId: "child", sessionPath: "/sessions/child.jsonl" },
    ]);
    expect(readSubagentSessionLinks(entries)).toEqual([
      {
        toolCallId: "t0",
        childSessionId: "child",
        agent: "search",
        ownerSessionId: "experiment-child",
        launchId: reserved.launchId,
        agentId: "search_0",
      },
    ]);
    expect(coordinator.summaries()).toEqual([{ ...identity, status: "working" }]);
    expect(Object.hasOwn(coordinator.summaries()[0] ?? {}, "sessionPath")).toBe(false);
    expect(pathFreeContracts).toEqual([true, true, true, true]);
  });

  it("records terminal summaries and notification acknowledgement", () => {
    const { coordinator } = harness();
    const reserved = coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t0", requested: "search", catalog: catalogOf("search") });
    materialize(coordinator, reserved);
    coordinator.recordLaunchAcknowledged(reserved.launchId);
    coordinator.recordTerminal({ launchId: reserved.launchId, status: "error", latestAssistantText: "partial result", errorMessage: "aborted" });
    coordinator.recordNotificationBatch({ batchId: "b0", ownerSessionId: "root", launchIds: [reserved.launchId], content: "status" });

    expect(coordinator.summaries()).toEqual([{
      launchId: reserved.launchId,
      ownerSessionId: "root",
      toolCallId: "t0",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child",
      status: "error",
      latestMessage: "partial result",
    }]);
    expect(coordinator.journal().pendingBatches.map(({ batchId }) => batchId)).toEqual(["b0"]);
    coordinator.acknowledgeNotification("b0");
    expect(coordinator.journal().pendingBatches).toEqual([]);
  });

  it("publishes supervisor events until the listener unsubscribes", () => {
    const { coordinator } = harness();
    const listener = vi.fn();
    const unsubscribe = coordinator.subscribe(listener);
    const event: SubagentSupervisorEvent = {
      type: "subagent_supervisor",
      launchId: "l0",
      ownerSessionId: "root",
      toolCallId: "t0",
      agent: "search",
      agentId: "search_0",
      childSessionId: "child",
      status: "working",
    };

    coordinator.publish(event);
    unsubscribe();
    coordinator.publish({ ...event, status: "complete" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it("reads bound Paper Assistant state and refuses reservations while closing", () => {
    const { coordinator, manager } = harness();
    let model: string | undefined = "provider/model-a";
    let thinking: string | undefined = "high";
    coordinator.bindPaperAssistantState({ model: () => model, thinking: () => thinking });

    expect(coordinator.getRootSessionManager()).toBe(manager);
    expect(coordinator.getPaperAssistantModel()).toBe("provider/model-a");
    expect(coordinator.getPaperAssistantThinking()).toBe("high");
    model = "provider/model-b";
    thinking = undefined;
    expect(coordinator.getPaperAssistantModel()).toBe("provider/model-b");
    expect(coordinator.getPaperAssistantThinking()).toBeUndefined();

    coordinator.beginClosing();
    expect(() => coordinator.reserveDispatch({ ownerSessionId: "root", toolCallId: "t0", requested: "search", catalog: catalogOf("search") }))
      .toThrow(/closing/i);
  });
});
