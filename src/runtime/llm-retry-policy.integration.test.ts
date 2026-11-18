import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLlmRetryPolicyExtension } from "../extensions/llm-retry-policy";
import { importPi } from "./pi-import";
import { createLlmRetryPolicyBinding, type AutomaticRetrySnapshot } from "./llm-retry-policy";

vi.mock("./logger", () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

const schedule = [5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000, 120_000, 120_000, 120_000];
let root: string;
let pi: Awaited<ReturnType<typeof importPi>>;
let ai: typeof import("@earendil-works/pi-ai");
let sequence = 0;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-llm-retry-"));
  for (const name of ["home", "identity"]) mkdirSync(join(root, name));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("USERPROFILE", join(root, "home"));
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(root, "identity"));
  vi.stubEnv("PI_OFFLINE", "1");
  pi = await importPi();
  ai = await import("@earendil-works/pi-ai");
}, 60_000);

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
afterAll(() => {
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function fixture(options: {
  global?: Record<string, unknown>;
  project?: Record<string, unknown>;
  seed?: "normal" | "split";
  auto?: boolean;
  contextWindow?: number;
  decorated?: boolean;
} = {}) {
  vi.stubGlobal("fetch", () => { throw new Error("External network is forbidden in retry tests."); });
  const directory = join(root, `fixture-${++sequence}`);
  const cwd = join(directory, "paper");
  const agentDir = join(directory, "agent");
  mkdirSync(join(cwd, ".easyresearch"), { recursive: true });
  mkdirSync(agentDir);
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".easyresearch", "settings.json");
  let globalBytes = JSON.stringify({ compaction: { enabled: options.auto ?? false, reserveTokens: 100, keepRecentTokens: 20 }, ...options.global });
  let projectBytes = JSON.stringify(options.project ?? {});
  writeFileSync(globalPath, globalBytes);
  writeFileSync(projectPath, projectBytes);
  const settings = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const originalGetter = settings.getRetrySettings;
  const provider = ai.fauxProvider({
    provider: `retry-policy-fixture-${sequence}`,
    tokenSize: { min: 100_000, max: 100_000 },
    models: [{ id: "fake", contextWindow: options.contextWindow ?? 128_000, maxTokens: 1_000 }],
  });
  const runtime = await pi.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  runtime.registerNativeProvider(provider.provider);
  const manager = pi.SessionManager.inMemory(cwd);
  const addUser = (text: string) => manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  let target: string | undefined;
  if (options.seed) {
    target = addUser("OLD REQUEST " + "x".repeat(500));
    manager.appendMessage(ai.fauxAssistantMessage("OLD ANSWER " + "y".repeat(500)));
    if (options.seed === "split") {
      addUser("CURRENT REQUEST " + "z".repeat(500));
      manager.appendMessage(ai.fauxAssistantMessage("RECENT SUFFIX " + "r".repeat(200)));
    } else {
      addUser("LATEST USER " + "z".repeat(500));
    }
  }
  const binding = options.decorated === false ? undefined : createLlmRetryPolicyBinding(settings);
  const preparations: Array<{ isSplitTurn: boolean; messagesToSummarize: unknown[]; turnPrefixMessages: unknown[] }> = [];
  let session: AgentSession;
  const capturePreparation: ExtensionFactory = (api) => {
    api.on("session_before_compact", (event) => { preparations.push(event.preparation); });
  };
  const loader = new pi.DefaultResourceLoader({
    cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      ...(binding ? [createLlmRetryPolicyExtension(binding)] : []),
      capturePreparation,
    ],
  });
  await loader.reload();
  ({ session } = await pi.createAgentSession({
    cwd, agentDir, model: provider.getModel(), thinkingLevel: "off", modelRuntime: runtime,
    sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: "all",
  }));
  binding?.attach(session);
  await session.bindExtensions({ mode: "rpc" });
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => { events.push(event); });
  const snapshots: Array<AutomaticRetrySnapshot | null> = [];
  binding?.subscribe(() => { snapshots.push(binding.getAutomaticRetry()); });
  const requests: Array<{ time: number; options: Parameters<Extract<FauxResponseStep, Function>>[1] }> = [];
  const step = (response: ReturnType<typeof ai.fauxAssistantMessage>): Extract<FauxResponseStep, Function> => (_context, options) => {
    requests.push({ time: Date.now(), options });
    return response;
  };
  const error = () => step(ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" }));
  const success = (text = "summary ok") => step(ai.fauxAssistantMessage(text));
  cleanup.push(async () => {
    await session.abort();
    session.dispose();
    binding?.dispose();
    expect(readFileSync(globalPath, "utf8")).toBe(globalBytes);
    expect(readFileSync(projectPath, "utf8")).toBe(projectBytes);
  });
  return {
    session, settings, provider, manager, binding, events, snapshots, requests, preparations, target: target!, error, success, step, originalGetter,
    setGlobal(value: Record<string, unknown>) {
      globalBytes = JSON.stringify({ ...JSON.parse(globalBytes), ...value });
      writeFileSync(globalPath, globalBytes);
    },
    setProject(value: Record<string, unknown>) {
      projectBytes = JSON.stringify(value);
      writeFileSync(projectPath, projectBytes);
    },
  };
}

