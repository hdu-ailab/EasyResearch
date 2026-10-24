import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importPi } from "../runtime/pi-import";
import { AGENT_ALIAS_ENTRY } from "../subagent/agent-alias";
import { SUBAGENT_SESSION_LINK_ENTRY } from "../subagent/session-links";
import { DirectoryService } from "./directories";
import { createReadonlySubagentSessionStore, SubagentSessionService } from "./subagent-sessions";
import { relocateWorkspaceHistories } from "./workspace-history";
import { WorkspaceService } from "./workspaces";

describe("workspace history operations", () => {
  let root: string;
  let cwd: string;
  let pi: Awaited<ReturnType<typeof importPi>>;
  let store: ReturnType<typeof createReadonlySubagentSessionStore>;
  let service: WorkspaceService;
  let events: unknown[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "easyresearch-workspaces-"));
    vi.stubEnv("HOME", root);
    vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(root, "agent"));
    cwd = join(root, "paper");
    mkdirSync(cwd);
    pi = await importPi();
    store = createReadonlySubagentSessionStore(pi);
    events = [];
    service = new WorkspaceService({
      store, sessionsDir: join(pi.getAgentDir(), "sessions"), directories: new DirectoryService(root),
      invalidateUsage: () => {},
      registry: {
        list: () => [],
        withWorkspaceMutation: (_scopes, _force, run) => run([]),
        publishSessionEvent: (_id, event) => { events.push(event); },
      },
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  function history(directory = cwd, name?: string) {
    mkdirSync(directory, { recursive: true });
    const manager = pi.SessionManager.create(directory);
    manager.appendMessage({ role: "user", content: `Original path: ${directory}`, timestamp: 1 });
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Preserved response" }],
      api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 2,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    if (name) manager.appendSessionInfo(name);
    return { id: manager.getSessionId(), path: manager.getSessionFile()!, cwd: directory, manager };
  }
  function pair() {
    const parent = history();
    const child = history(cwd, "easyresearch:search");
    parent.manager.appendCustomEntry(AGENT_ALIAS_ENTRY, {
      id: "search_0", agent: "search", sessionId: child.id, sessionPath: child.path,
    });
    parent.manager.appendCustomEntry(SUBAGENT_SESSION_LINK_ENTRY, {
      toolCallId: "dispatch", agent: "search", childSessionId: child.id, agentId: "search_0",
    });
    return { parent, child };
  }
  function tail(path: string) {
    const bytes = readFileSync(path);
    return bytes.subarray(bytes.indexOf(10) + 1);
  }

  it("renames the real folder, preserves all transcript bytes and reopens the same root/child UUIDs", async () => {
    const { parent, child } = pair();
    const nested = history(join(cwd, "nested"));
    const other = history(`${cwd}-other`);
    writeFileSync(join(cwd, "paper.md"), "manuscript");
    const originals = [parent, child, nested].map((entry) => tail(entry.path));
    const result = await service.rename(cwd, "renamed paper");
    expect(result.cwd).toBe(join(root, "renamed paper"));
    expect(existsSync(cwd)).toBe(false);
    expect(readFileSync(join(result.cwd, "paper.md"), "utf8")).toBe("manuscript");
    for (const [index, entry] of [parent, child, nested].entries()) {
      const manager = pi.SessionManager.open(entry.path);
      expect(manager.getSessionId()).toBe(entry.id);
      expect(manager.getSessionFile()).toBe(entry.path);
      expect(manager.getCwd()).toBe(index === 2 ? join(result.cwd, "nested") : result.cwd);
      expect(tail(entry.path)).toEqual(originals[index]);
    }
    expect(store.open(other.path).getCwd()).toBe(other.cwd);
    const snapshot = await new SubagentSessionService(store).snapshot(parent.id, child.id);
    expect(snapshot.session.id).toBe(child.id);
    expect(snapshot.session.cwd).toBe(result.cwd);
    expect(events).toContainEqual({ type: "session_relocated", sessionId: parent.id, cwd: result.cwd });
  });

  it("recovers an externally moved workspace and preserves existing destination sessions", async () => {
    const { parent, child } = pair();
    writeFileSync(join(cwd, "evidence.txt"), "evidence");
    const destination = join(root, "moved");
    renameSync(cwd, destination);
    const other = history(destination);
    await expect(service.validate(cwd)).rejects.toMatchObject({ code: "WORKSPACE_MISSING", cwd });
    const result = await service.relocate(cwd, destination);
    expect(new Set(result.sessionIds)).toEqual(new Set([parent.id, child.id]));
    expect((await store.listAll()).filter((entry) => entry.cwd === destination).map((entry) => entry.id).sort())
      .toEqual([parent.id, child.id, other.id].sort());
    expect(readFileSync(join(destination, "evidence.txt"), "utf8")).toBe("evidence");
    expect(existsSync(cwd)).toBe(false);
  });

  it("deletes all exact-workspace histories while keeping project files and nested workspaces", async () => {
    const { parent, child } = pair();
    const second = history();
    const orphan = history(cwd, "easyresearch:experiment");
    const nested = history(join(cwd, "independent"));
    writeFileSync(join(cwd, "keep.txt"), "keep");
    const result = await service.delete(cwd);
    expect(new Set(result.sessionIds)).toEqual(new Set([parent.id, child.id, second.id, orphan.id]));
    expect((await store.listAll()).map((entry) => entry.id)).toEqual([nested.id]);
    expect(readFileSync(join(cwd, "keep.txt"), "utf8")).toBe("keep");
    expect(events).toContainEqual({ type: "session_deleted", sessionId: second.id });
  });

  it("can delete a missing workspace without recreating its directory", async () => {
    const entry = history();
    rmSync(cwd, { recursive: true });
    await service.delete(cwd);
    expect(existsSync(entry.path)).toBe(false);
    expect(existsSync(cwd)).toBe(false);
  });

  it("preserves a child referenced by a surviving foreign-workspace fork", async () => {
    const { parent, child } = pair();
    const foreign = join(root, "foreign");
    mkdirSync(foreign);
    const fork = pi.SessionManager.forkFrom(parent.path, foreign);
    await service.delete(cwd);
    expect(existsSync(parent.path)).toBe(false);
    expect(existsSync(child.path)).toBe(true);
    expect(existsSync(fork.getSessionFile()!)).toBe(true);
  });

  it("rejects invalid names, unknown workspaces and occupied destinations without changing histories", async () => {
    const entry = history();
    const original = readFileSync(entry.path);
    for (const name of ["", "..", "../escape", "a/b", "a\\b", " bad", "bad\0name"]) {
      await expect(service.rename(cwd, name)).rejects.toMatchObject({ code: "WORKSPACE_NAME_INVALID" });
    }
    mkdirSync(join(root, "occupied"));
    writeFileSync(join(root, "occupied", "keep"), "other files");
    await expect(service.rename(cwd, "occupied")).rejects.toThrow(/already exists/);
    await expect(service.delete(join(root, "unknown"))).rejects.toMatchObject({ code: "WORKSPACE_UNKNOWN" });
    expect(readFileSync(entry.path)).toEqual(original);
    expect(readFileSync(join(root, "occupied", "keep"), "utf8")).toBe("other files");
  });

  it("rolls back published headers and the folder rename after a later write fails", () => {
    const entries = [history(), history()];
    const originals = entries.map((entry) => readFileSync(entry.path));
    const destination = join(root, "next");
    let writes = 0;
    expect(() => relocateWorkspaceHistories(entries, () => destination, {
      directoryRename: { source: cwd, destination },
      publish: (source, target) => {
        if (++writes === 2) throw new Error("injected disk failure");
        renameSync(source, target);
      },
    })).toThrow("injected disk failure");
    expect(existsSync(cwd)).toBe(true);
    expect(existsSync(destination)).toBe(false);
    for (const [index, entry] of entries.entries()) expect(readFileSync(entry.path)).toEqual(originals[index]);
  });
});
