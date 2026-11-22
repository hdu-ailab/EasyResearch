import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importPi } from "../../runtime/pi-import";
import { createSessionNameExtension } from "./index";
import { projectSessionUsage } from "../../web/api-usage";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-auto-title-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  vi.stubEnv("HOME", root);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  const pi = await importPi();
  const ai = await import("@earendil-works/pi-ai");
  const provider = ai.fauxProvider({ provider: "title-test", models: [{ id: "research-model" }] });
  const runtime = await pi.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(provider.provider);
  const manager = pi.SessionManager.inMemory(root);
  const settings = pi.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const titleEntered = Promise.withResolvers<void>();
  const titleRelease = Promise.withResolvers<void>();
  const cancellation = new AbortController();
  let titleResult = ai.fauxAssistantMessage('"轴承故障诊断研究"');
  const titleRequests: Array<{ model: string; text: string; tools: number; signal?: AbortSignal }> = [];
  const chatRequests: string[] = [];
  provider.setResponses(Array.from({ length: 12 }, () => async (context: Parameters<import("@earendil-works/pi-ai").FauxResponseFactory>[0], options: Parameters<import("@earendil-works/pi-ai").FauxResponseFactory>[1], _state: unknown, model: import("@earendil-works/pi-ai").Model<any>) => {
    const system = ai.getCurrentSystemPrompt(context.messages);
    if (system.includes("RESEARCH_MAIN_FIXTURE")) {
      chatRequests.push(JSON.stringify(context.messages));
      return ai.fauxAssistantMessage("研究回复");
    }
    titleRequests.push({ model: model.id, text: JSON.stringify(context.messages), tools: ai.getCurrentTools(context.messages).length, signal: options?.signal });
    titleEntered.resolve();
    await titleRelease.promise;
    return titleResult;
  }));
  const loader = new pi.DefaultResourceLoader({
    cwd: root, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "RESEARCH_MAIN_FIXTURE",
    extensionFactories: [createSessionNameExtension({ enabled: () => enabled, signal: cancellation.signal })],
  });
  await loader.reload();
  const { session } = await pi.createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: provider.getModel(), sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: "all" });
  await session.bindExtensions({ mode: "rpc" });
  const titleResultEvents: string[] = [];
  session.subscribe((event) => {
    if (event.type === "entry_appended" && event.entry.type === "custom" && event.entry.customType === "easyresearch:auto-title-result") titleResultEvents.push(event.entry.id);
  });
  cleanup.push(async () => {
    titleRelease.resolve();
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { session, manager, titleRequests, chatRequests, titleEntered, titleRelease, titleResultEvents,
    cancel: () => cancellation.abort(),
    setEnabled(value: boolean) { enabled = value; },
    setResult(text: string, error = false) { titleResult = ai.fauxAssistantMessage(text, error ? { stopReason: "error", errorMessage: "503 unavailable" } : {}); },
  };
}

describe("automatic initial session name", () => {
  it("ignores rejected preflight input and titles the first message actually accepted", async () => {
    const f = await fixture();
    const hasAuth = vi.spyOn(f.session.modelRuntime, "hasConfiguredAuth").mockReturnValueOnce(false);
    const checkAuth = vi.spyOn(f.session.modelRuntime, "checkAuth").mockRejectedValueOnce(new Error("fixture rejected preflight"));
    await expect(f.session.prompt("REJECTED FIRST TOPIC")).rejects.toThrow("fixture rejected preflight");
    hasAuth.mockRestore(); checkAuth.mockRestore();
    await f.session.prompt("ACCEPTED DIFFERENT TOPIC");
    expect(f.titleRequests).toHaveLength(1);
    expect(f.titleRequests[0]!.text).toContain("ACCEPTED DIFFERENT TOPIC");
    expect(f.titleRequests[0]!.text).not.toContain("REJECTED FIRST TOPIC");
    f.titleRelease.resolve();
  });
  it("uses the Research Assistant model once without blocking or contaminating chat", async () => {
    const f = await fixture();
    await f.session.prompt("帮我研究轴承故障诊断");
    expect(f.session.getLastAssistantText()).toBe("研究回复");
    expect(f.titleRequests).toHaveLength(1);
    expect(f.titleRequests[0]).toMatchObject({ model: "research-model", tools: 0 });
    expect(f.titleRequests[0]!.text).toContain("帮我研究轴承故障诊断");
    f.titleRelease.resolve();
    await vi.waitFor(() => expect(f.session.sessionName).toBe("轴承故障诊断研究"));
    await f.session.prompt("继续实验");
    expect(f.titleRequests).toHaveLength(1);
    expect(f.chatRequests.every((request) => !request.includes("轴承故障诊断研究"))).toBe(true);
    expect(f.manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "easyresearch:auto-title-result")).toBe(true);
    const usage = projectSessionUsage(f.session.sessionId, f.manager.getEntries(), f.manager.getBranch());
    const titleUsage = usage.inlineUsage.find((entry) => entry.source === "title")!;
    expect(f.titleResultEvents).toEqual([titleUsage.id]);
    expect(titleUsage.usage.totalTokens).toBeGreaterThan(0);
    expect(usage.models.find((entry) => entry.key === "title-test/research-model")!.totals.records).toBe(usage.direct.records);
    await f.session.reload();
    await f.session.prompt("重新载入后继续");
    expect(f.titleRequests).toHaveLength(1);
  });

  it("titles Skill context from its name and user arguments without copying the expanded body", async () => {
    const f = await fixture();
    await f.session.prompt('<skill name="paper-context" location="/fixture/SKILL.md">\nPRIVATE_SKILL_BODY\n</skill>\n\nStudy bearing diagnosis');
    expect(f.titleRequests).toHaveLength(1);
    expect(f.titleRequests[0]!.text).toContain("Study bearing diagnosis");
    expect(f.titleRequests[0]!.text).toContain("paper-context");
    expect(f.titleRequests[0]!.text).not.toContain("PRIVATE_SKILL_BODY");
    expect(f.chatRequests[0]).toContain("PRIVATE_SKILL_BODY");
    f.titleRelease.resolve();
  });

  it.each(["Manual title", ""])("keeps a concurrent manual name or clear (%j)", async (name) => {
    const f = await fixture();
    await f.session.prompt("Research a paper");
    expect(f.titleRequests).toHaveLength(1);
    f.session.setSessionName(name);
    f.titleRelease.resolve();
    await vi.waitFor(() => expect(f.manager.getEntries().some(e => e.type === "custom" && e.customType === "easyresearch:auto-title-result")).toBe(true));
    expect(f.session.sessionName ?? "").toBe(name);
  });

  it("does not retroactively title a conversation that started with the option disabled", async () => {
    const f = await fixture(false);
    await f.session.prompt("First request");
    f.setEnabled(true);
    await f.session.prompt("Later request");
    expect(f.titleRequests).toHaveLength(0);
    expect(f.session.sessionName).toBeUndefined();
  });

  it("discards a late result after the global option is disabled", async () => {
    const f = await fixture();
    await f.session.prompt("First request");
    expect(f.titleRequests).toHaveLength(1);
    f.setEnabled(false);
    f.titleRelease.resolve();
    await vi.waitFor(() => expect(f.manager.getEntries().some(e => e.type === "custom" && e.customType === "easyresearch:auto-title-result")).toBe(true));
    expect(f.session.sessionName).toBeUndefined();
  });

  it.each([false, true])("retains the existing fallback for empty/error results (%s)", async (error) => {
    const f = await fixture();
    f.setResult("", error);
    f.titleRelease.resolve();
    await f.session.prompt("First request");
    await vi.waitFor(() => expect(f.manager.getEntries().some(e => e.type === "custom" && e.customType === "easyresearch:auto-title-result")).toBe(true));
    expect(f.session.sessionName).toBeUndefined();
    expect(f.session.getLastAssistantText()).toBe("研究回复");
  });

  it("cancels the owned title request before reload finishes", async () => {
    const f = await fixture();
    await f.session.prompt("First request");
    expect(f.titleRequests).toHaveLength(1);
    const reload = f.session.reload();
    await vi.waitFor(() => expect(f.titleRequests[0]!.signal?.aborted).toBe(true));
    f.titleRelease.resolve();
    await reload;
    expect(f.session.sessionName).toBeUndefined();
  });

  it("honors root Stop after chat has already settled", async () => {
    const f = await fixture();
    await f.session.prompt("First request");
    expect(f.session.isIdle).toBe(true);
    expect(f.titleRequests).toHaveLength(1);
    f.cancel();
    expect(f.titleRequests[0]!.signal?.aborted).toBe(true);
    f.titleRelease.resolve();
    await vi.waitFor(() => expect(f.manager.getEntries().some(e => e.type === "custom" && e.customType === "easyresearch:auto-title-result")).toBe(true));
    expect(f.session.sessionName).toBeUndefined();
  });
});