async function drive<T>(operation: Promise<T>): Promise<T> {
  let done = false;
  let value: T | undefined;
  let failure: unknown;
  void operation.then((result) => { value = result; done = true; }, (error) => { failure = error; done = true; });
  for (let turn = 0; !done && turn < 500; turn++) {
    await vi.advanceTimersByTimeAsync(0);
    if (!done && vi.getTimerCount()) await vi.advanceTimersToNextTimerAsync();
    else if (!done) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(done, "native operation must settle under bounded fake-clock driving").toBe(true);
  if (failure) throw failure;
  return value!;
}
function fakeClock() {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(0);
}
function intervals(times: number[]) { return times.slice(1).map((time, index) => time - times[index]!); }
function summaryDelays(events: AgentSessionEvent[]): number[] {
  return events.flatMap((event) => event.type === "summarization_retry_scheduled" ? [event.delayMs] : []);
}

describe("LLM retry policy with pinned native Pi", () => {
  it("demonstrates uncapped native summaries without the host projection", async () => {
    const f = await fixture({ decorated: false, seed: "normal", global: { retry: { maxRetries: 10, baseDelayMs: 5_000 } } });
    f.provider.setResponses([...Array.from({ length: 10 }, f.error), f.success()]);
    fakeClock();
    await drive(f.session.compact());
    expect(intervals(f.requests.map((request) => request.time)).slice(-2)).toEqual([1_280_000, 2_560_000]);
  });

  it("caps real manual compaction and preserves native usage/provider options", async () => {
    const f = await fixture({ seed: "normal", global: { retry: { provider: { timeoutMs: 321_000, maxRetries: 0, maxRetryDelayMs: 45_000 } } } });
    f.provider.setResponses([...Array.from({ length: 10 }, f.error), f.success()]);
    fakeClock();
    const result = await drive(f.session.compact());
    expect(intervals(f.requests.map((request) => request.time))).toEqual(schedule);
    expect(summaryDelays(f.events)).toEqual(schedule);
    expect(f.snapshots.filter((snapshot) => snapshot !== null).map((snapshot) => snapshot.source)).toEqual(schedule.map(() => "compaction"));
    expect(result.usage).toBeDefined();
    expect(f.requests.every(({ options }) => options?.timeoutMs === 321_000 && options.maxRetries === 0 && options.maxRetryDelayMs === 45_000)).toBe(true);
    expect(f.manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(f.binding!.getAutomaticRetry()).toBeNull();
  });

  it("resets the shared captured policy between two split-compaction summary calls", async () => {
    const f = await fixture({ seed: "split" });
    f.provider.setResponses([
      ...Array.from({ length: 10 }, f.error), f.success("history"),
      ...Array.from({ length: 10 }, f.error), f.success("prefix"),
    ]);
    fakeClock();
    const result = await drive(f.session.compact());
    expect(f.preparations[0]?.isSplitTurn).toBe(true);
    expect(f.preparations[0]!.messagesToSummarize.length).toBeGreaterThan(0);
    expect(f.preparations[0]!.turnPrefixMessages.length).toBeGreaterThan(0);
    expect(summaryDelays(f.events)).toEqual([...schedule, ...schedule]);
    expect(intervals(f.requests.slice(0, 11).map((request) => request.time))).toEqual(schedule);
    expect(intervals(f.requests.slice(11).map((request) => request.time))).toEqual(schedule);
    expect(result.summary).toContain("history");
    expect(result.summary).toContain("prefix");
    expect(result.usage).toBeDefined();
  });

  it("caps branch summary retries with their own observational source", async () => {
    const f = await fixture({ seed: "normal" });
    f.provider.setResponses([...Array.from({ length: 10 }, f.error), f.success("branch summary")]);
    fakeClock();
    const result = await drive(f.session.navigateTree(f.target, { summarize: true }).finally(f.binding!.finishSummary));
    expect(intervals(f.requests.map((request) => request.time))).toEqual(schedule);
    expect(summaryDelays(f.events)).toEqual(schedule);
    expect(f.snapshots.filter((snapshot) => snapshot !== null).every((snapshot) => snapshot.source === "branchSummary")).toBe(true);
    expect(result.summaryEntry?.usage).toBeDefined();
    expect(f.binding!.getAutomaticRetry()).toBeNull();
  });

  it("exhausts Agent retries at eleven calls and resets the native budget for a managed wake", async () => {
    const f = await fixture();
    f.provider.setResponses(Array.from({ length: 11 }, f.error));
    fakeClock();
    await drive(f.session.prompt("request"));
    expect(f.provider.state.callCount).toBe(11);
    expect(intervals(f.requests.map((request) => request.time))).toEqual(schedule);
    expect(f.session.retryAttempt).toBe(0);
    expect(f.session.isIdle).toBe(true);
    expect(f.binding!.getAutomaticRetry()).toBeNull();
    f.provider.setResponses([...Array.from({ length: 10 }, f.error), f.success()]);
    await drive(f.session.sendCustomMessage({ customType: "retry-policy-test", content: "", display: false }, { triggerTurn: true }));
    expect(f.provider.state.callCount).toBe(22);
    expect(intervals(f.requests.slice(11).map((request) => request.time))).toEqual(schedule);
    expect(f.session.retryAttempt).toBe(0);
  });

  it("caps threshold-triggered automatic compaction", async () => {
    const f = await fixture({ seed: "normal", auto: true, contextWindow: 1_000 });
    f.settings.applyOverrides({ compaction: { reserveTokens: 999 } });
    f.provider.setResponses([...Array.from({ length: 10 }, f.error), f.success("auto summary"), f.success("answer")]);
    fakeClock();
    await drive(f.session.prompt("after threshold"));
    expect(f.events.some((event) => event.type === "compaction_start" && event.reason === "threshold")).toBe(true);
    expect(summaryDelays(f.events).slice(0, 10)).toEqual(schedule);
    expect(intervals(f.requests.slice(0, 11).map((request) => request.time))).toEqual(schedule);
  });

  it("caps overflow-recovery summaries before Pi resumes the interrupted response", async () => {
    const f = await fixture({ seed: "normal", auto: true });
    f.provider.setResponses([
      f.step(ai.fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" })),
      ...Array.from({ length: 10 }, f.error), f.success("overflow summary"), f.success("recovered"),
    ]);
    fakeClock();
    await drive(f.session.prompt("overflow recovery"));
    expect(f.events.some((event) => event.type === "compaction_start" && event.reason === "overflow")).toBe(true);
    expect(summaryDelays(f.events)).toEqual(schedule);
    expect(intervals(f.requests.slice(1, 12).map((request) => request.time))).toEqual(schedule);
    expect(f.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
  });

  it.each([
    [{ retry: { maxRetries: 4, baseDelayMs: 7_000 } }, { retry: { maxRetries: 0 } }, []],
    [{ retry: { maxRetries: 4 } }, { retry: { enabled: false } }, []],
    [{ retry: { enabled: false } }, {}, []],
    [{ retry: { maxRetries: 4, baseDelayMs: 7_000 } }, { retry: { maxRetries: 2, baseDelayMs: 3_000 } }, [3_000, 6_000]],
    [{ retry: { maxRetries: 4, baseDelayMs: 7_000 } }, { retry: { maxRetries: 2, baseDelayMs: 0 } }, [0, 0]],
    [{ retry: { maxRetries: 2, baseDelayMs: 200_000 } }, {}, [120_000, 120_000]],
  ])("preserves native configured precedence and the host delay ceiling (%j, %j)", async (global, project, expected) => {
    const f = await fixture({ seed: "normal", global, project });
    f.provider.setResponses(Array.from({ length: 11 }, f.error));
    fakeClock();
    await expect(drive(f.session.compact())).rejects.toThrow(/503 overloaded/);
    expect(summaryDelays(f.events)).toEqual(expected);
    expect(f.provider.state.callCount).toBe(expected.length + 1);
  });

  it("keeps the real manager through reload and restores inherited getter identity on disposal", async () => {
    const f = await fixture({ seed: "normal" });
    const prototypeGetter = Object.getPrototypeOf(f.settings).getRetrySettings;
    expect(f.settings).toBeInstanceOf(pi.SettingsManager);
    f.setProject({ retry: { maxRetries: 2, baseDelayMs: 9_000 } });
    await f.session.reload();
    expect(Object.getPrototypeOf(f.settings).getRetrySettings).toBe(prototypeGetter);
    f.provider.setResponses([f.error(), f.error(), f.success()]);
    fakeClock();
    await drive(f.session.compact());
    expect(intervals(f.requests.map((request) => request.time))).toEqual([9_000, 18_000]);
    f.binding!.dispose();
    expect(f.settings.getRetrySettings).toBe(f.originalGetter);
    expect(Object.hasOwn(f.settings, "getRetrySettings")).toBe(false);
    expect(f.settings.getRetrySettings()).toMatchObject({ maxRetries: 2, baseDelayMs: 9_000 });
    expect(pi.SettingsManager.inMemory().getRetrySettings()).toMatchObject({ maxRetries: 3, baseDelayMs: 2_000 });
  });

  it("preserves a captured summary policy despite extra getter reads and a settings reload", async () => {
    const f = await fixture({ seed: "normal" });
    const firstFailure = f.error();
    f.provider.setResponses([
      async (...args) => {
        f.setProject({ retry: { maxRetries: 1, baseDelayMs: 777 } });
        await f.settings.reload();
        expect(f.settings.getRetrySettings()).toMatchObject({ maxRetries: 1, baseDelayMs: 777 });
        return firstFailure(...args);
      },
      ...Array.from({ length: 9 }, f.error), f.success(),
    ]);
    fakeClock();
    await drive(f.session.compact());
    expect(intervals(f.requests.map((request) => request.time))).toEqual(schedule);
    expect(f.settings.getRetrySettings()).toMatchObject({ maxRetries: 1, baseDelayMs: 777 });
  });

  it("keeps the active captured policy when native reload replaces extension instances", async () => {
    const f = await fixture({ seed: "normal" });
    const firstFailure = f.error();
    f.provider.setResponses([
      async (...args) => {
        expect(f.session.isCompacting).toBe(true);
        await f.session.reload();
        expect(f.session.isCompacting).toBe(true);
        return firstFailure(...args);
      },
      ...Array.from({ length: 9 }, f.error), f.success(),
    ]);
    fakeClock();
    await drive(f.session.compact());
    expect(intervals(f.requests.map((request) => request.time))).toEqual(schedule);
    expect(f.binding!.getAutomaticRetry()).toBeNull();
  });

  it.each(["agent", "compaction"] as const)("native %s cancellation interrupts capped backoff without another request", async (source) => {
    const f = await fixture({ seed: source === "compaction" ? "normal" : undefined });
    f.provider.setResponses(Array.from({ length: 11 }, f.error));
    f.session.subscribe((event) => {
      if ((event.type === "summarization_retry_scheduled" || event.type === "auto_retry_start") && event.attempt === 6) {
        queueMicrotask(() => { void f.session.abort(); });
      }
    });
    fakeClock();
    if (source === "compaction") await expect(drive(f.session.compact())).rejects.toThrow(/cancel/i);
    else await drive(f.session.prompt("cancel after the cap"));
    expect(f.provider.state.callCount).toBe(6);
    expect(f.session.isIdle).toBe(true);
    expect(f.binding!.getAutomaticRetry()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["failure", "abort"] as const)("cleans up branch %s and starts the next native summary at its initial base", async (kind) => {
    const f = await fixture({ seed: "normal" });
    f.provider.setResponses(Array.from({ length: 11 }, f.error));
    const unsubscribe = f.session.subscribe((event) => {
      if (kind === "abort" && event.type === "summarization_retry_scheduled" && event.attempt === 6) {
        queueMicrotask(() => f.session.abortBranchSummary());
      }
    });
    fakeClock();
    const operation = f.session.navigateTree(f.target, { summarize: true }).finally(f.binding!.finishSummary);
    if (kind === "failure") await expect(drive(operation)).rejects.toThrow(/503 overloaded/);
    else expect(await drive(operation)).toMatchObject({ cancelled: true, aborted: true });
    unsubscribe();
    expect(f.session.isCompacting).toBe(false);
    expect(f.binding!.getAutomaticRetry()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const baseline = f.requests.length;
    f.provider.setResponses([...Array.from({ length: 10 }, f.error), f.success()]);
    await drive(f.session.navigateTree(f.target, { summarize: true }).finally(f.binding!.finishSummary));
    expect(intervals(f.requests.slice(baseline).map((request) => request.time))).toEqual(schedule);
  });

  it("isolates concurrently running native AgentSessions and summary policies", async () => {
    const left = await fixture({ seed: "normal" });
    const right = await fixture({ seed: "normal", project: { retry: { baseDelayMs: 3_000, maxRetries: 7 } } });
    left.provider.setResponses([...Array.from({ length: 10 }, left.error), left.success()]);
    right.provider.setResponses([...Array.from({ length: 7 }, right.error), right.success()]);
    fakeClock();
    await drive(Promise.all([
      left.session.compact(),
      right.session.navigateTree(right.target, { summarize: true }).finally(right.binding!.finishSummary),
    ]));
    expect(intervals(left.requests.map((request) => request.time))).toEqual(schedule);
    expect(intervals(right.requests.map((request) => request.time))).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 96_000, 120_000]);
  });
});
