import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { importPi } from "./pi-import";

describe("Pi platform shell exclusion", () => {
  it.each([
    ["bash", "powershell"],
    ["powershell", "bash"],
  ] as const)(
    "keeps %s absent and %s available through extension loading and reload",
    async (excluded, available) => {
      const root = mkdtempSync(join(tmpdir(), "easyresearch-platform-tools-"));
      const cwd = join(root, "paper");
      const agentDir = join(root, "agent");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      const pi = await importPi();
      const settingsManager = pi.SettingsManager.inMemory();
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        extensionFactories: [{
          name: "excluded-shell-test",
          factory(api) {
            api.registerTool({
              name: excluded,
              label: excluded,
              description: "Excluded shell regression tool",
              parameters: Type.Object({}),
              async execute() {
                return { content: [{ type: "text", text: "unexpected" }], details: {} };
              },
            });
          },
        }],
      });

      try {
        await resourceLoader.reload();
        const { session } = await pi.createAgentSession({
          cwd,
          agentDir,
          settingsManager,
          sessionManager: pi.SessionManager.inMemory(cwd),
          resourceLoader,
          tools: ["bash", "powershell"],
          excludeTools: [excluded],
        });
        try {
          await session.bindExtensions({ mode: "print" });
          const expectShellPolicy = () => {
            const allTools = session.getAllTools().map(({ name }) => name);
            expect(allTools).not.toContain(excluded);
            expect(allTools).toContain(available);
            const activeTools = session.getActiveToolNames();
            expect(activeTools).not.toContain(excluded);
            expect(activeTools).toContain(available);
          };

          expectShellPolicy();
          session.setActiveToolsByName(["bash", "powershell"]);
          expectShellPolicy();
          await session.reload();
          expectShellPolicy();
        } finally {
          session.dispose();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps historical Windows bash rows unchanged while the next turn exposes only powershell", async () => {
    const root = mkdtempSync(join(tmpdir(), "easyresearch-historical-windows-shell-"));
    const cwd = join(root, "paper");
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");

    let session: Awaited<ReturnType<Awaited<ReturnType<typeof importPi>>["createAgentSession"]>>["session"] | undefined;
    let failure: unknown;
    let failed = false;
    try {
      mkdirSync(cwd, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(sessionDir, { recursive: true });
      const pi = await importPi();
      const { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider } = await import(
        "@earendil-works/pi-ai"
      );
      const historicalToolCallId = "historical-bash-call";
      const manager = pi.SessionManager.create(cwd, sessionDir);
      manager.appendMessage({
        role: "user",
        content: "inspect the historical workspace",
        timestamp: 1,
      });
      manager.appendMessage({
        role: "assistant",
        content: [{
          type: "toolCall",
          id: historicalToolCallId,
          name: "bash",
          arguments: { command: "pwd" },
        }],
        api: "faux",
        provider: "historical-provider",
        model: "historical-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      });
      manager.appendMessage({
        role: "toolResult",
        toolCallId: historicalToolCallId,
        toolName: "bash",
        content: [{ type: "text", text: "C:\\paper" }],
        isError: false,
        timestamp: 3,
      });
      const sessionPath = manager.getSessionFile();
      if (!sessionPath) throw new Error("persistent historical session had no physical path");
      const originalBytes = readFileSync(sessionPath);

      const reopened = pi.SessionManager.open(sessionPath, sessionDir);
      expect(reopened.getSessionFile()).toBe(sessionPath);
      expect(reopened.buildSessionContext().messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({
            type: "toolCall",
            id: historicalToolCallId,
            name: "bash",
          })],
        }),
        expect.objectContaining({
          role: "toolResult",
          toolCallId: historicalToolCallId,
          toolName: "bash",
        }),
      ]));

      const providerRequests: Array<{
        tools: string[];
        messages: Array<{
          role: string;
          content?: unknown;
          toolCallId?: string;
          toolName?: string;
        }>;
      }> = [];
      const provider = fauxProvider({
        provider: "current-provider",
        models: [{ id: "current-model", name: "Current Model" }],
      });
      provider.setResponses([
        (context) => {
          providerRequests.push({
            tools: context.tools?.map(({ name }) => name) ?? [],
            messages: structuredClone(context.messages),
          });
          return fauxAssistantMessage("continued with the current Windows shell");
        },
      ]);
      const modelRuntime = await pi.ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider(provider.provider);
      const settingsManager = pi.SettingsManager.inMemory();
      const resourceLoader = new pi.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();
      const created = await pi.createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager,
        sessionManager: reopened,
        resourceLoader,
        model: provider.getModel(),
        thinkingLevel: "off",
        tools: ["bash", "powershell"],
        excludeTools: ["bash"],
      });
      session = created.session;

      expect(session.getAllTools().map(({ name }) => name)).toEqual(["powershell"]);
      expect(session.getActiveToolNames()).toEqual(["powershell"]);

      await session.prompt("continue this session");

      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]?.tools).toEqual(["powershell"]);
      expect(providerRequests[0]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({ name: "bash" })],
        }),
        expect.objectContaining({
          role: "toolResult",
          toolCallId: historicalToolCallId,
          toolName: "bash",
        }),
      ]));
      const finalBytes = readFileSync(sessionPath);
      expect(finalBytes.length).toBeGreaterThan(originalBytes.length);
      expect(finalBytes.subarray(0, originalBytes.length).equals(originalBytes)).toBe(true);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        session?.dispose();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    if (failed) throw failure;
  });
});
