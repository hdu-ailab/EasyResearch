import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entry, fixture, verification } from "../../research-memory/test-fixture";
import type { MemoryResult, ResearchMemoryRequest } from "../../research-memory/types";
import { createLiveConfiguration, type LiveConfiguration } from "../../runtime/live-configuration";
import type { AgentSessionNetworkRouter } from "../../runtime/network-routing";
import { importPi } from "../../runtime/pi-import";
import { SubagentCoordinator } from "../../subagent/coordinator";
import { createDefaultStageSessionLauncher, type StageLaunchHandle } from "../../subagent/stage-session";
import { PiSessionFactory, type SessionAdapter } from "../../web/session-adapter";

let files: Awaited<ReturnType<typeof fixture>>;
let live: LiveConfiguration | undefined;
const roots: SessionAdapter[] = [];
const children: StageLaunchHandle[] = [];

beforeEach(async () => {
  files = await fixture();
  const home = join(files.root, "home");
  await mkdir(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", files.agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubGlobal("fetch", async () => { throw new Error("Network forbidden in memory runtime tests"); });
});

afterEach(async () => {
  for (const child of children.splice(0)) await child.dispose();
  for (const root of roots.splice(0)) await root.stop();
  await live?.close();
  live = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await files.cleanup();
});

async function writeAgent(name: string, tools: string[]) {
  await writeFile(join(files.agentDir, "agents", `${name}.md`), [
    "---", `name: ${name}`, `tools: ${JSON.stringify(tools)}`,
    "skills: [not-installed-test-skill]", "subagents: []", "---", `${name} test role.`,
  ].join("\n"));
}

async function harness() {
  const pi = await importPi();
  const ai = await import("@earendil-works/pi-ai");
  const provider = ai.fauxProvider({ provider: "memory-runtime", models: [{ id: "test" }], tokenSize: { min: 100_000, max: 100_000 } });
  await mkdir(join(files.agentDir, "agents"));
  // The controller-owned Task 3 adds the bundled Markdown allowlists. These
  // ordinary global definitions exercise today's real discovery/override path.
  await writeAgent("search", ["read", "research-memory"]);
  await writeAgent("memory-reader", ["read"]);
  await writeAgent("memory-general", []);
  await writeFile(join(files.agentDir, "agents", "research-assistant.md"), [
    "---", "name: research-assistant", "tools: []", "skills: [not-installed-test-skill]", "---", "Research Assistant test role.",
  ].join("\n"));
  await writeFile(join(files.agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: false }, retry: { enabled: false },
    easyresearch: { agentDefaults: { "research-assistant": { model: "memory-runtime/test", thinking: "off" } } },
  }));
  live = createLiveConfiguration({
    agentDir: files.agentDir,
    modelValidator: {
      async prepareModelCatalog() {
        return { registeredModels: provider.models, availableModels: provider.models, commit() {}, rollback() {} };
      },
      currentAvailableModels: () => provider.models,
    },
  });
  await live.start();
  expect(live.error).toBeNull();
  // Only replace the external model transport. Default root/stage factories,
  // bindings, discovery, Pi registration, execution and storage remain real.
  const decorated = new WeakSet<object>();
  const router: AgentSessionNetworkRouter = {
    appliedSearchRoute: {
      policyFingerprint: "memory-test-direct",
      applyProxyConfiguration(target) { target.useProxy = false; target.proxyUrl = ""; },
      invalidError: () => undefined,
      sanitizeError: () => "Search unavailable in test",
    },
    withScope: (_scope, operation) => operation(),
    decorateModelRuntime(runtime) {
      if (!decorated.has(runtime)) {
        decorated.add(runtime);
        (runtime as unknown as ModelRuntime).registerNativeProvider(provider.provider);
      }
      return runtime;
    },
  };
  const factory = await PiSessionFactory.resolve(live, router);
  const launchStage = await createDefaultStageSessionLauncher(router);
  const requests: string[][] = [];
  const script = (inputs: ResearchMemoryRequest[]) => {
    provider.setResponses([
      ...inputs.map(input => (context: Context) => {
        requests.push(context.tools?.map(tool => tool.name) ?? []);
        return ai.fauxAssistantMessage(ai.fauxToolCall("research-memory", input), { stopReason: "toolUse" });
      }),
      ai.fauxAssistantMessage("Memory task complete."),
    ]);
  };
  const root = factory.create({ cwd: files.cwd });
  roots.push(root);
  const messages: ToolResultMessage[] = [];
  root.onEvent(event => {
    const e = event as { type: string; message?: ToolResultMessage };
    if (e.type === "message_end" && e.message?.role === "toolResult") messages.push(e.message);
  });
  await root.start();
  return {
    root, requests,
    async rootCall(input: ResearchMemoryRequest) {
      script([input]);
      const before = messages.length;
      let finish!: () => void;
      const settled = new Promise<void>(resolve => { finish = resolve; });
      const unsubscribe = root.onEvent(event => {
        if ((event as { type: string }).type === "agent_settled") finish();
      });
      try {
        await root.prompt("Execute the memory operation.");
        await settled;
      } finally {
        unsubscribe();
      }
      expect(messages.length).toBe(before + 1);
      return messages.at(-1)!;
    },
    async stage(inputs: ResearchMemoryRequest[], name = "search", cwd = files.cwd) {
      script(inputs);
      const catalog = await live!.resolveAgents(cwd);
      const agent = catalog.find(agent => agent.name === name)!;
      const manager = pi.SessionManager.create(cwd);
      const coordinator = new SubagentCoordinator(manager);
      const reservation = coordinator.reserveDispatch({
        ownerSessionId: manager.getSessionId(), toolCallId: "memory-stage", requested: name,
        catalog: { all: catalog, available: [agent] },
      });
      const handle = await launchStage({ reservation, agent, callerAgent: "research-assistant", task: "Execute memory operations.",
        cwd, coordinator, liveConfiguration: live!,
      });
      children.push(handle);
      await handle.materialized;
      const result = await handle.completion;
      expect(result.exitCode, result.stderr).toBe(0);
      const results = result.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
      expect(results).toHaveLength(inputs.length);
      return { handle, results };
    },
  };
}

