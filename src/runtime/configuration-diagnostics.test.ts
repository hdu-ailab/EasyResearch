import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, expect, it } from "vitest";
import { importPi } from "./pi-import";
import { createLiveConfiguration, type ConfigurationWatchImplementation, type LiveConfiguration } from "./live-configuration";

const roots: string[] = [];
const runtimes: LiveConfiguration[] = [];
beforeAll(async () => { await importPi(); }, 60_000);
afterEach(async () => {
  for (const live of runtimes.splice(0)) await live.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-config-diagnostics-"));
  roots.push(root);
  const handles: Array<{ fail(): void; closed: boolean }> = [];
  let failNextStart = false;
  const watch: ConfigurationWatchImplementation = () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const handle = { closed: false, fail() { listeners.get("error")?.(new Error("PRIVATE_ERROR_CONTENT")); },
      on(event: string, callback: (...args: unknown[]) => void) {
        listeners.set(event, callback);
        if (event === "ready") queueMicrotask(() => {
          if (failNextStart) { failNextStart = false; handle.fail(); }
          else callback();
        });
        return handle;
      },
      add() { return handle; }, async close() { handle.closed = true; } };
    handles.push(handle);
    return handle;
  };
  const live = createLiveConfiguration({ agentDir: root, catalogOptions: { homeDir: root }, watch,
    modelValidator: { currentAvailableModels: () => [], prepareModelCatalog: async () => ({ registeredModels: [], availableModels: [], commit() {}, rollback() {} }) } });
  runtimes.push(live);
  return { root, live, handles, failNextStart: () => { failNextStart = true; } };
}

it("identifies a parse failure by absolute path without leaking invalid bytes", async () => {
  const { root, live } = fixture();
  await live.start();
  writeFileSync(join(root, "settings.json"), '{"apiKey":"PRIVATE_ERROR_CONTENT');
  await live.synchronize();
  expect(live.error).toContain(join(root, "settings.json"));
  expect(live.error).not.toContain("PRIVATE_ERROR_CONTENT");
});

it("keeps watcher faults until explicit recovery reopens monitoring and publishes healthy state", async () => {
  const { root, live, handles } = fixture();
  await live.start();
  const events: unknown[] = [];
  live.subscribe((event) => events.push(event));
  handles[0]!.fail();
  expect(live.error).toContain(root);
  expect(live.error).not.toContain("PRIVATE_ERROR_CONTENT");
  await live.synchronize();
  expect(live.error).not.toBeNull();
  const generation = live.generation;
  await live.synchronize({ recoverWatchers: true });
  expect(handles[0]!.closed).toBe(true);
  expect(handles.length).toBeGreaterThan(1);
  expect(live.error).toBeNull();
  expect(live.generation).toBe(generation);
  expect(events.at(-1)).toMatchObject({ type: "config.updated", generation, runtimeChanged: false });
});

it("retains the diagnostic when recovery fails and allows a later successful retry", async () => {
  const state = fixture();
  await state.live.start();
  state.handles[0]!.fail();
  state.failNextStart();
  await state.live.synchronize({ recoverWatchers: true });
  expect(state.live.error).toContain(state.root);
  await state.live.synchronize({ recoverWatchers: true });
  expect(state.live.error).toBeNull();
});

it("accepts timeout edits at a runtime generation while retaining the last good timeout for invalid input", async () => {
  const { root, live } = fixture();
  await live.start();
  const events: Array<{ type: string; runtimeChanged?: boolean }> = [];
  live.subscribe((event) => events.push(event));
  const path = join(root, "settings.json");
  writeFileSync(path, JSON.stringify({ retry: { provider: { timeoutMs: 2500 } } }));
  await live.synchronize();
  expect(live.providerTimeoutSettings).toEqual({ timeoutMs: 2500, source: "provider" });
  expect(events.at(-1)).toMatchObject({ type: "config.updated", runtimeChanged: true });
  writeFileSync(path, JSON.stringify({ retry: { provider: { timeoutMs: "PRIVATE_ERROR_CONTENT" } } }));
  await live.synchronize();
  expect(live.providerTimeoutSettings.timeoutMs).toBe(2500);
  expect(live.error).toContain(path);
  expect(live.error).not.toContain("PRIVATE_ERROR_CONTENT");
  writeFileSync(path, JSON.stringify({ retry: { provider: { timeoutMs: 0 } } }));
  await live.synchronize();
  expect(live.providerTimeoutSettings.timeoutMs).toBe(0);
  expect(live.error).toBeNull();
});
