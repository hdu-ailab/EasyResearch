import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
});
