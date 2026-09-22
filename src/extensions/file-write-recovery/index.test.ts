import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importPi } from "../../runtime/pi-import";
import { createProviderTimeoutExtension } from "../provider-timeout";
import { createFileWriteRecoveryExtension } from ".";

async function fixture(global = {}, project = {}) {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-write-recovery-"));
  const cwd = join(root, "paper");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".easyresearch"), { recursive: true });
  mkdirSync(agentDir);
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".easyresearch", "settings.json");
  writeFileSync(globalPath, JSON.stringify({ compaction: { enabled: false }, ...global }));
  writeFileSync(projectPath, JSON.stringify(project));
  const before = [readFileSync(globalPath, "utf8"), readFileSync(projectPath, "utf8")];
  const pi = await importPi();
  const { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
  const provider = fauxProvider({ provider: "write-recovery-fixture", models: [{ id: "slow-local" }] });
  const runtime = await pi.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(provider.provider);
  const settings = pi.SettingsManager.create(cwd, agentDir);
  settings.setProjectTrusted(true);
  const loader = new pi.DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      { name: "provider-timeout", factory: createProviderTimeoutExtension(settings) },
      { name: "file-write-recovery", factory: createFileWriteRecoveryExtension() },
    ],
  });
  await loader.reload();
  const { session } = await pi.createAgentSession({
    cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime: runtime,
    sessionManager: pi.SessionManager.inMemory(cwd), model: provider.getModel(), thinkingLevel: "off", tools: ["write"],
  });
  await session.bindExtensions({ mode: "print" });
  return {
    cwd, settings, session, provider, fauxAssistantMessage,
    assertUnchanged: () => expect([readFileSync(globalPath, "utf8"), readFileSync(projectPath, "utf8")]).toEqual(before),
    close: () => { session.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
}

describe("slow-provider and failed-write recovery through Pi", () => {
  it.each([
    ["EACCES: permission denied", /permissions/, /one smaller section/],
    ["ENOSPC: no space left on device", /disk space/, /one smaller section/],
    ["Operation aborted", /Do not automatically restart/, /one smaller section/],
    ["EISDIR: illegal operation on a directory", /parent directories/, /one smaller section/],
    ["Request timed out", /smaller section/, /disk space/],
    ["Unexpected filesystem error", /original error/, /one smaller section/],
  ])("preserves the original %s result and adds only relevant advice once", async (text, expected, absent) => {
    const handlers = new Map<string, (event: any) => any>();
    await createFileWriteRecoveryExtension()({ on: (name: string, handler: (event: any) => any) => handlers.set(name, handler) } as never);
    const event = { toolName: "write", toolCallId: "t", content: [{ type: "text", text }], isError: true, details: { original: true } };
    const original = structuredClone(event);
    const patch = handlers.get("tool_result")!(event);
    expect(event).toEqual(original);
    expect(patch.content[0]).toEqual(original.content[0]);
    expect(patch.content[1].text).toMatch(expected);
    expect(patch.content[1].text).not.toMatch(absent);
    expect(patch.isError).toBeUndefined();
    expect(patch.details).toBeUndefined();
    expect(handlers.get("tool_result")!({ ...event, ...patch })).toBeUndefined();
    expect(handlers.get("tool_result")!({ ...event, toolName: "read" })).toBeUndefined();
    expect(handlers.get("context")!({ messages: [{ ...event, ...patch, role: "toolResult" }] })).toBeUndefined();
  });

  it("does not mistake rejected document prose for a disk error or recovery marker", async () => {
    const handlers = new Map<string, (event: any) => any>();
    await createFileWriteRecoveryExtension()({ on: (name: string, handler: (event: any) => any) => handlers.set(name, handler) } as never);
    const message = { role: "toolResult", toolName: "write", toolCallId: "t", isError: true,
      content: [{ type: "text", text: 'Validation failed for tool "write":\n  - path: required\n\nReceived arguments:\n{"content":"ENOSPC Write recovery: quoted example"}' }] };
    const context = { messages: [message] };
    const original = structuredClone(context);
    const result = handlers.get("context")!(context);
    expect(result.messages[0].content[1].text).toContain("smaller section");
    expect(context).toEqual(original);
  });

  it("never fabricates write results for interrupted provider calls", async () => {
    const f = await fixture({ retry: { enabled: false } });
    try {
      f.provider.setResponses([f.fauxAssistantMessage([
        { type: "text", text: "Now I will write the report." },
        { type: "toolCall", id: "partial", name: "write", arguments: { path: "report.md", content: "partial" } },
      ], { stopReason: "error", errorMessage: "Stream ended without finish_reason" })]);
      await f.session.prompt("write report");
      expect(f.session.messages.filter(m => m.role === "toolResult")).toEqual([]);
      expect(f.session.messages.at(-1)).toMatchObject({ stopReason: "error", errorMessage: "Stream ended without finish_reason" });
    } finally { f.close(); }
  });

  it.each([
    [{}, {}, 3_600_000],
    [{ retry: { provider: { timeoutMs: 900_000 } } }, {}, 900_000],
    [{ retry: { provider: { timeoutMs: 900_000 } } }, { retry: { provider: { timeoutMs: 420_000 } } }, 420_000],
    [{ httpIdleTimeoutMs: 480_000 }, {}, 480_000],
    [{}, { httpIdleTimeoutMs: 0 }, 2_147_483_647],
    [{ retry: { provider: { timeoutMs: 0 } } }, {}, 0],
  ])("passes effective timeout to the provider before and after reload (%j, %j)", async (global, project, expected) => {
    const f = await fixture(global, project);
    try {
      const timeouts: unknown[] = [];
      const response = (_context: unknown, options: { timeoutMs?: number } | undefined) => {
        timeouts.push(options?.timeoutMs);
        return f.fauxAssistantMessage("done");
      };
      f.provider.setResponses([response, response]);
      await f.session.prompt("first");
      await f.session.reload();
      await f.session.prompt("after reload");
      expect(timeouts).toEqual([expected, expected]);
      f.assertUnchanged();
    } finally { f.close(); }
  });

  it.each(["invalid", "truncated", "filesystem"] as const)("gives the next model actionable %s write recovery without losing successful sections", async (failure) => {
    const f = await fixture();
    try {
      writeFileSync(join(f.cwd, "section-01.md"), "confirmed first section\n");
      let observed = "";
      const args = failure === "invalid" ? { path: "section-02.md" } :
        { path: failure === "filesystem" ? "section-01.md/child.md" : "section-02.md", content: "incomplete" };
      f.provider.setResponses([
        f.fauxAssistantMessage([
          { type: "toolCall", id: "write-fail", name: "write", arguments: args },
        ], { stopReason: failure === "truncated" ? "length" : "toolUse" }),
        (context) => {
          const result = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "write-fail");
          expect(result).toMatchObject({ isError: true });
          observed = JSON.stringify(result?.content);
          return f.fauxAssistantMessage("recover from the confirmed sections");
        },
      ]);
      await f.session.prompt("finish the report");
      expect(observed).toContain("Write recovery:");
      expect(observed).toMatch(failure === "filesystem" ? /path|directory/i : /smaller|section/i);
      expect(readFileSync(join(f.cwd, "section-01.md"), "utf8")).toBe("confirmed first section\n");
      const stored = f.session.messages.find((m) => m.role === "toolResult");
      expect(stored).toMatchObject({ isError: true });
    } finally { f.close(); }
  });

  it("keeps successful write results free of error advice", async () => {
    const f = await fixture();
    try {
      f.provider.setResponses([
        f.fauxAssistantMessage([{ type: "toolCall", id: "ok", name: "write", arguments: { path: "section.md", content: "complete section" } }], { stopReason: "toolUse" }),
        (context) => {
          const result = context.messages.find((m) => m.role === "toolResult");
          expect(result).toMatchObject({ isError: false });
          expect(JSON.stringify(result)).not.toContain("Write recovery:");
          return f.fauxAssistantMessage("done");
        },
      ]);
      await f.session.prompt("write section");
      expect(readFileSync(join(f.cwd, "section.md"), "utf8")).toBe("complete section");
    } finally { f.close(); }
  });
});
