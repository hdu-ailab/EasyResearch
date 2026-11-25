import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveConfiguration, type LiveConfiguration } from "../runtime/live-configuration";
import { createAgentRuntimeBinding } from "../runtime/agent-runtime-binding";
import { ConfigFileService } from "./config-files";
import { deleteGlobalSkill, listGlobalSkills, patchGlobalSkill, readGlobalSkill, writeGlobalSkill } from "./agent-resources";
import { createRouteHandler, type RouteServices } from "./routes";
import { SkillMarketplace } from "./skill-marketplace";
import { marketFixture } from "./skill-marketplace.test-helper";

let root: string, agentDir: string, bundle: string, cwd: string, descriptor: string;
let live: LiveConfiguration;
let config: ConfigFileService;
let handler: ReturnType<typeof createRouteHandler>;
let events: Array<{ type: string; skillsChanged?: boolean; generation: number }>;
const content = (name = "fixture") => `---\nname: ${name}\ndescription: Fixture description\n---\nInstructions.\n`;
const options = () => ({ skillPolicy: live.skillPolicy, bundledSkillsDir: join(bundle, "skills"), homeDir: root });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "er-skill-controls-"));
  agentDir = join(root, ".easyresearch", "agent"); bundle = join(root, "bundle"); cwd = join(root, "paper");
  descriptor = join(agentDir, "skills/fixture/SKILL.md");
  mkdirSync(join(descriptor, ".."), { recursive: true }); mkdirSync(cwd);
  mkdirSync(join(bundle, "skills"), { recursive: true }); mkdirSync(join(bundle, "agents"));
  writeFileSync(descriptor, content());
  writeFileSync(join(bundle, "agents/research-assistant.md"), "---\nname: research-assistant\ndescription: fixture\nskills: []\n---\nFixture\n");
  writeFileSync(join(bundle, "agents/custom.md"), "---\nname: custom\ndescription: fixture\nskills: [fixture]\n---\nFixture\n");
  vi.stubEnv("HOME", root); vi.stubEnv("EASYRESEARCH_CODING_AGENT_DIR", agentDir); vi.stubEnv("EASYRESEARCH_BUNDLED_ROOT", bundle);
  live = createLiveConfiguration({ agentDir, catalogOptions: { homeDir: root, bundledSkillsDir: join(bundle, "skills") },
    modelValidator: { prepareModelCatalog: async () => ({ registeredModels: [], availableModels: [], commit() {}, rollback() {} }), currentAvailableModels: () => [] } });
  events = [];
  live.subscribe((event) => events.push(event));
  await live.start();
  config = new ConfigFileService(agentDir, { onAuthoritativeWrite: (change) => live.notify(change),
    acquireProject: (path) => live.acquireProject(path), synchronizeProject: (path) => live.synchronize({ projectCwds: [path] }) });
  handler = createRouteHandler({ config, configuration: live, registry: {}, directories: {}, logger: { error() {}, warn() {} } } as unknown as RouteServices);
});
afterEach(async () => { await handler?.close?.(); await live?.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function request(method: string, body?: unknown, name = "fixture") {
  return handler(new Request(`http://localhost/api/skill-resources/${encodeURIComponent(name)}`, {
    method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  }));
}

describe("Skill resource controls", () => {
  it("keeps disabled inventory/editing available and immediately publishes accepted global/custom runtime state", async () => {
    const generation = live.generation;
    const response = await request("PATCH", { enabled: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false, canDelete: true, description: "Fixture description" });
    expect(live.generation).toBeGreaterThan(generation);
    expect(events.at(-1)).toMatchObject({ type: "config.updated", skillsChanged: true });
    const resources = await listGlobalSkills(config, options());
    expect(resources).toEqual([expect.objectContaining({ name: "fixture", enabled: false })]);
    expect((await live.resolveAgents()).every((agent) => !agent.effectiveSkills.includes("fixture"))).toBe(true);
    expect((await live.resolveAgents()).find((agent) => agent.name === "custom")?.missingSkills).toEqual([]);
    await writeGlobalSkill(config, "fixture", `${content()}Edited while disabled.\n`, options());
    expect((await readGlobalSkill(config, "fixture", options())).content).toContain("Edited while disabled");
    expect((await request("PATCH", { enabled: true })).status).toBe(200);
    expect((await live.resolveAgents()).every((agent) => agent.effectiveSkills.includes("fixture"))).toBe(true);
  });

  it.each([null, [], {}, { enabled: "false" }, { enabled: false, path: "../../outside" }])("rejects malformed state %j", async (body) => {
    expect((await request("PATCH", body)).status).toBe(400);
    expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
    expect(readFileSync(descriptor, "utf8")).toBe(content());
  });

  it("requires JSON for state writes and never resolves traversal names as paths", async () => {
    expect((await handler(new Request("http://localhost/api/skill-resources/fixture", { method: "PATCH", body: '{"enabled":false}' }))).status).toBe(415);
    expect((await request("DELETE", undefined, "../../outside")).status).toBe(404);
    expect(existsSync(descriptor)).toBe(true);
  });

  it("keeps disabled bundled Skills disabled when editing creates a global override", async () => {
    mkdirSync(join(bundle, "skills/builtin")); writeFileSync(join(bundle, "skills/builtin/SKILL.md"), content("builtin"));
    await live.synchronize({ recoverWatchers: true });
    await patchGlobalSkill(config, "builtin", false, options());
    const saved = await writeGlobalSkill(config, "builtin", `${content("builtin")}Edited.\n`, options());
    expect(saved).toMatchObject({ source: "global", enabled: false });
    expect((await readGlobalSkill(config, "builtin", options())).enabled).toBe(false);
    expect((await live.resolveAgents()).every((agent) => !agent.effectiveSkills.includes("builtin"))).toBe(true);
  });

  it("uses accepted override policy after invalid external settings and restores it on repair", async () => {
    await patchGlobalSkill(config, "fixture", false, options());
    const generation = live.generation;
    writeFileSync(join(agentDir, "settings.json"), '{"skills":"invalid"}');
    expect((await live.synchronize()).status).toBe("rejected");
    expect(live.generation).toBe(generation);
    expect((await readGlobalSkill(config, "fixture", options())).enabled).toBe(false);
    writeFileSync(join(agentDir, "settings.json"), '{"skills":[]}');
    await live.synchronize();
    expect((await readGlobalSkill(config, "fixture", options())).enabled).toBe(true);
  });

  it("removes the owned directory and its exact overrides, preserving supporting siblings and unrelated settings", async () => {
    const sibling = join(agentDir, "skills/sibling");
    mkdirSync(sibling); writeFileSync(join(sibling, "SKILL.md"), content("sibling"));
    writeFileSync(join(agentDir, "skills/fixture/asset.bin"), Buffer.from([0, 255, 128]));
    const external = join(root, "referenced");
    mkdirSync(external); writeFileSync(join(external, "keep.txt"), "external reference");
    symlinkSync(external, join(agentDir, "skills/fixture/external"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "kept", skills: ["+skills/fixture", "-skills/fixture/SKILL.md", "!sibling", "+skills/sibling"], custom: { keep: true } }));
    await live.synchronize();
    expect(await (await request("DELETE")).json()).toEqual({ deleted: true, name: "fixture" });
    expect(existsSync(join(descriptor, ".."))).toBe(false);
    expect(readFileSync(join(sibling, "SKILL.md"), "utf8")).toBe(content("sibling"));
    expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("external reference");
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      theme: "kept", skills: ["!sibling", "+skills/sibling"], custom: { keep: true },
    });
    mkdirSync(join(descriptor, "..")); writeFileSync(descriptor, content());
    await live.notify({ skillsChanged: true });
    expect((await listGlobalSkills(config, options())).find((skill) => skill.name === "fixture")?.enabled).toBe(true);
  });

  it("does not clear newly added external overrides during deletion", async () => {
    writeFileSync(join(agentDir, "settings.json"), '{"skills":["-skills/fixture"]}');
    const original = config.mutateGlobalSettings.bind(config);
    const newer = "+./skills/fixture/SKILL.md";
    vi.spyOn(config, "mutateGlobalSettings").mockImplementation((mutate, options) => {
      if (!existsSync(descriptor)) {
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: ["-skills/fixture", newer], unrelated: "preserved" }));
      }
      return original(mutate, options);
    });
    await deleteGlobalSkill(config, "fixture", options());
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({ skills: [newer], unrelated: "preserved" });
  });

  it("preserves a replacement directory if deletion custody changes while settings are updated", async () => {
    const original = config.mutateGlobalSettings.bind(config);
    const recovery = join(root, "original-directory");
    let replacement: string | undefined;
    vi.spyOn(config, "mutateGlobalSettings").mockImplementation((mutate, options) => {
      if (!existsSync(descriptor) && !replacement) {
        replacement = join(agentDir, readdirSync(agentDir).find((name) => name.startsWith(".skill-delete-"))!);
        renameSync(replacement, recovery);
        mkdirSync(replacement);
        writeFileSync(join(replacement, "user-work.txt"), "preserve replacement");
      }
      return original(mutate, options);
    });
    await expect(deleteGlobalSkill(config, "fixture", options())).rejects.toMatchObject({ code: "SKILL_DELETE_INCOMPLETE" });
    expect(readFileSync(join(recovery, "SKILL.md"), "utf8")).toBe(content());
    expect(readFileSync(join(replacement!, "user-work.txt"), "utf8")).toBe("preserve replacement");
  });

  it("never deletes bundled/home/standalone or symlinked directories and preserves external references", async () => {
    mkdirSync(join(bundle, "skills/builtin")); writeFileSync(join(bundle, "skills/builtin/SKILL.md"), content("builtin"));
    writeFileSync(join(agentDir, "skills/single.md"), content("single"));
    for (const name of ["builtin", "single"]) {
      expect((await readGlobalSkill(config, name, options())).canDelete).toBe(false);
      await expect(deleteGlobalSkill(config, name, options())).rejects.toMatchObject({ code: "SKILL_NOT_DELETABLE" });
    }
    const homeSkill = join(root, ".agents/skills/home-only");
    mkdirSync(homeSkill, { recursive: true }); writeFileSync(join(homeSkill, "SKILL.md"), content("home-only"));
    const homeOptions = { ...options(), skillPolicy: { ...live.skillPolicy, enableDotAgentsSkill: true } };
    expect((await readGlobalSkill(config, "home-only", homeOptions)).canDelete).toBe(false);
    await expect(deleteGlobalSkill(config, "home-only", homeOptions)).rejects.toMatchObject({ code: "SKILL_NOT_DELETABLE" });
    const outside = join(root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "SKILL.md"), content("external"));
    symlinkSync(outside, join(agentDir, "skills/external"), process.platform === "win32" ? "junction" : "dir");
    expect((await request("DELETE", undefined, "external")).status).toBe(404);
    symlinkSync(join(agentDir, "skills/fixture"), join(agentDir, "skills/aaa-alias"), process.platform === "win32" ? "junction" : "dir");
    expect((await readGlobalSkill(config, "fixture", options())).canDelete).toBe(false);
    expect((await request("DELETE")).status).toBe(409);
    expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toBe(content("external"));
    expect(existsSync(descriptor)).toBe(true);
  });

  it("supports namespaced identities and serializes install, disable and delete through the same owner", async () => {
    const fixture = marketFixture();
    const paused = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const market = new SkillMarketplace({ config, skillOptions: options, fetch: async (url) => fixture.response(url),
      notify: async () => { entered.resolve(); await paused.promise; return live.notify({ skillsChanged: true }); } });
    try {
      const install = market.install({ id: fixture.id, commit: fixture.commit });
      await entered.promise;
      const disable = patchGlobalSkill(config, "market-test", false, options());
      const remove = deleteGlobalSkill(config, "market-test", options());
      expect(existsSync(join(agentDir, "skills/market-test/SKILL.md"))).toBe(true);
      paused.resolve();
      await install; await disable; await remove;
      await market.install({ id: fixture.id, commit: fixture.commit });
      expect((await readGlobalSkill(config, "market-test", options())).enabled).toBe(true);
      const namespaced = join(agentDir, "skills/stitch-fixture");
      mkdirSync(namespaced); writeFileSync(join(namespaced, "SKILL.md"), content("stitch::fixture"));
      await live.notify({ skillsChanged: true });
      const response = await request("PATCH", { enabled: false }, "stitch::fixture");
      expect(await response.json()).toMatchObject({ name: "stitch::fixture", enabled: false });
      expect(await (await request("DELETE", undefined, "stitch::fixture")).json()).toEqual({ deleted: true, name: "stitch::fixture" });
      expect(existsSync(namespaced)).toBe(false);
    } finally { paused.resolve(); await market.close(); }
  });

  it("restores a pending delete when settings cannot be changed and reports persisted notification failures honestly", async () => {
    writeFileSync(join(agentDir, "settings.json"), "{bad");
    await expect(deleteGlobalSkill(config, "fixture", options())).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(readFileSync(descriptor, "utf8")).toBe(content());
    writeFileSync(join(agentDir, "settings.json"), "{}");
    const rejected = new ConfigFileService(agentDir, { onAuthoritativeWrite: async () => ({ status: "rejected" }) });
    await expect(patchGlobalSkill(rejected, "fixture", false, options())).rejects.toMatchObject({ code: "CONFIG_REJECTED" });
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).skills).toEqual([`-${descriptor.replaceAll("\\", "/")}`]);
    await expect(deleteGlobalSkill(rejected, "fixture", options())).rejects.toMatchObject({ code: "CONFIG_REJECTED" });
    expect(existsSync(descriptor)).toBe(false);
  });

  it("keeps active runtime paths until whole-run idle application while Settings changes immediately", async () => {
    const binding = createAgentRuntimeBinding({ live, agentName: "research-assistant", cwd,
      createModelRuntime: async () => ({ refresh: async () => {}, getModel: () => undefined, getAvailableSnapshot: () => [], getProvider: () => undefined, getProviderAuthStatus: () => ({ configured: false }), getError: () => undefined }),
      resolveAutomaticModel: async () => undefined,
      compaction: { apply: (policy) => ({ triggerPercent: policy.triggerPercent, enabled: true }), current: () => ({ triggerPercent: 70, enabled: true }) } });
    const session = { isIdle: true, model: undefined, thinkingLevel: "off" as const, reload: vi.fn(async () => {}), abort: async () => {}, rebindModel() {}, setThinkingLevel() {} };
    try {
      await binding.ensureCurrent(); await binding.attach(session);
      const initialPaths = binding.skillPaths();
      expect(initialPaths).toHaveLength(1);
      session.isIdle = false;
      await patchGlobalSkill(config, "fixture", false, options());
      await binding.ensureCurrent();
      expect(binding.skillPaths()).toEqual(initialPaths);
      expect((await readGlobalSkill(config, "fixture", options())).enabled).toBe(false);
      session.isIdle = true;
      await binding.ensureCurrent();
      expect(binding.skillPaths()).toEqual([]);
      await patchGlobalSkill(config, "fixture", true, options());
      await binding.ensureCurrent();
      expect(binding.skillPaths()).toEqual(initialPaths);
    } finally { await binding.dispose(); }
  });

  it("watches exact-project overrides without disabling a different global resource", async () => {
    const base = join(cwd, ".easyresearch");
    mkdirSync(join(base, "skills/fixture"), { recursive: true });
    writeFileSync(join(base, "skills/fixture/SKILL.md"), content());
    const registration = await live.acquireProject(cwd);
    try {
      const generation = live.generation;
      writeFileSync(join(base, "settings.json"), JSON.stringify({ skills: ["-skills/fixture"] }));
      await vi.waitFor(() => expect(live.generation).toBeGreaterThan(generation));
      expect((await live.resolveAgents(cwd)).every((agent) => !agent.effectiveSkills.includes("fixture"))).toBe(true);
      expect((await live.resolveAgents()).every((agent) => agent.effectiveSkills.includes("fixture"))).toBe(true);
      await config.write({ scope: "project", cwd, path: "settings.json", content: '{"skills":[]}' });
      expect((await live.resolveAgents(cwd)).every((agent) => agent.effectiveSkills.includes("fixture"))).toBe(true);
    } finally { await registration.release(); }
  });
});
