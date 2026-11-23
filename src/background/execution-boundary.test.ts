import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PrepareRequest } from "@earendil-works/pi-agent-core";
import { importPi } from "../runtime/pi-import";
import { ExecutionClaims, EXECUTION_CLAIM_TYPE } from "./execution-claims";
import { installExecutionClaimBoundary } from "./execution-boundary";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "execution-boundary-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  mkdirSync(agentDir); mkdirSync(sessionDir);
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  const pi = await importPi();
  const { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
  const provider = fauxProvider({ provider: "execution-boundary-fixture", models: [{ id: "local" }] });
  const runtime = await pi.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
  runtime.registerNativeProvider(provider.provider);
  const settings = pi.SettingsManager.create(root, agentDir);
  settings.setProjectTrusted(true); settings.setCompactionEnabled(false); settings.setRetryEnabled(false);
  const manager = pi.SessionManager.create(root, sessionDir);
  const loader = new pi.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { session } = await pi.createAgentSession({ cwd: root, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime: runtime,
    sessionManager: manager, model: provider.getModel(), thinkingLevel: "off", noTools: "all" });
  await session.bindExtensions({ mode: "print" });
  const claims = new ExecutionClaims(manager);
  let requests = 0;
  provider.setResponses(Array.from({ length: 5 }, () => () => { requests++; return fauxAssistantMessage("done"); }));
  return { session, manager, claims, provider, fauxAssistantMessage, requests: () => requests,
    async close() { session.dispose(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); },
  };
}

