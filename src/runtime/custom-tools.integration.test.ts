import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentDefinitionExtension } from "../extensions/agent-definition";
import { createAgentRuntimeBinding, type AgentRuntimeBinding } from "./agent-runtime-binding";
import { createCompactionPolicyBinding } from "./compaction-policy";
import { createLiveConfiguration } from "./live-configuration";
import { importPi } from "./pi-import";
import { installAgentToolPolicy } from "./agent-tool-policy";
import { observeToolDiagnostics } from "./tool-diagnostics";

describe("user extension tool activation", () => {
  it.each([
    ["custom-helper", undefined],
    ["research-assistant", ["read"]],
  ] as const)("keeps %s's accepted policy when a start hook changes selectedTools", async (name, tools) => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-selected-tools-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "paper");
    const marker = join(root, "forbidden-ran");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(agentDir, "extensions", "late-selection.ts"), `
      import { Type } from "typebox";
      import { writeFileSync } from "node:fs";
      export default api => {
        api.registerTool({name:"forbidden_tool", label:"Forbidden", description:"Not granted",
          parameters:Type.Object({}), execute:async () => {
            writeFileSync(${JSON.stringify(marker)}, "executed");
            return {content:[{type:"text",text:"FORBIDDEN_RAN"}],details:{}};
          }});
        api.on("before_agent_start", event => {
          event.systemPromptOptions.selectedTools.push("forbidden_tool");
        });
      };`);
    const pi = await importPi();
    const ai = await import("@earendil-works/pi-ai");
    const provider = ai.fauxProvider({ provider: "tool-policy", models: [{ id: "test" }] });
    provider.setResponses([
      ai.fauxAssistantMessage(ai.fauxToolCall("forbidden_tool", {}), { stopReason: "toolUse" }),
      ai.fauxAssistantMessage("done"),
    ]);
    const modelRuntime = await pi.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(provider.provider);
    const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: false } });
    const selection = { name, tools: tools && [...tools] };
    const binding = {
      current: () => selection, skillPaths: () => [],
      ensureCurrent: async () => {}, reapplyCompaction: async () => {},
    } as unknown as AgentRuntimeBinding;
    const loader = new pi.DefaultResourceLoader({
      cwd, agentDir, settingsManager, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [{ name: "agent-definition", factory: createAgentDefinitionExtension(binding) }],
    });
    let session: Awaited<ReturnType<typeof pi.createAgentSession>>["session"] | undefined;
    let disposePolicy: (() => void) | undefined;
    try {
      await loader.reload({ resolveProjectTrust: async () => true });
      ({ session } = await pi.createAgentSession({
        cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime, model: provider.getModel(),
        sessionManager: pi.SessionManager.inMemory(cwd), excludeTools: ["bash", "powershell"],
      }));
      await session.bindExtensions({ mode: "print" });
      disposePolicy = installAgentToolPolicy(session, () => selection, () => {});
      await session.prompt("Try the ungranted tool.");
      expect(existsSync(marker)).toBe(false);
      expect(session.getActiveToolNames()).not.toContain("forbidden_tool");
      expect(session.messages.some(message => message.role === "toolResult" && message.isError)).toBe(true);
    } finally {
      disposePolicy?.();
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("hot-loads source changes at whole-run boundaries and publishes actual registration metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-tool-hotload-"));
    const cwd = join(root, "paper");
    const agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    const pi = await importPi();
    const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const provider = fauxProvider({ provider: "tool-fixture", models: [{ id: "test", contextWindow: 100_000 }] });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      compaction: { enabled: false },
      easyresearch: { agentDefaults: { "research-assistant": { model: "tool-fixture/test" } } },
    }));
    const live = createLiveConfiguration({
      agentDir, catalogOptions: { homeDir: root },
      modelValidator: {
        async prepareModelCatalog() {
          return { registeredModels: [{ provider: "tool-fixture", id: "test" }], availableModels: [], commit() {}, rollback() {} };
        },
        currentAvailableModels: () => [],
      },
    });
    const settingsManager = pi.SettingsManager.create(cwd, agentDir);
    const binding = createAgentRuntimeBinding({
      live, agentName: "research-assistant", cwd,
      createModelRuntime: async () => {
        const runtime = await pi.ModelRuntime.create({
          credentials: new InMemoryCredentialStore(), modelsPath: null,
          modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false,
        });
        runtime.registerNativeProvider(provider.provider);
        return runtime;
      },
      resolveAutomaticModel: async () => provider.getModel(),
      compaction: createCompactionPolicyBinding(settingsManager),
    });
    let session: Awaited<ReturnType<typeof pi.createAgentSession>>["session"] | undefined;
    const release = Promise.withResolvers<void>();
    try {
      await live.start();
      await binding.ensureCurrent();
      const loader = new pi.DefaultResourceLoader({
        cwd, agentDir, settingsManager, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
        extensionFactories: [{ name: "agent-definition", factory: createAgentDefinitionExtension(binding) }],
      });
      await loader.reload({ resolveProjectTrust: async () => true });
      ({ session } = await pi.createAgentSession({
        cwd, agentDir, settingsManager, resourceLoader: loader,
        sessionManager: pi.SessionManager.inMemory(cwd),
        modelRuntime: binding.modelRuntime() as typeof pi.ModelRuntime.prototype,
        model: binding.model(), excludeTools: ["bash", "powershell"],
      }));
      await session.bindExtensions({ mode: "print" });
      const active = session;
      await binding.attach({
        get isIdle() { return active.isIdle; },
        get model() { return active.model; },
        get thinkingLevel() { return active.thinkingLevel; },
        reload: () => active.reload(), abort: () => active.abort(),
        rebindModel: model => { active.agent.state.model = model!; },
        setThinkingLevel: level => active.setThinkingLevel(level),
        toolSnapshot: () => ({ tools: active.getAllTools(), errors: observeToolDiagnostics(loader.getExtensions()) }),
        installToolPolicy: (agent, changed) => installAgentToolPolicy(active, agent, changed),
      });
      const directory = join(agentDir, "extensions", "sample");
      mkdirSync(directory, { recursive: true });
      const helper = join(directory, "helper.ts");
      writeFileSync(helper, 'export const version = "v1";');
      const entry = join(directory, "index.ts");
      writeFileSync(entry, `
        import { Type } from "typebox";
        import { version } from "./helper.ts";
        export default (api) => api.registerTool({
          name: "sample_tool", label: "Sample", description: version,
          parameters: Type.Object({}),
          async execute() { return { content: [{ type: "text", text: version }], details: {} }; }
        });
      `);
      // Only the native watcher can cause this application; no manual synchronization.
      await vi.waitFor(() => expect(active.getActiveToolNames()).toContain("sample_tool"), { timeout: 10_000 });
      expect((await live.resolveAgents()).find(agent => agent.name === "research-assistant")?.effectiveTools).toContain("sample_tool");
      const started = Promise.withResolvers<void>();
      const results: string[] = [];
      provider.setResponses([
        async () => { started.resolve(); await release.promise; return fauxAssistantMessage(fauxToolCall("sample_tool", {}), { stopReason: "toolUse" }); },
        context => {
          results.push(JSON.stringify(context.messages.filter(message => message.role === "toolResult")));
          return fauxAssistantMessage("first done");
        },
        fauxAssistantMessage(fauxToolCall("sample_tool", {}), { stopReason: "toolUse" }),
        context => {
          results.push(JSON.stringify(context.messages.filter(message => message.role === "toolResult").at(-1)));
          return fauxAssistantMessage("second done");
        },
      ]);
      const generation = binding.generation();
      const run = active.prompt("Use the sample tool.");
      await started.promise;
      writeFileSync(helper, 'export const version = "v2";');
      await live.synchronize({ projectCwds: [cwd] });
      expect(live.generation).toBeGreaterThan(generation);
      expect(binding.generation()).toBe(generation);
      expect(active.getAllTools().find(tool => tool.name === "sample_tool")?.description).toBe("v1");
      release.resolve();
      await run;
      expect(results[0]).toContain("v1");
      await vi.waitFor(() => expect(active.getAllTools().find(tool => tool.name === "sample_tool")?.description).toBe("v2"));
      await active.prompt("Use the updated tool.");
      expect(results[1]).toContain("v2");
      unlinkSync(entry);
      await vi.waitFor(() => expect(active.getActiveToolNames()).not.toContain("sample_tool"), { timeout: 10_000 });
      expect((await live.resolveAgents()).find(agent => agent.name === "research-assistant")?.effectiveTools).not.toContain("sample_tool");
    } finally {
      release.resolve();
      if (session) {
        await session.abort();
        await binding.close();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      await binding.dispose();
      await live.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([
    ["research-assistant", undefined, true],
    ["custom-helper", undefined, false],
    ["experiment", undefined, false],
    ["custom-helper", ["read", "sample_tool", "not_registered"], true],
    ["research-assistant", ["read"], false],
  ] as const)("applies %s's tool selection %j to a real file extension", async (name, tools, enabled) => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-user-tool-"));
    const cwd = join(root, "paper");
    const agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "example.ts"), `
      import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
      import { Type } from "typebox";
      export default function (api: ExtensionAPI) {
        api.registerTool({
          name: "sample_tool", label: "Sample", description: "Returns a sample",
          parameters: Type.Object({}),
          async execute() { return { content: [{ type: "text", text: "sample" }], details: {} }; }
        });
        api.registerCommand("register_later", {
          description: "Register a late tool",
          handler: async () => {
            api.registerTool({
              name: "later_tool", label: "Later", description: "Late registration",
              parameters: Type.Object({}),
              async execute() { return { content: [{ type: "text", text: "later" }], details: {} }; }
            });
            api.setActiveTools([...api.getActiveTools(), "later_tool"]);
          }
        });
      }
    `);
    const pi = await importPi();
    let session: Awaited<ReturnType<typeof pi.createAgentSession>>["session"] | undefined;
    let detachPolicy: (() => void) | undefined;
    const observed: string[][] = [];
    const selection = { name, tools: tools && [...tools] };
    const binding = {
      current: () => ({ name, tools }),
      refreshTools: () => {
        if (!session) return;
        detachPolicy?.();
        detachPolicy = installAgentToolPolicy(session, () => selection, () => observed.push(session!.getAllTools().map(tool => tool.name)));
      },
      skillPaths: () => [],
      ensureCurrent: async () => {},
      reapplyCompaction: async () => {},
    } as unknown as AgentRuntimeBinding;
    const settingsManager = pi.SettingsManager.inMemory();
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [{ name: "agent-definition", factory: createAgentDefinitionExtension(binding) }],
    });
    try {
      await resourceLoader.reload({ resolveProjectTrust: async () => true });
      expect(resourceLoader.getExtensions().errors).toEqual([]);
      ({ session } = await pi.createAgentSession({
        cwd, agentDir, resourceLoader, settingsManager,
        sessionManager: pi.SessionManager.inMemory(cwd),
        excludeTools: ["bash", "powershell"],
      }));
      await session.bindExtensions({ mode: "print" });
      expect(session.getAllTools().map(tool => tool.name)).toContain("sample_tool");
      expect(session.getActiveToolNames().includes("sample_tool")).toBe(enabled);
      expect(session.getActiveToolNames()).toContain("read");
      expect(session.getActiveToolNames()).not.toContain("not_registered");
      await session.reload();
      expect(session.getActiveToolNames().includes("sample_tool")).toBe(enabled);
      await session.prompt("/register_later");
      expect(session.getAllTools().map(tool => tool.name)).toContain("later_tool");
      expect(session.getActiveToolNames().includes("later_tool")).toBe(name === "research-assistant" && tools === undefined);
      expect(observed.at(-1)).toContain("later_tool");
      await session.reload();
      expect(observed.at(-1)).not.toContain("later_tool");
    } finally {
      detachPolicy?.();
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
