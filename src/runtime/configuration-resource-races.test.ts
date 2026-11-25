import fsPromises from "node:fs/promises";
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLiveConfiguration,
  type ConfigurationEvent,
  type ConfigurationWatchImplementation,
  type LiveConfiguration,
} from "./live-configuration";
import { importPi } from "./pi-import";

const roots: string[] = [];
const configurations: LiveConfiguration[] = [];

afterEach(async () => {
  for (const live of configurations.splice(0)) await live.close();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function descriptor(marker: string) {
  return `---\nname: race-skill\ndescription: ${marker}\n---\n${marker}\n`;
}

// Deliberately drop notifications: recovery must finish inside the original read,
// not depend on a second event, a timer, or an explicit user refresh.
const droppedWatch: ConfigurationWatchImplementation = () => {
  const watcher = {
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === "ready") queueMicrotask(listener);
      return watcher;
    },
    add() { return watcher; },
    async close() {},
  };
  return watcher;
};

async function fixture(scope: "project" | "global" | "home" = "project") {
  const root = mkdtempSync(join(tmpdir(), "easyresearch-configuration-race-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const agentDir = join(homeDir, ".easyresearch", "agent");
  const project = join(root, "paper");
  const config = scope === "project" ? join(project, ".easyresearch")
    : scope === "global" ? agentDir : join(homeDir, ".agents");
  const skills = join(config, "skills");
  const skillPath = join(skills, "race-skill", "SKILL.md");
  mkdirSync(project);
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("USERPROFILE", homeDir);
  vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir);
  await importPi();
  write(join(agentDir, "agents", "race-consumer.md"),
    "---\nname: race-consumer\ndescription: fixture\nskills: [race-skill]\ntools: [read]\n---\nFixture\n");
  if (scope === "project") write(join(agentDir, "skills", "race-skill", "SKILL.md"), descriptor("GLOBAL_FALLBACK"));
  if (scope === "home") write(join(agentDir, "settings.json"), JSON.stringify({ easyresearch: { enable_dot_agents_skill: true } }));
  write(skillPath, descriptor("PROJECT_ORIGINAL"));
  const live = createLiveConfiguration({
    agentDir,
    catalogOptions: { homeDir },
    watch: droppedWatch,
    modelValidator: {
      currentAvailableModels: () => [],
      prepareModelCatalog: async () => ({ registeredModels: [], availableModels: [], commit() {}, rollback() {} }),
    },
  });
  configurations.push(live);
  await live.start();
  await live.acquireProject(project);
  expect(live.error).toBeNull();
  const events: ConfigurationEvent[] = [];
  live.subscribe((event) => events.push(event));
  const accepted = async () => {
    const consumer = (await live.resolveAgents(project)).find((agent) => agent.name === "race-consumer")!;
    const path = consumer.effectiveSkillPaths?.[0];
    return path ? readFileSync(join(path, "SKILL.md"), "utf8") : undefined;
  };
  expect(await accepted()).toContain("PROJECT_ORIGINAL");
  return { root, agentDir, project, config, skills, skillPath, live, events, accepted };
}

describe("configuration resource scan races", () => {
  it.each(["remove", "replace"] as const)("re-reads a project layer %s after enumeration before publishing a generation", async (operation) => {
    const state = await fixture();
    const generation = state.live.generation;
    const original = fsPromises.lstat;
    let mutated = false;
    vi.spyOn(fsPromises, "lstat").mockImplementation((async (path: string, ...args: unknown[]) => {
      const result = await Reflect.apply(original, fsPromises, [path, ...args]);
      if (!mutated && String(path) === state.skills) {
        mutated = true;
        renameSync(state.config, join(state.project, "retired-configuration"));
        if (operation === "replace") write(state.skillPath, descriptor("PROJECT_REPLACEMENT"));
      }
      return result;
    }) as typeof original);
    syncBuiltinESMExports();

    const outcome = await state.live.synchronize({ projectCwds: [state.project] });

    expect(mutated).toBe(true);
    expect(outcome).toMatchObject({ status: "committed", error: null, generation: generation + 1 });
    expect(state.events.filter((event) => event.type === "config.error")).toEqual([]);
    expect(await state.accepted()).toContain(operation === "remove" ? "GLOBAL_FALLBACK" : "PROJECT_REPLACEMENT");
  });

  it.each(["global", "home"] as const)("re-reads %s Skill removal after enumeration through the same accepted owner", async (scope) => {
    const state = await fixture(scope);
    const generation = state.live.generation;
    const original = fsPromises.lstat;
    let mutated = false;
    vi.spyOn(fsPromises, "lstat").mockImplementation((async (path: string, ...args: unknown[]) => {
      const result = await Reflect.apply(original, fsPromises, [path, ...args]);
      if (!mutated && String(path) === state.skills) {
        mutated = true;
        renameSync(state.skills, join(state.root, "retired-skills"));
      }
      return result;
    }) as typeof original);
    syncBuiltinESMExports();

    expect(await state.live.synchronize()).toMatchObject({ status: "committed", error: null, generation: generation + 1 });
    expect(mutated).toBe(true);
    expect(state.events.filter((event) => event.type === "config.error")).toEqual([]);
    expect(await state.accepted()).toBeUndefined();
  });

  it("re-enumerates when the directory disappears between synchronous metadata and opendir", async () => {
    const state = await fixture();
    const original = fs.opendirSync;
    let mutated = false;
    vi.spyOn(fs, "opendirSync").mockImplementation((...args) => {
      if (!mutated && String(args[0]) === state.skills) {
        mutated = true;
        renameSync(state.config, join(state.root, "retired-configuration"));
      }
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();

    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "committed", error: null });
    expect(mutated).toBe(true);
    expect(await state.accepted()).toContain("GLOBAL_FALLBACK");
    expect(state.events.filter((event) => event.type === "config.error")).toEqual([]);
  });

  it("discards opened descriptor bytes if an atomic replacement wins before validation", async () => {
    const state = await fixture();
    const original = fsPromises.open;
    let mutated = false;
    vi.spyOn(fsPromises, "open").mockImplementation((async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (!mutated && String(args[0]) === state.skillPath) {
        mutated = true;
        const replacement = join(state.root, "next-skill");
        write(replacement, descriptor("PROJECT_REPLACEMENT"));
        renameSync(replacement, state.skillPath);
      }
      return handle;
    }) as typeof original);
    syncBuiltinESMExports();

    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "committed", error: null });
    expect(mutated).toBe(true);
    expect(await state.accepted()).toContain("PROJECT_REPLACEMENT");
    expect(state.events.filter((event) => event.type === "config.error")).toEqual([]);
  });

  it("does not retry a containment violation into a falsely accepted empty layer", async () => {
    const state = await fixture();
    const generation = state.live.generation;
    const outside = join(state.root, "external-skill");
    write(join(outside, "SKILL.md"), descriptor("UNACCEPTED_EXTERNAL"));
    const original = fsPromises.open;
    let opens = 0;
    vi.spyOn(fsPromises, "open").mockImplementation((async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (String(args[0]) === state.skillPath) {
        opens += 1;
        const directory = join(state.skillPath, "..");
        renameSync(directory, join(state.root, "retired-skill"));
        symlinkSync(outside, directory, "dir");
      }
      return handle;
    }) as typeof original);
    syncBuiltinESMExports();

    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "rejected", generation });
    expect(opens).toBe(1);
    expect(await state.accepted()).toContain("PROJECT_ORIGINAL");
    expect(state.events.map((event) => event.type)).toEqual(["config.error"]);
  });

  it.each(["EACCES", "EIO", "ENOTCONN"])("reports %s immediately and retains accepted bytes", async (code) => {
    const state = await fixture();
    const generation = state.live.generation;
    const original = fsPromises.lstat;
    let attempts = 0;
    vi.spyOn(fsPromises, "lstat").mockImplementation(((path: string, ...args: unknown[]) => {
      if (String(path) === state.skills) {
        attempts += 1;
        return Promise.reject(Object.assign(new Error("PRIVATE_READ_ERROR"), { code }));
      }
      return Reflect.apply(original, fsPromises, [path, ...args]);
    }) as typeof original);
    syncBuiltinESMExports();

    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "rejected", generation });
    expect(attempts).toBe(1);
    expect(state.live.error).toContain(state.config);
    expect(state.live.error).not.toContain("PRIVATE_READ_ERROR");
    expect(await state.accepted()).toContain("PROJECT_ORIGINAL");
    expect(state.events.map((event) => event.type)).toEqual(["config.error"]);
  });

  it("bounds repeated replacement, retains last-good bytes and permits later settled recovery", async () => {
    const state = await fixture();
    const generation = state.live.generation;
    const original = fsPromises.open;
    let attempts = 0;
    const spy = vi.spyOn(fsPromises, "open").mockImplementation((async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (String(args[0]) === state.skillPath) {
        attempts += 1;
        renameSync(state.config, join(state.root, `retired-${attempts}`));
        write(state.skillPath, descriptor(`PROJECT_REPLACEMENT_${attempts}`));
      }
      return handle;
    }) as typeof original);
    syncBuiltinESMExports();

    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "rejected", generation });
    expect(attempts).toBe(3);
    expect(state.live.error).toContain(state.config);
    expect(await state.accepted()).toContain("PROJECT_ORIGINAL");
    expect(state.events.map((event) => event.type)).toEqual(["config.error"]);
    spy.mockRestore();
    syncBuiltinESMExports();

    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "committed", error: null });
    expect(await state.accepted()).toContain(`PROJECT_REPLACEMENT_${attempts}`);
  });

  it.each(["global", "project"] as const)("re-reads an opened %s extension after atomic helper replacement", async (scope) => {
    const state = await fixture();
    const config = scope === "global" ? state.agentDir : state.config;
    const source = join(config, "extensions", "tool", "helper.ts");
    write(source, "export const value = 'before';");
    await state.live.synchronize({ projectCwds: [state.project] });
    const generation = state.live.generation;
    state.events.splice(0);
    const original = fsPromises.open;
    let mutated = false;
    vi.spyOn(fsPromises, "open").mockImplementation((async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (!mutated && String(args[0]) === source) {
        mutated = true;
        const replacement = join(state.root, "helper.next");
        write(replacement, "export const value = 'after';");
        renameSync(replacement, source);
      }
      return handle;
    }) as typeof original);
    syncBuiltinESMExports();

    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({
      status: "committed", error: null, generation: generation + 1,
    });
    expect(mutated).toBe(true);
    expect(state.events.filter((event) => event.type === "config.error")).toEqual([]);
    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "unchanged" });
  });

  it("re-enumerates an extension directory removed after stat instead of retaining a partial fingerprint", async () => {
    const state = await fixture();
    const extensions = join(state.config, "extensions");
    write(join(extensions, "tool.ts"), "export {};");
    await state.live.synchronize({ projectCwds: [state.project] });
    state.events.splice(0);
    const original = fsPromises.opendir;
    let mutated = false;
    vi.spyOn(fsPromises, "opendir").mockImplementation((async (...args: Parameters<typeof original>) => {
      if (!mutated && String(args[0]) === extensions) {
        mutated = true;
        renameSync(extensions, join(state.root, "retired-extensions"));
      }
      return original(...args);
    }) as typeof original);
    syncBuiltinESMExports();

    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "committed", error: null });
    expect(mutated).toBe(true);
    expect(state.events.filter((event) => event.type === "config.error")).toEqual([]);
    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "unchanged" });
  });

  it("re-reads removed extension settings after resolving their physical source", async () => {
    const state = await fixture();
    const settings = join(state.config, "settings.json");
    write(settings, JSON.stringify({ extensions: ["../external-tool.ts"] }));
    write(join(state.project, "external-tool.ts"), "export {};");
    await state.live.synchronize({ projectCwds: [state.project] });
    state.events.splice(0);
    const original = fsPromises.lstat;
    let mutated = false;
    vi.spyOn(fsPromises, "lstat").mockImplementation((async (path: string, ...args: unknown[]) => {
      const result = await Reflect.apply(original, fsPromises, [path, ...args]);
      if (!mutated && String(path) === settings) {
        mutated = true;
        unlinkSync(settings);
      }
      return result;
    }) as typeof original);
    syncBuiltinESMExports();

    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "committed", error: null });
    expect(mutated).toBe(true);
    expect(state.events.filter((event) => event.type === "config.error")).toEqual([]);
    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "unchanged" });
  });

  it("keeps a nonmissing extension open failure diagnostic without retry", async () => {
    const state = await fixture();
    const source = join(state.config, "extensions", "tool.ts");
    write(source, "export {};");
    await state.live.synchronize({ projectCwds: [state.project] });
    const generation = state.live.generation;
    state.events.splice(0);
    const original = fsPromises.open;
    let attempts = 0;
    vi.spyOn(fsPromises, "open").mockImplementation((async (...args: Parameters<typeof original>) => {
      if (String(args[0]) === source) {
        attempts += 1;
        throw Object.assign(new Error("PRIVATE_READ_ERROR"), { code: "EACCES" });
      }
      return original(...args);
    }) as typeof original);
    syncBuiltinESMExports();

    expect(await state.live.synchronize({ projectCwds: [state.project] })).toMatchObject({ status: "rejected", generation });
    expect(attempts).toBe(1);
    expect(state.live.error).toContain(source);
    expect(state.live.error).not.toContain("PRIVATE_READ_ERROR");
    expect(state.events.map((event) => event.type)).toEqual(["config.error"]);
  });

  it("re-enumerates a global Agent removed between directory listing and file read", async () => {
    const state = await fixture();
    const source = join(state.agentDir, "agents", "race-consumer.md");
    const generation = state.live.generation;
    const original = fsPromises.readFile;
    let mutated = false;
    vi.spyOn(fsPromises, "readFile").mockImplementation((async (...args: Parameters<typeof original>) => {
      if (!mutated && String(args[0]) === source) {
        mutated = true;
        unlinkSync(source);
      }
      return original(...args);
    }) as typeof original);
    syncBuiltinESMExports();

    expect(await state.live.synchronize()).toMatchObject({ status: "committed", error: null, generation: generation + 1 });
    expect(mutated).toBe(true);
    expect((await state.live.resolveAgents(state.project)).find((agent) => agent.name === "race-consumer")).toBeUndefined();
    expect(state.events.filter((event) => event.type === "config.error")).toEqual([]);
  });
});
