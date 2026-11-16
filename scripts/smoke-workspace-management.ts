import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { importPi } from "../src/runtime/pi-import";
import { SubagentCoordinator } from "../src/subagent/coordinator";
import type { AgentConfig } from "../src/subagent/agents";

type Pi = Awaited<ReturnType<typeof importPi>>;

function createHistory(pi: Pi, cwd: string, name: string, text: string, directory?: string) {
  const manager = pi.SessionManager.create(cwd, directory);
  manager.appendMessage({ role: "user", content: `Synthetic request: ${text}`, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  manager.appendSessionInfo(name);
  return { id: manager.getSessionId(), path: manager.getSessionFile()!, manager };
}

export function createWorkspaceSmokeFixture(pi: Pi, root: string, label: string) {
  const cwd = join(root, `workspace-${label}`);
  const other = join(root, `unrelated-${label}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(other, { recursive: true });
  const create = (directory: string, name: string) => createHistory(pi, directory, name, `Workspace response ${label}`);
  const parent = create(cwd, `Workspace root ${label}`);
  const child = create(cwd, "easyresearch:search");
  parent.manager.appendCustomEntry("easyresearch:subagent_session_alias", {
    id: "search_0", agent: "search", sessionId: child.id, sessionPath: child.path,
  });
  parent.manager.appendCustomEntry("easyresearch:subagent_session", {
    toolCallId: "workspace-dispatch", agent: "search", childSessionId: child.id, agentId: "search_0",
  });
  const unrelated = create(other, `Unrelated root ${label}`);
  const sentinel = `Project files survive workspace management: ${label}`;
  writeFileSync(join(cwd, "keep.txt"), sentinel);
  const originals = new Map([parent, child, unrelated].map((session) => [session.path, readFileSync(session.path)]));
  return { cwd, other, parent, child, unrelated, sentinel, originals };
}

/** Synthetic partial migration: original root cwd/edges, current child cwd and physical store. */
export function createMigratedWorkspaceSmokeFixture(pi: Pi, home: string, label: string, shared = false) {
  const agentDir = join(home, ".easyresearch", "agent");
  const sessionsDir = join(agentDir, "sessions");
  const oldHome = join(dirname(home), "old-home");
  const cwd = join(oldHome, `migration-${label}`);
  const currentCwd = join(home, `migration-${label}`);
  mkdirSync(currentCwd, { recursive: true });
  const previous = process.env.EASYRESEARCH_CODING_AGENT_DIR;
  process.env.EASYRESEARCH_CODING_AGENT_DIR = agentDir;
  try {
    const name = `Migrated root ${label}`;
    const parent = createHistory(pi, cwd, name, name);
    // Keep the original bucket even though the child header already has its new cwd.
    const child = createHistory(pi, currentCwd, "easyresearch:search", "Migrated child", dirname(parent.path));
    const oldPath = join(oldHome, ".easyresearch", "agent", "sessions", relative(sessionsDir, child.path));
    assert(!existsSync(oldPath), "Migration fixture must not have a live original child");
    const agent: AgentConfig = { name: "search", description: "synthetic smoke", enabled: true, builtin: false,
      systemPrompt: "synthetic smoke", source: "global", filePath: "unused", effectiveTools: [], effectiveSkills: [],
      effectiveSkillPaths: [], missingSkills: [] };
    const coordinator = new SubagentCoordinator(parent.manager);
    const reservation = coordinator.reserveDispatch({ ownerSessionId: parent.id, toolCallId: `migration-${label}`,
      requested: "search", catalog: { all: [agent], available: [agent] } });
    const identity = { childSessionId: child.id, sessionPath: oldPath };
    coordinator.recordChildCreated(reservation, identity);
    coordinator.recordMaterialized(reservation, identity);
    coordinator.recordLaunchAcknowledged(reservation.launchId);
    coordinator.recordTerminal({ launchId: reservation.launchId, status: "complete" });
    const unrelated = createHistory(pi, currentCwd, `Current unrelated ${label}`, "Unrelated destination history");
    const nested = createHistory(pi, join(currentCwd, "nested"), `Nested unrelated ${label}`, "Nested history");
    const fork = shared ? pi.SessionManager.forkFrom(parent.path, join(home, `foreign-${label}`)) : undefined;
    const sentinel = `Migration project files survive: ${label}`;
    writeFileSync(join(currentCwd, "keep.txt"), sentinel);
    const preserved = [unrelated.path, nested.path, ...(fork ? [child.path, fork.getSessionFile()!] : [])];
    const originals = new Map([parent.path, child.path, ...preserved].map((path) => [path, readFileSync(path)]));
    return { name, cwd, currentCwd, parent, child, oldPath, reservation, unrelated, nested, fork, sentinel, preserved, originals };
  } finally {
    if (previous === undefined) delete process.env.EASYRESEARCH_CODING_AGENT_DIR;
    else process.env.EASYRESEARCH_CODING_AGENT_DIR = previous;
  }
}

export type MigratedWorkspaceSmokeFixture = ReturnType<typeof createMigratedWorkspaceSmokeFixture>;

export function assertMigratedWorkspacePreserved(fixture: MigratedWorkspaceSmokeFixture, conflict = false): void {
  assert.equal(readFileSync(join(fixture.currentCwd, "keep.txt"), "utf8"), fixture.sentinel);
  assert(!existsSync(fixture.oldPath));
  assert(!existsSync(fixture.cwd), "Deletion must not recreate the old workspace");
  for (const path of conflict ? [...fixture.originals.keys()] : fixture.preserved) {
    assert.deepEqual(readFileSync(path), fixture.originals.get(path), `History changed: ${path}`);
  }
}

export function contradictMigratedWorkspace(fixture: MigratedWorkspaceSmokeFixture): void {
  fixture.parent.manager.appendCustomEntry("easyresearch:subagent_session_alias", {
    id: fixture.reservation.agentId, agent: "writing", sessionId: fixture.child.id, sessionPath: fixture.oldPath,
  });
  fixture.originals.set(fixture.parent.path, readFileSync(fixture.parent.path));
}

/** Linux inotify supplies ordered unlink evidence for the individual API's empty response. */
export function observeMigrationRemoval(fixture: MigratedWorkspaceSmokeFixture) {
  const removed: string[] = [];
  const names = new Map([fixture.child, fixture.parent].map((item) => [basename(item.path), item.id]));
  // Other platforms may coalesce/reorder directory notifications. Their workspace
  // response still asserts the server's ordered removal result; never turn OS
  // notification ordering into a spurious native release failure.
  const watcher = process.platform === "linux" ? watch(dirname(fixture.parent.path), (event, filename) => {
    if (event !== "rename" || filename === null) return;
    const id = names.get(filename.toString());
    if (id && !removed.includes(id)) removed.push(id);
  }) : undefined;
  let failure: Error | undefined;
  watcher?.on("error", (error) => { failure = error; });
  return {
    observesUnlinkOrder: watcher !== undefined,
    async assertChildFirst(deadline: number) {
      if (watcher) {
        while (removed.length < 2 && !failure && Date.now() < deadline) await Bun.sleep(10);
        if (failure) throw failure;
        assert.deepEqual(removed, [fixture.child.id, fixture.parent.id], "Actual deletion must unlink the child before its root");
      } else console.log(`[smoke] ${process.platform}: unordered filesystem notifications; unlink-order observation is Linux-only`);
      assert(!existsSync(fixture.child.path));
      assert(!existsSync(fixture.parent.path));
    },
    close() { watcher?.close(); },
  };
}

export async function smokeMigratedWorkspaceManagement(base: string, pi: Pi, home: string, deadline: number): Promise<void> {
  const completed: MigratedWorkspaceSmokeFixture[] = [];
  const request = async (path: string, body: unknown, status = 200) => {
    assert(deadline > Date.now(), "Migration smoke deadline exhausted");
    const response = await fetch(`${base}${path}`, { method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    const value = response.status === 204 ? null : await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  for (const mode of ["workspace", "individual"] as const) {
    const fixture = createMigratedWorkspaceSmokeFixture(pi, home, mode);
    const path = mode === "workspace" ? "/api/workspaces" : `/api/sessions/${fixture.parent.id}`;
    const target = mode === "workspace" ? { cwd: fixture.cwd } : {};
    // A legacy force without echoed scopes admits only the original cwd. The
    // additional migrated cwd must first be disclosed, even with no active model.
    const busy = await request(path, { ...target, force: true }, 409);
    assert.equal(busy.code, mode === "workspace" ? "WORKSPACE_BUSY" : "SESSION_BUSY");
    assert.deepEqual(new Set(busy.affectedCwds), new Set([fixture.cwd, fixture.currentCwd]));
    assertMigratedWorkspacePreserved(fixture, true);
    const observation = observeMigrationRemoval(fixture);
    try {
      const result = await request(path, { ...target, force: true, expectedCwds: busy.affectedCwds }, mode === "workspace" ? 200 : 204);
      if (mode === "workspace") assert.deepEqual(result.sessionIds, [fixture.child.id, fixture.parent.id]);
      await observation.assertChildFirst(Math.min(deadline, Date.now() + 5_000));
      assertMigratedWorkspacePreserved(fixture);
      completed.push(fixture);
    } finally { observation.close(); }
  }
  for (const mode of ["workspace", "individual"] as const) {
    const shared = createMigratedWorkspaceSmokeFixture(pi, home, `shared-${mode}`, true);
    const result = await request(mode === "workspace" ? "/api/workspaces" : `/api/sessions/${shared.parent.id}`,
      mode === "workspace" ? { cwd: shared.cwd } : {}, mode === "workspace" ? 200 : 204);
    if (mode === "workspace") assert.deepEqual(result.sessionIds, [shared.parent.id]);
    assert(!existsSync(shared.parent.path));
    assertMigratedWorkspacePreserved(shared);
    completed.push(shared);
  }

  for (const mode of ["workspace", "individual"] as const) {
    const fixture = createMigratedWorkspaceSmokeFixture(pi, home, `scope-expansion-${mode}`, true);
    const path = mode === "workspace" ? "/api/workspaces" : `/api/sessions/${fixture.parent.id}`;
    const target = mode === "workspace" ? { cwd: fixture.cwd } : {};
    const busy = await request(path, { ...target, force: true, expectedCwds: [] }, 409);
    assert.equal(busy.code, mode === "workspace" ? "WORKSPACE_BUSY" : "SESSION_BUSY");
    assert.deepEqual(busy.affectedCwds, [fixture.cwd]);
    assertMigratedWorkspacePreserved(fixture, true);

    // Delete the real synthetic foreign fork through HTTP. Its disappearance
    // expands exclusivity without changing the original coordinator's journal.
    const forkPath = fixture.fork!.getSessionFile()!;
    await request(`/api/sessions/${fixture.fork!.getSessionId()}`, {}, 204);
    assert(!existsSync(forkPath));
    const stale = await request(path, { ...target, force: true, expectedCwds: busy.affectedCwds }, 409);
    assert.equal(stale.code, mode === "workspace" ? "WORKSPACE_BUSY" : "SESSION_BUSY");
    assert.deepEqual(new Set(stale.affectedCwds), new Set([fixture.cwd, fixture.currentCwd]));
    for (const [historyPath, bytes] of fixture.originals) {
      if (historyPath !== forkPath) assert.deepEqual(readFileSync(historyPath), bytes);
    }
    // The child is now exclusive; only unrelated histories belong in the final
    // preservation set. The fork was intentionally removed by the earlier API.
    fixture.preserved.splice(0, fixture.preserved.length, fixture.unrelated.path, fixture.nested.path);
    const observation = observeMigrationRemoval(fixture);
    try {
      const result = await request(path, { ...target, force: true, expectedCwds: stale.affectedCwds }, mode === "workspace" ? 200 : 204);
      if (mode === "workspace") assert.deepEqual(result.sessionIds, [fixture.child.id, fixture.parent.id]);
      await observation.assertChildFirst(Math.min(deadline, Date.now() + 5_000));
      assertMigratedWorkspacePreserved(fixture);
      completed.push(fixture);
    } finally { observation.close(); }
  }

  // Keep the contradiction last: it must stay a global inventory conflict on every retry.
  const conflict = createMigratedWorkspaceSmokeFixture(pi, home, "conflict");
  contradictMigratedWorkspace(conflict);
  for (const force of [false, true]) for (const mode of ["workspace", "individual"] as const) {
    const result = await request(mode === "workspace" ? "/api/workspaces" : `/api/sessions/${conflict.parent.id}`,
      mode === "workspace" ? { cwd: conflict.cwd, force } : { force }, 409);
    assert.equal(result.code, "SESSION_HISTORY_CONFLICT");
    assertMigratedWorkspacePreserved(conflict, true);
    for (const fixture of completed) assertMigratedWorkspacePreserved(fixture);
  }
  console.log("[smoke] migrated workspace/individual child-first deletion, shared-history preservation, stale-scope rejection and persistent typed conflicts passed");
}

async function smokeIsolatedHomeMigration(pi: Pi, root: string, deadline: number): Promise<void> {
  // The outer release smoke deliberately uses a custom agentDir. Never weaken the
  // migration detector to accept it: launch the same compiled daemon in a standard layout.
  const sourceAgentDir = pi.getAgentDir();
  const binary = join(sourceAgentDir, "bin", process.platform === "win32" ? "easyresearch-daemon.exe" : "easyresearch-daemon");
  const runtime = join(root, "migration-acceptance");
  const home = join(runtime, "home");
  const agentDir = join(home, ".easyresearch", "agent");
  const emptyPath = join(runtime, "empty-path");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(emptyPath, { recursive: true });
  cpSync(join(sourceAgentDir, "bundled"), join(agentDir, "bundled"), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir,
    XDG_CONFIG_HOME: join(runtime, "config"), XDG_CACHE_HOME: join(runtime, "cache"), LOCALAPPDATA: join(runtime, "localappdata"),
    PATH: emptyPath, EASYRESEARCH_SKIP_SETUP: "1" };
  assert.equal(Bun.which("node", { PATH: emptyPath }), null);
  assert.equal(Bun.which("bun", { PATH: emptyPath }), null);
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
  const port = probe.port!;
  probe.stop(true);
  try {
    assert(deadline > Date.now(), "Migration daemon startup deadline exhausted");
    const start = spawnSync(binary, ["--no-open", "--port", String(port)], {
      env, cwd: home, encoding: "utf8", timeout: Math.min(90_000, deadline - Date.now()),
    });
    assert.equal(start.status, 0, start.error?.message ?? `${start.stdout}\n${start.stderr}`);
    const base = `http://127.0.0.1:${port}`;
    const status = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.json());
    assert.equal(status.agentDir, agentDir, "Migration acceptance must use only its isolated standard store");
    await smokeMigratedWorkspaceManagement(base, pi, home, deadline);
  } finally {
    const stop = spawnSync(binary, ["exit"], { env, cwd: home, encoding: "utf8", timeout: 30_000 });
    assert.equal(stop.status, 0, stop.error?.message ?? stop.stderr);
    rmSync(runtime, { recursive: true, force: true });
  }
}

export async function smokeWorkspaceManagement(base: string, pi: Pi, root: string, deadline: number): Promise<void> {
  const fixture = createWorkspaceSmokeFixture(pi, root, "native");
  const request = async (path: string, body?: unknown, method = "POST", status = 200) => {
    assert(deadline > Date.now(), "Workspace smoke deadline exhausted");
    const response = await fetch(`${base}${path}`, {
      method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    const value = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`);
    return value;
  };
  const opened = await request("/api/sessions/open", { path: fixture.parent.path });
  assert.equal(opened.id, fixture.parent.id);
  const beforeRename = new Map([fixture.parent, fixture.child].map((entry) => [entry.path, readFileSync(entry.path)]));
  const renamed = join(root, "workspace-native-renamed");
  await request("/api/workspaces/rename", { cwd: fixture.cwd, name: basename(renamed) });
  assert(!existsSync(fixture.cwd));
  assert.equal(readFileSync(join(renamed, "keep.txt"), "utf8"), fixture.sentinel);
  for (const entry of [fixture.parent, fixture.child]) {
    const bytes = readFileSync(entry.path);
    const before = beforeRename.get(entry.path)!;
    assert.deepEqual(bytes.subarray(bytes.indexOf(10) + 1), before.subarray(before.indexOf(10) + 1));
    assert.equal(JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString()).cwd, renamed);
  }
  assert.equal((await request("/api/sessions/open", { path: fixture.parent.path })).id, fixture.parent.id);
  const child = await request(`/api/sessions/${fixture.parent.id}/subagents/${fixture.child.id}/snapshot`, undefined, "GET");
  assert.equal(child.session.id, fixture.child.id);
  assert.equal(child.session.cwd, renamed);
  const moved = join(root, "workspace-native-external");
  renameSync(renamed, moved);
  const missing = await request("/api/sessions/open", { path: fixture.parent.path }, "POST", 404);
  assert.equal(missing.code, "WORKSPACE_MISSING");
  assert.equal(missing.cwd, renamed);
  await request("/api/workspaces/relocate", { cwd: renamed, directory: moved });
  const recovered = await request("/api/sessions/open", { path: fixture.parent.path });
  assert.equal(recovered.id, fixture.parent.id);
  assert.equal(recovered.cwd, moved);
  await request("/api/workspaces", { cwd: moved }, "DELETE");
  assert(!existsSync(fixture.parent.path));
  assert(!existsSync(fixture.child.path));
  assert.equal(readFileSync(join(moved, "keep.txt"), "utf8"), fixture.sentinel);
  assert.deepEqual(readFileSync(fixture.unrelated.path), fixture.originals.get(fixture.unrelated.path));
  console.log("[smoke] workspace rename, missing-folder recovery, stable root/child identities and history-only deletion passed");
  await smokeIsolatedHomeMigration(pi, root, deadline);
}
