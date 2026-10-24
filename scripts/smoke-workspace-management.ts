import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { importPi } from "../src/runtime/pi-import";

type Pi = Awaited<ReturnType<typeof importPi>>;

export function createWorkspaceSmokeFixture(pi: Pi, root: string, label: string) {
  const cwd = join(root, `workspace-${label}`);
  const other = join(root, `unrelated-${label}`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(other, { recursive: true });
  const create = (directory: string, name: string) => {
    const manager = pi.SessionManager.create(directory);
    manager.appendMessage({ role: "user", content: `Workspace request ${label}`, timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: `Workspace response ${label}` }],
      api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    manager.appendSessionInfo(name);
    return { id: manager.getSessionId(), path: manager.getSessionFile()!, manager };
  };
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
}