function result(message: ToolResultMessage): MemoryResult {
  expect(message.isError, JSON.stringify(message.content)).toBe(false);
  expect(message.content).toEqual([{ type: "text", text: JSON.stringify(message.details) }]);
  return message.details as MemoryResult;
}

describe("production root/stage research-memory wiring", () => {
  it("uses discovered stage identity for proposal/verification and root authority for activation and fresh-stage reuse", async () => {
    const h = await harness();
    expect(existsSync(join(files.agentDir, "research-memory"))).toBe(false);
    const author = await h.stage([{ action: "propose", entry: entry() }]);
    const proposed = result(author.results[0]!).record!;
    expect(existsSync(join(files.agentDir, "research-memory"))).toBe(true);
    expect(author.handle.sessionPath.startsWith(join(files.agentDir, "sessions"))).toBe(true);
    expect(proposed.pending?.author).toEqual({
      agent: "search", cwd: files.cwd, sessionId: author.handle.childSessionId, model: "memory-runtime/test",
    });
    expect(result(await h.rootCall({ action: "recall" })).memories).toEqual([]);
    const verifier = await h.stage([{ action: "verify", id: proposed.id, expectedRevision: proposed.revision, verification: verification() }]);
    const verified = result(verifier.results[0]!).record!;
    expect(verified.pending?.verification?.actor.sessionId).toBe(verifier.handle.childSessionId);
    expect(verifier.handle.childSessionId).not.toBe(author.handle.childSessionId);
    const unauthorized = await h.stage([{ action: "activate", id: proposed.id, expectedRevision: verified.revision }]);
    expect(unauthorized.results[0]).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^FORBIDDEN: /) }] });
    const active = result(await h.rootCall({ action: "activate", id: proposed.id, expectedRevision: verified.revision })).record!;
    expect(active.actor).toMatchObject({ agent: "research-assistant", sessionId: (await h.root.getState()).sessionId });
    expect((await h.root.getState()).sessionFile?.startsWith(join(files.agentDir, "sessions"))).toBe(true);
    const ref = { scope: active.scope, id: active.id, revision: active.revision };
    const fresh = await h.stage([{ action: "recall", role: "search" }, { action: "get", ...ref }]);
    expect(fresh.handle.childSessionId).not.toBe(author.handle.childSessionId);
    expect(result(fresh.results[0]!).memories?.map(memory => memory.ref)).toEqual([ref]);
    expect(result(fresh.results[1]!).record?.active?.entry).toEqual(entry());
    const other = await h.stage([{ action: "recall" }], "search", files.otherCwd);
    expect(result(other.results[0]!).memories).toEqual([]);
  });

  it("honors root/stage strict allowlists and keeps all-tools custom Agents inside their shell/SSH policy", async () => {
    const h = await harness();
    result(await h.rootCall({ action: "recall" }));
    const names = () => h.requests.at(-1)!;
    expect(names()).toContain("research-memory");
    expect(names()).toContain("ssh-bash");
    expect(names()).toContain(process.platform === "win32" ? "powershell" : "bash");
    expect(names()).not.toContain(process.platform === "win32" ? "bash" : "powershell");
    const excluded = await h.stage([{ action: "recall" }], "memory-reader");
    expect(excluded.results[0]?.isError).toBe(true);
    expect(names()).toEqual(["read"]);
    const general = await h.stage([{ action: "propose", entry: entry() }], "memory-general");
    expect(result(general.results[0]!).record?.actor.agent).toBe("memory-general");
    expect(names()).toContain("research-memory");
    expect(names()).not.toContain("ssh-bash");
    expect(names()).not.toContain("subagent");
    expect(names()).toContain(process.platform === "win32" ? "powershell" : "bash");
    expect(names()).not.toContain(process.platform === "win32" ? "bash" : "powershell");
    await writeAgent("research-assistant", ["read"]);
    await live!.notify({ agentsChanged: true });
    expect((await h.rootCall({ action: "recall" })).isError).toBe(true);
    expect(names()).toEqual(["read"]);
  });
});
