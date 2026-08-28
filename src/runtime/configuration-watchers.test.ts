import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ChokidarOptions } from "chokidar";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ConfigurationWatcherManager,
  createConfigurationWatcherManager,
  type ResourceWatchChange,
} from "./configuration-watchers";
import type { ConfigurationWatchImplementation } from "./live-configuration";
import { fingerprintSkillRoot, type SkillScopeFingerprint } from "./resource-fingerprint";

const STABLE_EVENT_WAIT_MS = 450;
const tempRoots: string[] = [];
const managers: ConfigurationWatcherManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close().catch(() => {});
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-configuration-watchers-"));
  tempRoots.push(root);
  return root;
}

function workspace(): { root: string; agentDir: string; homeDir: string; project: string } {
  const root = tempRoot();
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  const project = join(root, "paper");
  mkdirSync(agentDir);
  mkdirSync(homeDir);
  mkdirSync(project);
  return { root, agentDir, homeDir, project };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitFor(predicate: () => boolean, message: string, timeout = 6_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await sleep(20);
  }
}

interface RealHarness {
  manager: ConfigurationWatcherManager;
  changes: ResourceWatchChange[];
  errors: { count: number };
  fingerprintCalls: string[];
}

function realHarness(
  paths: ReturnType<typeof workspace>,
  fingerprintProject: (cwd: string) => Promise<SkillScopeFingerprint> = (cwd) =>
    fingerprintSkillRoot(join(cwd, ".easyresearch", "skills"), `project:${cwd}`),
): RealHarness {
  const changes: ResourceWatchChange[] = [];
  const errors = { count: 0 };
  const fingerprintCalls: string[] = [];
  const manager = createConfigurationWatcherManager({
    agentDir: paths.agentDir,
    homeDir: paths.homeDir,
    onChange(change) {
      changes.push({
        ...change,
        ...(change.projectCwds ? { projectCwds: [...change.projectCwds] } : {}),
      });
    },
    onError() {
      errors.count += 1;
    },
    async fingerprintProject(cwd) {
      fingerprintCalls.push(cwd);
      return fingerprintProject(cwd);
    },
  });
  managers.push(manager);
  return { manager, changes, errors, fingerprintCalls };
}

async function clearStableEvents(changes: ResourceWatchChange[]): Promise<void> {
  await sleep(STABLE_EVENT_WAIT_MS);
  changes.splice(0);
}

async function expectObserved(
  changes: ResourceWatchChange[],
  mutate: () => void,
  predicate: (change: ResourceWatchChange) => boolean,
  message: string,
): Promise<void> {
  await clearStableEvents(changes);
  mutate();
  await waitFor(() => changes.some(predicate), message);
}

async function expectUnobserved(changes: ResourceWatchChange[], mutate: () => void): Promise<void> {
  await clearStableEvents(changes);
  mutate();
  await sleep(STABLE_EVENT_WAIT_MS * 2);
  expect(changes).toEqual([]);
}

function projectChange(cwd: string): (change: ResourceWatchChange) => boolean {
  return (change) => change.skillsChanged === true && change.projectCwds?.includes(cwd) === true;
}

function nestedDirectory(root: string, depth: number): string {
  return join(root, ...Array.from({ length: depth }, (_, index) => `level-${index + 1}`));
}

