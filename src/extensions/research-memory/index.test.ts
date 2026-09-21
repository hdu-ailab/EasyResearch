import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entry, fixture, verification } from "../../research-memory/test-fixture";
import type { MemoryRecord, MemoryResult, ResearchMemoryRequest } from "../../research-memory/types";
import { importPi } from "../../runtime/pi-import";

let files: Awaited<ReturnType<typeof fixture>>;
const sessions: AgentSession[] = [];

beforeEach(async () => {
  files = await fixture();
  const home = join(files.root, "home");
  await mkdir(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", files.agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubGlobal("fetch", async () => { throw new Error("Unexpected network request in memory tests"); });
});

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await files.cleanup();
});

async function runtime(agent: () => string, cwd = files.cwd) {
  const pi = await importPi();
  const ai = await import("@earendil-works/pi-ai");
  const { createResearchMemoryExtension } = await import("./index");
  const provider = ai.fauxProvider({
    provider: "memory-test", models: [{ id: "first" }, { id: "second" }],
    tokenSize: { min: 100_000, max: 100_000 },
  });
  const modelRuntime = await pi.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(files.agentDir, "models-store.json"), refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd, agentDir: files.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [{ name: "research-memory", factory: createResearchMemoryExtension({ agent }) }],
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await pi.createAgentSession({
    cwd, agentDir: files.agentDir, settingsManager, resourceLoader, modelRuntime,
    sessionManager: pi.SessionManager.inMemory(cwd), model: provider.getModel(),
    thinkingLevel: "off", tools: ["research-memory"],
  });
  sessions.push(session);
  await session.bindExtensions({ mode: "print" });
  const tool = session.agent.state.tools.find(tool => tool.name === "research-memory")!;
  expect(tool).toBeDefined();
  return {
    session, tool, provider,
    async call(input: ResearchMemoryRequest | Record<string, unknown>): Promise<ToolResultMessage> {
      provider.setResponses([
        ai.fauxAssistantMessage(ai.fauxToolCall("research-memory", input), { stopReason: "toolUse" }),
        ai.fauxAssistantMessage("Finished memory operation."),
      ]);
      await session.prompt("Perform the memory operation.");
      const result = session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult").at(-1);
      expect(result).toBeDefined();
      return result!;
    },
  };
}

function success(message: ToolResultMessage): MemoryResult {
  expect(message.isError, JSON.stringify(message.content)).toBe(false);
  expect(message.content).toEqual([{ type: "text", text: JSON.stringify(message.details) }]);
  return message.details as MemoryResult;
}

function record(message: ToolResultMessage): MemoryRecord {
  const result = success(message);
  expect(result.record).toBeDefined();
  return result.record!;
}

function failure(message: ToolResultMessage, code: string) {
  expect(message.isError).toBe(true);
  expect(message.content).toEqual([{ type: "text", text: expect.stringMatching(new RegExp(`^${code}: `)) }]);
  expect(Object.keys(message.details ?? {})).toEqual([]);
  expect(JSON.stringify(message)).not.toContain(files.root);
  expect(JSON.stringify(message)).not.toContain("PRIVATE_SENTINEL");
}