describe("fail-closed native execution claim boundary", () => {
  it("makes zero provider requests if the claim append fails, even when Pi resolves its run", async () => {
    const f = await fixture();
    const boundary = installExecutionClaimBoundary(f.session, f.claims);
    try {
      const append = f.manager.appendCustomEntry.bind(f.manager);
      let fail = true;
      vi.spyOn(f.manager, "appendCustomEntry").mockImplementation((type, data) => {
        if (type === EXECUTION_CLAIM_TYPE && fail) { fail = false; throw new Error("claim disk full"); }
        return append(type, data);
      });
      await expect(boundary.observe(() => f.session.prompt("accepted input"))).rejects.toThrow("claim disk full");
      expect(f.requests()).toBe(0);
      expect(boundary.failure()?.message).toContain("claim disk full");
      expect(() => boundary.assertHealthy()).toThrow("claim disk full");
      await expect(boundary.observe(() => f.session.prompt("cannot silently retry the failed admission"))).rejects.toThrow("claim disk full");
      expect(f.requests()).toBe(0);
    } finally { boundary.dispose(); await f.close(); }
  });
  it("durably admits a custom-first run without synthesizing human or assistant input, and survives reload", async () => {
    const f = await fixture();
    const boundary = installExecutionClaimBoundary(f.session, f.claims);
    try {
      const pi = await importPi();
      let requests = 0;
      f.provider.setResponses([() => {
        requests++;
        const disk = pi.SessionManager.open(f.session.sessionFile!);
        expect(new ExecutionClaims(disk).current()?.pending).toBe(true);
        expect(disk.getEntries().filter((entry) => entry.type === "message"
          && (entry.message.role === "user" || entry.message.role === "assistant"))).toEqual([]);
        expect(disk.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "test:wake")).toHaveLength(1);
        return f.fauxAssistantMessage("custom input accepted");
      }, () => { requests++; return f.fauxAssistantMessage("after reload"); }]);
      await boundary.observe(() => f.session.sendCustomMessage({
        customType: "test:wake", content: "custom-only input", display: false,
      }, { triggerTurn: true }));
      expect(requests).toBe(1);
      expect(f.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user")).toEqual([]);
      expect(f.claims.current()?.pending).toBe(false);
      const context = f.manager.buildSessionProjection().messages;
      const leaf = f.manager.getLeafId();
      await f.session.reload();
      expect(f.manager.buildSessionProjection().messages).toEqual(context);
      expect(f.manager.getLeafId()).toBe(leaf);
      await boundary.observe(() => f.session.prompt("actual followup"));
      expect(requests).toBe(2);
      expect(f.manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "test:wake")).toHaveLength(1);
    } finally { boundary.dispose(); await f.close(); }
  });
  it("makes zero provider requests when exclusive custom-input publication collides", async () => {
    const f = await fixture();
    const boundary = installExecutionClaimBoundary(f.session, f.claims);
    const link = fs.linkSync;
    const path = f.session.sessionFile!;
    const collision = "foreign file must remain byte-preserved\n";
    const stub = vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
      if (target === path) fs.writeFileSync(path, collision, { flag: "wx" });
      return link(source, target);
    });
    try {
      await expect(boundary.observe(() => f.session.sendCustomMessage({
        customType: "test:wake", content: "accepted custom input", display: false,
      }, { triggerTurn: true }))).rejects.toThrow();
      expect(f.requests()).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(collision);
      expect(readdirSync(f.manager.getSessionDir()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally { stub.mockRestore(); boundary.dispose(); await f.close(); }
  });
  it("does not trust an existing matching header that lacks the accepted custom input", async () => {
    const f = await fixture();
    const boundary = installExecutionClaimBoundary(f.session, f.claims);
    const path = f.session.sessionFile!;
    const headerOnly = `${JSON.stringify(f.manager.getHeader())}\n`;
    fs.writeFileSync(path, headerOnly, { flag: "wx" });
    try {
      await expect(boundary.observe(() => f.session.sendCustomMessage({
        customType: "test:wake", content: "accepted custom input", display: false,
      }, { triggerTurn: true }))).rejects.toThrow(/durab/i);
      expect(f.requests()).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(headerOnly);
    } finally { boundary.dispose(); await f.close(); }
  });
  it("makes zero provider requests and removes owned staging files after a custom-input write failure", async () => {
    const f = await fixture();
    const boundary = installExecutionClaimBoundary(f.session, f.claims);
    const stub = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("custom admission disk full"); });
    try {
      await expect(boundary.observe(() => f.session.sendCustomMessage({
        customType: "test:wake", content: "accepted custom input", display: false,
      }, { triggerTurn: true }))).rejects.toThrow("custom admission disk full");
      expect(f.requests()).toBe(0);
      expect(readdirSync(f.manager.getSessionDir()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally { stub.mockRestore(); boundary.dispose(); await f.close(); }
  });
  it("admits a claim after native user materialization and settles without duplicate user rows", async () => {
    const f = await fixture();
    const boundary = installExecutionClaimBoundary(f.session, f.claims);
    try {
      const pi = await importPi();
      let requests = 0;
      f.provider.setResponses([() => {
        requests++;
        const onDisk = pi.SessionManager.open(f.session.sessionFile!);
        expect(new ExecutionClaims(onDisk).current()).toMatchObject({ pending: true, attempts: 0 });
        expect(onDisk.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
        return f.fauxAssistantMessage("done");
      }]);
      await boundary.observe(() => f.session.prompt("one real user input"));
      expect(requests).toBe(1);
      expect(f.claims.current()).toMatchObject({ pending: false, outcome: "settled" });
      expect(f.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
      expect(f.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === EXECUTION_CLAIM_TYPE)).toHaveLength(2);
    } finally { boundary.dispose(); await f.close(); }
  });
  it("surfaces settlement append failure through the owned result and preserves the durable pending claim", async () => {
    const f = await fixture();
    const boundary = installExecutionClaimBoundary(f.session, f.claims);
    try {
      const append = f.manager.appendCustomEntry.bind(f.manager);
      vi.spyOn(f.manager, "appendCustomEntry").mockImplementation((type, data) => {
        if (type === EXECUTION_CLAIM_TYPE && !(data as { pending: boolean }).pending) throw new Error("settlement disk full");
        return append(type, data);
      });
      await expect(boundary.observe(() => f.session.prompt("one real user input"))).rejects.toThrow("settlement disk full");
      expect(f.requests()).toBe(1);
      expect(f.claims.current()?.pending).toBe(true);
      const pi = await importPi();
      expect(new ExecutionClaims(pi.SessionManager.open(f.session.sessionFile!)).current()?.pending).toBe(true);
      await expect(boundary.observe(() => f.session.prompt("must not infer again"))).rejects.toThrow("settlement disk full");
      expect(f.requests()).toBe(1);
    } finally { boundary.dispose(); await f.close(); }
  });
  it("keeps a suspended claim at native settlement", async () => {
    const f = await fixture();
    const boundary = installExecutionClaimBoundary(f.session, f.claims);
    try {
      f.provider.setResponses([() => { f.claims.suspend(); return f.fauxAssistantMessage("interrupted by planned restart"); }]);
      await boundary.observe(() => f.session.prompt("work"));
      expect(f.claims.current()).toMatchObject({ pending: true, attempts: 0 });
    } finally { boundary.dispose(); await f.close(); }
  });
  it("preserves the previous public hook, survives actual reload, and restores without clobbering another hook", async () => {
    const f = await fixture();
    const original = f.session.agent.prepareRequest;
    let calls = 0;
    const previous: PrepareRequest = async (request, signal) => { calls++; return (await original?.(request, signal)) ?? undefined; };
    f.session.agent.prepareRequest = previous;
    const boundary = installExecutionClaimBoundary(f.session, f.claims);
    try {
      const installed = f.session.agent.prepareRequest;
      await boundary.observe(() => f.session.prompt("first"));
      await f.session.reload();
      expect(f.session.agent.prepareRequest).toBe(installed);
      await boundary.observe(() => f.session.prompt("second"));
      expect(calls).toBe(2);
      const replacement: PrepareRequest = async (request, signal) => (await installed?.(request, signal)) ?? undefined;
      f.session.agent.prepareRequest = replacement;
      boundary.refresh();
      await boundary.observe(() => f.session.prompt("third"));
      expect(calls).toBe(3);
      boundary.dispose();
      expect(f.session.agent.prepareRequest).toBe(replacement);
      await f.session.prompt("disposed wrappers pass through");
      expect(calls).toBe(4);
    } finally { boundary.dispose(); await f.close(); }
  });
});
