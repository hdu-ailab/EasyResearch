import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveConfiguration, type ConfigurationEvent, type LiveConfiguration } from "../runtime/live-configuration";
import { MAX_EXTENSION_DEPTH } from "../runtime/extension-resources";
import { ConfigFileService, ConfigServiceError } from "./config-files";

let root: string, agentDir: string, cwd: string, bundle: string;
let live: LiveConfiguration;
const quietWatch = () => {
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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "easyresearch-extension-write-"));
  agentDir = join(root, "agent"); cwd = join(root, "paper"); bundle = join(root, "bundle");
  for (const path of [agentDir, cwd, join(bundle, "agents"), join(bundle, "skills")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(bundle, "agents", "research-assistant.md"), "---\nname: research-assistant\ndescription: Fixture\n---\nFixture.");
  vi.stubEnv("HOME", root); vi.stubEnv("USERPROFILE", root); vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir);
  live = createLiveConfiguration({
    agentDir, watch: quietWatch,
    catalogOptions: { homeDir: root, bundledAgentsDir: bundle, bundledSkillsDir: join(bundle, "skills") },
    modelValidator: {
      async prepareModelCatalog() { return { registeredModels: [], availableModels: [], commit() {}, rollback() {} }; },
      currentAvailableModels: () => [],
    },
  });
  await live.start();
});
afterEach(async () => { await live?.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("authoritative Web extension writes", () => {
  it.each(["global", "project"] as const)("accepts %s entry/helper writes before responding without filesystem notifications", async scope => {
    let target = "";
    let owned = false;
    const events: ConfigurationEvent[] = [];
    live.subscribe(event => events.push(event));
    const notify = vi.fn(async change => {
      expect(readFileSync(target, "utf8")).toContain("fixture");
      if (scope === "project") expect(owned).toBe(true);
      return live.notify(change);
    });
    const acquireProject = vi.fn(async path => {
      expect(path).toBe(cwd);
      expect(existsSync(target)).toBe(false);
      const registration = await live.acquireProject(path);
      owned = true;
      return { cwd: path, release: async () => { await registration.release(); owned = false; } };
    });
    const synchronizeProject = vi.fn(async path => {
      expect(owned).toBe(true);
      expect(readFileSync(target, "utf8")).toContain("fixture");
      return live.synchronize({ projectCwds: [path] });
    });
    const service = new ConfigFileService(agentDir, { onAuthoritativeWrite: notify, acquireProject, synchronizeProject });
    const base = scope === "global" ? agentDir : join(cwd, ".easyresearch");
    for (const [path, content] of [
      ["extensions/sample/index.ts", "export default () => {}; // fixture"],
      ["extensions/sample/.helpers/data.json", '{"fixture":true}'],
    ]) {
      target = join(base, path!);
      const generation = live.generation;
      await service.write({ scope, cwd, path: path!, content: content! });
      expect(live.generation).toBeGreaterThan(generation);
      expect(notify).toHaveBeenLastCalledWith({ extensionsChanged: true, ...(scope === "project" ? { projectCwds: [cwd] } : {}) });
      expect(events.at(-1)).toMatchObject({ type: "config.updated", generation: live.generation, runtimeChanged: true });
      expect(owned).toBe(false);
    }
    expect(notify).toHaveBeenCalledTimes(2);
    expect(acquireProject).toHaveBeenCalledTimes(scope === "project" ? 2 : 0);
    expect(synchronizeProject).toHaveBeenCalledTimes(scope === "project" ? 2 : 0);
  });

  it.each(["global", "project"] as const)("keeps %s dependency/linked/external targets outside automatic write notification", async scope => {
    const notify = vi.fn();
    const acquireProject = vi.fn();
    const synchronizeProject = vi.fn();
    const service = new ConfigFileService(agentDir, { onAuthoritativeWrite: notify, acquireProject, synchronizeProject });
    const base = scope === "global" ? agentDir : join(cwd, ".easyresearch");
    mkdirSync(join(base, "extensions"), { recursive: true });
    mkdirSync(join(base, "external"), { recursive: true });
    symlinkSync(join(base, "external"), join(base, "extensions", "linked"), process.platform === "win32" ? "junction" : "dir");
    for (const path of [
      "extensions/node_modules/package/index.ts", "extensions/.git/cache.json",
      "extensions/notes.txt", "extensions/linked/helper.ts", "external/helper.ts",
      `extensions/${Array.from({ length: MAX_EXTENSION_DEPTH + 1 }, () => "deep").join("/")}/helper.ts`,
    ]) await service.write({ scope, cwd, path, content: path.endsWith(".json") ? "{}" : "export {};" });
    expect(notify).not.toHaveBeenCalled();
    expect(acquireProject).not.toHaveBeenCalled();
    expect(synchronizeProject).not.toHaveBeenCalled();
  });

  it("keeps explicit external sources on manual/preflight fingerprints", async () => {
    mkdirSync(join(agentDir, "external"));
    writeFileSync(join(agentDir, "external", "helper.ts"), "before");
    writeFileSync(join(agentDir, "settings.json"), '{"extensions":["external/helper.ts"]}');
    await live.synchronize();
    const generation = live.generation;
    const notify = vi.fn(change => live.notify(change));
    await new ConfigFileService(agentDir, { onAuthoritativeWrite: notify }).write({
      scope: "global", path: "external/helper.ts", content: "after",
    });
    expect(notify).not.toHaveBeenCalled();
    expect(live.generation).toBe(generation);
    await live.synchronize();
    expect(live.generation).toBeGreaterThan(generation);
  });

  it("releases project source ownership after a saved-but-rejected notification", async () => {
    const release = vi.fn(async () => {});
    const service = new ConfigFileService(agentDir, {
      acquireProject: async path => ({ cwd: path, release }),
      onAuthoritativeWrite: async () => { throw new ConfigServiceError(409, "Configuration was saved but could not be accepted.", "CONFIG_REJECTED"); },
    });
    await expect(service.write({ scope: "project", cwd, path: "extensions/entry.ts", content: "export {};" }))
      .rejects.toMatchObject({ code: "CONFIG_REJECTED" });
    expect(release).toHaveBeenCalledOnce();
    expect(readFileSync(join(cwd, ".easyresearch", "extensions", "entry.ts"), "utf8")).toBe("export {};");
  });
});
