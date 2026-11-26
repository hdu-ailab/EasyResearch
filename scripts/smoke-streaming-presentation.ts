#!/usr/bin/env bun
/** Isolated real provider -> native daemon -> rebuilt Work/Markdown Worker presentation probe. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { smokeAgentText } from "./smoke-agent-scenario";
import { createSmokeDaemonCustody } from "./smoke-release-support";

const binary = resolve(process.argv[2] && !process.argv[2]!.startsWith("--") ? process.argv[2]! : "release/easyresearch-linux-x64/bin/easyresearch");
const baseline = process.argv.includes("--baseline");
const onlyCase = process.argv.find(value => value.startsWith("--case="))?.slice("--case=".length);
const root = mkdtempSync(join(tmpdir(), "streaming-presentation-"));
const home = join(root, "home"), agentDir = join(home, ".easyresearch", "agent"), project = join(root, "project");
const emptyPath = join(root, "empty-path");
for (const directory of [home, agentDir, project, emptyPath]) mkdirSync(directory, { recursive: true, mode: 0o700 });
const errors: string[] = [];
const streams = new Map<string, { chunks: string[]; start: Promise<void>; release(): void; done: Promise<void>; finish(): void }>();
const parents = new Map<string, { child: string; dispatched: boolean }>();
const encoder = new TextEncoder();
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
  const body = await request.json();
  const task = [...body.messages].reverse().flatMap((message: any) => message.role === "user"
    ? (smokeAgentText(message.content).match(/\b(?:PARENT_)?STREAM_[a-f0-9-]{36}\b/g) ?? []) : [])
    .find((value: string) => streams.has(value) || parents.has(value));
  const spec = streams.get(task ?? "");
  const chunk = (delta: unknown, finish: string | null = null) => ({
    id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
  });
  const parent = parents.get(task ?? "");
  if (parent) {
    const first = !parent.dispatched; parent.dispatched = true;
    const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-child", type: "function",
      function: { name: "subagent", arguments: JSON.stringify({ agent: "piper-brain", description: "Streaming child fixture", prompt: parent.child }) } }] }
      : { role: "assistant", content: "Child fixture observed." };
    return new Response(`data: ${JSON.stringify(chunk(delta))}\n\ndata: ${JSON.stringify(chunk({}, first ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } });
  }
  if (!spec) { errors.push("Unexpected fixture model request"); return Response.json({ error: "Unknown fixture" }, { status: 400 }); }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await spec.start;
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`));
        for (const [index, text] of spec.chunks.entries()) {
          if (cancelled || request.signal.aborted) break;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: text }))}\n\n`));
          if (index < spec.chunks.length - 1) await new Promise(resolveWait => setTimeout(resolveWait, 110));
        }
        if (!cancelled && !request.signal.aborted) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`));
          controller.close();
        }
      } catch (error) { if (!cancelled && !request.signal.aborted) errors.push(String(error)); }
      finally { spec.finish(); }
    },
    cancel() { cancelled = true; spec.finish(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
} });
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
  baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "private-fixture",
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  models: [{ id: "fixture", name: "Fixture", contextWindow: 32000, maxTokens: 2048 }],
} } }));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture",
  compaction: { enabled: false }, retry: { enabled: false },
  easyresearch: { web: { autoSessionTitle: false, sessionIdleTimeoutMs: -1 },
    agentDefaults: { "research-assistant": { model: "fixture/fixture", thinking: "off" } } },
}));
mkdirSync(join(agentDir, "agents"));
writeFileSync(join(agentDir, "agents", "piper-brain.md"), "---\nname: piper-brain\ndescription: Isolated streaming fixture\ntools: [read]\nsubagents: []\n---\nReturn the requested fixture response.\n");
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port!; await probe.stop(true);
const origin = `http://127.0.0.1:${port}`;
const custody = createSmokeDaemonCustody({ agentDir, host: "127.0.0.1", port });
const env = { HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir, PATH: emptyPath,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
  TMPDIR: tmpdir(), PI_OFFLINE: "1", NO_PROXY: "localhost,127.0.0.1,::1", LANG: "C.UTF-8" };
const json = async (path: string, body?: unknown) => {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(20_000), ...(body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) });
  assert(response.ok, `${path}: ${response.status}`); return response.json() as Promise<any>;
};
type Sample = { length: number; height: number; bottom: number; scrollTop: number; time: number; table: boolean };
type Probe = {
  samples: Sample[]; replacements: number; bodyReplacements: number; tableLosses: number; frame: number;
  wordAnimations: number; animationReplays: number; selection: string | null; longTasks: number[];
  stop(): void;
};
type ProbeWindow = Window & { streamPresentation: Probe; pendingStopParse?: boolean };
let browser: Browser | undefined, context: BrowserContext | undefined, primary: unknown;
const report: Record<string, any> = { binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  baseline, root, cases: [], browserErrors: [], errors, cleanupErrors: [], passed: false };
console.log(`STREAM_PRESENTATION artifacts: ${root}`);
try {
  const launcher = Bun.spawn([binary, "--no-open", "--port", String(port)], {
    cwd: home, env, stdin: "ignore", stdout: Bun.file(join(root, "startup.log")), stderr: Bun.file(join(root, "startup-error.log")),
  });
  const timeout = setTimeout(() => launcher.kill("SIGKILL"), 90_000);
  try { assert.equal(await launcher.exited, 0); } finally { clearTimeout(timeout); }
  assert(await custody.capture());
  assert.equal((await json("/api/status")).agentDir, agentDir);
  browser = await chromium.launch({ executablePath: process.env.COMPARE_CHROMIUM_PATH ?? chromium.executablePath(), headless: true, args: ["--no-proxy-server"] });
  report.browser = browser.version();
  for (const [width, language, theme, mode] of [
    [1280, "en", "light", "worker"], [390, "zh-CN", "dark", "worker-delayed"], [1280, "en", "dark", "fallback"],
    [1280, "zh-CN", "light", "child-delayed"],
    [1280, "en", "light", "worker-motion"], [390, "en", "dark", "fallback-motion"],
    [1280, "en", "light", "worker-stop"],
  ] as const) {
    if (process.argv.includes("--child-only") && mode !== "child-delayed") continue;
    if (onlyCase && mode !== onlyCase) continue;
    const { id } = await json("/api/sessions", { cwd: project });
    const task = `STREAM_${randomUUID()}`;
    const child = mode === "child-delayed";
    const stopping = mode === "worker-stop";
    const prose = language === "en"
      ? Array.from({ length: 36 }, (_, index) => `${index === 0 ? "" : " "}Stable streaming text preserves the current paragraph ${index + 1}.`)
      : Array.from({ length: 36 }, (_, index) => `流式文本应当平稳追加，已有内容保持稳定，这是第${index + 1}段连续测试文字。`);
    const table = "## 稳定表格\n\n| 输入 | 输出 | 差值 |\n| --- | --- | --- |\n"
      + Array.from({ length: 30 }, (_, index) => `| ${index} | **稳定** | ${index + 1} |\n`).join("") + "\n## 后续文字\n\n";
    const chunks = child || stopping ? [table, ...prose] : prose;
    const parentTask = child ? `PARENT_${task}` : task;
    if (child) parents.set(parentTask, { child: task, dispatched: false });
    let release!: () => void, finish!: () => void;
    const start = new Promise<void>(resolveStart => { release = resolveStart; });
    const done = new Promise<void>(resolveDone => { finish = resolveDone; });
    streams.set(task, { chunks, start, release, done, finish });
    const motion = mode.endsWith("motion");
    context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: motion ? "no-preference" : "reduce" });
    await context.addInitScript(({ language, theme, mode }) => {
      localStorage.setItem("easyresearch.webui.preferences", JSON.stringify({ language, studioTheme: theme }));
      if (mode.startsWith("fallback")) Object.defineProperty(window, "Worker", { configurable: true, value: undefined });
      if (mode.endsWith("delayed") || mode === "worker-stop") {
        const OriginalWorker = window.Worker;
        window.Worker = new Proxy(OriginalWorker, { construct(Target, args) {
          const worker = Reflect.construct(Target, args) as Worker;
          if (!String(args[0]).includes("markdown.worker")) return worker;
          const add = worker.addEventListener.bind(worker), remove = worker.removeEventListener.bind(worker), terminate = worker.terminate.bind(worker);
          if (mode === "worker-stop") {
            const post = worker.postMessage.bind(worker);
            worker.postMessage = ((value: { source?: unknown }, options?: StructuredSerializeOptions) => {
              if (typeof value?.source === "string" && value.source.endsWith("current paragraph 10.")) {
                (window as unknown as ProbeWindow).pendingStopParse = true;
              }
              post(value, options);
            }) as typeof worker.postMessage;
          }
          const listeners = new Map<EventListenerOrEventListenerObject, EventListener>();
          const timers = new Set<number>();
          worker.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
            if (type !== "message") return add(type, listener, options);
            const delayed: EventListener = event => {
              const timer = window.setTimeout(() => {
                timers.delete(timer);
                if (typeof listener === "function") listener.call(worker, event); else listener.handleEvent(event);
              }, 70);
              timers.add(timer);
            };
            listeners.set(listener, delayed); add(type, delayed, options);
          }) as typeof worker.addEventListener;
          worker.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
            remove(type, listeners.get(listener) ?? listener, options); listeners.delete(listener);
          }) as typeof worker.removeEventListener;
          worker.terminate = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); terminate(); };
          return worker;
        } });
      }
    }, { language, theme, mode });
    const page: Page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", error => report.browserErrors.push(error.message));
    const workerAssets: string[] = [];
    page.on("response", response => { if (/\/assets\/markdown\.worker-.*\.js/.test(response.url())) workerAssets.push(response.url()); });
    await page.goto(`${origin}/#/work/${id}?cwd=${encodeURIComponent(project)}`);
    await expect(page.getByTestId("transcript-viewport")).toBeVisible();
    await expect(page.locator("textarea").first()).toBeEnabled();
    let childId: string | undefined;
    if (child) {
      await json(`/api/sessions/${id}/messages`, { message: parentTask });
      await expect.poll(async () => {
        childId = (await json(`/api/sessions/${id}/snapshot`)).subagents.find((value: any) => value.agent === "piper-brain")?.childSessionId;
        return childId;
      }).toBeTruthy();
      try {
        await page.getByTestId("agent-tab-group").locator("button[aria-pressed]").filter({ hasText: /piper-brain/ }).click();
      } catch (error) {
        await page.screenshot({ path: join(root, "child-selection-failed.png") });
        writeFileSync(join(root, "child-selection-failed.txt"), await page.locator("body").innerText());
        writeFileSync(join(root, "child-selection-snapshot.json"), JSON.stringify(await json(`/api/sessions/${id}/snapshot`), null, 2));
        throw error;
      }
    }
    await page.evaluate(motion => {
      const seenAnimations = new WeakSet<Element>();
      const state: Probe = {
        samples: [], replacements: 0, bodyReplacements: 0, tableLosses: 0, frame: 0,
        wordAnimations: 0, animationReplays: 0, selection: null, longTasks: [],
        stop() {
          cancelAnimationFrame(state.frame);
          document.removeEventListener("animationstart", animation);
          observer?.disconnect();
        },
      };
      const animation = (event: AnimationEvent) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || target.tagName !== "SPAN" || !target.closest('[data-message-body="assistant"]')) return;
        state.wordAnimations++;
        if (seenAnimations.has(target)) state.animationReplays++;
        seenAnimations.add(target);
      };
      document.addEventListener("animationstart", animation);
      const observer = PerformanceObserver.supportedEntryTypes.includes("longtask")
        ? new PerformanceObserver(list => { for (const entry of list.getEntries()) state.longTasks.push(entry.duration); }) : undefined;
      observer?.observe({ type: "longtask" });
      let paragraph: Element | null = null;
      let sawTable = false;
      let previousBody: HTMLElement | null = null, bodyCount = 0;
      const sample = () => {
        const bodies = [...document.querySelectorAll<HTMLElement>('[data-message-body="assistant"]')]
          .filter(element => /Stable streaming text|流式文本应当|稳定表格/.test(element.textContent ?? ""));
        const body = bodies.at(-1);
        const viewport = document.querySelector<HTMLElement>("[data-testid=transcript-viewport] section");
        if (body && viewport) {
          // Sample the actual reply, not a labeled child dispatch or the separate
          // abort notice. A new reply owns a new sample series.
          if (bodies.length > bodyCount) {
            state.samples = []; state.replacements = 0; state.tableLosses = 0;
            paragraph = null; sawTable = false;
          } else if (previousBody && body !== previousBody) state.bodyReplacements++;
          bodyCount = bodies.length; previousBody = body;
          const current = body.querySelector("p");
          if (paragraph && current && paragraph !== current) state.replacements++;
          if (current) paragraph = current;
          if (motion && state.selection === null && (body.textContent?.length ?? 0) > 200 && current) {
            const walker = document.createTreeWalker(current, NodeFilter.SHOW_TEXT);
            const first = walker.nextNode();
            if (first && first.textContent?.startsWith("Stable")) {
              const range = document.createRange();
              range.setStart(first, 0); range.setEnd(first, 6);
              const selection = window.getSelection();
              selection?.removeAllRanges(); selection?.addRange(range);
              state.selection = "Stable";
            }
          }
          const table = body.querySelector("table") !== null;
          if (sawTable && !table) state.tableLosses++;
          sawTable ||= table;
          const rect = body.getBoundingClientRect();
          state.samples.push({ length: body.textContent?.length ?? 0, height: rect.height, bottom: rect.bottom, scrollTop: viewport.scrollTop, time: performance.now(), table });
        }
        state.frame = requestAnimationFrame(sample);
      };
      (window as unknown as ProbeWindow).streamPresentation = state;
      sample();
    }, motion);
    if (!child) await json(`/api/sessions/${id}/messages`, { message: task });
    release();
    if (stopping) {
      await page.waitForFunction(() => (window as unknown as ProbeWindow).pendingStopParse === true);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
    }
    let unpinned: number | undefined;
    if (child) {
      await expect(page.locator('[data-message-body="assistant"]').last().getByRole("table")).toBeVisible();
      const viewport = page.getByTestId("transcript-viewport").locator("section");
      await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200);
      const before = await viewport.evaluate(element => element.scrollTop);
      await viewport.hover();
      await page.mouse.wheel(0, -500);
      await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeLessThan(before - 50);
      await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
      unpinned = await viewport.evaluate(element => element.scrollTop);
    }
    await done;
    await expect.poll(async () => (await json(`/api/sessions/${id}/snapshot`)).session.status).toBe("ready");
    const body = page.locator('[data-message-body="assistant"]').filter({ hasText: /Stable streaming text|流式文本应当|稳定表格/ }).last();
    const persistedView = stopping ? await json(`/api/sessions/${id}/snapshot`) : undefined;
    const stoppedText = stopping ? smokeAgentText(persistedView.timeline.findLast((entry: any) => entry.kind === "message"
      && entry.message.role === "assistant").message.content) : undefined;
    if (stoppedText !== undefined) {
      assert(stoppedText.length > table.length && chunks.join("").startsWith(stoppedText), "Stop must preserve exact received output");
      await expect(body.getByRole("table")).toBeVisible();
    }
    await expect.poll(async () => (await body.locator("p").filter({ hasText: /^(Stable streaming text|流式文本应当)/ }).first().textContent())?.trim())
      .toBe(stoppedText?.slice(table.length).trim() ?? prose.join(""));
    if (child) {
      await expect(body.getByRole("table")).toBeVisible();
      const persisted = await json(`/api/sessions/${id}/subagents/${childId}/snapshot`);
      assert(persisted.timeline.some((entry: any) => entry.kind === "message" && entry.message.role === "assistant"
        && smokeAgentText(entry.message.content) === chunks.join("")), "Child persisted output must be exact");
    }
    const finalScrollTop = await page.getByTestId("transcript-viewport").locator("section").evaluate(element => element.scrollTop);
    await page.screenshot({ path: join(root, `${mode}-${language}.png`) });
    const measured = await page.evaluate(() => {
      const value = (window as unknown as ProbeWindow).streamPresentation;
      value.stop(); return {
        samples: value.samples, replacements: value.replacements, bodyReplacements: value.bodyReplacements, tableLosses: value.tableLosses,
        wordAnimations: value.wordAnimations, animationReplays: value.animationReplays,
        selectedPrefix: value.selection, finalSelection: window.getSelection()?.toString(), longTasks: value.longTasks,
      };
    });
    const reversals = measured.samples.filter((sample, index) => index > 0 && sample.length >= measured.samples[index - 1]!.length
      && sample.height < measured.samples[index - 1]!.height - 1);
    const gaps = measured.samples.slice(1).map((sample, index) => sample.time - measured.samples[index]!.time).sort((a, b) => a - b);
    const result = { mode, width, language, theme, workerAssets, stopped: stopping, replacements: measured.replacements,
      tableLosses: measured.tableLosses,
      bodyReplacements: measured.bodyReplacements,
      wordAnimations: measured.wordAnimations, animationReplays: measured.animationReplays,
      selectionPreserved: measured.selectedPrefix !== null && measured.selectedPrefix === measured.finalSelection,
      ...(unpinned === undefined ? {} : { unpinnedScrollDelta: Math.abs(finalScrollTop - unpinned) }),
      rafP95Ms: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
      longTasks: measured.longTasks.length, longTaskMs: measured.longTasks.reduce((sum, value) => sum + value, 0),
      heightReversals: reversals.length, largestShrink: Math.max(0, ...measured.samples.slice(1).map((sample, index) => measured.samples[index]!.height - sample.height)),
      finalTextExact: true, frames: measured.samples.length };
    report.cases.push(result);
    writeFileSync(join(root, `${mode}-${language}-frames.json`), JSON.stringify(measured, null, 2));
    assert(measured.samples.length > 30, "A real sequence of painted streaming frames must be observed");
    if (!mode.startsWith("fallback")) assert(workerAssets.length > 0, "Exercise the real hashed Markdown Worker");
    if (!baseline) {
      assert.equal(result.heightReversals, 0, `${mode}: append-only plain paragraph shrank during streaming`);
      assert.equal(result.replacements, 0, `${mode}: growing paragraph DOM was replaced`);
      assert.equal(result.tableLosses, 0, `${mode}: rendered table reverted while later output arrived`);
      assert.equal(result.bodyReplacements, 0, `${mode}: answer body was replaced`);
      assert.equal(result.animationReplays, 0, `${mode}: existing word replayed its fade`);
      if (unpinned !== undefined) assert(Math.abs(finalScrollTop - unpinned) <= 2, "Streaming must not pull an unpinned reader");
      if (motion) {
        assert(result.wordAnimations > 0, `${mode}: new live words must actually animate`);
        assert(result.selectionPreserved, `${mode}: native selection on the completed prefix must survive`);
      } else assert.equal(result.wordAnimations, 0, `${mode}: reduced motion must be static`);
    }
    await context.close(); context = undefined;
  }
  assert(report.cases.length > 0, "Select a known streaming presentation case");
  assert.deepEqual(errors, []); assert.deepEqual(report.browserErrors, []);
  report.passed = !baseline;
} catch (error) { primary = error; report.error = String(error); }
finally {
  for (const stream of streams.values()) stream.release();
  const settled = await Promise.allSettled([
    (async () => { await context?.close(); await browser?.close(); })(), custody.stopAndVerify(), provider.stop(true),
  ]);
  report.cleanupErrors = settled.flatMap(value => value.status === "rejected" ? [String(value.reason)] : []);
  if (report.cleanupErrors.length) report.passed = false;
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
}
if (primary) throw primary;
assert.equal(report.cleanupErrors.length, 0);
console.log(`STREAM_PRESENTATION ${baseline ? "baseline measured" : "passed"}: ${root}/report.json`);
