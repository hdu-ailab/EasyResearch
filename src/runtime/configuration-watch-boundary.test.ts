import fsPromises from "node:fs/promises";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigurationWatcherManager, type ConfigurationWatcherManager, type ResourceWatchChange } from "./configuration-watchers";
import { fingerprintSkillRoot } from "./resource-fingerprint";

const roots: string[] = [];
const managers: ConfigurationWatcherManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-watch-boundary-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const agentDir = join(homeDir, ".easyresearch", "agent");
  const project = join(homeDir, "paper");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project);
  const changes: ResourceWatchChange[] = [];
  const errors: unknown[] = [];
  const manager = createConfigurationWatcherManager({
    agentDir, homeDir,
    onChange: (change) => { changes.push(change); },
    onError: () => { errors.push("monitoring failed"); },
    fingerprintProject: (cwd) => fingerprintSkillRoot(join(cwd, ".easyresearch", "skills"), cwd),
  });
  managers.push(manager);
  return { root, homeDir, agentDir, project, changes, errors, manager };
}

function skill(path: string, body: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `---\nname: boundary-fixture\ndescription: fixture\n---\n${body}\n`);
}

async function observed(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 6_000, interval: 25 });
}

describe("production configuration filesystem boundary", () => {
  it.each([
    ["project", false], ["project", true], ["home", false], ["home", true],
  ] as const)("initializes and hot reloads %s resources (existing=%s) beside a disconnected mount without scanning siblings", async (scope, existing) => {
    const state = fixture();
    const anchor = scope === "project" ? state.project : state.homeDir;
    const brokenMount = join(anchor, "unrelated-mount");
    mkdirSync(brokenMount);
    const originalLstat = fsPromises.lstat;
    const stats = vi.spyOn(fsPromises, "lstat").mockImplementation(((path: string, ...args: unknown[]) => {
      if (String(path) === brokenMount) {
        return Promise.reject(Object.assign(new Error("Transport endpoint is not connected"), {
          code: "ENOTCONN", syscall: "lstat", path: brokenMount,
        }));
      }
      return Reflect.apply(originalLstat, fsPromises, [path, ...args]);
    }) as typeof fsPromises.lstat);
    const reads = vi.spyOn(fsPromises, "readdir");
    syncBuiltinESMExports();
    const config = join(anchor, scope === "project" ? ".easyresearch" : ".agents");
    const descriptor = join(config, "skills", "fixture", "SKILL.md");
    if (existing) skill(descriptor, "preexisting");
    await state.manager.start(scope === "home");
    if (scope === "project") await expect(state.manager.acquireProject(state.project)).resolves.toBeDefined();
    skill(descriptor, "created after acquisition");
    await observed(() => state.changes.some((change) => change.skillsChanged));
    // Give the owned watcher reconstruction time to settle before the next edit.
    await new Promise((done) => setTimeout(done, 450));
    state.changes.splice(0);
    skill(descriptor, "subsequent edit");
    await observed(() => state.changes.some((change) => change.skillsChanged));
    expect(state.errors).toEqual([]);
    expect(reads.mock.calls.map(([path]) => resolve(String(path)))).not.toContain(anchor);
    expect(stats.mock.calls.map(([path]) => String(path))).not.toContain(brokenMount);
    await state.manager.close();
  }, 15_000);

  it("reports filesystem faults inside the configuration boundary instead of claiming readiness", async () => {
    const state = fixture();
    const config = join(state.project, ".easyresearch");
    mkdirSync(config);
    const original = fsPromises.lstat;
    vi.spyOn(fsPromises, "lstat").mockImplementation(((path: string, ...args: unknown[]) => {
      if (String(path) === config) return Promise.reject(Object.assign(new Error("configuration unavailable"), {
        code: "ENOTCONN", syscall: "lstat", path: config,
      }));
      return Reflect.apply(original, fsPromises, [path, ...args]);
    }) as typeof fsPromises.lstat);
    syncBuiltinESMExports();
    await state.manager.start(false);
    await expect(state.manager.acquireProject(state.project)).rejects.toMatchObject({ code: "ENOTCONN" });
    expect(state.errors.length).toBeGreaterThan(0);
  });

  it("reattaches a replaced configuration directory and releases watches on project release", async () => {
    const state = fixture();
    const config = join(state.project, ".easyresearch");
    const descriptor = join(config, "skills", "fixture", "SKILL.md");
    skill(descriptor, "original");
    await state.manager.start(false);
    const registration = await state.manager.acquireProject(state.project);
    renameSync(config, join(state.project, "retired-config"));
    skill(descriptor, "replacement");
    await observed(() => state.changes.some((change) => change.skillsChanged));
    await new Promise((done) => setTimeout(done, 450));
    state.changes.splice(0);
    skill(descriptor, "replacement edited");
    await observed(() => state.changes.some((change) => change.skillsChanged));
    await registration.release();
    state.changes.splice(0);
    skill(descriptor, "unowned edit");
    await new Promise((done) => setTimeout(done, 450));
    expect(state.changes).toEqual([]);
    expect(state.errors).toEqual([]);
  }, 15_000);

  it("retains exact-cwd alias identity while following a retargeted project", async () => {
    const state = fixture();
    const second = join(state.homeDir, "second");
    const descriptor = join(second, ".easyresearch", "skills", "fixture", "SKILL.md");
    skill(descriptor, "second");
    const alias = join(state.homeDir, "alias");
    symlinkSync(relative(state.homeDir, state.project), alias, "dir");
    await state.manager.start(false);
    const registration = await state.manager.acquireProject(alias);
    expect(registration.cwd).toBe(alias);
    const replacement = join(state.homeDir, "next-alias");
    symlinkSync(relative(state.homeDir, second), replacement, "dir");
    renameSync(replacement, alias);
    await observed(() => state.changes.some((change) => change.projectCwds?.includes(alias)));
    await new Promise((done) => setTimeout(done, 450));
    state.changes.splice(0);
    skill(descriptor, "edited through new target");
    await observed(() => state.changes.some((change) => change.projectCwds?.includes(alias)));
    expect(state.errors).toEqual([]);
  }, 15_000);
});