function sameFilesystemPath(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

describe("real stable-anchor resource watching", () => {
  it("observes first global leaf creation, every mutation kind, and atomic replacement", async () => {
    const paths = workspace();
    const state = realHarness(paths);
    await state.manager.start(false);

    const agent = join(paths.agentDir, "agents", "custom.md");
    await expectObserved(
      state.changes,
      () => {
        mkdirSync(join(paths.agentDir, "agents"));
        writeFileSync(agent, "agent-one", "utf8");
      },
      (change) => change.agentsChanged === true,
      "first Agent descriptor creation was not observed",
    );
    await expectObserved(
      state.changes,
      () => writeFileSync(agent, "agent-two", "utf8"),
      (change) => change.agentsChanged === true,
      "Agent descriptor edit was not observed",
    );
    await expectObserved(
      state.changes,
      () => unlinkSync(agent),
      (change) => change.agentsChanged === true,
      "Agent descriptor unlink was not observed",
    );

    const agentReplacement = join(paths.root, "replacement-agent.md");
    writeFileSync(agentReplacement, "agent-three", "utf8");
    await expectObserved(
      state.changes,
      () => renameSync(agentReplacement, agent),
      (change) => change.agentsChanged === true,
      "atomic Agent replacement was not observed",
    );

    await expectObserved(
      state.changes,
      () => writeFileSync(join(paths.agentDir, "settings.json"), "{}", "utf8"),
      () => true,
      "first settings.json creation was not observed",
    );
    await expectObserved(
      state.changes,
      () => writeFileSync(join(paths.agentDir, "models.json"), "{}", "utf8"),
      (change) => change.modelsChanged === true,
      "first models.json creation was not observed",
    );

    const skillDirectory = join(paths.agentDir, "skills", "custom");
    const skill = join(skillDirectory, "SKILL.md");
    await expectObserved(
      state.changes,
      () => {
        mkdirSync(skillDirectory, { recursive: true });
        writeFileSync(skill, "skill-one", "utf8");
      },
      (change) => change.skillsChanged === true,
      "first Skill descriptor creation was not observed",
    );
    await expectObserved(
      state.changes,
      () => writeFileSync(skill, "skill-two", "utf8"),
      (change) => change.skillsChanged === true,
      "Skill descriptor edit was not observed",
    );
    await expectObserved(
      state.changes,
      () => unlinkSync(skill),
      (change) => change.skillsChanged === true,
      "Skill descriptor unlink was not observed",
    );

    writeFileSync(skill, "skill-three", "utf8");
    await clearStableEvents(state.changes);
    await expectObserved(
      state.changes,
      () => rmSync(skillDirectory, { recursive: true }),
      (change) => change.skillsChanged === true,
      "valid Skill directory removal was not observed",
    );

    mkdirSync(skillDirectory);
    writeFileSync(skill, "skill-four", "utf8");
    await clearStableEvents(state.changes);
    const skillReplacement = join(paths.root, "replacement-skill.md");
    writeFileSync(skillReplacement, "skill-five", "utf8");
    await expectObserved(
      state.changes,
      () => renameSync(skillReplacement, skill),
      (change) => change.skillsChanged === true,
      "atomic Skill replacement was not observed",
    );

    expect(state.errors.count).toBe(0);
  }, 30_000);

  it("watches the optional-home anchor only while the accepted policy enables it", async () => {
    const paths = workspace();
    const state = realHarness(paths);
    await state.manager.start(true);
    const descriptor = join(paths.homeDir, ".agents", "skills", "home-skill", "SKILL.md");

    await expectObserved(
      state.changes,
      () => {
        mkdirSync(join(descriptor, ".."), { recursive: true });
        writeFileSync(descriptor, "home-one", "utf8");
      },
      (change) => change.skillsChanged === true,
      "first optional-home Skill was not observed",
    );

    await state.manager.setHomeEnabled(false);
    await expectUnobserved(state.changes, () => writeFileSync(descriptor, "home-two", "utf8"));

    await state.manager.setHomeEnabled(true);
    await expectObserved(
      state.changes,
      () => writeFileSync(descriptor, "home-three", "utf8"),
      (change) => change.skillsChanged === true,
      "re-enabled optional-home Skill edit was not observed",
    );
  }, 20_000);

  it("uses strict filters, depth 18, and no symlink following while admitting conservative Skill events", async () => {
    const paths = workspace();
    const external = join(paths.root, "external");
    const globalSkills = join(paths.agentDir, "skills");
    const projectSkills = join(paths.project, ".easyresearch", "skills");
    const acceptedDirectory = nestedDirectory(projectSkills, 16);
    const rejectedDirectory = nestedDirectory(projectSkills, 17);
    mkdirSync(join(paths.agentDir, "agents", "nested"), { recursive: true });
    mkdirSync(join(paths.agentDir, "bundled", "agents"), { recursive: true });
    mkdirSync(join(paths.agentDir, "bundled", "skills", "bundled"), { recursive: true });
    mkdirSync(globalSkills, { recursive: true });
    mkdirSync(join(globalSkills, ".hidden"), { recursive: true });
    mkdirSync(join(globalSkills, "node_modules", "dependency"), { recursive: true });
    mkdirSync(join(globalSkills, "retired.bak"), { recursive: true });
    mkdirSync(join(paths.homeDir, ".agents", "skills"), { recursive: true });
    mkdirSync(acceptedDirectory, { recursive: true });
    mkdirSync(rejectedDirectory, { recursive: true });
    mkdirSync(external);
    writeFileSync(join(external, "SKILL.md"), "outside-one", "utf8");
    symlinkSync(external, join(globalSkills, "outside-link"), "dir");

    const state = realHarness(paths, async () => fixedFingerprint("depth-test"));
    await state.manager.start(true);
    const registration = await state.manager.acquireProject(paths.project);

    await expectUnobserved(state.changes, () => {
      writeFileSync(join(paths.agentDir, "notes.txt"), "unrelated", "utf8");
      writeFileSync(join(paths.agentDir, "agents", "notes.txt"), "unrelated", "utf8");
      writeFileSync(join(paths.agentDir, "agents", "nested", "nested.md"), "inert", "utf8");
      writeFileSync(join(paths.agentDir, "bundled", "agents", "bundled.md"), "inert", "utf8");
      writeFileSync(join(paths.agentDir, "bundled", "skills", "bundled", "SKILL.md"), "inert", "utf8");
      writeFileSync(join(paths.homeDir, "home-note.md"), "inert", "utf8");
      writeFileSync(join(paths.project, ".easyresearch", "settings.json"), "{}", "utf8");
      writeFileSync(join(external, "SKILL.md"), "outside-two", "utf8");
      writeFileSync(join(globalSkills, ".hidden", "SKILL.md"), "hidden", "utf8");
      writeFileSync(join(globalSkills, "node_modules", "dependency", "SKILL.md"), "dependency", "utf8");
      writeFileSync(join(globalSkills, "retired.bak", "SKILL.md"), "retired", "utf8");
    });

    await expectObserved(
      state.changes,
      () => writeFileSync(join(paths.agentDir, "auth.json"), "{}", "utf8"),
      (change) => change.availabilityChanged === true,
      "an external credential change did not request availability refresh",
    );
    await expectObserved(
      state.changes,
      () => writeFileSync(join(paths.agentDir, "models-store.json"), "{}", "utf8"),
      (change) => change.availabilityChanged === true,
      "an external catalog-cache change did not request availability refresh",
    );

    await expectObserved(
      state.changes,
      () => writeFileSync(join(projectSkills, "asset.js"), "export {};", "utf8"),
      projectChange(paths.project),
      "an auxiliary Skill asset did not request a project rescan",
    );
    await expectObserved(
      state.changes,
      () => mkdirSync(join(projectSkills, "empty-directory")),
      projectChange(paths.project),
      "an empty Skill directory add did not request a project rescan",
    );
    await expectObserved(
      state.changes,
      () => rmSync(join(projectSkills, "empty-directory"), { recursive: true }),
      projectChange(paths.project),
      "an empty Skill directory removal did not request a project rescan",
    );
    await expectObserved(
      state.changes,
      () => writeFileSync(join(acceptedDirectory, "SKILL.md"), "accepted", "utf8"),
      projectChange(paths.project),
      "a depth-16 descriptor was not reached from the project anchor",
    );
    await expectUnobserved(state.changes, () => {
      writeFileSync(join(rejectedDirectory, "SKILL.md"), "too deep", "utf8");
    });

    await registration.release();
  }, 30_000);

  it("sends an in-root symlink target edit through project fingerprint commit and rollback", async () => {
    const paths = workspace();
    const skillRoot = join(paths.project, ".easyresearch", "skills");
    mkdirSync(skillRoot, { recursive: true });
    const payload = join(skillRoot, "payload.txt");
    writeFileSync(payload, "alpha", "utf8");
    symlinkSync("payload.txt", join(skillRoot, "linked.md"), "file");
    const state = realHarness(paths);
    await state.manager.start(false);
    const registration = await state.manager.acquireProject(paths.project);
    const baselineCalls = state.fingerprintCalls.length;

    await expectObserved(
      state.changes,
      () => writeFileSync(payload, "ALPHA", "utf8"),
      projectChange(paths.project),
      "an in-root symlink target edit did not request fingerprint comparison",
    );

    const rolledBack = await state.manager.prepareProjectChanges([paths.project]);
    expect(state.fingerprintCalls.length).toBeGreaterThan(baselineCalls);
    expect(rolledBack.changedCwds).toEqual([paths.project]);
    rolledBack.rollback();

    const committed = await state.manager.prepareProjectChanges([paths.project]);
    expect(committed.changedCwds).toEqual([paths.project]);
    committed.commit();
    const unchanged = await state.manager.prepareProjectChanges([paths.project]);
    expect(unchanged.changedCwds).toEqual([]);
    unchanged.rollback();

    await registration.release();
  }, 20_000);

  it("discards the project baseline and ignores edits while the exact cwd is unowned", async () => {
    const paths = workspace();
    const skillRoot = join(paths.project, ".easyresearch", "skills");
    const descriptor = join(skillRoot, "project.md");
    const state = realHarness(paths);
    await state.manager.start(false);
    const first = await state.manager.acquireProject(paths.project);

    await expectObserved(
      state.changes,
      () => {
        mkdirSync(skillRoot, { recursive: true });
        writeFileSync(descriptor, "one", "utf8");
      },
      projectChange(paths.project),
      "first project Skill creation was not observed from the exact-cwd anchor",
    );
    const accepted = await state.manager.prepareProjectChanges([paths.project]);
    expect(accepted.changedCwds).toEqual([paths.project]);
    accepted.commit();
    await first.release();

    await expectUnobserved(state.changes, () => writeFileSync(descriptor, "two", "utf8"));

    const second = await state.manager.acquireProject(paths.project);
    const prepared = await state.manager.prepareProjectChanges([paths.project]);
    expect(prepared.changedCwds).toEqual([]);
    prepared.rollback();
    await second.release();
  }, 15_000);

  it("detects a project descriptor change after a transaction was prepared", async () => {
    const paths = workspace();
    const descriptor = join(paths.project, ".easyresearch", "skills", "project.md");
    const state = realHarness(paths);
    await state.manager.start(false);
    const registration = await state.manager.acquireProject(paths.project);
    mkdirSync(join(descriptor, ".."), { recursive: true });
    writeFileSync(descriptor, "one", "utf8");

    const prepared = await state.manager.prepareProjectChanges([paths.project]);
    expect(prepared.changedCwds).toEqual([paths.project]);
    writeFileSync(descriptor, "two", "utf8");

    await expect(prepared.isCurrent()).resolves.toBe(false);
    prepared.rollback();
    await registration.release();
  }, 15_000);

  it("observes first project Skill creation through a symlink-spelled exact cwd", async () => {
    const paths = workspace();
    const alias = join(paths.root, "paper-alias");
    symlinkSync(relative(paths.root, paths.project), alias, "dir");
    const state = realHarness(paths);
    await state.manager.start(false);
    const registration = await state.manager.acquireProject(alias);
    expect(registration.cwd).toBe(resolve(alias));

    await expectObserved(
      state.changes,
      () => {
        const skillDirectory = join(paths.project, ".easyresearch", "skills", "linked-project");
        mkdirSync(skillDirectory, { recursive: true });
        writeFileSync(join(skillDirectory, "SKILL.md"), "linked-one", "utf8");
      },
      projectChange(resolve(alias)),
      "a symlink-spelled exact cwd did not observe its real project descendants",
    );

    const prepared = await state.manager.prepareProjectChanges([alias]);
    expect(prepared.changedCwds).toEqual([resolve(alias)]);
    prepared.rollback();
    await registration.release();
  }, 15_000);

  it("follows a retargeted exact-cwd symlink to current Skill descriptors without restart", async () => {
    const paths = workspace();
    const secondProject = join(paths.root, "paper-two");
    const firstDescriptor = join(paths.project, ".easyresearch", "skills", "first", "SKILL.md");
    const secondDescriptor = join(secondProject, ".easyresearch", "skills", "second", "SKILL.md");
    mkdirSync(join(firstDescriptor, ".."), { recursive: true });
    mkdirSync(join(secondDescriptor, ".."), { recursive: true });
    writeFileSync(firstDescriptor, "first-one", "utf8");
    writeFileSync(secondDescriptor, "second-one", "utf8");
    const alias = join(paths.root, "paper-current");
    symlinkSync(relative(paths.root, paths.project), alias, "dir");
    const state = realHarness(paths);
    await state.manager.start(false);
    const registration = await state.manager.acquireProject(alias);

    const replacement = join(paths.root, "paper-current-next");
    symlinkSync(relative(paths.root, secondProject), replacement, "dir");
    await expectObserved(
      state.changes,
      () => renameSync(replacement, alias),
      projectChange(resolve(alias)),
      "retargeting the exact-cwd symlink did not refresh its watched project",
    );

    await expectObserved(
      state.changes,
      () => writeFileSync(secondDescriptor, "second-two", "utf8"),
      projectChange(resolve(alias)),
      "the retargeted exact cwd did not observe its current Skill descriptor",
    );
    await expectUnobserved(state.changes, () => writeFileSync(firstDescriptor, "first-two", "utf8"));

    await registration.release();
  }, 20_000);
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function settleWithin<T>(promise: Promise<T>, milliseconds = 500): Promise<T | "timeout"> {
  return Promise.race([promise, sleep(milliseconds).then(() => "timeout" as const)]);
}

interface ControlledWatcher {
  readonly paths: readonly string[];
  readonly options: ChokidarOptions;
  closeAttempts: number;
  closeAction: () => Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): ControlledWatcher;
  add(paths: string | readonly string[]): ControlledWatcher;
  close(): Promise<void>;
  emit(event: string, ...args: unknown[]): void;
}

function controlledWatch(
  options: {
    autoReady?: boolean | ((index: number, paths: readonly string[]) => boolean);
    autoAdd?: boolean | ((index: number, path: string) => boolean);
    construct?: (paths: readonly string[], index: number) => void;
  } = {},
): {
  implementation: ConfigurationWatchImplementation;
  handles: ControlledWatcher[];
} {
  const handles: ControlledWatcher[] = [];
  const implementation = ((paths: string[], watchOptions: ChokidarOptions) => {
    const index = handles.length;
    options.construct?.(paths, index);
    const watchedPaths = [...paths];
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const handle: ControlledWatcher = {
      paths: watchedPaths,
      options: watchOptions,
      closeAttempts: 0,
      closeAction: async () => {},
      on(event, listener) {
        const current = listeners.get(event) ?? [];
        current.push(listener);
        listeners.set(event, current);
        return handle;
      },
      add(addedPaths) {
        const additions = typeof addedPaths === "string" ? [addedPaths] : addedPaths;
        for (const path of additions) {
          if (watchedPaths.includes(path)) continue;
          watchedPaths.push(path);
          const autoAdd =
            typeof options.autoAdd === "function" ? options.autoAdd(index, path) : options.autoAdd !== false;
          if (autoAdd) queueMicrotask(() => handle.emit("add", path));
        }
        return handle;
      },
      async close() {
        handle.closeAttempts += 1;
        await handle.closeAction();
      },
      emit(event, ...args) {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      },
    };
    handles.push(handle);
    const autoReady =
      typeof options.autoReady === "function" ? options.autoReady(index, watchedPaths) : options.autoReady !== false;
    if (autoReady) queueMicrotask(() => handle.emit("ready"));
    return handle;
  }) as ConfigurationWatchImplementation;
  return { implementation, handles };
}

async function startControlled(
  manager: ConfigurationWatcherManager,
  control: ReturnType<typeof controlledWatch>,
): Promise<void> {
  const starting = manager.start(false);
  await waitFor(() => control.handles.length === 1, "global watcher was not constructed");
  control.handles[0]?.emit("ready");
  await starting;
}

function fixedFingerprint(value: string): SkillScopeFingerprint {
  return { value, descriptors: [`${value}.md`], skillDescriptors: [] };
}

describe("project watcher lifecycle and concurrency", () => {
  it("cancels staged initial acquisition so shutdown cannot wait on exact-anchor confirmation", async () => {
    const paths = workspace();
    const alias = join(paths.root, "paper-alias");
    symlinkSync(relative(paths.root, paths.project), alias, "dir");
    const control = controlledWatch({ autoAdd: (index) => index !== 1 });
    let fingerprints = 0;
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {},
      fingerprintProject: async () => {
        fingerprints += 1;
        return fixedFingerprint("baseline");
      },
    });
    managers.push(manager);
    await manager.start(false);

    const acquiring = manager.acquireProject(alias);
    const acquisitionOutcome = acquiring.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await waitFor(
      () => control.handles[1]?.paths.includes(resolve(alias)) === true,
      "staged project watcher did not add its exact anchor",
    );
    const closeOutcome = manager.close().then(
      () => "closed" as const,
      () => "rejected" as const,
    );
    const outcome = await settleWithin(closeOutcome);
    if (outcome === "timeout") {
      control.handles[1]?.emit("error", new Error("test cleanup after staged acquisition deadlock"));
      await closeOutcome;
    }

    expect(outcome).toBe("closed");
    expect(await acquisitionOutcome).toBe("rejected");
    expect(fingerprints).toBe(0);
    expect(control.handles.every((handle) => handle.closeAttempts === 1)).toBe(true);
  });

  it("cancels staged replacement so shutdown cannot wait on exact-anchor confirmation", async () => {
    const paths = workspace();
    const secondProject = join(paths.root, "paper-two");
    mkdirSync(secondProject);
    const alias = join(paths.root, "paper-alias");
    symlinkSync(relative(paths.root, paths.project), alias, "dir");
    const control = controlledWatch({ autoAdd: (index) => index !== 2 });
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {},
      fingerprintProject: async () => fixedFingerprint("baseline"),
    });
    managers.push(manager);
    await manager.start(false);
    const registration = await manager.acquireProject(alias);

    const replacementLink = join(paths.root, "paper-alias-next");
    symlinkSync(relative(paths.root, secondProject), replacementLink, "dir");
    renameSync(replacementLink, alias);
    control.handles[1]?.emit("change", resolve(alias));
    await waitFor(
      () => control.handles[2]?.paths.includes(resolve(alias)) === true,
      "replacement watcher did not enter exact-anchor confirmation",
    );
    const closeOutcome = manager.close().then(
      () => "closed" as const,
      () => "rejected" as const,
    );
    const outcome = await settleWithin(closeOutcome);
    if (outcome === "timeout") {
      control.handles[2]?.emit("error", new Error("test cleanup after staged replacement deadlock"));
      await closeOutcome;
    }

    expect(outcome).toBe("closed");
    expect(control.handles.every((handle) => handle.closeAttempts === 1)).toBe(true);
    await registration.release();
  });

  it("settles a staged replacement from a sole exact-anchor change and follows the current target", async () => {
    const paths = workspace();
    const secondProject = join(paths.root, "paper-two");
    const secondDescriptor = join(secondProject, ".easyresearch", "skills", "second", "SKILL.md");
    mkdirSync(join(secondDescriptor, ".."), { recursive: true });
    writeFileSync(secondDescriptor, "second-one", "utf8");
    const alias = join(paths.root, "paper-alias");
    symlinkSync(relative(paths.root, paths.project), alias, "dir");
    const control = controlledWatch({ autoAdd: (index) => index !== 2 });
    const changes: ResourceWatchChange[] = [];
    const fingerprintTargets: string[] = [];
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: (change) => changes.push(change),
      onError: () => {},
      fingerprintProject: async (cwd) => {
        fingerprintTargets.push(realpathSync(cwd));
        return fixedFingerprint("baseline");
      },
    });
    managers.push(manager);
    await manager.start(false);
    const registration = await manager.acquireProject(alias);

    const replacementLink = join(paths.root, "paper-alias-next");
    symlinkSync(relative(paths.root, secondProject), replacementLink, "dir");
    renameSync(replacementLink, alias);
    control.handles[1]?.emit("change", resolve(alias));
    await waitFor(
      () => control.handles[2]?.paths.includes(resolve(alias)) === true,
      "replacement watcher did not enter exact-anchor confirmation",
    );

    control.handles[2]?.emit("change", resolve(alias));
    const preparing = manager.prepareProjectChanges([alias]);
    const prepared = await settleWithin(preparing);
    if (prepared === "timeout") {
      control.handles[2]?.emit("error", new Error("test cleanup after swallowed exact-anchor change"));
      await preparing;
      throw new Error("a sole exact-anchor change left staged readiness pending");
    }
    prepared.rollback();

    expect(fingerprintTargets).toEqual([realpathSync(paths.project), realpathSync(secondProject)]);
    expect(control.handles[2]?.paths).toContain(realpathSync(secondProject));
    await waitFor(
      () => changes.some(projectChange(resolve(alias))),
      "exact-anchor change did not complete the current-target replacement",
    );

    changes.splice(0);
    control.handles[2]?.emit("change", secondDescriptor);
    expect(changes).toEqual([{ skillsChanged: true, projectCwds: [resolve(alias)] }]);
    await registration.release();
  });

  for (const confirmationEvent of ["add", "addDir"] as const) {
    it(`keeps an outstanding registration when stale ${confirmationEvent} confirmation precedes disappearance`, async () => {
      const paths = workspace();
      const secondProject = join(paths.root, "paper-two");
      const currentProject = join(paths.root, "paper-current");
      const currentDescriptor = join(currentProject, ".easyresearch", "skills", "current", "SKILL.md");
      mkdirSync(secondProject);
      mkdirSync(join(currentDescriptor, ".."), { recursive: true });
      writeFileSync(currentDescriptor, "current-one", "utf8");
      const alias = join(paths.root, "paper-alias");
      symlinkSync(relative(paths.root, paths.project), alias, "dir");
      const control = controlledWatch({ autoAdd: (index) => index !== 2 });
      const changes: ResourceWatchChange[] = [];
      let fingerprints = 0;
      const manager = createConfigurationWatcherManager({
        agentDir: paths.agentDir,
        homeDir: paths.homeDir,
        watch: control.implementation,
        onChange: (change) => changes.push(change),
        onError: () => {},
        fingerprintProject: async () => {
          fingerprints += 1;
          return fixedFingerprint("baseline");
        },
      });
      managers.push(manager);
      await manager.start(false);
      const registration = await manager.acquireProject(alias);

      const replacementLink = join(paths.root, "paper-alias-next");
      symlinkSync(relative(paths.root, secondProject), replacementLink, "dir");
      renameSync(replacementLink, alias);
      control.handles[1]?.emit("change", resolve(alias));
      await waitFor(
        () => control.handles[2]?.paths.includes(resolve(alias)) === true,
        "replacement watcher did not enter exact-anchor confirmation",
      );

      control.handles[2]?.emit(confirmationEvent, resolve(alias));
      unlinkSync(alias);
      const preparedWhileMissing = await manager.prepareProjectChanges([alias]);
      expect(fingerprints).toBe(2);
      preparedWhileMissing.rollback();

      symlinkSync(relative(paths.root, currentProject), alias, "dir");
      control.handles[2]?.emit("add", resolve(alias));
      await waitFor(
        () =>
          control.handles[3]?.paths.includes(resolve(alias)) === true && changes.some(projectChange(resolve(alias))),
        "recreated exact symlink did not restore its outstanding watcher",
      );
      expect(control.handles[3]?.paths).toContain(realpathSync(currentProject));

      changes.splice(0);
      writeFileSync(currentDescriptor, "current-two", "utf8");
      control.handles[3]?.emit("change", currentDescriptor);
      expect(changes).toEqual([{ skillsChanged: true, projectCwds: [resolve(alias)] }]);
      await registration.release();
    });
  }

  it("keeps an outstanding registration through transient exact-symlink disappearance", async () => {
    const paths = workspace();
    const secondProject = join(paths.root, "paper-two");
    const currentProject = join(paths.root, "paper-current");
    const currentDescriptor = join(currentProject, ".easyresearch", "skills", "current", "SKILL.md");
    mkdirSync(secondProject);
    mkdirSync(join(currentDescriptor, ".."), { recursive: true });
    writeFileSync(currentDescriptor, "current-one", "utf8");
    const alias = join(paths.root, "paper-alias");
    symlinkSync(relative(paths.root, paths.project), alias, "dir");
    const control = controlledWatch({ autoAdd: (index) => index !== 2 });
    const changes: ResourceWatchChange[] = [];
    let fingerprints = 0;
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: (change) => changes.push(change),
      onError: () => {},
      fingerprintProject: async () => {
        fingerprints += 1;
        return fixedFingerprint("baseline");
      },
    });
    managers.push(manager);
    await manager.start(false);
    const registration = await manager.acquireProject(alias);

    const replacementLink = join(paths.root, "paper-alias-next");
    symlinkSync(relative(paths.root, secondProject), replacementLink, "dir");
    renameSync(replacementLink, alias);
    control.handles[1]?.emit("change", resolve(alias));
    await waitFor(
      () => control.handles[2]?.paths.includes(resolve(alias)) === true,
      "replacement watcher did not enter exact-anchor confirmation",
    );

    unlinkSync(alias);
    control.handles[2]?.emit("unlink", resolve(alias));
    const preparedWhileMissing = await manager.prepareProjectChanges([alias]);
    expect(fingerprints).toBe(2);
    preparedWhileMissing.rollback();
    symlinkSync(relative(paths.root, currentProject), alias, "dir");
    control.handles[2]?.emit("add", resolve(alias));
    await waitFor(
      () => control.handles.length === 4 && changes.some(projectChange(resolve(alias))),
      "recreated exact symlink did not restore its outstanding watcher",
    );

    await clearStableEvents(changes);
    writeFileSync(currentDescriptor, "current-two", "utf8");
    control.handles[3]?.emit("change", currentDescriptor);
    await waitFor(
      () => changes.some(projectChange(resolve(alias))),
      "current Skill descriptor edit was not observed without reacquisition",
    );
    await registration.release();
  });

  it("retries a failed replacement on acquisition without recapturing the owned baseline", async () => {
    const paths = workspace();
    const secondProject = join(paths.root, "paper-two");
    mkdirSync(secondProject);
    const alias = join(paths.root, "paper-alias");
    symlinkSync(relative(paths.root, paths.project), alias, "dir");
    let failReplacement = true;
    const control = controlledWatch({
      construct: (_anchors, index) => {
        if (index === 2 && failReplacement) {
          failReplacement = false;
          throw new Error("replacement construction failed");
        }
      },
    });
    let errors = 0;
    let fingerprints = 0;
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {
        errors += 1;
      },
      fingerprintProject: async () => {
        fingerprints += 1;
        return fixedFingerprint(`baseline-${fingerprints}`);
      },
    });
    managers.push(manager);
    await manager.start(false);
    const original = await manager.acquireProject(alias);

    const replacementLink = join(paths.root, "paper-alias-next");
    symlinkSync(relative(paths.root, secondProject), replacementLink, "dir");
    renameSync(replacementLink, alias);
    control.handles[1]?.emit("change", resolve(alias));
    await waitFor(() => errors === 1, "replacement failure was not surfaced");

    const recovered = await manager.acquireProject(alias);
    expect(control.handles).toHaveLength(3);
    expect(control.handles.filter((handle) => handle.closeAttempts === 0)).toHaveLength(2);
    expect(fingerprints).toBe(1);
    await original.release();
    expect(control.handles[2]?.closeAttempts).toBe(0);
    await recovered.release();
    expect(control.handles[2]?.closeAttempts).toBe(1);
  });

  it("retains refs and baseline while synchronization reinstalls a failed retarget watcher", async () => {
    const paths = workspace();
    const secondProject = join(paths.root, "paper-two");
    mkdirSync(secondProject);
    const alias = join(paths.root, "paper-alias");
    symlinkSync(relative(paths.root, paths.project), alias, "dir");
    let failReplacement = true;
    const control = controlledWatch({
      construct: (_anchors, index) => {
        if (index === 2 && failReplacement) {
          failReplacement = false;
          throw new Error("replacement construction failed");
        }
      },
    });
    let errors = 0;
    let fingerprintValue = "project-v1";
    let fingerprints = 0;
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {
        errors += 1;
      },
      fingerprintProject: async () => {
        fingerprints += 1;
        return fixedFingerprint(fingerprintValue);
      },
    });
    managers.push(manager);
    await manager.start(false);
    const original = await manager.acquireProject(alias);

    const replacementLink = join(paths.root, "paper-alias-next");
    symlinkSync(relative(paths.root, secondProject), replacementLink, "dir");
    renameSync(replacementLink, alias);
    control.handles[1]?.emit("change", resolve(alias));
    await waitFor(() => errors === 1, "replacement failure was not surfaced");

    fingerprintValue = "project-v2";
    const prepared = await manager.prepareProjectChanges([alias]);
    expect(prepared.changedCwds).toEqual([resolve(alias)]);
    prepared.commit();
    expect(control.handles).toHaveLength(3);
    expect(control.handles.filter((handle) => handle.closeAttempts === 0)).toHaveLength(2);
    expect(fingerprints).toBe(2);

    const second = await manager.acquireProject(alias);
    expect(control.handles).toHaveLength(3);
    expect(fingerprints).toBe(2);
    await original.release();
    expect(control.handles[2]?.closeAttempts).toBe(0);
    await second.release();
    expect(control.handles[2]?.closeAttempts).toBe(1);
  });

  it("rebuilds when the exact cwd retargets before staged anchor confirmation", async () => {
    const paths = workspace();
    const secondProject = join(paths.root, "paper-two");
    mkdirSync(secondProject);
    const alias = join(paths.root, "paper-alias");
    symlinkSync(relative(paths.root, paths.project), alias, "dir");
    const control = controlledWatch({ autoAdd: (index) => index === 0 });
    const fingerprintTargets: string[] = [];
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {},
      fingerprintProject: async (cwd) => {
        fingerprintTargets.push(realpathSync(cwd));
        return fixedFingerprint("baseline");
      },
    });
    managers.push(manager);
    await manager.start(false);

    let earlyRegistration: Awaited<ReturnType<ConfigurationWatcherManager["acquireProject"]>> | undefined;
    const acquiring = manager.acquireProject(alias).then((registration) => {
      earlyRegistration = registration;
      return registration;
    });
    await waitFor(
      () => control.handles[1]?.paths.includes(resolve(alias)) === true,
      "initial watcher did not enter exact-anchor confirmation",
    );

    const replacementLink = join(paths.root, "paper-alias-next");
    symlinkSync(relative(paths.root, secondProject), replacementLink, "dir");
    renameSync(replacementLink, alias);
    control.handles[1]?.emit("add", resolve(alias));
    await waitFor(
      () => earlyRegistration !== undefined || control.handles.length === 3,
      "staged confirmation neither completed nor rebuilt",
    );
    if (earlyRegistration) {
      await earlyRegistration.release();
      expect(control.handles).toHaveLength(3);
      return;
    }

    expect(fingerprintTargets).toEqual([]);
    expect(control.handles[1]?.closeAttempts).toBe(1);
    control.handles[2]?.emit("add", resolve(alias));
    const registration = await acquiring;
    expect(fingerprintTargets).toEqual([realpathSync(alias)]);
    await registration.release();
  });

  it("rejects a pre-ready startup error, closes its watcher, and retries with a fresh instance", async () => {
    const paths = workspace();
    const control = controlledWatch({ autoReady: false });
    let errors = 0;
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {
        errors += 1;
      },
      fingerprintProject: async () => fixedFingerprint("baseline"),
    });
    managers.push(manager);

    const starting = manager.start(false);
    const rejected = expect(starting).rejects.toThrow("global watch failed before ready");
    await waitFor(() => control.handles.length === 1, "global watcher was not constructed");
    control.handles[0]?.emit("error", new Error("global watch failed before ready"));
    await rejected;
    expect(control.handles[0]?.closeAttempts).toBe(1);
    expect(errors).toBe(1);

    const retry = manager.start(false);
    await waitFor(() => control.handles.length === 2, "global watcher was not reconstructed");
    control.handles[1]?.emit("ready");
    await retry;
    expect(control.handles[1]?.closeAttempts).toBe(0);
  });

  it("does not return first acquisition before watcher readiness and baseline completion", async () => {
    const paths = workspace();
    const control = controlledWatch({ autoReady: false });
    const baseline = deferred<SkillScopeFingerprint>();
    let fingerprintStarted = false;
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {},
      fingerprintProject: async () => {
        fingerprintStarted = true;
        return baseline.promise;
      },
    });
    managers.push(manager);
    await startControlled(manager, control);

    let acquired = false;
    const acquiring = manager.acquireProject(paths.project).then((registration) => {
      acquired = true;
      return registration;
    });
    await waitFor(() => control.handles.length === 2, "project watcher was not constructed");
    expect(fingerprintStarted).toBe(false);
    expect(acquired).toBe(false);

    control.handles[1]?.emit("ready");
    await waitFor(() => fingerprintStarted, "baseline did not start after ready");
    expect(acquired).toBe(false);
    baseline.resolve(fixedFingerprint("baseline"));
    const registration = await acquiring;
    expect(acquired).toBe(true);
    await registration.release();
  });

  it("shares one exact-cwd watcher and baseline across references and releases once", async () => {
    const paths = workspace();
    const control = controlledWatch();
    let fingerprints = 0;
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {},
      fingerprintProject: async () => {
        fingerprints += 1;
        return fixedFingerprint("baseline");
      },
    });
    managers.push(manager);
    await manager.start(false);

    const [first, second] = await Promise.all([
      manager.acquireProject(paths.project),
      manager.acquireProject(paths.project),
    ]);
    expect(
      control.handles.filter((handle) => handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project))),
    ).toHaveLength(1);
    expect(fingerprints).toBe(1);

    const projectWatcher = control.handles.find((handle) =>
      handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project)),
    );
    await first.release();
    await first.release();
    expect(projectWatcher?.closeAttempts).toBe(0);
    await second.release();
    expect(projectWatcher?.closeAttempts).toBe(1);
  });

  it("releases acquisition when caller construction fails and re-baselines later bytes", async () => {
    const paths = workspace();
    const control = controlledWatch();
    let value = "one";
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {},
      fingerprintProject: async () => fixedFingerprint(value),
    });
    managers.push(manager);
    await manager.start(false);

    await expect(
      (async () => {
        const registration = await manager.acquireProject(paths.project);
        try {
          throw new Error("runtime construction failed");
        } finally {
          await registration.release();
        }
      })(),
    ).rejects.toThrow("runtime construction failed");

    value = "two";
    const registration = await manager.acquireProject(paths.project);
    const prepared = await manager.prepareProjectChanges([paths.project]);
    expect(prepared.changedCwds).toEqual([]);
    prepared.rollback();
    await registration.release();
  });

  it("closes a watcher when baseline construction fails before allowing a retry", async () => {
    const paths = workspace();
    const control = controlledWatch();
    let attempts = 0;
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {},
      fingerprintProject: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("fingerprint failed");
        return fixedFingerprint("recovered");
      },
    });
    managers.push(manager);
    await manager.start(false);

    await expect(manager.acquireProject(paths.project)).rejects.toThrow("fingerprint failed");
    const failedWatcher = control.handles.find((handle) =>
      handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project)),
    );
    expect(failedWatcher?.closeAttempts).toBe(1);

    const registration = await manager.acquireProject(paths.project);
    expect(
      control.handles.filter((handle) => handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project))),
    ).toHaveLength(2);
    await registration.release();
  });

  it("surfaces synchronous project watcher construction failure without baselining and retries", async () => {
    const paths = workspace();
    let failProjectConstruction = true;
    const control = controlledWatch({
      construct: ([anchor]) => {
        if (anchor !== undefined && sameFilesystemPath(anchor, paths.project) && failProjectConstruction) {
          failProjectConstruction = false;
          throw new Error("watch construction failed");
        }
      },
    });
    let errors = 0;
    let fingerprints = 0;
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {
        errors += 1;
      },
      fingerprintProject: async () => {
        fingerprints += 1;
        return fixedFingerprint("baseline");
      },
    });
    managers.push(manager);
    await manager.start(false);

    await expect(manager.acquireProject(paths.project)).rejects.toThrow("watch construction failed");
    expect(errors).toBe(1);
    expect(fingerprints).toBe(0);

    const registration = await manager.acquireProject(paths.project);
    expect(
      control.handles.filter((handle) => handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project))),
    ).toHaveLength(1);
    expect(fingerprints).toBe(1);
    await registration.release();
  });

  it("retains failed close ownership and makes reacquisition join its retry before replacement", async () => {
    const paths = workspace();
    const control = controlledWatch();
    const changes: ResourceWatchChange[] = [];
    let value = "one";
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: (change) => changes.push(change),
      onError: () => {},
      fingerprintProject: async () => fixedFingerprint(value),
    });
    managers.push(manager);
    await manager.start(false);
    const first = await manager.acquireProject(paths.project);
    const firstWatcher = control.handles.find((handle) =>
      handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project)),
    );
    if (!firstWatcher) throw new Error("missing first project watcher");
    const retryClose = deferred<void>();
    firstWatcher.closeAction = async () => {
      if (firstWatcher.closeAttempts === 1) throw new Error("first close failed");
      await retryClose.promise;
    };

    await expect(first.release()).rejects.toThrow("first close failed");
    value = "two";
    const reacquiring = manager.acquireProject(paths.project);
    await waitFor(() => firstWatcher.closeAttempts === 2, "reacquisition did not retry failed close");
    expect(
      control.handles.filter((handle) => handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project))),
    ).toHaveLength(1);
    retryClose.resolve();
    const second = await reacquiring;
    expect(
      control.handles.filter((handle) => handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project))),
    ).toHaveLength(2);

    const prepared = await manager.prepareProjectChanges([paths.project]);
    expect(prepared.changedCwds).toEqual([]);
    prepared.rollback();

    firstWatcher.emit("change", join(paths.project, ".easyresearch", "skills", "stale.md"));
    expect(changes).toEqual([]);
    const secondWatcher = control.handles.at(-1);
    secondWatcher?.emit("change", join(paths.project, ".easyresearch", "skills", "current.md"));
    expect(changes).toEqual([{ skillsChanged: true, projectCwds: [paths.project] }]);
    await second.release();
  });

  it("does not create a replacement while the zero-ref watcher is still closing", async () => {
    const paths = workspace();
    const control = controlledWatch();
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {},
      fingerprintProject: async () => fixedFingerprint("baseline"),
    });
    managers.push(manager);
    await manager.start(false);
    const first = await manager.acquireProject(paths.project);
    const firstWatcher = control.handles.find((handle) =>
      handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project)),
    );
    if (!firstWatcher) throw new Error("missing first project watcher");
    const closing = deferred<void>();
    firstWatcher.closeAction = () => closing.promise;

    const release = first.release();
    const reacquire = manager.acquireProject(paths.project);
    await waitFor(() => firstWatcher.closeAttempts === 1, "release did not start close");
    expect(
      control.handles.filter((handle) => handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project))),
    ).toHaveLength(1);
    closing.resolve();
    await release;
    const second = await reacquire;
    expect(
      control.handles.filter((handle) => handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project))),
    ).toHaveLength(2);
    await second.release();
  });

  it("keeps normalized absolute cwd spellings distinct without realpath or case folding", async () => {
    const paths = workspace();
    const alias = join(paths.root, "paper-alias");
    symlinkSync(relative(paths.root, paths.project), alias, "dir");
    const control = controlledWatch();
    const changes: ResourceWatchChange[] = [];
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: (change) => changes.push(change),
      onError: () => {},
      fingerprintProject: async (cwd) => fixedFingerprint(cwd),
    });
    managers.push(manager);
    await manager.start(false);

    const physical = await manager.acquireProject(join(paths.project, "."));
    const linked = await manager.acquireProject(alias);
    expect(physical.cwd).toBe(resolve(paths.project));
    expect(linked.cwd).toBe(resolve(alias));
    expect(physical.cwd).not.toBe(linked.cwd);
    const projectWatchers = control.handles.slice(1);
    expect(projectWatchers).toHaveLength(2);
    expect(projectWatchers[0]?.paths).toContain(physical.cwd);
    expect(projectWatchers[1]?.paths).toContain(linked.cwd);
    projectWatchers[0]?.emit("change", join(projectWatchers[0].paths[0] ?? "", ".easyresearch", "skills", "one.md"));
    projectWatchers[1]?.emit("change", join(projectWatchers[1].paths[0] ?? "", ".easyresearch", "skills", "two.md"));
    expect(changes).toEqual([
      { skillsChanged: true, projectCwds: [resolve(paths.project)] },
      { skillsChanged: true, projectCwds: [resolve(alias)] },
    ]);
    await physical.release();
    await linked.release();
  });

  it("closes admission immediately, attempts every owner, and retries only failed shutdown closes", async () => {
    const paths = workspace();
    const secondProject = join(paths.root, "paper-two");
    mkdirSync(secondProject);
    const control = controlledWatch();
    const manager = createConfigurationWatcherManager({
      agentDir: paths.agentDir,
      homeDir: paths.homeDir,
      watch: control.implementation,
      onChange: () => {},
      onError: () => {},
      fingerprintProject: async (cwd) => fixedFingerprint(cwd),
    });
    managers.push(manager);
    await manager.start(true);
    const first = await manager.acquireProject(paths.project);
    const second = await manager.acquireProject(secondProject);
    const failing = control.handles.find((handle) =>
      handle.paths.some((anchor) => sameFilesystemPath(anchor, paths.project)),
    );
    if (!failing) throw new Error("missing project watcher");
    failing.closeAction = async () => {
      if (failing.closeAttempts === 1) throw new Error("shutdown close failed");
    };

    const close = manager.close();
    await expect(manager.acquireProject(paths.project)).rejects.toThrow(/closed|closing/i);
    await expect(close).rejects.toThrow(/close/i);
    expect(control.handles.every((handle) => handle.closeAttempts === 1)).toBe(true);

    await manager.close();
    expect(failing.closeAttempts).toBe(2);
    expect(control.handles.filter((handle) => handle !== failing).every((handle) => handle.closeAttempts === 1)).toBe(
      true,
    );
    await first.release();
    await second.release();
  });
});
