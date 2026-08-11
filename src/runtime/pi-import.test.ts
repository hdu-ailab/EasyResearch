import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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
	it("uses the EasyResearch agent override and ignores Pi's override", async () => {
		const { getAgentDir } = await importPi();
		const lazyDir = mkdtempSync(join(tmpdir(), "easyresearch-agent-"));
		const piDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
		tempDirs.push(lazyDir, piDir);
		process.env.EASYRESEARCH_CODING_AGENT_DIR = lazyDir;
		process.env.PI_CODING_AGENT_DIR = piDir;

		expect(getAgentDir()).toBe(lazyDir);
	});

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