describe("research-memory through initialized Pi", () => {
  it("registers without resolving caller identity or accessing a memory library until execution", async () => {
    let ready = false;
    const owner = await runtime(() => {
      if (!ready) throw new Error("Caller identity was requested during registration");
      return "search";
    });
    expect(owner.session.getActiveToolNames()).toContain("research-memory");
    expect(owner.tool.parameters.type).toBe("object");
    expect(owner.tool.parameters.properties.action).toMatchObject({ type: "string", enum: expect.arrayContaining(["recall", "rollback"]) });
    expect(existsSync(join(files.agentDir, "research-memory"))).toBe(false);
    ready = true;
    expect(success(await owner.call({ action: "recall" }))).toEqual({ memories: [], diagnostics: [], truncated: false });
    expect(existsSync(join(files.agentDir, "research-memory"))).toBe(false);
  });

  it("requires independent Pi sessions and Research Assistant activation before fresh-task reuse", async () => {
    const author = await runtime(() => "search");
    const proposed = record(await author.call({ action: "propose", entry: entry() }));
    expect(proposed.pending?.author).toEqual({
      cwd: files.cwd, sessionId: author.session.sessionId, agent: "search", model: "memory-test/first",
    });
    expect(success(await author.call({ action: "recall" })).memories).toEqual([]);
    const target = { id: proposed.id, expectedRevision: proposed.revision };
    failure(await author.call({ action: "verify", ...target, verification: verification() }), "FORBIDDEN");
    const verifier = await runtime(() => "search");
    const verified = record(await verifier.call({ action: "verify", ...target, verification: verification() }));
    expect(verified.pending?.verification?.actor.sessionId).toBe(verifier.session.sessionId);
    expect(verifier.session.sessionId).not.toBe(author.session.sessionId);
    failure(await verifier.call({ action: "activate", id: proposed.id, expectedRevision: verified.revision }), "FORBIDDEN");
    const root = await runtime(() => "research-assistant");
    const activated = record(await root.call({ action: "activate", id: proposed.id, expectedRevision: verified.revision }));
    expect(activated.actor.sessionId).toBe(root.session.sessionId);
    expect(activated.pending).toBeUndefined();
    const fresh = await runtime(() => "writing");
    const recalled = success(await fresh.call({ action: "recall", query: "citation", role: "writing", kind: "method", limit: 1 }));
    const ref = { scope: activated.scope, id: activated.id, revision: activated.revision };
    expect(recalled.memories?.map(memory => memory.ref)).toEqual([ref]);
    expect(record(await fresh.call({ action: "get", ...ref })).active?.entry).toEqual(entry());
  });

  it("uses the current binding and model at execution, including loss of publication authority", async () => {
    let agent = "research-assistant";
    const owner = await runtime(() => agent);
    agent = "writing";
    await owner.session.setModel(owner.provider.getModel("second")!);
    const proposed = record(await owner.call({ action: "propose", entry: entry() }));
    expect(proposed.actor).toMatchObject({ agent: "writing", model: "memory-test/second", sessionId: owner.session.sessionId });
    failure(await owner.call({ action: "reject", id: proposed.id, expectedRevision: proposed.revision, reason: "Withdraw" }), "FORBIDDEN");
    agent = "research-assistant";
    const rejected = record(await owner.call({ action: "reject", id: proposed.id, expectedRevision: proposed.revision, reason: "Withdraw" }));
    expect(rejected.actor.agent).toBe(agent);
    expect(rejected.pending).toBeUndefined();
  });

  it("keeps project records private while sharing only the generalized projection", async () => {
    const root = await runtime(() => "research-assistant");
    const verifier = await runtime(() => "search");
    const project = record(await root.call({ action: "propose", entry: entry() }));
    const shared = record(await root.call({ action: "propose", scope: "shared", entry: entry() }));
    const verified = record(await verifier.call({ action: "verify", scope: "shared", id: shared.id, expectedRevision: shared.revision,
      verification: verification({ checks: [...verification().checks, { name: "distinct task", kind: "transfer", outcome: "pass", details: "Held-out task passed." }] }),
    }));
    const active = record(await root.call({ action: "activate", scope: "shared", id: shared.id, expectedRevision: verified.revision }));
    const foreign = await runtime(() => "search", files.otherCwd);
    failure(await foreign.call({ action: "get", id: project.id }), "NOT_FOUND");
    failure(await foreign.call({ action: "propose", scope: "shared", entry: entry() }), "FORBIDDEN");
    const recalled = success(await foreign.call({ action: "recall" }));
    expect(recalled.memories?.map(memory => memory.ref)).toEqual([{ scope: "shared", id: active.id, revision: active.revision }]);
    const projected = record(await foreign.call({ action: "get", scope: "shared", id: active.id }));
    expect(projected.active?.entry.evidencePaths).toEqual([]);
    expect(projected.active?.author).toEqual({ agent: "research-assistant", model: "memory-test/first" });
    const serialized = JSON.stringify(projected);
    for (const privateValue of [files.cwd, root.session.sessionId, verifier.session.sessionId, "source.md", "verification.md"]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("keeps pinned incumbent reads stable across replacement, rejection, retirement and rollback", async () => {
    const root = await runtime(() => "research-assistant");
    const verifier = await runtime(() => "search");
    const first = record(await root.call({ action: "propose", entry: entry() }));
    const proof = record(await verifier.call({ action: "verify", id: first.id, expectedRevision: first.revision, verification: verification() }));
    const active = record(await root.call({ action: "activate", id: first.id, expectedRevision: proof.revision }));
    const pending = record(await root.call({ action: "propose", id: first.id, expectedRevision: active.revision,
      entry: entry({ title: "Candidate replacement", basedOn: [{ scope: "project", id: first.id, revision: active.revision }] }),
    }));
    expect(success(await root.call({ action: "recall" })).memories?.[0]?.title).toBe(active.active?.entry.title);
    const historical = record(await root.call({ action: "get", id: first.id, revision: active.revision }));
    expect(historical).toMatchObject({ historical: true, active: active.active });
    const rejected = record(await root.call({ action: "reject", id: first.id, expectedRevision: pending.revision, reason: "Insufficient evidence" }));
    failure(await root.call({ action: "retire", id: first.id, expectedRevision: pending.revision, reason: "Stale write" }), "CONFLICT");
    const retired = record(await root.call({ action: "retire", id: first.id, expectedRevision: rejected.revision, reason: "No longer applicable" }));
    expect(success(await root.call({ action: "recall" })).memories).toEqual([]);
    const restored = record(await root.call({ action: "rollback", id: first.id, expectedRevision: retired.revision, revision: active.revision, reason: "Restored applicability" }));
    expect(restored.active).toEqual(active.active);
    expect(restored.revision).toBeGreaterThan(retired.revision);
    expect(success(await root.call({ action: "recall" })).memories?.[0]?.ref.revision).toBe(restored.revision);
  });

  it("round-trips strategy comparison payloads through Pi schema validation", async () => {
    const root = await runtime(() => "research-assistant");
    const verifier = await runtime(() => "experiment");
    const proposed = record(await root.call({ action: "propose", entry: entry({ kind: "strategy" }) }));
    const comparison = { baseline: 2, candidate: 3, direction: "maximize" as const, baselineBudget: 5, candidateBudget: 5,
      budgetUnit: "trials", protocol: "Frozen evaluator and model", heldOutTask: "Unseen retrieval task" };
    const verified = record(await verifier.call({ action: "verify", id: proposed.id, expectedRevision: proposed.revision,
      verification: verification({ comparison, checks: [...verification().checks,
        { name: "attributed mechanism", kind: "mechanism", outcome: "pass", details: "Controlled attribution in report." }] }),
    }));
    expect(verified.pending?.verification?.result?.comparison).toEqual(comparison);
    expect(record(await root.call({ action: "activate", id: proposed.id, expectedRevision: verified.revision })).active?.entry.kind).toBe("strategy");
  });

  it.each([
    { action: "recall", agent: "research-assistant" },
    { action: "recall", sessionId: "PRIVATE_SENTINEL" },
    { action: "recall", cwd: "PRIVATE_SENTINEL", agentDir: "PRIVATE_SENTINEL" },
    { action: "recall", entry: entry() },
    { action: "propose" },
    { action: "get" },
    { action: "PRIVATE_SENTINEL" },
    { action: "recall", limit: "PRIVATE_SENTINEL" },
    { action: "propose", entry: entry({ roles: [] }) },
    { action: "propose", entry: { ...entry(), actor: "PRIVATE_SENTINEL" } },
  ])("rejects malformed or identity-bearing arguments safely ($#)", async input => {
    const owner = await runtime(() => "search");
    failure(await owner.call(input), "INVALID_REQUEST");
    expect(existsSync(join(files.agentDir, "research-memory"))).toBe(false);
  });

  it("accepts legacy UUIDv4 references and reports missing records through Pi's normal error result", async () => {
    const owner = await runtime(() => "search");
    failure(await owner.call({ action: "get", id: "5f3df86c-6c01-4dc0-9bcb-1668f515e2e1" }), "NOT_FOUND");
    expect(success(await owner.call({ action: "recall" })).memories).toEqual([]);
  });

  it("forwards cancellation without leaking the abort reason or creating memory", async () => {
    const owner = await runtime(() => "search");
    const aborted = AbortSignal.abort(new Error(`${files.root}/PRIVATE_SENTINEL`));
    await expect(owner.tool.execute("aborted", { action: "propose", entry: entry() }, aborted))
      .rejects.toThrow(/^ABORTED: /);
    expect(existsSync(join(files.agentDir, "research-memory"))).toBe(false);
  });

  it("sanitizes unexpected binding failures and refuses missing model provenance", async () => {
    let unavailable = true;
    const owner = await runtime(() => {
      if (unavailable) throw new Error(`${files.root}/PRIVATE_SENTINEL`);
      return "search";
    });
    failure(await owner.call({ action: "recall" }), "IO");
    unavailable = false;
    Reflect.set(owner.session.agent.state, "model", undefined);
    await expect(owner.tool.execute("missing-model", { action: "propose", entry: entry() }))
      .rejects.toThrow(/^INVALID_REQUEST: /);
    expect(existsSync(join(files.agentDir, "research-memory"))).toBe(false);
  });
});
