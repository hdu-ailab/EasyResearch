import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentDefinitionExtension } from "../extensions/agent-definition";
import { SubagentCoordinator } from "../subagent/coordinator";
import { SubagentSupervisor } from "../subagent/supervisor";
import { createStageSessionLauncher, type StageLaunchHandle, type StageSessionDependencies } from "../subagent/stage-session";
import { createPiAgentSessionCreator, PiSessionFactory, type PiRuntimeDependencies } from "../web/session-adapter";
import { createLiveConfiguration } from "./live-configuration";
import type { ConfigurationEvent } from "../web/contracts";
import type { AgentRuntimeBinding } from "./agent-runtime-binding";
import { importPi } from "./pi-import";

vi.mock("./logger", () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

let root: string, agentDir: string, cwd: string, bundle: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-tool-skill-"));
  agentDir = join(root, "agent"); cwd = join(root, "paper"); bundle = join(root, "bundle");
  for (const path of [agentDir, cwd, join(bundle, "skills"), join(bundle, "agents"), join(root, "sessions")]) mkdirSync(path, { recursive: true });
  vi.stubEnv("HOME", root); vi.stubEnv("USERPROFILE", root); vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubGlobal("fetch", async () => { throw new Error("Network forbidden in Tool/Skill tests"); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
function skill(base: string, name: string) {
  const path = join(base, "skills", name, "SKILL.md");
  write(path, `---\nname: ${name}\ndescription: Integration fixture\n---\nInstructions.`);
  return path;
}
function tool(name: string, expression: string) {
  return `api.registerTool({name:${JSON.stringify(name)},label:"Fixture",description:${expression},
    parameters:Type.Object({}),execute:async()=>({content:[{type:"text",text:${expression}}],details:{}})});`;
}
function extension(body: string) {
  return `import { Type } from "typebox"; export default api => { ${body} };`;
}

async function harness() {
  const pi = await importPi();
  const ai = await import("@earendil-works/pi-ai");
  const mainProvider = ai.fauxProvider({ provider: "tool-skill-root", models: [{ id: "test" }] });
  const stageProvider = ai.fauxProvider({ provider: "tool-skill-stage", models: [{ id: "test" }] });
  const settings = { compaction: { enabled: false }, retry: { enabled: false },
    easyresearch: { agentDefaults: { "research-assistant": { model: "tool-skill-root/test" }, custom: { model: "tool-skill-stage/test" } } } };
  write(join(agentDir, "settings.json"), JSON.stringify(settings));
  for (const [name, tools] of [["research-assistant", []], ["custom", ["read", "global_fixture", "project_fixture"]]] as const) {
    write(join(bundle, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Fixture\ntools: ${JSON.stringify(tools)}\nskills: []\nsubagents: ${JSON.stringify(name === "research-assistant" ? ["custom"] : [])}\n---\nFixture.`);
  }
  const quietWatch = () => {
    const watcher = {
      on(event: string, listener: (...args: unknown[]) => void) { if (event === "ready") queueMicrotask(listener); return watcher; },
      add() { return watcher; }, async close() {},
    };
    return watcher;
  };
  const live = createLiveConfiguration({
    agentDir, watch: quietWatch, catalogOptions: { homeDir: root, bundledAgentsDir: bundle, bundledSkillsDir: join(bundle, "skills") },
    modelValidator: {
      async prepareModelCatalog() {
        return { registeredModels: [mainProvider, stageProvider].map(provider => ({ provider: provider.getModel().provider, id: "test" })),
          availableModels: [], commit() {}, rollback() {} };
      },
      currentAvailableModels: () => [],
    },
  });
  await live.start();
  const events: ConfigurationEvent[] = [];
  live.subscribe(event => events.push(event));
  const sessions: AgentSession[] = [];
  const bindings: AgentRuntimeBinding[] = [];
  const reloads: Array<{ mock: { calls: unknown[][] } }> = [];
  const common = {
    agentDir,
    createSessionManager: (path: string) => pi.SessionManager.create(path, join(root, "sessions")),
    openSessionManager: (path: string) => pi.SessionManager.open(path, join(root, "sessions")),
    createSettingsManager: (path: string) => pi.SettingsManager.create(path, agentDir),
    createModelRuntime: async () => {
      const runtime = await pi.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
        modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
      for (const provider of [mainProvider, stageProvider]) runtime.registerNativeProvider(provider.provider);
      return runtime;
    },
    createResourceLoader: (input: Parameters<PiRuntimeDependencies["createResourceLoader"]>[0]) => new pi.DefaultResourceLoader({
      ...input as ConstructorParameters<typeof pi.DefaultResourceLoader>[0], noContextFiles: true, noPromptTemplates: true, noThemes: true,
    }),
    createAgentSession: async (input: Record<string, unknown>) => {
      const result = await pi.createAgentSession(input as Parameters<typeof pi.createAgentSession>[0]);
      sessions.push(result.session);
      reloads.push(vi.spyOn(result.session, "reload"));
      return result;
    },
    resolveAutomaticModel: async () => mainProvider.getModel(),
    createExtensionFactories: ({ binding }: { binding: AgentRuntimeBinding }) => {
      bindings.push(binding);
      return [{ name: "agent-definition", factory: createAgentDefinitionExtension(binding) }];
    },
  };
  const launchStage = createStageSessionLauncher({
    ...common, createDirectChildSupervisor: (coordinator, launch) => new SubagentSupervisor({ coordinator, launchStage: launch }),
  } as StageSessionDependencies);
  const creator = createPiAgentSessionCreator({
    ...common, liveConfiguration: live,
    createCoordinator: manager => new SubagentCoordinator(manager), recoverSubagentTree: async () => {},
    createDirectChildSupervisor: coordinator => new SubagentSupervisor({ coordinator, launchStage }),
  } as PiRuntimeDependencies);
  const adapter = new PiSessionFactory(creator, pi.estimateTokens).create({ cwd });
  let stage: StageLaunchHandle | undefined;
  return {
    ai, mainProvider, stageProvider, settings, live, events, adapter, sessions, bindings, reloads,
    async launch() {
      const rows = await live.resolveAgents(cwd);
      const agent = rows.find(row => row.name === "custom")!;
      const manager = common.createSessionManager(cwd);
      const coordinator = new SubagentCoordinator(manager);
      const reservation = coordinator.reserveDispatch({ ownerSessionId: manager.getSessionId(), toolCallId: "stage",
        requested: agent.name, catalog: { all: rows, available: [agent] } });
      stage = await launchStage({ reservation, agent, callerAgent: "research-assistant", task: "Use both tools.", cwd, coordinator, liveConfiguration: live });
      coordinator.recordMaterialized(reservation, { childSessionId: stage.childSessionId, sessionPath: stage.sessionPath });
      coordinator.recordLaunchAcknowledged(reservation.launchId);
      return stage;
    },
    async close() { try { await stage?.dispose(); } finally { try { await adapter.stop(); } finally { await live.close(); } } },
  };
}

describe("real native Tool diagnostics and shared Skill/Tool generation", () => {
  it.each([false, true])("projects native hidden withdrawal at the same generation without reloading (strict main: %s)", async strict => {
    const names = ["withdrawable_fixture", "initially_hidden_fixture", "model_only_fixture", "codemode_fixture", "deferred_fixture"];
    write(join(agentDir, "extensions", "exposure.ts"), extension(`
      const register = (name, exposure) => api.registerTool({name, exposure, label:"Exposure", description:"Unchanged metadata",
        parameters:Type.Object({}), execute:async()=>({content:[{type:"text",text:name}],details:{}})});
      register("withdrawable_fixture", "direct");
      register("initially_hidden_fixture", "hidden");
      register("model_only_fixture", "model-only");
      register("codemode_fixture", "codemode");
      register("deferred_fixture", "deferred");
      api.registerCommand("withdraw_fixture", {description:"Withdraw", handler:async()=>{
        register("withdrawable_fixture", "hidden");
        api.setActiveTools([...api.getActiveTools(), "withdrawable_fixture", "initially_hidden_fixture"]);
      }});
    `));
    if (strict) write(join(agentDir, "agents", "research-assistant.md"),
      `---\nname: research-assistant\ndescription: Fixture\ntools: ${JSON.stringify(["read", ...names])}\n---\nFixture.`);
    const h = await harness();
    try {
      await h.adapter.start();
      const native = h.sessions[0]!;
      expect(native.getAllTools().find(item => item.name === "initially_hidden_fixture")?.exposure).toBe("hidden");
      expect(native.getActiveToolNames()).not.toContain("initially_hidden_fixture");
      const initial = (await h.live.resolveAgents())[0]!;
      expect(initial.effectiveTools).not.toContain("initially_hidden_fixture");
      expect(initial.effectiveTools).toContain("withdrawable_fixture");
      const generation = h.live.generation, epoch = h.live.availabilityEpoch, eventStart = h.events.length;
      await native.prompt("/withdraw_fixture");
      expect(native.getAllTools().find(item => item.name === "withdrawable_fixture")?.exposure).toBe("hidden");
      expect(native.getActiveToolNames()).not.toContain("withdrawable_fixture");
      expect(native.getCallableToolNames()).not.toContain("withdrawable_fixture");
      for (const scope of [undefined, cwd]) {
        const current = (await h.live.resolveAgents(scope))[0]!;
        expect(current.effectiveTools).not.toContain("withdrawable_fixture");
        expect(current.effectiveTools).not.toContain("initially_hidden_fixture");
        expect(current.effectiveTools).toEqual(expect.arrayContaining(["model_only_fixture", "codemode_fixture", "deferred_fixture"]));
        expect(current.toolDiagnostics).toBeUndefined();
      }
      expect(native.getAllTools().filter(item => names.includes(item.name)).map(item => [item.name, item.exposure])).toEqual([
        ["withdrawable_fixture", "hidden"], ["initially_hidden_fixture", "hidden"],
        ["model_only_fixture", "model-only"], ["codemode_fixture", "codemode"], ["deferred_fixture", "deferred"],
      ]);
      expect(native.getCallableToolNames()).not.toContain("model_only_fixture");
      expect(native.getCallableToolNames()).toEqual(expect.arrayContaining(["codemode_fixture", "deferred_fixture"]));
      expect(h.live.generation).toBe(generation);
      expect(h.live.availabilityEpoch).toBe(epoch);
      expect(h.events.slice(eventStart)).toEqual([expect.objectContaining({
        toolsChanged: true, runtimeChanged: false, generation, availabilityEpoch: epoch,
      })]);
      expect(h.reloads[0]).not.toHaveBeenCalled();
    } finally { await h.close(); }
  }, 30_000);

  it("isolates dependency/syntax/factory failures, distinguishes loaded registration conflicts, and keeps invocation errors in chat", async () => {
    const extensions = join(agentDir, "extensions");
    const missing = join(extensions, "missing.ts"), syntax = join(extensions, "syntax.ts"), factory = join(extensions, "factory.ts");
    write(missing, 'import "certainly-missing-tool-diagnostic-fixture"; export default () => {};');
    write(syntax, "export default function(api: {");
    write(factory, extension(`${tool("discarded_first", '"first"')}${tool("discarded_second", '"second"')}throw new Error("PRIVATE_FACTORY");`));
    write(join(extensions, "healthy.ts"), extension(`${tool("healthy", '"HEALTHY"')}api.registerTool({
      name:"execution_error",label:"Error",description:"Execution only",parameters:Type.Object({}),execute:async()=>{throw new Error("EXECUTION_ONLY");}});`));
    for (const name of ["first", "second"]) write(join(extensions, `${name}.ts`), extension(
      `${tool("collision", JSON.stringify(name))}${tool(`unique_${name}`, JSON.stringify(name))}`,
    ));
    const h = await harness();
    try {
      await h.adapter.start();
      const native = h.sessions[0]!;
      const inventory = (await h.live.resolveAgents())[0]!;
      expect(inventory.toolDiagnostics?.filter(item => item.kind === "load").map(item => item.path).sort()).toEqual([missing, syntax, factory].sort());
      const registration = inventory.toolDiagnostics?.filter(item => item.kind === "registration") ?? [];
      expect(registration).toHaveLength(1);
      expect(native.resourceLoader.getExtensions().extensions.map(item => item.path)).toContain(registration[0]!.path);
      expect(inventory.effectiveTools).toEqual(expect.arrayContaining(["healthy", "execution_error", "unique_first", "unique_second"]));
      expect(inventory.effectiveTools).not.toContain("discarded_first");
      expect(inventory.effectiveTools).not.toContain("discarded_second");
      expect(JSON.stringify(inventory)).not.toContain("PRIVATE_FACTORY");
      const generation = h.live.generation, epoch = h.live.availabilityEpoch;
      const tools = ["execution_error", "healthy", "unique_first", "unique_second"];
      h.mainProvider.setResponses([
        ...tools.map(name => h.ai.fauxAssistantMessage(h.ai.fauxToolCall(name, {}), { stopReason: "toolUse" })),
        h.ai.fauxAssistantMessage("done"),
      ]);
      await h.adapter.prompt("Exercise all healthy registrations, with one execution failure.");
      await vi.waitFor(() => expect(h.adapter.hasBackgroundWork()).toBe(false));
      const results = native.messages.filter(message => message.role === "toolResult");
      expect(results.map(message => [message.toolName, message.isError])).toEqual(tools.map((name, index) => [name, index === 0]));
      expect(JSON.stringify(results)).toContain("HEALTHY");
      expect((await h.live.resolveAgents())[0]!.toolDiagnostics).toEqual(inventory.toolDiagnostics);
      expect(h.live.generation).toBe(generation);
      expect(h.live.availabilityEpoch).toBe(epoch);
      expect(h.reloads[0]).not.toHaveBeenCalled();
      // Remove the root's inventory so only the production stage snapshot can supply diagnostics.
      await h.adapter.stop();
      h.stageProvider.setResponses([h.ai.fauxAssistantMessage("stage complete")]);
      const stage = await h.launch();
      await stage.completion;
      expect((await h.live.resolveAgents())[0]!.toolDiagnostics).toEqual(inventory.toolDiagnostics);
    } finally { await h.close(); }
  }, 30_000);

  it("retains busy root/stage Skills and helper implementations, applies both at settlement, and never reloads for inventory-only events", async () => {
    const projectBase = join(cwd, ".easyresearch");
    const commonGlobal = skill(agentDir, "common"), globalOnly = skill(agentDir, "global-only");
    skill(projectBase, "common"); skill(projectBase, "project-only");
    for (const [base, name, version] of [[agentDir, "global_fixture", "v1"], [projectBase, "project_fixture", "p1"]]) {
      write(join(base!, "extensions", "fixture", "helper.ts"), `export const version = ${JSON.stringify(version)};`);
      write(join(base!, "extensions", "fixture", "index.ts"),
        `import { Type } from "typebox"; import { version } from "./helper.ts"; export default api => { ${tool(name!, "version")} };`);
    }
    const h = await harness();
    const rootStarted = Promise.withResolvers<void>(), stageStarted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const responses = (started: typeof rootStarted) => [
      async () => { started.resolve(); await release.promise; return h.ai.fauxAssistantMessage(h.ai.fauxToolCall("global_fixture", {}), { stopReason: "toolUse" }); },
      h.ai.fauxAssistantMessage(h.ai.fauxToolCall("project_fixture", {}), { stopReason: "toolUse" }),
      h.ai.fauxAssistantMessage("done"),
    ];
    h.mainProvider.setResponses(responses(rootStarted));
    h.stageProvider.setResponses(responses(stageStarted));
    const skills = (session: AgentSession) => session.resourceLoader.getSkills().skills.map(item => item.name).sort();
    try {
      await h.adapter.start();
      await h.adapter.prompt("Use both tools.");
      await rootStarted.promise;
      const stage = await h.launch();
      await stageStarted.promise;
      const generation = h.live.generation, epoch = h.live.availabilityEpoch;
      for (const session of h.sessions) expect(skills(session)).toEqual(["common", "global-only", "project-only"]);
      write(join(agentDir, "settings.json"), JSON.stringify({ ...h.settings, skills: [`-${commonGlobal}`, `-${globalOnly}`] }));
      write(join(projectBase, "settings.json"), '{"skills":["-skills/project-only"]}');
      write(join(agentDir, "extensions", "fixture", "helper.ts"), 'export const version = "v2";');
      write(join(projectBase, "extensions", "fixture", "helper.ts"), 'export const version = "p2";');
      await h.live.synchronize({ projectCwds: [cwd] });
      const pending = h.live.generation;
      expect(pending).toBe(generation + 1);
      expect(h.live.availabilityEpoch).toBe(epoch);
      for (const binding of h.bindings) expect(binding.generation()).toBe(generation);
      for (const session of h.sessions) {
        expect(skills(session)).toEqual(["common", "global-only", "project-only"]);
        expect(session.getAllTools().find(item => item.name === "global_fixture")?.description).toBe("v1");
      }
      expect((await h.live.resolveAgents(cwd))[0]!.effectiveSkills).toEqual(["common"]);
      expect((await h.live.resolveAgents())[0]!.effectiveSkills).toEqual([]);
      expect((await h.live.resolveAgents())[0]!.effectiveTools).not.toContain("project_fixture");
      release.resolve();
      await stage.completion;
      await vi.waitFor(() => expect(h.adapter.hasBackgroundWork()).toBe(false));
      await Promise.all(h.bindings.map(binding => binding.ensureCurrent()));
      for (const session of h.sessions) {
        const results = session.messages.filter(message => message.role === "toolResult");
        expect(results.map(message => message.content)).toEqual([
          [{ type: "text", text: "v1" }], [{ type: "text", text: "p1" }],
        ]);
        expect(skills(session)).toEqual(["common"]);
        expect(session.getAllTools().find(item => item.name === "global_fixture")?.description).toBe("v2");
        expect(session.getAllTools().find(item => item.name === "project_fixture")?.description).toBe("p2");
      }
      for (const binding of h.bindings) expect(binding.generation()).toBe(pending);
      for (const reload of h.reloads) expect(reload).toHaveBeenCalledOnce();
      for (const provider of [h.mainProvider, h.stageProvider]) provider.setResponses([
        h.ai.fauxAssistantMessage(h.ai.fauxToolCall("global_fixture", {}), { stopReason: "toolUse" }),
        h.ai.fauxAssistantMessage(h.ai.fauxToolCall("project_fixture", {}), { stopReason: "toolUse" }),
        h.ai.fauxAssistantMessage("updated"),
      ]);
      await h.adapter.prompt("Use the updated tools.");
      await h.sessions[1]!.prompt("Use the updated tools.");
      await vi.waitFor(() => expect(h.adapter.hasBackgroundWork()).toBe(false));
      for (const session of h.sessions) expect(session.messages.filter(message => message.role === "toolResult").slice(-2)
        .map(message => message.content)).toEqual([[{ type: "text", text: "v2" }], [{ type: "text", text: "p2" }]]);
      const eventStart = h.events.length;
      const owner = {};
      h.live.updateRuntimeTools?.(owner, { cwd, agentName: "research-assistant", generation: pending,
        tools: [{ name: "observed", sourceInfo: { path: join(agentDir, "extensions", "observed.ts"), scope: "user" } }] });
      await Promise.all(h.bindings.map(binding => binding.ensureCurrent()));
      h.live.updateRuntimeTools?.(owner, undefined);
      expect(h.events.slice(eventStart)).toHaveLength(2);
      for (const event of h.events.slice(eventStart)) expect(event).toMatchObject({
        toolsChanged: true, runtimeChanged: false, generation: pending, availabilityEpoch: epoch,
      });
      for (const reload of h.reloads) expect(reload).toHaveBeenCalledOnce();
    } finally { release.resolve(); await h.close(); }
  }, 30_000);
});
