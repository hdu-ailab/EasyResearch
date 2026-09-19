import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importPi } from "../runtime/pi-import";
import { AGENT_ALIAS_ENTRY } from "../subagent/agent-alias";
import type { AgentConfig } from "../subagent/agents";
import { SubagentCoordinator } from "../subagent/coordinator";
import { SUBAGENT_SESSION_LINK_ENTRY } from "../subagent/session-links";
import {
  deleteSessionHistory, SessionHistoryConflictError, type SessionHistoryTarget,
} from "./session-deletion";
import { createReadonlySubagentSessionStore, type SubagentSessionStore } from "./subagent-sessions";

type Pi = Awaited<ReturnType<typeof importPi>>;
type Manager = ReturnType<Pi["SessionManager"]["create"]>;
type History = SessionHistoryTarget & { manager: Manager };

describe("deleteSessionHistory", () => {
  let pi: Pi;
  let home: string;
  let cwd: string;
  let sessionsDir: string;
  let store: SubagentSessionStore;
  const agent: AgentConfig = {
    name: "search", description: "fixture", enabled: true, builtin: false,
    systemPrompt: "fixture", source: "global", filePath: "unused",
    effectiveTools: [], effectiveSkills: [], effectiveSkillPaths: [], missingSkills: [],
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "easyresearch-deletion-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", join(home, ".easyresearch", "agent"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    pi = await importPi();
    sessionsDir = join(pi.getAgentDir(), "sessions");
    store = createReadonlySubagentSessionStore(pi);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function history(persist = true, project = cwd): History {
    const manager = pi.SessionManager.create(project);
    if (persist) {
      manager.appendMessage({ role: "user", content: "fixture request", timestamp: Date.now() });
      manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "fixture response" }],
        api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop",
        timestamp: Date.now(), usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
    }
    return { id: manager.getSessionId(), path: manager.getSessionFile()!, cwd: manager.getCwd(), manager };
  }

  function dispatch(root: History, child: SessionHistoryTarget, options: {
    owner?: History; requested?: string; state?: "created" | "suppressed" | "failed";
  } = {}) {
    const coordinator = new SubagentCoordinator(root.manager);
    const reservation = coordinator.reserveDispatch({
      ownerSessionId: options.owner?.id ?? root.id, toolCallId: randomUUID(),
      requested: options.requested ?? agent.name, catalog: { all: [agent], available: [agent] },
    });
    const identity = { childSessionId: child.id, sessionPath: child.path };
    coordinator.recordChildCreated(reservation, identity);
    if (options.state === "created") return reservation;
    if (options.state === "failed") {
      coordinator.recordPreMaterializationFailure(reservation, new Error("fixture failure"));
      return reservation;
    }
    coordinator.recordMaterialized(reservation, identity);
    if (options.state === "suppressed") coordinator.recordLaunchSuppressed(reservation.launchId);
    else {
      coordinator.recordLaunchAcknowledged(reservation.launchId);
      coordinator.recordTerminal({ launchId: reservation.launchId, status: "complete" });
    }
    return reservation;
  }

  function alias(owner: History, child: SessionHistoryTarget) {
    owner.manager.appendCustomEntry(AGENT_ALIAS_ENTRY, {
      id: randomUUID(), agent: agent.name, sessionId: child.id, sessionPath: child.path,
    });
  }

  function link(owner: History, child: SessionHistoryTarget) {
    owner.manager.appendCustomEntry(SUBAGENT_SESSION_LINK_ENTRY, {
      toolCallId: randomUUID(), agent: agent.name, childSessionId: child.id,
    });
  }

  function rewriteHeader(session: History, patch: Record<string, unknown>) {
    writeFileSync(session.path, [
      { ...session.manager.getHeader(), ...patch }, ...session.manager.getEntries(),
    ].map((entry) => JSON.stringify(entry)).join("\n"));
  }

  function breakSummary(session: History) {
    writeFileSync(session.path, [session.manager.getHeader(), ...session.manager.getEntries().map((entry) =>
      entry.type === "message" && entry.message.role === "assistant"
        ? { ...entry, message: { ...entry.message, content: null } } : entry,
    )].map((entry) => JSON.stringify(entry)).join("\n"));
  }

  function fork(source: History, project = cwd): History {
    mkdirSync(project, { recursive: true });
    const manager = pi.SessionManager.forkFrom(source.path, project);
    return { id: manager.getSessionId(), path: manager.getSessionFile()!, cwd: manager.getCwd(), manager };
  }

  describe.each(["same cwd", "foreign cwd"])("fully listed native forks in %s", (scope) => {
    function fixture() {
      const root = history();
      const child = history();
      const nested = history();
      const unrelated = history();
      dispatch(root, child);
      // Only the coordinator records this nested ownership, including in its fork.
      dispatch(root, nested, { owner: child });
      const sourcePath = join(dirname(root.path), "source-without-uuid-or-timestamp.jsonl");
      renameSync(root.path, sourcePath);
      root.path = sourcePath;
      const copied = fork(root, scope === "same cwd" ? cwd : join(home, "fork-project"));
      return { root, child, nested, unrelated, copied };
    }

    it("does not block unrelated-root deletion or change any shared history", async () => {
      const { root, child, nested, unrelated, copied } = fixture();
      const files = [root, child, nested, unrelated, copied];
      expect(new Set((await store.listAll()).map((session) => session.id))).toEqual(new Set(files.map((session) => session.id)));
      expect(copied.manager.getHeader()?.parentSession).toBe(root.path);
      expect(copied.manager.getEntries()).toEqual(root.manager.getEntries());
      const preserved = [root, child, nested, copied];
      const before = preserved.map((session) => readFileSync(session.path));

      expect(await deleteSessionHistory(unrelated, { sessionsDir, store })).toEqual([unrelated.id]);
      expect(existsSync(unrelated.path)).toBe(false);
      expect(preserved.map((session) => readFileSync(session.path))).toEqual(before);
    });

    it.each(["source first", "fork first"])("preserves shared history and stays cwd-bounded when deleting %s", async (order) => {
      const { root, child, nested, unrelated, copied } = fixture();
      const files = [root, child, nested, unrelated, copied];
      expect(new Set((await store.listAll()).map((session) => session.id))).toEqual(new Set(files.map((session) => session.id)));
      const [first, last] = order === "source first" ? [root, copied] : [copied, root];
      const preserved = [last, child, nested, unrelated];
      const before = preserved.map((session) => readFileSync(session.path));

      expect(await deleteSessionHistory(first, { sessionsDir, store })).toEqual([first.id]);
      expect(existsSync(first.path)).toBe(false);
      expect(preserved.map((session) => readFileSync(session.path))).toEqual(before);
      const foreignOnly = scope === "foreign cwd" && last === copied;
      expect(await deleteSessionHistory(last, { sessionsDir, store }))
        .toEqual(foreignOnly ? [last.id] : [nested.id, child.id, last.id]);
      expect(existsSync(last.path)).toBe(false);
      if (foreignOnly) expect([child, nested].map((session) => readFileSync(session.path))).toEqual(before.slice(1, 3));
      else expect([child, nested].every((session) => !existsSync(session.path))).toBe(true);
      expect(readFileSync(unrelated.path)).toEqual(before[3]);
    });

    it("preserves shared nested references when deleting a surviving fork after its source was removed", async () => {
      const { root, child, nested, unrelated, copied } = fixture();
      const survivor = history();
      link(survivor, child);
      const local = history(true, copied.cwd);
      dispatch(copied, local);
      unlinkSync(root.path);
      const files = [child, nested, unrelated, copied, survivor, local];
      expect(new Set((await store.listAll()).map((session) => session.id))).toEqual(new Set(files.map((session) => session.id)));
      const preserved = [child, nested, unrelated, survivor];
      const before = preserved.map((session) => readFileSync(session.path));

      expect(await deleteSessionHistory(copied, { sessionsDir, store })).toEqual([local.id, copied.id]);
      expect([root, copied, local].every((session) => !existsSync(session.path))).toBe(true);
      expect(preserved.map((session) => readFileSync(session.path))).toEqual(before);
    });

    it("retains native source provenance through a removed intermediate fork", async () => {
      const { root, child, nested, unrelated, copied } = fixture();
      const survivingFork = fork(copied, copied.cwd);
      expect(await store.listAll()).toHaveLength(6);
      const preserved = [root, child, nested, survivingFork];
      const before = preserved.map((session) => readFileSync(session.path));

      expect(await deleteSessionHistory(copied, { sessionsDir, store })).toEqual([copied.id]);
      expect(await deleteSessionHistory(unrelated, { sessionsDir, store })).toEqual([unrelated.id]);
      expect(preserved.map((session) => readFileSync(session.path))).toEqual(before);
      expect(await deleteSessionHistory(root, { sessionsDir, store })).toEqual([root.id]);
      expect(await deleteSessionHistory(survivingFork, { sessionsDir, store }))
        .toEqual(scope === "same cwd" ? [nested.id, child.id, survivingFork.id] : [survivingFork.id]);
      if (scope === "foreign cwd") expect([child, nested].map((session) => readFileSync(session.path))).toEqual(before.slice(1, 3));
      else expect([child, nested].every((session) => !existsSync(session.path))).toBe(true);
    });
  });

  describe.each(["created", "suppressed"] as const)("foreign forks with a never-materialized %s child", (state) => {
    describe.each(["native", "reversed"])("%s listing order", (order) => {
      function fixture() {
        const root = history();
        const missing = history(false);
        const reserved = dispatch(root, missing, { state: "created" });
        if (state === "suppressed") new SubagentCoordinator(root.manager).recordLaunchSuppressed(reserved.launchId);
        const nativeStore = store;
        const orderedStore = {
          ...nativeStore,
          listAll: async () => {
            const listed = await nativeStore.listAll();
            return order === "native" ? listed : listed.reverse();
          },
        };
        return { root, missing, orderedStore };
      }

      it.each(["fork", "unrelated", "source"])("deletes %s first without assigning the fork cwd to the missing child", async (selected) => {
        const { root, missing, orderedStore } = fixture();
        const copied = fork(root, join(home, "fork-project"));
        const unrelated = history();
        const files = [root, copied, unrelated];
        expect(new Set((await store.listAll()).map((session) => session.id))).toEqual(new Set(files.map((session) => session.id)));
        expect(existsSync(missing.path)).toBe(false);
        const target = selected === "fork" ? copied : selected === "source" ? root : unrelated;
        const preserved = files.filter((session) => session !== target);
        const before = preserved.map((session) => readFileSync(session.path));

        expect(await deleteSessionHistory(target, { sessionsDir, store: orderedStore })).toEqual([target.id]);
        expect(existsSync(target.path)).toBe(false);
        expect(preserved.map((session) => readFileSync(session.path))).toEqual(before);
        if (selected !== "fork") {
          expect(await deleteSessionHistory(copied, { sessionsDir, store: orderedStore })).toEqual([copied.id]);
        }
        if (selected !== "source") {
          expect(await deleteSessionHistory(root, { sessionsDir, store: orderedStore })).toEqual([missing.id, root.id]);
        }
        expect(existsSync(missing.path)).toBe(false);
      });

      it.each([false, true])("preserves foreign nested history after source removal with surviving mapping=%s", async (shared) => {
        const { root, missing, orderedStore } = fixture();
        const nested = history();
        dispatch(root, nested, { owner: missing });
        const copied = fork(root, join(home, "fork-project"));
        const unrelated = history();
        if (shared) link(unrelated, missing);
        const local = history(true, copied.cwd);
        dispatch(copied, local);
        unlinkSync(root.path);
        const files = [nested, copied, unrelated, local];
        expect(new Set((await store.listAll()).map((session) => session.id))).toEqual(new Set(files.map((session) => session.id)));
        expect(existsSync(missing.path)).toBe(false);
        const preserved = [nested, copied, local];
        const before = preserved.map((session) => readFileSync(session.path));

        expect(await deleteSessionHistory(unrelated, { sessionsDir, store: orderedStore })).toEqual([unrelated.id]);
        expect(preserved.map((session) => readFileSync(session.path))).toEqual(before);
        expect(await deleteSessionHistory(copied, { sessionsDir, store: orderedStore })).toEqual([local.id, copied.id]);
        expect(readFileSync(nested.path)).toEqual(before[0]);
        expect([root, missing, copied, local, unrelated].every((session) => !existsSync(session.path))).toBe(true);
      });
    });
  });

  it.each([false, true])("does not invent a surviving owner for a missing node after source removal, shared fork=%s", async (shared) => {
    const root = history();
    const missing = history(false);
    const nested = history();
    dispatch(root, missing, { state: "created" });
    dispatch(root, nested, { owner: missing });
    const copied = fork(root);
    const survivor = shared ? fork(root, join(home, "other-project")) : undefined;
    unlinkSync(root.path);
    const before = readFileSync(nested.path);

    expect(await deleteSessionHistory(copied, { sessionsDir, store })).toEqual(shared ? [copied.id] : [nested.id, copied.id]);
    expect(existsSync(missing.path)).toBe(false);
    if (survivor) {
      expect(readFileSync(nested.path)).toEqual(before);
      expect(await deleteSessionHistory(survivor, { sessionsDir, store })).toEqual([survivor.id]);
      expect(readFileSync(nested.path)).toEqual(before);
    } else expect(existsSync(nested.path)).toBe(false);
  });

  it.each(["valid", "UUID mismatch", "normalized cwd", "missing cwd"])("inspects an unlisted real file rather than treating its cwd as unobserved: %s", async (kind) => {
    const root = history();
    const child = history();
    dispatch(root, child);
    const copied = fork(root, join(home, "fork-project"));
    const unrelated = history();
    unlinkSync(root.path);
    const header = { ...child.manager.getHeader(),
      ...(kind === "UUID mismatch" ? { id: randomUUID() } : {}),
      ...(kind === "normalized cwd" ? { cwd: `${child.cwd}/.` } : {}),
      ...(kind === "missing cwd" ? { cwd: undefined } : {}),
    };
    writeFileSync(child.path, [header, ...child.manager.getEntries().map((entry) =>
      entry.type === "message" && entry.message.role === "assistant"
        ? { ...entry, message: { ...entry.message, content: null } } : entry,
    )].map((entry) => JSON.stringify(entry)).join("\n"));
    expect(new Set((await store.listAll()).map((session) => session.id))).toEqual(new Set([copied.id, unrelated.id]));
    const files = [child, copied, unrelated];
    const before = files.map((session) => readFileSync(session.path));

    if (kind === "valid") {
      expect(await deleteSessionHistory(unrelated, { sessionsDir, store })).toEqual([unrelated.id]);
      expect(await deleteSessionHistory(copied, { sessionsDir, store })).toEqual([copied.id]);
      expect(readFileSync(child.path)).toEqual(before[0]);
    } else {
      await expect(deleteSessionHistory(unrelated, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
      expect(files.map((session) => readFileSync(session.path))).toEqual(before);
    }
  });

  it.each(["no fork", "unrelated parent", "new foreign mapping", "unrelated owner", "unknown owner"])(
    "does not grant inherited-reference authority to %s", async (invalid) => {
      const root = history();
      const child = history();
      const unrelated = history();
      dispatch(root, child);
      const foreignCwd = join(home, "foreign-project");
      mkdirSync(foreignCwd);
      const copied = invalid === "no fork" ? history(true, foreignCwd) : fork(root, foreignCwd);
      if (invalid === "no fork") alias(copied, child);
      if (invalid === "unrelated parent") rewriteHeader(copied, { parentSession: unrelated.path });
      if (invalid === "new foreign mapping") alias(copied, unrelated);
      if (invalid === "unrelated owner" || invalid === "unknown owner") {
        dispatch(copied, history(true, foreignCwd), { owner: invalid === "unrelated owner" ? unrelated : history(false, foreignCwd) });
      }
      const files = await store.listAll();
      const before = files.map((session) => readFileSync(session.path));
      await expect(deleteSessionHistory(unrelated, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
      expect(files.map((session) => readFileSync(session.path))).toEqual(before);
    },
  );

  it.each(["local owner", "different launch"])("does not treat a new foreign mapping with %s as inherited after source removal", async (kind) => {
    const root = history();
    const child = history();
    dispatch(root, child);
    const copied = fork(root, join(home, "fork-project"));
    const unrelated = history();
    const foreign = history();
    dispatch(unrelated, foreign);
    dispatch(copied, foreign, kind === "different launch" ? { owner: unrelated } : {});
    unlinkSync(root.path);
    const files = await store.listAll();
    const before = files.map((session) => readFileSync(session.path));

    await expect(deleteSessionHistory(copied, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(files.map((session) => readFileSync(session.path))).toEqual(before);
  });

  it.each(["cycle", "relative", "outside store", "replaced source"])("rejects unsafe native-fork provenance: %s", async (kind) => {
    const root = history();
    const child = history();
    dispatch(root, child);
    const copied = fork(root);
    const unrelated = history();
    if (kind === "replaced source") {
      unlinkSync(root.path);
      renameSync(unrelated.path, root.path);
      unrelated.path = root.path;
    } else rewriteHeader(copied, {
      parentSession: kind === "cycle" ? copied.path : kind === "relative" ? "missing.jsonl" : join(cwd, "missing.jsonl"),
    });
    const files = await store.listAll();
    const before = files.map((session) => readFileSync(session.path));

    await expect(deleteSessionHistory(copied, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(files.map((session) => readFileSync(session.path))).toEqual(before);
  });

  it("removes only exact owned histories, preserving same-cwd siblings and project files byte-for-byte", async () => {
    const root = history();
    const child = history();
    const sibling = history();
    // Names and a common storage directory are not ownership evidence.
    for (const session of [root, child, sibling]) session.manager.appendSessionInfo("same name");
    dispatch(root, child);
    const siblingBefore = readFileSync(sibling.path).subarray(0, -1);
    writeFileSync(sibling.path, siblingBefore);
    const projectFile = join(cwd, "manuscript.md");
    writeFileSync(projectFile, "keep me");

    expect(await deleteSessionHistory(root, { sessionsDir, store })).toEqual([child.id, root.id]);
    expect(existsSync(root.path)).toBe(false);
    expect(existsSync(child.path)).toBe(false);
    expect(readFileSync(sibling.path)).toEqual(siblingBefore);
    expect(readFileSync(projectFile, "utf8")).toBe("keep me");
    expect(existsSync(dirname(root.path))).toBe(true);
  });

  it("includes created, suppressed, and failed jobs and deletes nested continuations once in postorder", async () => {
    const root = history();
    const owner = history();
    const nested = history();
    const suppressed = history();
    const failed = history();
    const reservation = dispatch(root, owner);
    dispatch(root, nested, { owner, state: "created" });
    dispatch(root, suppressed, { state: "suppressed" });
    dispatch(root, failed, { state: "failed" });
    dispatch(root, owner, { requested: reservation.agentId });
    const removed: string[] = [];

    const ids = await deleteSessionHistory(root, {
      sessionsDir, store, removeFile(path) { unlinkSync(path); removed.push(path); },
    });
    expect(new Set(ids)).toEqual(new Set([root.id, owner.id, nested.id, suppressed.id, failed.id]));
    expect(removed).toHaveLength(ids.length);
    expect(removed.indexOf(nested.path)).toBeLessThan(removed.indexOf(owner.path));
    expect(removed.at(-1)).toBe(root.path);
    expect(removed.every((path) => !existsSync(path))).toBe(true);
  });

  it("follows legacy native-list links and nested alias-only mappings without reconstructing names", async () => {
    const root = history();
    const child = history();
    const nested = history();
    const original = nested.path;
    nested.path = join(dirname(nested.path), "not-a-timestamp.jsonl");
    renameSync(original, nested.path);
    link(root, child);
    alias(child, nested);
    link(child, nested);
    link(root, child);

    expect(await deleteSessionHistory(root, { sessionsDir, store })).toEqual([nested.id, child.id, root.id]);
    expect([root, child, nested].every((session) => !existsSync(session.path))).toBe(true);
  });

  it("protects a shared child and all reachable history, including edges stored only in the deleted root", async () => {
    const root = history();
    const survivor = history();
    const shared = history();
    const nested = history();
    const deep = history();
    const exclusive = history();
    dispatch(root, shared);
    dispatch(root, nested, { owner: shared, state: "created" });
    link(nested, deep);
    dispatch(root, exclusive);
    link(survivor, shared);
    const preserved = [survivor, shared, nested, deep];
    const before = preserved.map((session) => readFileSync(session.path));

    expect(new Set(await deleteSessionHistory(root, { sessionsDir, store }))).toEqual(new Set([exclusive.id, root.id]));
    expect(preserved.map((session) => readFileSync(session.path))).toEqual(before);
    expect(existsSync(exclusive.path)).toBe(false);
    expect(existsSync(root.path)).toBe(false);
  });

  it.each(["same directory", "another directory"])("preserves shared history when native listing omits a readable root in %s", async (location) => {
    const root = history();
    const survivor = history();
    const exclusive = history();
    const shared = history();
    const nested = history();
    dispatch(root, exclusive);
    dispatch(root, shared);
    dispatch(root, nested, { owner: shared });
    link(survivor, shared);
    breakSummary(survivor);
    if (location === "another directory") {
      const directory = join(sessionsDir, "other-native-directory");
      mkdirSync(directory);
      const path = join(directory, "survivor.jsonl");
      renameSync(survivor.path, path);
      survivor.path = path;
    }
    const listed = await store.listAll();
    expect(listed.some((session) => session.id === root.id)).toBe(true);
    expect(listed.some((session) => session.id === shared.id)).toBe(true);
    expect(listed.some((session) => session.id === survivor.id)).toBe(false);
    const readable = store.open(survivor.path);
    expect(readable.getSessionId()).toBe(survivor.id);
    expect(readable.getEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ customType: SUBAGENT_SESSION_LINK_ENTRY, data: expect.objectContaining({ childSessionId: shared.id }) }),
    ]));
    const files = [root, survivor, exclusive, shared, nested];
    const before = files.map((session) => readFileSync(session.path));

    await expect(deleteSessionHistory(root, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(files.map((session) => readFileSync(session.path))).toEqual(before);
  });

  it.each(["same cwd", "foreign cwd"])("preserves copied child mappings when native listing omits a native fork with %s", async (scope) => {
    const root = history();
    const child = history();
    const nested = history();
    dispatch(root, child);
    dispatch(root, nested, { owner: child });
    const forkCwd = scope === "same cwd" ? cwd : join(home, "fork-project");
    mkdirSync(forkCwd, { recursive: true });
    const manager = pi.SessionManager.forkFrom(root.path, forkCwd);
    const fork: History = {
      id: manager.getSessionId(), cwd: manager.getCwd(), path: manager.getSessionFile()!, manager,
    };
    expect(fork.id).not.toBe(root.id);
    expect(fork.cwd).toBe(forkCwd);
    breakSummary(fork);
    const listed = await store.listAll();
    expect(listed.some((session) => session.id === root.id)).toBe(true);
    expect(listed.some((session) => session.id === child.id)).toBe(true);
    expect(listed.some((session) => session.id === fork.id)).toBe(false);
    const readable = store.open(fork.path);
    expect(readable.getCwd()).toBe(forkCwd);
    expect(readable.getEntries()).toEqual(expect.arrayContaining([child, nested].map((session) =>
      expect.objectContaining({ customType: SUBAGENT_SESSION_LINK_ENTRY, data: expect.objectContaining({ childSessionId: session.id }) }),
    )));
    const files = [root, fork, child, nested];
    const before = files.map((session) => readFileSync(session.path));

    await expect(deleteSessionHistory(root, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(files.map((session) => readFileSync(session.path))).toEqual(before);
  });

  it("does not infer exclusivity from a foreign cwd in an unaccounted history", async () => {
    const root = history();
    const child = history();
    dispatch(root, child);
    const otherCwd = join(home, "other-project");
    mkdirSync(otherCwd);
    const unrelated = history(true, otherCwd);
    breakSummary(unrelated);
    expect((await store.listAll()).some((session) => session.id === unrelated.id)).toBe(false);
    const files = [root, child, unrelated];
    const before = files.map((session) => readFileSync(session.path));

    await expect(deleteSessionHistory(root, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(files.map((session) => readFileSync(session.path))).toEqual(before);
  });

  it("ignores non-history resources and preserves unrelated listed foreign-cwd history", async () => {
    const root = history();
    const child = history();
    dispatch(root, child);
    const otherCwd = join(home, "other-project");
    mkdirSync(otherCwd);
    const unrelated = history(true, otherCwd);
    expect((await store.listAll()).some((session) => session.id === unrelated.id)).toBe(true);
    const before = readFileSync(unrelated.path);
    const resource = join(dirname(root.path), "notes.txt");
    writeFileSync(resource, "not JSONL history");

    expect(await deleteSessionHistory(root, { sessionsDir, store })).toEqual([child.id, root.id]);
    expect(readFileSync(unrelated.path)).toEqual(before);
    expect(readFileSync(resource, "utf8")).toBe("not JSONL history");
  });

  it("accounts for a native-list-omitted child through an exact persisted mapping", async () => {
    const root = history();
    const child = history();
    dispatch(root, child, { state: "created" });
    breakSummary(child);
    expect((await store.listAll()).some((session) => session.id === child.id)).toBe(false);

    expect(await deleteSessionHistory(root, { sessionsDir, store })).toEqual([child.id, root.id]);
    expect(existsSync(child.path)).toBe(false);
    expect(existsSync(root.path)).toBe(false);
  });

  it.each(["invalid header", "oversized header", "file symlink", "directory symlink"])("fails closed on unaccounted physical history with %s", async (invalid) => {
    const root = history();
    const child = history();
    dispatch(root, child);
    const unaccounted = history();
    if (invalid === "invalid header") writeFileSync(unaccounted.path, "invalid header\n");
    if (invalid === "oversized header") {
      breakSummary(unaccounted);
      const entries = readFileSync(unaccounted.path, "utf8").split("\n").slice(1);
      writeFileSync(unaccounted.path, [
        JSON.stringify({ ...unaccounted.manager.getHeader(), padding: "x".repeat(128 * 1024) }), ...entries,
      ].join("\n"));
    }
    if (invalid === "file symlink" || invalid === "directory symlink") {
      breakSummary(unaccounted);
      const external = join(cwd, "outside-history");
      mkdirSync(external);
      const externalPath = join(external, "unaccounted.jsonl");
      renameSync(unaccounted.path, externalPath);
      if (invalid === "file symlink") symlinkSync(externalPath, unaccounted.path);
      else symlinkSync(external, join(sessionsDir, "unaccounted-directory"), "junction");
      unaccounted.path = externalPath;
    }
    expect((await store.listAll()).some((session) => session.id === unaccounted.id)).toBe(false);
    const files = [root, child, unaccounted];
    const before = files.map((session) => readFileSync(session.path));

    await expect(deleteSessionHistory(root, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(files.map((session) => readFileSync(session.path))).toEqual(before);
  });

  it("tolerates absent mapped children, legacy UUID-only links, and unmaterialized reservations", async () => {
    const root = history();
    const missing = history();
    const legacy = history();
    const neverWritten = history(false);
    dispatch(root, missing);
    link(root, legacy);
    dispatch(root, neverWritten, { state: "created" });
    new SubagentCoordinator(root.manager).reserveDispatch({
      ownerSessionId: root.id, toolCallId: randomUUID(), requested: agent.name,
      catalog: { all: [agent], available: [agent] },
    });
    unlinkSync(missing.path);
    unlinkSync(legacy.path);

    expect(new Set(await deleteSessionHistory(root, { sessionsDir, store })))
      .toEqual(new Set([root.id, missing.id, legacy.id, neverWritten.id]));
    expect([root, missing, legacy, neverWritten].every((session) => !existsSync(session.path))).toBe(true);
  });

  it("retains the ownership index after a later-child failure and completes a root-last retry", async () => {
    const root = history();
    const owner = history();
    const nested = history();
    const later = history();
    dispatch(root, owner);
    dispatch(root, nested, { owner });
    dispatch(root, later);
    const rootBefore = readFileSync(root.path);
    const failure = Object.assign(new Error("injected EACCES"), { code: "EACCES" });

    await expect(deleteSessionHistory(root, {
      sessionsDir, store, removeFile(path) {
        if (path === later.path) throw failure;
        unlinkSync(path);
      },
    })).rejects.toBe(failure);
    expect(existsSync(nested.path)).toBe(false);
    expect(existsSync(owner.path)).toBe(false);
    expect(readFileSync(root.path)).toEqual(rootBefore);
    expect(existsSync(later.path)).toBe(true);
    expect(new Set(await deleteSessionHistory(root, { sessionsDir, store })))
      .toEqual(new Set([root.id, owner.id, nested.id, later.id]));
    expect([root, owner, nested, later].every((session) => !existsSync(session.path))).toBe(true);
  });

  it.each(["id", "cwd", "malformed"])("validates every candidate before removing anything when a child has replaced %s", async (field) => {
    const root = history();
    const first = history();
    const invalid = history();
    dispatch(root, first);
    dispatch(root, invalid);
    if (field === "malformed") writeFileSync(invalid.path, "not a session");
    else rewriteHeader(invalid, { [field]: field === "id" ? randomUUID() : home });
    const files = [root, first, invalid];
    const before = files.map((session) => readFileSync(session.path));

    await expect(deleteSessionHistory(root, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(files.map((session) => readFileSync(session.path))).toEqual(before);
  });

  it.each(["id", "cwd", "path", "unlisted"])("refuses a root with a stale native-list %s", async (field) => {
    const root = history();
    const before = readFileSync(root.path);
    const stale = { id: root.id, cwd: root.cwd, path: root.path };
    if (field === "id") stale.id = randomUUID();
    if (field === "cwd") stale.cwd = home;
    if (field === "path") stale.path = join(dirname(root.path), "other.jsonl");
    const staleStore = { ...store, listAll: async () => field === "unlisted" ? [] : [stale] };

    await expect(deleteSessionHistory(root, { sessionsDir, store: staleStore, allowMissingRoot: true }))
      .rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(readFileSync(root.path)).toEqual(before);
  });

  it.each(["normalized cwd", "late header"])("checks the original physical header rather than accepting a %s", async (invalid) => {
    const root = history();
    const child = history();
    dispatch(root, child);
    const listed = await store.listAll();
    if (invalid === "normalized cwd") rewriteHeader(child, { cwd: `${child.cwd}/.` });
    else writeFileSync(child.path, `not a header\n${readFileSync(child.path, "utf8")}`);
    const before = [root, child].map((session) => readFileSync(session.path));
    await expect(deleteSessionHistory(root, {
      sessionsDir, store: { ...store, listAll: async () => listed },
    })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect([root, child].map((session) => readFileSync(session.path))).toEqual(before);
  });

  it("permits a missing lazy root only under explicit owned-session authority", async () => {
    const root = history(false);
    await expect(deleteSessionHistory(root, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(await deleteSessionHistory(root, { sessionsDir, store, allowMissingRoot: true })).toEqual([root.id]);
    expect(existsSync(root.path)).toBe(false);
  });

  it.each(["duplicate UUID", "conflicting alias", "cycle", "unknown owner"])("refuses %s before any removal", async (invalid) => {
    const root = history();
    const child = history();
    dispatch(root, child);
    if (invalid === "duplicate UUID") writeFileSync(join(dirname(child.path), "duplicate.jsonl"), readFileSync(child.path));
    if (invalid === "conflicting alias") alias(root, { ...child, path: join(dirname(child.path), "other.jsonl") });
    if (invalid === "cycle") link(child, root);
    if (invalid === "unknown owner") dispatch(root, history(), { owner: history(false) });
    const before = [root, child].map((session) => readFileSync(session.path));

    await expect(deleteSessionHistory(root, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect([root, child].map((session) => readFileSync(session.path))).toEqual(before);
  });

  it.each(["launch link", "agent alias"])("refuses a %s that contradicts a journaled child identity", async (kind) => {
    const root = history();
    const child = history();
    const unrelated = history();
    const reservation = dispatch(root, child);
    if (kind === "launch link") {
      root.manager.appendCustomEntry(SUBAGENT_SESSION_LINK_ENTRY, {
        toolCallId: reservation.toolCallId, launchId: reservation.launchId,
        agent: reservation.agent, agentId: reservation.agentId,
        ownerSessionId: root.id, childSessionId: unrelated.id,
      });
    } else {
      root.manager.appendCustomEntry(AGENT_ALIAS_ENTRY, {
        id: reservation.agentId, agent: reservation.agent,
        sessionId: unrelated.id, sessionPath: unrelated.path,
      });
    }
    const files = [root, child, unrelated];
    const before = files.map((session) => readFileSync(session.path));
    await expect(deleteSessionHistory(root, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(files.map((session) => readFileSync(session.path))).toEqual(before);
  });

  it("refuses direct deletion of a history referenced by a surviving root", async () => {
    const root = history();
    const child = history();
    dispatch(root, child);
    const before = [root, child].map((session) => readFileSync(session.path));
    await expect(deleteSessionHistory(child, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect([root, child].map((session) => readFileSync(session.path))).toEqual(before);
  });

  it.each(["directory", "symlink", "outside store"])("refuses a %s root under missing-root authority", async (invalid) => {
    const root = history();
    const listed = await store.listAll();
    const original = root.path;
    const outside = join(cwd, "protected.jsonl");
    const before = readFileSync(root.path);
    renameSync(root.path, outside);
    if (invalid === "directory") mkdirSync(root.path);
    else if (invalid === "symlink") symlinkSync(outside, root.path);
    else root.path = outside;
    await expect(deleteSessionHistory(root, {
      sessionsDir, store: { ...store, listAll: async () => listed.map((item) => item.path === original ? { ...item, path: root.path } : item) },
      allowMissingRoot: true,
    })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(readFileSync(outside)).toEqual(before);
  });

  it("revalidates physical containment before unlinking a child whose directory was replaced", async () => {
    const root = history();
    const first = history();
    const child = history();
    const directory = join(sessionsDir, "owned");
    mkdirSync(directory);
    const original = child.path;
    child.path = join(directory, "child.jsonl");
    renameSync(original, child.path);
    dispatch(root, first);
    dispatch(root, child);
    const outside = join(cwd, "protected");
    await expect(deleteSessionHistory(root, {
      sessionsDir, store, removeFile(path) {
        unlinkSync(path);
        if (path === first.path) {
          renameSync(directory, outside);
          symlinkSync(outside, directory, "junction");
        }
      },
    })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(existsSync(join(outside, "child.jsonl"))).toBe(true);
    expect(existsSync(root.path)).toBe(true);
  });

  it.each(["directory", "symlink", "outside store", "relative path", "non-JSONL", "ancestor symlink"])("rejects a mapped %s rather than touching that target", async (invalid) => {
    const root = history();
    const child = history();
    const before = readFileSync(child.path);
    if (invalid === "directory") {
      unlinkSync(child.path);
      mkdirSync(child.path);
    } else if (invalid === "symlink") {
      const original = child.path;
      const outside = join(cwd, "protected.jsonl");
      renameSync(original, outside);
      symlinkSync(outside, original);
    } else if (invalid === "outside store") {
      const outside = join(cwd, "protected.jsonl");
      renameSync(child.path, outside);
      child.path = outside;
    } else if (invalid === "relative path") {
      child.path = relative(process.cwd(), child.path);
    } else if (invalid === "non-JSONL") {
      const path = join(dirname(child.path), "protected.md");
      renameSync(child.path, path);
      child.path = path;
    } else {
      const directory = join(sessionsDir, "linked");
      symlinkSync(dirname(child.path), directory, "junction");
      child.path = join(directory, child.path.slice(dirname(child.path).length + 1));
    }
    dispatch(root, child);
    const rootBefore = readFileSync(root.path);

    await expect(deleteSessionHistory(root, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(readFileSync(root.path)).toEqual(rootBefore);
    if (invalid !== "directory") expect(readFileSync(child.path)).toEqual(before);
    else expect(existsSync(child.path)).toBe(true);
  });

  it("rejects a missing child beneath a symlink escape even though its final file is absent", async () => {
    const root = history();
    const child = history(false);
    const escape = join(sessionsDir, "escape");
    symlinkSync(cwd, escape, "junction");
    child.path = join(escape, "missing.jsonl");
    dispatch(root, child, { state: "created" });
    await expect(deleteSessionHistory(root, { sessionsDir, store })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(existsSync(root.path)).toBe(true);
  });

  it.each(["root", "child"])("revalidates the %s header immediately before unlink after an earlier removal", async (which) => {
    const root = history();
    const first = history();
    const child = history();
    dispatch(root, first);
    dispatch(root, child);
    const replaced = which === "root" ? root : child;
    await expect(deleteSessionHistory(root, {
      sessionsDir, store, removeFile(path) {
        unlinkSync(path);
        if (path === first.path) rewriteHeader(replaced, { id: randomUUID() });
      },
    })).rejects.toBeInstanceOf(SessionHistoryConflictError);
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(replaced.path)).toBe(true);
    expect(existsSync(root.path)).toBe(true);
  });

  it("skips a child ENOENT at unlink but never swallows a root unlink failure", async () => {
    const root = history();
    const child = history();
    dispatch(root, child);
    const missing = Object.assign(new Error("injected ENOENT"), { code: "ENOENT" });
    await expect(deleteSessionHistory(root, {
      sessionsDir, store, removeFile(path) {
        if (path === child.path) unlinkSync(path);
        throw missing;
      },
    })).rejects.toBe(missing);
    expect(existsSync(root.path)).toBe(true);
    expect(existsSync(child.path)).toBe(false);
    await deleteSessionHistory(root, { sessionsDir, store });
    expect(existsSync(root.path)).toBe(false);
  });

  it("does not repair unterminated or migrate legacy JSONL while validating a failed removal", async () => {
    const root = history();
    const child = history();
    link(root, child);
    const { version: _version, ...header } = child.manager.getHeader()!;
    const entries = child.manager.getEntries().map(({ id: _id, parentId: _parentId, ...entry }) => entry);
    writeFileSync(child.path, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n"));
    writeFileSync(root.path, readFileSync(root.path).subarray(0, -1));
    const before = [root, child].map((session) => readFileSync(session.path));
    const failure = new Error("injected unlink failure");
    await expect(deleteSessionHistory(root, { sessionsDir, store, removeFile() { throw failure; } })).rejects.toBe(failure);
    expect([root, child].map((session) => readFileSync(session.path))).toEqual(before);
  });
});
