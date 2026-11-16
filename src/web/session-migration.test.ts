import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importPi } from "../runtime/pi-import";
import { AGENT_ALIAS_ENTRY } from "../subagent/agent-alias";
import type { AgentConfig } from "../subagent/agents";
import { SubagentCoordinator } from "../subagent/coordinator";
import { ActiveSessionRegistry, WorkspaceBusyError } from "./active-sessions";
import { DirectoryService } from "./directories";
import { FileOperationService } from "./file-operations";
import { deleteSessionHistories, prepareSessionDeletion, SessionHistoryConflictError } from "./session-deletion";
import { createSessionHistoryLifecycle } from "./session-lifecycle";
import { createReadonlySubagentSessionStore } from "./subagent-sessions";
import { WorkspaceService } from "./workspaces";
import type { SessionAdapter, SessionFactory } from "./session-adapter";

describe("operation-local session history migration", () => {
  let home: string;
  let oldHome: string;
  let newHome: string;
  let cwd: string;
  let nextCwd: string;
  let sessionsDir: string;
  let pi: Awaited<ReturnType<typeof importPi>>;
  let store: ReturnType<typeof createReadonlySubagentSessionStore>;
  const agent: AgentConfig = { name: "search", description: "fixture", enabled: true, builtin: false,
    systemPrompt: "fixture", source: "global", filePath: "unused", effectiveTools: [], effectiveSkills: [],
    effectiveSkillPaths: [], missingSkills: [] };
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "session-migration-"));
    oldHome = join(home, "old");
    newHome = join(home, "current");
    cwd = join(oldHome, "CV_Workspace");
    nextCwd = join(newHome, "CV_Workspace");
    mkdirSync(nextCwd, { recursive: true });
    vi.stubEnv("HOME", newHome);
    vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(newHome, ".easyresearch", "agent"));
    pi = await importPi();
    sessionsDir = join(pi.getAgentDir(), "sessions");
    store = createReadonlySubagentSessionStore(pi);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  function history(project: string, directory?: string) {
    const manager = pi.SessionManager.create(project, directory);
    manager.appendMessage({ role: "user", content: "synthetic", timestamp: 1 });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "synthetic" }], api: "openai-completions",
      provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    return { id: manager.getSessionId(), path: manager.getSessionFile()!, cwd: project, manager };
  }
  function pair(rootCwd = cwd) {
    const root = history(rootCwd);
    const child = history(nextCwd, dirname(root.path));
    child.manager.appendSessionInfo("easyresearch:search");
    const oldPath = child.path.replace(sessionsDir, join(oldHome, ".easyresearch", "agent", "sessions"));
    const coordinator = new SubagentCoordinator(root.manager);
    const reservation = coordinator.reserveDispatch({ ownerSessionId: root.id, toolCallId: randomUUID(),
      requested: "search", catalog: { all: [agent], available: [agent] } });
    const identity = { childSessionId: child.id, sessionPath: oldPath };
    coordinator.recordChildCreated(reservation, identity);
    coordinator.recordMaterialized(reservation, identity);
    coordinator.recordLaunchAcknowledged(reservation.launchId);
    coordinator.recordTerminal({ launchId: reservation.launchId, status: "complete" });
    return { root, child, oldPath, reservation };
  }
  function services(hook?: (scopes: readonly { cwd: string }[], force: boolean) => Promise<void>) {
    const registry = {
      list: () => [], publishSessionEvent: vi.fn(),
      withWorkspaceMutation: async <T>(scopes: readonly { cwd: string }[], force: boolean, run: (stopped: []) => Promise<T>) => {
        await hook?.(scopes, force);
        return run([]);
      },
    } as unknown as ActiveSessionRegistry;
    return {
      workspace: new WorkspaceService({ store, registry, directories: new DirectoryService(home), sessionsDir, invalidateUsage() {} }),
      individual: createSessionHistoryLifecycle({ store, registry, sessionsDir, usage: { invalidateUsage() {} } }),
    };
  }

  it.each(["workspace", "individual"] as const)("deletes only proven migrated descendants through both scopes: %s", async (mode) => {
    const { root, child } = pair();
    const unrelated = history(nextCwd);
    const nested = history(join(nextCwd, "nested"));
    const preserved = [unrelated, nested].map((item) => readFileSync(item.path));
    writeFileSync(join(nextCwd, "paper.md"), "project evidence");
    const entered: string[][] = [];
    let acquired = false;
    const service = services(async (scopes) => {
      expect(acquired).toBe(true);
      expect(new Set(scopes.map((scope) => scope.cwd))).toEqual(new Set([cwd, nextCwd]));
    });
    const guard = async <T>(scopes: string[], run: () => Promise<T>) => {
      entered.push(scopes); acquired = true;
      return run();
    };
    if (mode === "workspace") await service.workspace.delete(cwd, false, guard);
    else await service.individual.deleteSession(root.id, false, guard);
    expect(entered).toHaveLength(1);
    expect(existsSync(root.path)).toBe(false);
    expect(existsSync(child.path)).toBe(false);
    expect([unrelated, nested].map((item) => readFileSync(item.path))).toEqual(preserved);
    expect(readFileSync(join(nextCwd, "paper.md"), "utf8")).toBe("project evidence");
    expect(existsSync(cwd)).toBe(false);
  });

  it.each(["old file", "old symlink", "ancestor symlink", "role", "UUID", "foreign cwd", "alias", "basename", "duplicate UUID", "custom store"])(
    "rejects ambiguous migration before any removal: %s", async (kind) => {
      const { root, child, oldPath, reservation } = pair();
      if (kind === "old file" || kind === "old symlink") {
        mkdirSync(dirname(oldPath), { recursive: true });
        if (kind === "old file") writeFileSync(oldPath, readFileSync(child.path));
        else symlinkSync(child.path, oldPath);
      }
      if (kind === "ancestor symlink") symlinkSync(newHome, oldHome, "junction");
      if (kind === "role") child.manager.appendSessionInfo("easyresearch:writing");
      if (kind === "UUID" || kind === "foreign cwd") {
        const bytes = readFileSync(child.path, "utf8").split("\n");
        const header = JSON.parse(bytes[0]!);
        bytes[0] = JSON.stringify({ ...header, [kind === "UUID" ? "id" : "cwd"]: kind === "UUID" ? randomUUID() : join(newHome, "other-project") });
        writeFileSync(child.path, bytes.join("\n"));
      }
      if (kind === "alias") root.manager.appendCustomEntry(AGENT_ALIAS_ENTRY, {
        id: reservation.agentId, agent: "writing", sessionId: child.id, sessionPath: oldPath,
      });
      if (kind === "basename") { const next = join(dirname(child.path), "different.jsonl"); renameSync(child.path, next); child.path = next; }
      if (kind === "duplicate UUID") writeFileSync(join(dirname(child.path), "duplicate.jsonl"), readFileSync(child.path));
      if (kind === "custom store") {
        const next = join(newHome, "custom-agent");
        renameSync(pi.getAgentDir(), next);
        root.path = root.path.replace(pi.getAgentDir(), next);
        child.path = child.path.replace(pi.getAgentDir(), next);
        vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", next);
        sessionsDir = join(next, "sessions");
      }
      const before = [root, child].map((item) => readFileSync(item.path));
      const removeFile = vi.fn();
      await expect(deleteSessionHistories([root], { store, sessionsDir, removeFile })).rejects.toBeInstanceOf(SessionHistoryConflictError);
      expect(removeFile).not.toHaveBeenCalled();
      expect([root, child].map((item) => readFileSync(item.path))).toEqual(before);
    },
  );

  it("preserves migrated children referenced by a surviving foreign fork", async () => {
    const { root, child } = pair();
    const fork = pi.SessionManager.forkFrom(root.path, join(newHome, "foreign"));
    const before = [child.path, fork.getSessionFile()!].map((path) => readFileSync(path));
    await services().workspace.delete(cwd);
    expect(existsSync(root.path)).toBe(false);
    expect([child.path, fork.getSessionFile()!].map((path) => readFileSync(path))).toEqual(before);
    // Removing the original must not poison global inventory or grant the foreign
    // fork authority over the child's different actual workspace on its next use.
    const unrelated = history(join(newHome, "unrelated"));
    await deleteSessionHistories([unrelated], { store, sessionsDir });
    await deleteSessionHistories([{ id: fork.getSessionId(), path: fork.getSessionFile()!, cwd: fork.getCwd() }], { store, sessionsDir });
    expect(readFileSync(child.path)).toEqual(before[0]);
  });

  it.each(["original", "current"])("rejects a surviving old coordinator before removing any migrated history: %s cwd", async (scope) => {
    const { root, child } = pair(scope === "original" ? cwd : nextCwd);
    const oldRoot = root.path.replace(sessionsDir, join(oldHome, ".easyresearch", "agent", "sessions"));
    mkdirSync(dirname(oldRoot), { recursive: true });
    writeFileSync(oldRoot, readFileSync(root.path));
    const paths = [oldRoot, root.path, child.path];
    const before = paths.map((path) => readFileSync(path));
    const removeFile = vi.fn();
    await expect(deleteSessionHistories([root], { store, sessionsDir, removeFile })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(removeFile).not.toHaveBeenCalled();
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
  });

  it("revalidates old-coordinator absence after preparation with a materialized child", async () => {
    const { root, child } = pair();
    const removeFile = vi.fn();
    const plan = await prepareSessionDeletion([root], { store, sessionsDir, removeFile });
    const oldRoot = root.path.replace(sessionsDir, join(oldHome, ".easyresearch", "agent", "sessions"));
    mkdirSync(dirname(oldRoot), { recursive: true });
    writeFileSync(oldRoot, readFileSync(root.path));
    expect(() => plan.execute()).toThrow(SessionHistoryConflictError);
    expect(removeFile).not.toHaveBeenCalled();
    expect([oldRoot, root.path, child.path].every((path) => existsSync(path))).toBe(true);
  });

  it("rejects a surviving old alias-only owner even when another coordinator proves the migration", async () => {
    const { root, child, oldPath } = pair();
    const owner = history(cwd);
    owner.manager.appendCustomEntry(AGENT_ALIAS_ENTRY, {
      id: "legacy_search", agent: "search", sessionId: child.id, sessionPath: oldPath,
    });
    const oldOwner = owner.path.replace(sessionsDir, join(oldHome, ".easyresearch", "agent", "sessions"));
    mkdirSync(dirname(oldOwner), { recursive: true });
    writeFileSync(oldOwner, readFileSync(owner.path));
    const paths = [root.path, owner.path, child.path, oldOwner];
    const before = paths.map((path) => readFileSync(path));
    const removeFile = vi.fn();
    await expect(deleteSessionHistories([root, owner], { store, sessionsDir, removeFile })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(removeFile).not.toHaveBeenCalled();
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
  });

  it("lets the last same-workspace fork remove exclusively referenced migrated children", async () => {
    const { root, child } = pair();
    const fork = pi.SessionManager.forkFrom(root.path, cwd);
    const target = { id: fork.getSessionId(), path: fork.getSessionFile()!, cwd: fork.getCwd() };
    expect(await deleteSessionHistories([root], { store, sessionsDir })).toEqual([root.id]);
    expect(existsSync(child.path)).toBe(true);
    expect(await deleteSessionHistories([target], { store, sessionsDir })).toEqual([child.id, target.id]);
  });

  it("uses complete earlier dispatch evidence for an interrupted continuation and an absent reservation", async () => {
    const { root, child, oldPath, reservation } = pair();
    const coordinator = new SubagentCoordinator(root.manager);
    const continuation = coordinator.reserveDispatch({ ownerSessionId: root.id, toolCallId: randomUUID(),
      requested: reservation.agentId, catalog: { all: [agent], available: [agent] } });
    coordinator.recordChildCreated(continuation, { childSessionId: child.id, sessionPath: oldPath });
    const pending = pi.SessionManager.create(cwd);
    const reserved = coordinator.reserveDispatch({ ownerSessionId: root.id, toolCallId: randomUUID(),
      requested: "search", catalog: { all: [agent], available: [agent] } });
    coordinator.recordChildCreated(reserved, { childSessionId: pending.getSessionId(),
      sessionPath: pending.getSessionFile()!.replace(sessionsDir, join(oldHome, ".easyresearch", "agent", "sessions")) });
    const removed = await deleteSessionHistories([root], { store, sessionsDir });
    expect(new Set(removed)).toEqual(new Set([root.id, child.id, pending.getSessionId()]));
    expect(existsSync(pending.getSessionFile()!)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("rejects an unreadable old-path ancestor without treating it as absent", async () => {
    const { root, child } = pair();
    mkdirSync(oldHome);
    chmodSync(oldHome, 0);
    const removeFile = vi.fn();
    try {
      await expect(deleteSessionHistories([root], { store, sessionsDir, removeFile })).rejects.toMatchObject({ code: "SESSION_HISTORY_CONFLICT" });
      expect(removeFile).not.toHaveBeenCalled();
      expect([root, child].every((item) => existsSync(item.path))).toBe(true);
    } finally { chmodSync(oldHome, 0o700); }
  });

  it.each(["workspace", "individual"] as const)("requires explicit force for a busy recovered cwd: %s", async (mode) => {
    const { root, child } = pair();
    const service = services(async (scopes, force) => {
      if (!force) throw new WorkspaceBusyError(scopes.map((scope) => scope.cwd));
    });
    const remove = (force: boolean) => mode === "workspace" ? service.workspace.delete(cwd, force, undefined, force ? [cwd, nextCwd] : undefined)
      : service.individual.deleteSession(root.id, force, undefined, force ? [cwd, nextCwd] : undefined);
    await expect(remove(false)).rejects.toMatchObject({ code: mode === "workspace" ? "WORKSPACE_BUSY" : "SESSION_BUSY", affectedCwds: [cwd, nextCwd] });
    expect([root, child].every((item) => existsSync(item.path))).toBe(true);
    await remove(true);
    expect([root, child].every((item) => !existsSync(item.path))).toBe(true);
  });

  it("rechecks old-path absence after lifecycle acquisition", async () => {
    const { root, child, oldPath } = pair();
    const before = [root, child].map((item) => readFileSync(item.path));
    await expect(services(async () => {
      mkdirSync(dirname(oldPath), { recursive: true });
      writeFileSync(oldPath, readFileSync(child.path));
    }).workspace.delete(cwd)).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect([root, child].map((item) => readFileSync(item.path))).toEqual(before);
  });

  it.each(["workspace", "individual"] as const)("respects current-cwd file ownership before stopping any runtime: %s", async (mode) => {
    const { root, child } = pair();
    const runtime = vi.fn(async () => {});
    const service = services(runtime);
    const files = new FileOperationService({ isKnownCwd: async () => true });
    let release!: () => void;
    const held = files.withWorkspaceMutation([nextCwd], () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    try {
      const guard = <T>(scopes: string[], run: () => Promise<T>) => files.withWorkspaceMutation(scopes, run);
      const deletion = mode === "workspace" ? service.workspace.delete(cwd, true, guard, [cwd, nextCwd])
        : service.individual.deleteSession(root.id, true, guard, [cwd, nextCwd]);
      await expect(deletion).rejects.toMatchObject({ code: "FILE_OPERATION_CONFLICT" });
      expect(runtime).not.toHaveBeenCalled();
      expect([root, child].every((item) => existsSync(item.path))).toBe(true);
    } finally { release(); await held; await files.close(); }
  });

  it("rejects new identities discovered only after lifecycle acquisition", async () => {
    const { root, child } = pair();
    const before = [root, child].map((item) => readFileSync(item.path));
    let added: ReturnType<typeof history>;
    await expect(services(async () => { added = history(cwd); }).workspace.delete(cwd))
      .rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect([root, child].map((item) => readFileSync(item.path))).toEqual(before);
    expect(existsSync(added!.path)).toBe(true);
  });

  it("rejects a replaced physical file even when its copied UUID and cwd match", async () => {
    const { root, child } = pair();
    const original = readFileSync(child.path);
    await expect(services(async () => {
      renameSync(child.path, `${child.path}.backup`);
      writeFileSync(child.path, original);
    }).workspace.delete(cwd)).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(existsSync(root.path)).toBe(true);
    expect(readFileSync(child.path)).toEqual(original);
  });

  it("preserves old native fork provenance after the store moves", async () => {
    const { root, child } = pair();
    const fork = pi.SessionManager.forkFrom(root.path, join(newHome, "foreign"));
    const path = fork.getSessionFile()!;
    const lines = readFileSync(path, "utf8").split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), parentSession: root.path.replace(sessionsDir, join(oldHome, ".easyresearch", "agent", "sessions")) });
    writeFileSync(path, lines.join("\n"));
    const before = readFileSync(path);
    await services().workspace.delete(cwd);
    expect(existsSync(root.path)).toBe(false);
    expect(existsSync(child.path)).toBe(true);
    expect(readFileSync(path)).toEqual(before);
  });

  it("keeps preparation readonly and rejects replacement before the first unlink", async () => {
    const { root, child } = pair();
    const before = [root, child].map((item) => readFileSync(item.path));
    const removeFile = vi.fn();
    const plan = await prepareSessionDeletion([root], { store, sessionsDir, removeFile });
    expect([root, child].map((item) => readFileSync(item.path))).toEqual(before);
    writeFileSync(child.path, readFileSync(child.path, "utf8").replace(child.id, randomUUID()));
    expect(() => plan.execute()).toThrow(SessionHistoryConflictError);
    expect(removeFile).not.toHaveBeenCalled();
  });

  it.each(["original", "current"])("retains a %s-home root after partial failure without blocking unrelated deletion or retry", async (scope) => {
    const { root, child } = pair(scope === "original" ? cwd : nextCwd);
    const unrelated = history(join(newHome, "unrelated"));
    const rootBytes = readFileSync(root.path);
    await expect(deleteSessionHistories([root], { store, sessionsDir, removeFile(path) {
      if (path === root.path) throw new Error("injected failure");
      unlinkSync(path);
    } })).rejects.toThrow("injected failure");
    expect(existsSync(child.path)).toBe(false);
    expect(readFileSync(root.path)).toEqual(rootBytes);
    await expect(deleteSessionHistories([unrelated], { store, sessionsDir })).resolves.toEqual([unrelated.id]);
    expect(existsSync(unrelated.path)).toBe(false);
    expect(readFileSync(root.path)).toEqual(rootBytes);
    await expect(deleteSessionHistories([root], { store, sessionsDir })).resolves.toContain(root.id);
    expect(existsSync(root.path)).toBe(false);
  });

  it("does not infer an all-absent migration for a coordinator outside both home scopes", async () => {
    const { root, child } = pair(join(home, "unanchored-project"));
    unlinkSync(child.path);
    const before = readFileSync(root.path);
    const removeFile = vi.fn();
    await expect(deleteSessionHistories([root], { store, sessionsDir, removeFile })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(removeFile).not.toHaveBeenCalled();
    expect(readFileSync(root.path)).toEqual(before);
  });

  describe.each(["workspace", "individual"] as const)("%s confirmation scope", (mode) => {
    it.each(["expands", "shrinks", "unchanged single cwd"])("rechecks scope when exclusivity %s between requests", async (change) => {
      const { root, child } = pair();
      const foreignCwd = join(newHome, "foreign");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(foreignCwd);
      const fork = change !== "shrinks" ? pi.SessionManager.forkFrom(root.path, foreignCwd) : undefined;
      const unrelated = history(nextCwd);
      const stopped = new Map<string, number>();
      const factory: SessionFactory = { create(options) {
        if (!options.sessionPath) throw new Error("Fixture requires a physical session");
        const manager = store.open(options.sessionPath);
        const id = manager.getSessionId();
        const adapter: Partial<SessionAdapter> = {
          onEvent: () => () => {}, start: async () => {},
          getState: async () => ({ sessionId: id, sessionFile: options.sessionPath, thinkingLevel: "medium",
            isStreaming: true, isCompacting: false, messageCount: 2 }),
          isSupervisorActive: () => false, hasBackgroundWork: () => true, getCompactionState: () => "idle",
          stop: async () => { stopped.set(id, (stopped.get(id) ?? 0) + 1); },
        };
        return adapter as SessionAdapter;
      } };
      const registry = new ActiveSessionRegistry(factory, undefined, { idleTimeoutMs: -1 });
      const files = new FileOperationService({ isKnownCwd: async () => true });
      const guarded = vi.fn<(scopes: string[]) => void>();
      const guard = <T>(scopes: string[], run: () => Promise<T>) => {
        guarded(scopes);
        return files.withWorkspaceMutation(scopes, run);
      };
      const individual = createSessionHistoryLifecycle({ store, registry, sessionsDir, usage: { invalidateUsage() {} } });
      const workspace = new WorkspaceService({ store, registry, sessionsDir, directories: new DirectoryService(home), invalidateUsage() {} });
      const remove = (force: boolean, expectedCwds?: string[]) => mode === "workspace"
        ? workspace.delete(cwd, force, guard, expectedCwds) : individual.deleteSession(root.id, force, guard, expectedCwds);
      const code = mode === "workspace" ? "WORKSPACE_BUSY" : "SESSION_BUSY";
      try {
        await registry.open({ cwd, sessionId: root.id, sessionPath: root.path });
        await registry.open({ cwd: nextCwd, sessionId: unrelated.id, sessionPath: unrelated.path });
        const initiallyDisclosed = change === "shrinks" ? [cwd, nextCwd] : [cwd];
        await expect(remove(false)).rejects.toMatchObject({ code, affectedCwds: initiallyDisclosed });
        expect(stopped.size).toBe(0);
        const rootBytes = readFileSync(root.path);
        const childBytes = readFileSync(child.path);
        const unrelatedBytes = readFileSync(unrelated.path);
        if (change === "expands") {
          // Another view normally deletes the foreign fork; surviving journals do
          // not change, but the child now becomes an exclusive deletion candidate.
          await individual.deleteSession(fork!.getSessionId(), false, guard);
          expect(readFileSync(root.path)).toEqual(rootBytes);
          expect(readFileSync(child.path)).toEqual(childBytes);
          guarded.mockClear();
          for (const stale of [undefined, initiallyDisclosed]) {
            await expect(remove(true, stale)).rejects.toMatchObject({ code, affectedCwds: [cwd, nextCwd] });
            expect(guarded).not.toHaveBeenCalled();
            expect(stopped.size).toBe(0);
            expect(readFileSync(root.path)).toEqual(rootBytes);
            expect(readFileSync(child.path)).toEqual(childBytes);
            expect(readFileSync(unrelated.path)).toEqual(unrelatedBytes);
          }
          await remove(true, [cwd, nextCwd]);
          expect(stopped.get(unrelated.id)).toBe(1);
          expect(existsSync(child.path)).toBe(false);
        } else {
          if (change === "shrinks") pi.SessionManager.forkFrom(root.path, foreignCwd);
          // A disclosed superset is valid. Omission also retains compatibility
          // when the fresh plan really affects only the original target cwd.
          await remove(true, change === "shrinks" ? initiallyDisclosed : undefined);
          expect(stopped.get(unrelated.id) ?? 0).toBe(0);
          expect(readFileSync(child.path)).toEqual(childBytes);
        }
        expect(stopped.get(root.id)).toBe(1);
        expect(existsSync(root.path)).toBe(false);
        expect(readFileSync(unrelated.path)).toEqual(unrelatedBytes);
      } finally { await registry.shutdown(); await files.close(); }
    });
  });
});
