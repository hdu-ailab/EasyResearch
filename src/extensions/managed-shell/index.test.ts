import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { importPi } from "../../runtime/pi-import";
import { excludedLocalShellTools } from "../../runtime/platform-tools";
import { createManagedShellManager, type ShellNotification } from "../../background/shell";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "shell-extension-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  const pi = await importPi();
  const { createManagedShellExtension } = await import("./index");
  const { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
  const provider = fauxProvider({ provider: "shell-extension-fixture", models: [{ id: "local" }] });
  const runtime = await pi.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
  runtime.registerNativeProvider(provider.provider);
  const settings = pi.SettingsManager.create(root, agentDir);
  settings.setProjectTrusted(true);
  settings.setCompactionEnabled(false);
  const sessionManager = pi.SessionManager.inMemory(root);
  const sessionID = sessionManager.getSessionId();
  const manager = createManagedShellManager({ agentDir, rootSessionID: sessionID, cwd: root, worker: false });
  const notices: ShellNotification[] = [];
  manager.attachOwner({ sessionID, cwd: root, notify: async (notice) => { notices.push(notice); } });
  const loader = new pi.DefaultResourceLoader({
    cwd: root, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "managed-shell", factory: createManagedShellExtension({ manager, owner: () => ({ sessionID, cwd: root }) }) }],
  });
  await loader.reload();
  const { session } = await pi.createAgentSession({
    cwd: root, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime: runtime,
    sessionManager, model: provider.getModel(), thinkingLevel: "off", tools: ["shell"], excludeTools: excludedLocalShellTools(process.platform),
  });
  await session.bindExtensions({ mode: "print" });
  return { session, sessionManager, sessionID, root, agentDir, provider, fauxAssistantMessage, manager, notices,
    async close() { await manager.dispose(); session.dispose(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); },
  };
}

describe("managed shell through native Pi", () => {
  it("binds reused tool-call IDs to the exact valid assistant entry, beyond a prior batch result", async () => {
    const f = await fixture();
    let recovered: ReturnType<typeof createManagedShellManager> | undefined;
    try {
      const { createManagedShellTool } = await import("./index");
      const tool = createManagedShellTool({ manager: f.manager, owner: () => ({ sessionID: f.sessionID, cwd: f.root }) });
      const context = { sessionManager: f.sessionManager } as unknown as ExtensionToolContext;
      const assistant = (command: string) => f.fauxAssistantMessage([{ type: "toolCall", id: "reused", name: "shell", arguments: { command } }], { stopReason: "toolUse" });
      const earlier = f.sessionManager.appendMessage(assistant("echo earlier"));
      const completed = await tool.execute("reused", { command: "echo earlier" }, undefined, undefined, context);
      f.sessionManager.appendMessage({ role: "toolResult", toolCallId: "reused", toolName: "shell", content: completed.content, isError: false, timestamp: Date.now() });
      const current = f.sessionManager.appendMessage(f.fauxAssistantMessage([
        { type: "toolCall", id: "batch-first", name: "shell", arguments: { command: "echo first" } },
        { type: "toolCall", id: "reused", name: "shell", arguments: { command: "sleep 30" } },
      ], { stopReason: "toolUse" }));
      f.sessionManager.appendMessage({ role: "toolResult", toolCallId: "batch-first", toolName: "shell", content: [{ type: "text", text: "first" }], isError: false, timestamp: Date.now() });
      f.sessionManager.appendMessage({ ...assistant("unexecuted retry"), stopReason: "error" });
      f.sessionManager.appendMessage({ ...assistant("aborted retry"), stopReason: "aborted" });
      f.sessionManager.appendMessage(f.fauxAssistantMessage([{ type: "toolCall", id: "reused", name: "read", arguments: { path: "irrelevant" } }], { stopReason: "toolUse" }));
      expect(f.sessionManager.getLeafId()).not.toBe(current);
      const abort = new AbortController();
      const running = tool.execute("reused", { command: "sleep 30" }, abort.signal, undefined, context);
      abort.abort();
      const interrupted = await running;
      expect(interrupted.details).toMatchObject({ status: "cancelled" });
      expect(interrupted.isError).toBe(true);
      expect(JSON.stringify(interrupted.content)).toContain("Command interrupted by the user (shell ID:");
      expect(interrupted.details).not.toHaveProperty("assistantEntryId");
      await f.manager.dispose();
      recovered = createManagedShellManager({ agentDir: f.agentDir, cwd: f.root, rootSessionID: f.sessionID, worker: false });
      await recovered.recover({ verifyPriorOwner: async () => true });
      expect(recovered.recoveredCalls()).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionID: f.sessionID, toolCallID: "reused", assistantEntryId: earlier, result: expect.objectContaining({ status: "completed" }) }),
        expect.objectContaining({ sessionID: f.sessionID, toolCallID: "reused", assistantEntryId: current, result: expect.objectContaining({ status: "cancelled" }) }),
      ]));
    } finally { await recovered?.dispose(); await f.close(); }
  });

  it("exposes only shell and preserves a nonzero command outcome in model context", async () => {
    const f = await fixture();
    try {
      expect(f.session.getActiveToolNames()).toEqual(["shell"]);
      expect(f.session.getAllTools().map((tool) => tool.name)).not.toContain("bash");
      expect(f.session.getAllTools().map((tool) => tool.name)).not.toContain("powershell");
      f.provider.setResponses([
        f.fauxAssistantMessage([{ type: "toolCall", id: "shell-fail", name: "shell", arguments: { command: "echo truthful; exit 7" } }], { stopReason: "toolUse" }),
        (context) => {
          const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "shell-fail");
          expect(JSON.stringify(result)).toContain("Exit code: 7");
          expect(JSON.stringify(result)).toContain("truthful");
          expect(result && "isError" in result && result.isError).toBe(false);
          return f.fauxAssistantMessage("done");
        },
      ]);
      await f.session.prompt("Run command");
      expect(f.notices).toEqual([]);
    } finally { await f.close(); }
  });
  it("keeps a background process owned across an idle extension reload", async () => {
    const f = await fixture();
    try {
      f.provider.setResponses([
        f.fauxAssistantMessage([{ type: "toolCall", id: "shell-bg", name: "shell", arguments: { command: "sleep 0.25; echo later", background: true } }], { stopReason: "toolUse" }),
        (context) => {
          const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "shell-bg");
          expect(JSON.stringify(result)).toContain("DO NOT poll");
          return f.fauxAssistantMessage("waiting for notification");
        },
      ]);
      await f.session.prompt("Run background command");
      const shellID = f.manager.tasks()[0]?.id;
      await f.session.reload();
      expect(f.manager.tasks()[0]?.id).toBe(shellID);
      await expect.poll(() => f.notices.length).toBe(1);
      expect(f.notices[0]?.content).toContain("later");
    } finally { await f.close(); }
  });
});
