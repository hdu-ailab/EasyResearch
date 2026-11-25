import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { importPi } from "./pi-import";

const originalEasyResearchDir = process.env.EASYRESEARCH_CODING_AGENT_DIR;
const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

afterEach(() => {
	if (originalEasyResearchDir === undefined) delete process.env.EASYRESEARCH_CODING_AGENT_DIR;
	else process.env.EASYRESEARCH_CODING_AGENT_DIR = originalEasyResearchDir;
	if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("EasyResearch native identity", () => {
	it("reloads local extension helpers under Bun without retaining its native import cache", () => {
		const home = mkdtempSync(join(tmpdir(), "easyresearch-bun-extension-"));
		tempDirs.push(home);
		const agentDir = join(home, "agent");
		const cwd = join(home, "paper");
		const extension = join(agentDir, "extensions", "probe");
		mkdirSync(extension, { recursive: true });
		mkdirSync(cwd);
		const helper = join(extension, "helper.ts");
		writeFileSync(helper, 'export const version = "first";');
		writeFileSync(join(extension, "index.ts"), `
import { Type } from "typebox";
import { version } from "./helper.ts";
export default api => api.registerTool({
  name: "cache_probe", label: "Cache probe", description: "Read helper",
  parameters: Type.Object({}),
  execute: async () => ({content: [{ type: "text", text: version }], details: {}})
});`);
		const output = execFileSync("bun", ["-e", `
const { writeFileSync, renameSync } = await import("node:fs");
const { importPi } = await import("./src/runtime/pi-import.ts");
const pi = await importPi();
const cwd = ${JSON.stringify(cwd)}, agentDir = ${JSON.stringify(agentDir)};
const settingsManager = pi.SettingsManager.inMemory();
const loader = new pi.DefaultResourceLoader({cwd, agentDir, settingsManager,
 noSkills:true, noContextFiles:true, noThemes:true, noPromptTemplates:true});
await loader.reload({resolveProjectTrust: async () => true});
const { session } = await pi.createAgentSession({cwd, agentDir, settingsManager, resourceLoader: loader,
 sessionManager: pi.SessionManager.inMemory(cwd)});
try {
 await session.bindExtensions({mode:"print"});
 const run = () => session.getToolDefinition("cache_probe").execute("probe", {}, undefined, undefined, {});
 const before = await run();
 writeFileSync(${JSON.stringify(helper + ".next")}, 'export const version = "second";');
 renameSync(${JSON.stringify(helper + ".next")}, ${JSON.stringify(helper)});
 await session.reload();
 console.log(JSON.stringify({before, after:await run()}));
} finally {
 await session.extensionRunner.emit({type:"session_shutdown",reason:"quit"});
 session.dispose();
}`], {
			cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
			env: { ...process.env, HOME: home, USERPROFILE: home, EASYRESEARCH_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", JITI_TRY_NATIVE: "true" },
		});
		const result = JSON.parse(output.trim());
		expect(result.before.content[0].text).toBe("first");
		expect(result.after.content[0].text).toBe("second");
	}, 25_000);

	it("keeps EasyResearch identity when discovery is imported first", () => {
		const home = mkdtempSync(join(tmpdir(), "easyresearch-home-"));
		tempDirs.push(home);
		const env: Record<string, string | undefined> = { ...process.env, HOME: home };
		delete env.EASYRESEARCH_CODING_AGENT_DIR;
		delete env.PI_CODING_AGENT_DIR;
		delete env.PI_PACKAGE_DIR;
		const output = execFileSync(
			"bun",
			[
				"-e",
				`const agents = await import("./src/subagent/agents.ts");
const runtime = await import("./src/runtime/pi-import.ts");
void agents;
const pi = await runtime.importPi();
console.log(JSON.stringify({ agentDir: pi.getAgentDir(), configDir: pi.CONFIG_DIR_NAME }));`,
			],
			{ cwd: process.cwd(), env, encoding: "utf8" },
		).trim();

		expect(JSON.parse(output)).toEqual({
			agentDir: join(home, ".easyresearch", "agent"),
			configDir: ".easyresearch",
		});
	});

	it("uses the EasyResearch agent override and ignores Pi's override", async () => {
		const { getAgentDir } = await importPi();
		const lazyDir = mkdtempSync(join(tmpdir(), "easyresearch-agent-"));
		const piDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
		tempDirs.push(lazyDir, piDir);
		process.env.EASYRESEARCH_CODING_AGENT_DIR = lazyDir;
		process.env.PI_CODING_AGENT_DIR = piDir;

		expect(getAgentDir()).toBe(lazyDir);
	}, 15_000);

	it("loads project settings from exact-cwd .easyresearch instead of .pi", async () => {
		const { SettingsManager } = await importPi();
		const cwd = mkdtempSync(join(tmpdir(), "easyresearch-project-"));
		const agentDir = mkdtempSync(join(tmpdir(), "easyresearch-global-"));
		tempDirs.push(cwd, agentDir);
		mkdirSync(join(cwd, ".easyresearch"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".easyresearch", "settings.json"), '{"defaultModel":"lazy-model"}');
		writeFileSync(join(cwd, ".pi", "settings.json"), '{"defaultModel":"pi-model"}');

		expect(SettingsManager.create(cwd, agentDir).getDefaultModel()).toBe("lazy-model");
	});
});
